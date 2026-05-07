import { readFileSync } from "fs";
import { spawn, execSync } from "child_process";
import { Client } from "boardgame.io/dist/esm/client.js";
import { SocketIO } from "boardgame.io/dist/esm/multiplayer.js";

function getDeployedBaseUrl() {
  if (process.env.DEPLOYED_BASE_URL) {
    return process.env.DEPLOYED_BASE_URL.replace(/\/$/, "");
  }
  try {
    return readFileSync(".deployed-url", "utf-8").trim().replace(/\/$/, "");
  } catch {
    // ignore
  }
  throw new Error("DEPLOYED_BASE_URL env var or .deployed-url file required.");
}

function log(msg) {
  console.log(`[e2e-parity] ${msg}`);
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

async function runSmoke(BASE_URL, label) {
  log(`--- ${label}: ${BASE_URL} ---`);

  // 1. Create match
  const createRes = await fetch(`${BASE_URL}/games/tic-tac-toe/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ numPlayers: 2 }),
  });
  if (!createRes.ok) {
    throw new Error(`${label}: createMatch failed: ${createRes.status}`);
  }
  const { matchID } = await createRes.json();
  log(`  ${label}: Created match: ${matchID}`);

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
  log(`  ${label}: Joined both players.`);

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
  await new Promise((r) => setTimeout(r, 5000));

  client0.moves.clickCell(0);
  await new Promise((r) => setTimeout(r, 5000));

  const state0 = client0.getState();
  log(`  ${label}: Client0 move state: cell0=${state0?.G?.cells?.[0]}, stateID=${state0?._stateID}`);

  if (state0?.G?.cells?.[0] !== "0" || state0?._stateID !== 1) {
    throw new Error(`${label}: Client0 move failed`);
  }
  client0.stop();
  log(`  ${label}: Client0 stopped.`);

  // 4. Client1 connects and sees persisted state, then makes a move
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
  log(`  ${label}: Client1 sync state: cell0=${state1?.G?.cells?.[0]}, stateID=${state1?._stateID}`);

  if (state1?.G?.cells?.[0] !== "0" || state1?._stateID !== 1) {
    throw new Error(`${label}: Client1 did not see persisted move on sync`);
  }

  client1.moves.clickCell(4);
  await new Promise((r) => setTimeout(r, 5000));

  const state1After = client1.getState();
  log(`  ${label}: Client1 move state: cell4=${state1After?.G?.cells?.[4]}, stateID=${state1After?._stateID}`);

  if (state1After?.G?.cells?.[4] !== "1" || state1After?._stateID !== 2) {
    throw new Error(`${label}: Client1 move failed`);
  }
  client1.stop();
  log(`  ${label}: Client1 stopped.`);

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
  log(`  ${label}: Reconnect state: cell0=${state0reconnect?.G?.cells?.[0]}, cell4=${state0reconnect?.G?.cells?.[4]}, stateID=${state0reconnect?._stateID}`);

  if (state0reconnect?.G?.cells?.[0] !== "0" || state0reconnect?.G?.cells?.[4] !== "1" || state0reconnect?._stateID !== 2) {
    throw new Error(`${label}: Reconnect did not see both moves`);
  }
  client0reconnect.stop();
  log(`  ${label}: Reconnect OK.`);

  // Cleanup
  await fetch(`${BASE_URL}/e2e/cleanup`, { method: "POST" });
  log(`  ${label}: Cleanup done.`);

  return {
    matchID,
    stateID: state0reconnect._stateID,
    cells: state0reconnect.G.cells,
  };
}

function startLocalPartyKit() {
  log("Starting local PartyKit dev server...");
  const proc = spawn("pnpm", ["dev"], {
    cwd: process.cwd(),
    detached: false,
    stdio: "pipe",
    env: { ...process.env, FORCE_COLOR: "0" },
  });

  proc.stdout.on("data", (d) => {
    const line = d.toString().trim();
    if (line) log(`[dev] ${line}`);
  });
  proc.stderr.on("data", (d) => {
    const line = d.toString().trim();
    if (line) log(`[dev:err] ${line}`);
  });

  return proc;
}

async function waitForHealth(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status === 200) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw lastErr || new Error(`Health check timed out for ${url}`);
}

function killProcessTree(pid) {
  try {
    const stdout = execSync(`pgrep -P ${pid}`, { encoding: "utf-8" });
    const children = stdout.trim().split("\n").filter(Boolean);
    for (const child of children) {
      killProcessTree(parseInt(child, 10));
    }
  } catch {
    // no children
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // already dead
  }
}

async function cleanupLocal(proc) {
  if (proc && proc.pid) {
    killProcessTree(proc.pid);
  }
  await new Promise((r) => setTimeout(r, 1500));
  try {
    execSync("lsof -ti :1999 | xargs kill -9 2>/dev/null");
  } catch {
    // ignore
  }
  await new Promise((r) => setTimeout(r, 500));
}

async function assertPortFree() {
  try {
    const pids = execSync("lsof -ti :1999", { encoding: "utf-8" }).trim();
    if (pids) {
      throw new Error(`Port 1999 still occupied by: ${pids}`);
    }
  } catch (err) {
    if (err.message.includes("Port 1999 still occupied")) {
      throw err;
    }
    // lsof returns empty → port is free
  }
}

async function main() {
  let failed = false;

  try {
    // ── Local smoke ─────────────────────────────────────────────
    const localProc = startLocalPartyKit();
    await waitForHealth("http://127.0.0.1:1999/health");

    let localResult;
    try {
      localResult = await runSmoke("http://127.0.0.1:1999", "LOCAL");
    } finally {
      await cleanupLocal(localProc);
      await assertPortFree();
    }

    // ── Deployed smoke ──────────────────────────────────────────
    const deployedUrl = getDeployedBaseUrl();
    const deployedResult = await runSmoke(deployedUrl, "DEPLOYED");

    // ── Compare results ─────────────────────────────────────────
    log("--- Comparing local vs deployed results ---");
    if (localResult.stateID !== deployedResult.stateID) {
      throw new Error(`StateID mismatch: local=${localResult.stateID}, deployed=${deployedResult.stateID}`);
    }
    const localCells = JSON.stringify(localResult.cells);
    const deployedCells = JSON.stringify(deployedResult.cells);
    if (localCells !== deployedCells) {
      throw new Error(`Cells mismatch: local=${localCells}, deployed=${deployedCells}`);
    }
    log("  Local and deployed behavior is functionally equivalent.");

    log("All parity assertions passed.");
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
