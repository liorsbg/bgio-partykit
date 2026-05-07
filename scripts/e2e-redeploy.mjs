import { readFileSync } from "fs";
import { spawn } from "child_process";
import { Client } from "boardgame.io/dist/esm/client.js";
import { SocketIO } from "boardgame.io/dist/esm/multiplayer.js";

function getBaseUrl() {
  if (process.env.DEPLOYED_BASE_URL) {
    return process.env.DEPLOYED_BASE_URL.replace(/\/$/, "");
  }
  try {
    return readFileSync(".deployed-url", "utf-8").trim().replace(/\/$/, "");
  } catch {
    // ignore
  }
  throw new Error("DEPLOYED_BASE_URL env var or .deployed-url file required. Run deploy first.");
}

function log(msg) {
  console.log(`[e2e-redeploy] ${msg}`);
}

const TicTacToe = {
  name: "tic-tac-toe",
  setup: () => ({ cells: Array(9).fill(null) }),
  moves: {
    clickCell: ({ G, playerID }, id) => {
      if (G.cells[id] !== null) return "INVALID_MOVE";
      G.cells[id] = playerID;
    },
  },
  turn: { maxMoves: 1 },
};

async function main() {
  const BASE_URL = getBaseUrl();
  log(`Testing redeploy persistence on: ${BASE_URL}`);

  let failed = false;

  try {
    // 1. Create match and join player
    log("1. Creating match...");
    const createRes = await fetch(`${BASE_URL}/games/tic-tac-toe/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ numPlayers: 2 }),
    });
    const { matchID } = await createRes.json();
    log(`   Created match: ${matchID}`);

    const joinRes = await fetch(`${BASE_URL}/games/tic-tac-toe/${matchID}/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ playerID: "0", playerName: "Alice" }),
    });
    const { playerCredentials } = await joinRes.json();
    log("   Joined player 0.");

    // 2. Connect client and make a move
    log("2. Connecting client and making move...");
    const client = Client({
      game: TicTacToe,
      numPlayers: 2,
      playerID: "0",
      matchID,
      credentials: playerCredentials,
      multiplayer: SocketIO({ server: BASE_URL, socketOpts: { transports: ["websocket"] } }),
    });
    client.start();
    await new Promise((r) => setTimeout(r, 5000));

    client.moves.clickCell(0);
    await new Promise((r) => setTimeout(r, 5000));

    const stateBefore = client.getState();
    log(`   State before redeploy: cell0=${stateBefore?.G?.cells?.[0]}, stateID=${stateBefore?._stateID}`);

    if (stateBefore?.G?.cells?.[0] !== "0") {
      throw new Error("Move not persisted before redeploy");
    }
    if (stateBefore?._stateID !== 1) {
      throw new Error(`Pre-redeploy stateID should be 1, got ${stateBefore?._stateID}`);
    }

    client.stop();
    log("   Client stopped.");

    // 3. Redeploy
    log("3. Redeploying...");
    const deployChild = spawn("node", ["scripts/deploy.mjs"], {
      cwd: process.cwd(),
      stdio: "pipe",
      env: { ...process.env, FORCE_COLOR: "0" },
    });

    let deployOutput = "";
    deployChild.stdout.on("data", (d) => {
      const line = d.toString();
      deployOutput += line;
      process.stdout.write(line);
    });
    deployChild.stderr.on("data", (d) => {
      process.stderr.write(d.toString());
    });

    const deployExit = await new Promise((resolve) => deployChild.on("close", resolve));
    if (deployExit !== 0) {
      throw new Error(`Redeploy failed with exit code ${deployExit}`);
    }
    log("   Redeploy complete.");

    // 4. Reconnect with same credentials
    log("4. Reconnecting after redeploy...");
    const clientReconnect = Client({
      game: TicTacToe,
      numPlayers: 2,
      playerID: "0",
      matchID,
      credentials: playerCredentials,
      multiplayer: SocketIO({ server: BASE_URL, socketOpts: { transports: ["websocket"] } }),
    });
    clientReconnect.start();
    await new Promise((r) => setTimeout(r, 8000));

    const stateAfter = clientReconnect.getState();
    log(`   State after redeploy: cell0=${stateAfter?.G?.cells?.[0]}, stateID=${stateAfter?._stateID}`);

    if (stateAfter?.G?.cells?.[0] !== "0") {
      throw new Error("Redeploy lost persisted move");
    }
    if (stateAfter?._stateID !== 1) {
      throw new Error(`Post-redeploy stateID should be 1, got ${stateAfter?._stateID}`);
    }
    log("   Redeploy preserved match state and stateID.");

    clientReconnect.stop();

    // 5. Cleanup
    log("5. Cleaning up test match...");
    const cleanupRes = await fetch(`${BASE_URL}/e2e/cleanup`, { method: "POST" });
    if (cleanupRes.status === 200) {
      const body = await cleanupRes.json();
      log(`   Cleanup: ${JSON.stringify(body)}`);
    }

    log("All redeploy assertions passed.");
  } catch (err) {
    failed = true;
    log(`FAILED: ${err.message}`);
    console.error(err);
  }

  if (failed) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
