import { readFileSync, writeFileSync, rmSync, existsSync } from "fs";
import { spawn, execSync } from "child_process";
import { join } from "path";
import { Client } from "boardgame.io/dist/esm/client.js";
import { SocketIO } from "boardgame.io/dist/esm/multiplayer.js";

const CONSUMER_NAME = "bgio-consumer-e2e-test";
const TEMP_DIR = join("/tmp", CONSUMER_NAME);
const CLI_PATH = join(process.cwd(), "packages/create-bgio-partykit/dist/index.js");
const BGIO_PARTYKIT_PATH = process.cwd();

function log(msg) {
  console.log(`[e2e-consumer-deployed] ${msg}`);
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

async function scaffoldConsumer() {
  log("1. Cleaning up any previous consumer temp dir...");
  if (existsSync(TEMP_DIR)) {
    rmSync(TEMP_DIR, { recursive: true, force: true });
  }

  log("2. Scaffolding consumer project with create-bgio-partykit...");
  const cliChild = spawn("node", [CLI_PATH, TEMP_DIR], {
    cwd: process.cwd(),
    stdio: "pipe",
    env: { ...process.env, CI: "true", FORCE_COLOR: "0" },
  });

  let cliOutput = "";
  cliChild.stdout.on("data", (d) => {
    cliOutput += d.toString();
    process.stdout.write(d.toString());
  });
  cliChild.stderr.on("data", (d) => {
    process.stderr.write(d.toString());
  });

  const cliExit = await new Promise((resolve) => cliChild.on("close", resolve));
  if (cliExit !== 0) {
    throw new Error(`create-bgio-partykit CLI failed with exit code ${cliExit}`);
  }
  log("   Consumer scaffolded successfully.");
}

async function installAndConfigureConsumer() {
  log("3. Configuring consumer package.json to use local bgio-partykit...");
  const pkgPath = join(TEMP_DIR, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  pkg.dependencies["bgio-partykit"] = `file:${BGIO_PARTYKIT_PATH}`;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf-8");

  log("   Overwriting consumer game.ts with tic-tac-toe...");
  const gameTs = `import type { Game } from "boardgame.io";

export const TicTacToe: Game = {
  name: "tic-tac-toe",
  setup: () => ({ cells: Array(9).fill(null) }),
  moves: {
    clickCell: ({ G, playerID }, id: number) => {
      if (G.cells[id] !== null) return "INVALID_MOVE";
      G.cells[id] = playerID;
    },
  },
  turn: { maxMoves: 1 },
};
`;
  writeFileSync(join(TEMP_DIR, "src/game.ts"), gameTs, "utf-8");

  log("   Overwriting consumer server.ts to register tic-tac-toe...");
  const serverTs = `import { Server, registerGame } from "bgio-partykit";
import { TicTacToe } from "./game.js";

registerGame(TicTacToe);
export default Server;
`;
  writeFileSync(join(TEMP_DIR, "src/server.ts"), serverTs, "utf-8");

  log("4. Installing consumer dependencies...");
  const installChild = spawn("pnpm", ["install", "--no-frozen-lockfile", "--force"], {
    cwd: TEMP_DIR,
    stdio: "pipe",
    env: { ...process.env, CI: "true", FORCE_COLOR: "0" },
  });

  installChild.stdout.on("data", (d) => process.stdout.write(d.toString()));
  installChild.stderr.on("data", (d) => process.stderr.write(d.toString()));

  const installExit = await new Promise((resolve) => installChild.on("close", resolve));
  if (installExit !== 0) {
    throw new Error(`pnpm install in consumer failed with exit code ${installExit}`);
  }
  log("   Consumer dependencies installed.");

  // Verify installed bgio-partykit source is reachable
  const installedServerPath = join(TEMP_DIR, "node_modules/bgio-partykit/src/server.ts");
  if (!existsSync(installedServerPath)) {
    throw new Error("Installed bgio-partykit src/server.ts not found");
  }
}

async function waitForUrl(url, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status === 200) {
        log(`   URL ready: ${url}`);
        return;
      }
    } catch (err) {
      lastErr = err;
      if (!err.message?.includes("SSL") && !err.message?.includes("handshake")) {
        log(`   Waiting for ${url}: ${err.message}`);
      }
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw lastErr || new Error(`URL ${url} not ready after ${timeoutMs}ms`);
}

async function deployConsumer() {
  log("5. Deploying consumer project...");
  const deployChild = spawn("pnpm", ["partykit", "deploy", "--name", CONSUMER_NAME], {
    cwd: TEMP_DIR,
    stdio: "pipe",
    env: { ...process.env, FORCE_COLOR: "0" },
  });

  let deployOutput = "";
  deployChild.stdout.on("data", (d) => {
    deployOutput += d.toString();
    process.stdout.write(d.toString());
  });
  deployChild.stderr.on("data", (d) => {
    process.stderr.write(d.toString());
  });

  const deployExit = await new Promise((resolve) => deployChild.on("close", resolve));
  if (deployExit !== 0) {
    throw new Error(`Consumer deploy failed with exit code ${deployExit}`);
  }
  log("   Consumer deployed successfully.");

  // Extract deployed URL from output or construct it
  const urlMatch = deployOutput.match(/(https?:\/\/[^\s]+)/);
  const url = urlMatch ? urlMatch[1] : `https://${CONSUMER_NAME}.liorsbg.partykit.dev`;
  const cleanUrl = url.replace(/\/$/, "");

  log("   Waiting for deployed URL to become reachable (SSL provisioning)...");
  await waitForUrl(`${cleanUrl}/health`);
  return cleanUrl;
}

async function undeployConsumer() {
  log("8. Undeploying consumer project...");
  const undeployChild = spawn("pnpm", ["partykit", "deploy", "--name", CONSUMER_NAME, "--preview", "delete"], {
    cwd: TEMP_DIR,
    stdio: "pipe",
    env: { ...process.env, FORCE_COLOR: "0" },
  });

  undeployChild.stdout.on("data", (d) => process.stdout.write(d.toString()));
  undeployChild.stderr.on("data", (d) => process.stderr.write(d.toString()));

  const undeployExit = await new Promise((resolve) => undeployChild.on("close", resolve));
  if (undeployExit !== 0) {
    log(`   Undeploy exit code ${undeployExit} (may already be deleted).`);
  } else {
    log("   Consumer undeployed.");
  }
}

async function runSmoke(BASE_URL) {
  log(`6. Running smoke test against consumer: ${BASE_URL}`);

  // 1. Create match
  const createRes = await fetch(`${BASE_URL}/games/tic-tac-toe/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ numPlayers: 2 }),
  });
  if (!createRes.ok) {
    throw new Error(`Consumer createMatch failed: ${createRes.status}`);
  }
  const { matchID } = await createRes.json();
  log(`   Created match: ${matchID}`);

  // 2. Join players
  const join0Res = await fetch(`${BASE_URL}/games/tic-tac-toe/${matchID}/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ playerID: "0", playerName: "Alice" }),
  });
  const { playerCredentials: cred0 } = await join0Res.json();

  const join1Res = await fetch(`${BASE_URL}/games/tic-tac-toe/${matchID}/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ playerID: "1", playerName: "Bob" }),
  });
  const { playerCredentials: cred1 } = await join1Res.json();
  log("   Joined both players.");

  // 3. Client0 makes a move
  const client0 = Client({
    game: TicTacToe,
    numPlayers: 2,
    playerID: "0",
    matchID,
    credentials: cred0,
    multiplayer: SocketIO({ server: BASE_URL, socketOpts: { transports: ["websocket"] } }),
  });
  client0.start();
  await new Promise((r) => setTimeout(r, 8000));

  const state0Before = client0.getState();
  log(`   Client0 pre-move state: ${JSON.stringify(state0Before ? { cell0: state0Before.G?.cells?.[0], stateID: state0Before._stateID, phase: state0Before.ctx?.phase } : null)}`);
  if (!state0Before) {
    throw new Error("Client0 state is undefined before move — sync failed");
  }

  client0.moves.clickCell(0);
  await new Promise((r) => setTimeout(r, 5000));

  const state0 = client0.getState();
  log(`   Client0 move: cell0=${state0?.G?.cells?.[0]}, stateID=${state0?._stateID}`);

  if (state0?.G?.cells?.[0] !== "0" || state0?._stateID !== 1) {
    throw new Error("Consumer client0 move failed");
  }
  client0.stop();

  // 4. Client1 connects, sees persisted move, makes a move
  const client1 = Client({
    game: TicTacToe,
    numPlayers: 2,
    playerID: "1",
    matchID,
    credentials: cred1,
    multiplayer: SocketIO({ server: BASE_URL, socketOpts: { transports: ["websocket"] } }),
  });
  client1.start();
  await new Promise((r) => setTimeout(r, 5000));

  const state1 = client1.getState();
  log(`   Client1 sync: cell0=${state1?.G?.cells?.[0]}, stateID=${state1?._stateID}`);

  if (state1?.G?.cells?.[0] !== "0" || state1?._stateID !== 1) {
    throw new Error("Consumer client1 did not see persisted move on sync");
  }

  client1.moves.clickCell(4);
  await new Promise((r) => setTimeout(r, 5000));

  const state1After = client1.getState();
  log(`   Client1 move: cell4=${state1After?.G?.cells?.[4]}, stateID=${state1After?._stateID}`);

  if (state1After?.G?.cells?.[4] !== "1" || state1After?._stateID !== 2) {
    throw new Error("Consumer client1 move failed");
  }
  client1.stop();

  // 5. Client0 reconnects and sees both moves
  const client0reconnect = Client({
    game: TicTacToe,
    numPlayers: 2,
    playerID: "0",
    matchID,
    credentials: cred0,
    multiplayer: SocketIO({ server: BASE_URL, socketOpts: { transports: ["websocket"] } }),
  });
  client0reconnect.start();
  await new Promise((r) => setTimeout(r, 5000));

  const state0reconnect = client0reconnect.getState();
  log(`   Reconnect: cell0=${state0reconnect?.G?.cells?.[0]}, cell4=${state0reconnect?.G?.cells?.[4]}, stateID=${state0reconnect?._stateID}`);

  if (state0reconnect?.G?.cells?.[0] !== "0" || state0reconnect?.G?.cells?.[4] !== "1" || state0reconnect?._stateID !== 2) {
    throw new Error("Consumer reconnect did not see both moves");
  }
  client0reconnect.stop();

  // Cleanup
  await fetch(`${BASE_URL}/e2e/cleanup`, { method: "POST" });
  log("   Consumer smoke passed.");

  return { stateID: state0reconnect._stateID, cells: state0reconnect.G.cells };
}

async function main() {
  let failed = false;
  let consumerUrl;

  try {
    await scaffoldConsumer();
    await installAndConfigureConsumer();
    consumerUrl = await deployConsumer();

    // 6. Smoke test
    await runSmoke(consumerUrl);

    // 7. Redeploy consumer and verify persistence
    log("7. Redeploying consumer and verifying persistence...");
    const redeployUrl = await deployConsumer();
    if (redeployUrl !== consumerUrl) {
      log(`   NOTE: redeploy URL changed: ${consumerUrl} -> ${redeployUrl}`);
    }
    log("   Waiting for redeployed URL to become reachable...");
    await waitForUrl(`${redeployUrl}/health`);

    // Make another match after redeploy to verify the consumer still works
    await runSmoke(redeployUrl);
    log("   Consumer redeploy persistence verified.");

    log("All consumer deployed e2e assertions passed.");
  } catch (err) {
    failed = true;
    log(`FAILED: ${err.message}`);
    console.error(err);
  } finally {
    if (consumerUrl) {
      try {
        await undeployConsumer();
      } catch (err) {
        log(`Undeploy error: ${err.message}`);
      }
    }
    if (existsSync(TEMP_DIR)) {
      rmSync(TEMP_DIR, { recursive: true, force: true });
      log("   Temp dir cleaned up.");
    }
  }

  if (failed) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
