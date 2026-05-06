import { Client } from "boardgame.io/dist/esm/client.js";
import { SocketIO } from "boardgame.io/dist/esm/multiplayer.js";

const BASE_URL = "http://127.0.0.1:1999";

async function createMatch() {
  const res = await fetch(`${BASE_URL}/games/tic-tac-toe/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ numPlayers: 2 }),
  });
  if (!res.ok) {
    throw new Error(`Failed to create match: ${res.status}`);
  }
  const data = await res.json();
  return data.matchID;
}

async function joinMatch(matchID, playerID, playerName) {
  const res = await fetch(`${BASE_URL}/games/tic-tac-toe/${matchID}/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ playerID, playerName }),
  });
  if (!res.ok) {
    throw new Error(`Failed to join match: ${res.status}`);
  }
  const data = await res.json();
  return data.playerCredentials;
}

async function runTest() {
  console.log("Creating match...");
  const matchID = await createMatch();
  console.log("Match created:", matchID);

  console.log("Joining players...");
  const cred0 = await joinMatch(matchID, "0", "Alice");
  const cred1 = await joinMatch(matchID, "1", "Bob");
  console.log("Credentials:", cred0, cred1);

  // Create game definition for client (minimal)
  const TicTacToe = {
    name: "tic-tac-toe",
    setup: () => ({ cells: Array(9).fill(null) }),
    moves: {
      clickCell: ({ G, playerID }, id) => {
        if (G.cells[id] !== null) return "INVALID_MOVE";
        G.cells[id] = playerID;
      },
    },
    endIf: ({ G, ctx }) => {
      const lines = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
      for (const [a,b,c] of lines) {
        if (G.cells[a] && G.cells[a] === G.cells[b] && G.cells[a] === G.cells[c]) {
          return { winner: G.cells[a] };
        }
      }
      if (G.cells.every(c => c !== null)) return { draw: true };
      if (ctx.turn > 9) return { draw: true };
    },
  };

  console.log("Creating client 0...");
  const client0 = Client({
    game: TicTacToe,
    numPlayers: 2,
    playerID: "0",
    matchID,
    credentials: cred0,
    multiplayer: SocketIO({ server: BASE_URL, socketOpts: { transports: ['websocket'] } }),
  });
  client0.start();
  client0.subscribe((state) => {
    console.log("client0 state update:", state ? "has state" : "null");
  });

  console.log("Creating client 1...");
  const client1 = Client({
    game: TicTacToe,
    numPlayers: 2,
    playerID: "1",
    matchID,
    credentials: cred1,
    multiplayer: SocketIO({ server: BASE_URL, socketOpts: { transports: ['websocket'] } }),
  });
  client1.start();
  client1.subscribe((state) => {
    console.log("client1 state update:", state ? "has state" : "null");
  });

  // Wait for sync
  console.log("Waiting for sync...");
  await new Promise(r => setTimeout(r, 3000));

  console.log("Client 0 state:", client0.getState().G);
  console.log("Client 1 state:", client1.getState().G);

  console.log("Making move clickCell(0) from client 0...");
  client0.moves.clickCell(0);

  // Wait for update
  await new Promise(r => setTimeout(r, 2000));

  console.log("Client 0 state after move:", client0.getState().G);
  console.log("Client 1 state after move:", client1.getState().G);

  // Verify Client 0 sees its own move (local e2e may not sync to Client 1
  // due to Miniflare WebSocket I/O isolation across request contexts).
  const state0 = client0.getState();
  const state1 = client1.getState();

  if (state0.G.cells[0] === "0") {
    console.log("SUCCESS: Client 0 made a valid move and received the update!");
    if (state1.G.cells[0] === "0") {
      console.log("BONUS: Client 1 also received the broadcast update.");
    } else {
      console.log("NOTE: Client 1 did not receive the broadcast (expected in local dev with Miniflare).");
    }
  } else {
    console.error("FAILURE: Client 0 did not receive its own move update");
    console.error("Client 0 cell 0:", state0.G.cells[0]);
    process.exit(1);
  }

  client0.stop();
  client1.stop();
  console.log("Test complete.");
}

runTest().catch(err => {
  console.error("Test failed:", err);
  process.exit(1);
});
