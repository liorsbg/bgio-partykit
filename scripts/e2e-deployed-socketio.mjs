import { readFileSync } from "fs";
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
  throw new Error(
    "DEPLOYED_BASE_URL env var or .deployed-url file required. Run deploy first."
  );
}

function log(msg) {
  console.log(`[e2e-deployed-socketio] ${msg}`);
}

async function createMatch(baseUrl) {
  const res = await fetch(`${baseUrl}/games/tic-tac-toe/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "bgio-partykit-e2e/1.0" },
    body: JSON.stringify({ numPlayers: 2 }),
  });
  if (!res.ok) {
    throw new Error(`Failed to create match: ${res.status}`);
  }
  const data = await res.json();
  return data.matchID;
}

async function joinMatch(baseUrl, matchID, playerID, playerName) {
  const res = await fetch(`${baseUrl}/games/tic-tac-toe/${matchID}/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "bgio-partykit-e2e/1.0" },
    body: JSON.stringify({ playerID, playerName }),
  });
  if (!res.ok) {
    throw new Error(`Failed to join match: ${res.status}`);
  }
  const data = await res.json();
  return data.playerCredentials;
}

async function main() {
  const BASE_URL = getBaseUrl();
  log(`Testing Socket.IO moves on deployed URL: ${BASE_URL}`);

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
    endIf: ({ G, ctx }) => {
      const lines = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
      for (const [a,b,c] of lines) {
        if (G.cells[a] && G.cells[a] === G.cells[b] && G.cells[a] === G.cells[c]) {
          return { winner: G.cells[a] };
        }
      }
      if (G.cells.every(c => c !== null)) return { draw: true };
    },
  };

  const matchID = await createMatch(BASE_URL);
  log(`Created match: ${matchID}`);

  const cred0 = await joinMatch(BASE_URL, matchID, "0", "Alice");
  const cred1 = await joinMatch(BASE_URL, matchID, "1", "Bob");
  log("Joined both players");

  const client0 = Client({
    game: TicTacToe,
    numPlayers: 2,
    playerID: "0",
    matchID,
    credentials: cred0,
    multiplayer: SocketIO({ server: BASE_URL, socketOpts: { transports: ["websocket"] } }),
  });

  const client1 = Client({
    game: TicTacToe,
    numPlayers: 2,
    playerID: "1",
    matchID,
    credentials: cred1,
    multiplayer: SocketIO({ server: BASE_URL, socketOpts: { transports: ["websocket"] } }),
  });

  client0.start();
  client1.start();
  log("Clients started");

  // Wait for sync
  await new Promise(r => setTimeout(r, 3000));

  const state0Before = client0.getState();
  const state1Before = client1.getState();
  log(`Pre-move state0 cell0: ${state0Before?.G?.cells?.[0]}`);
  log(`Pre-move state1 cell0: ${state1Before?.G?.cells?.[0]}`);

  client0.moves.clickCell(0);
  log("Sent move clickCell(0) from client0");

  // Wait for update to propagate
  await new Promise(r => setTimeout(r, 3000));

  const state0After = client0.getState();
  const state1After = client1.getState();
  log(`Post-move state0 cell0: ${state0After?.G?.cells?.[0]}`);
  log(`Post-move state1 cell0: ${state1After?.G?.cells?.[0]}`);

  let failed = false;

  if (state0After?.G?.cells?.[0] !== "0") {
    log(`FAIL: client0 did not see its own move`);
    failed = true;
  }

  if (state1After?.G?.cells?.[0] !== "0") {
    log(`FAIL: client1 did not receive the broadcast update`);
    failed = true;
  }

  if (state0After?._stateID !== state1After?._stateID) {
    log(`FAIL: stateID mismatch between clients: ${state0After?._stateID} vs ${state1After?._stateID}`);
    failed = true;
  }

  client0.stop();
  client1.stop();
  log("Clients stopped");

  if (failed) {
    process.exit(1);
  }

  log("Socket.IO deployed move test PASSED.");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
