import { LobbyClient } from "boardgame.io/dist/esm/client.js";
import { Client } from "boardgame.io/dist/esm/client.js";
import { SocketIO } from "boardgame.io/dist/esm/multiplayer.js";

const BASE_URL = "https://bgio-partykit-e2e-staging.liorsbg.partykit.dev";

function log(msg) {
  console.log(`[debug] ${msg}`);
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
  const client = new LobbyClient({ server: BASE_URL });

  const { matchID } = await client.createMatch("tic-tac-toe", { numPlayers: 2 });
  log(`Created match: ${matchID}`);

  const match = await client.getMatch("tic-tac-toe", matchID);
  log(`getMatch OK: ${match.matchID}`);

  const joined0 = await client.joinMatch("tic-tac-toe", matchID, {
    playerID: "0",
    playerName: "DeployAlice",
  });
  log(`Joined player 0`);

  const joined1 = await client.joinMatch("tic-tac-toe", matchID, {
    playerName: "DeployBob",
  });
  log(`Joined player 1 (auto-assign): ${joined1.playerID}`);

  // Extra lobby ops like comprehensive test
  const { matches } = await client.listMatches("tic-tac-toe");
  log(`listMatches OK: ${matches.length} matches`);

  await client.updatePlayer("tic-tac-toe", matchID, {
    playerID: "0",
    credentials: joined0.playerCredentials,
    newName: "AliceUpdated",
  });
  log(`updatePlayer OK`);

  // Start Socket.IO clients
  const client0 = Client({
    game: TicTacToe,
    numPlayers: 2,
    playerID: "0",
    matchID,
    credentials: joined0.playerCredentials,
    multiplayer: SocketIO({ server: BASE_URL, socketOpts: { transports: ["websocket"] } }),
  });

  const client1 = Client({
    game: TicTacToe,
    numPlayers: 2,
    playerID: "1",
    matchID,
    credentials: joined1.playerCredentials,
    multiplayer: SocketIO({ server: BASE_URL, socketOpts: { transports: ["websocket"] } }),
  });

  client0.start();
  client1.start();

  log("Waiting 10 seconds for sync...");
  await new Promise((r) => setTimeout(r, 10000));

  log(`Pre-move state1 cell0: ${client1.getState()?.G?.cells?.[0]}`);

  client0.moves.clickCell(0);
  log("Sent move clickCell(0) from client0.");

  log("Waiting 5 seconds for update...");
  await new Promise((r) => setTimeout(r, 5000));

  log(`Post-move state0 cell0: ${client0.getState()?.G?.cells?.[0]}, stateID: ${client0.getState()?._stateID}`);
  log(`Post-move state1 cell0: ${client1.getState()?.G?.cells?.[0]}, stateID: ${client1.getState()?._stateID}`);

  client0.stop();
  client1.stop();
}

main().catch(console.error);
