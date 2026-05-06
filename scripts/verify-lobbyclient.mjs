import { LobbyClient } from "boardgame.io/dist/esm/client.js";

const BASE_URL = process.env.BASE_URL || "http://127.0.0.1:1999";

async function main() {
  const client = new LobbyClient({ server: BASE_URL });

  // 1. listGames
  console.log("[verify] listGames...");
  const games = await client.listGames();
  console.log("[verify] games:", JSON.stringify(games));
  if (!Array.isArray(games) || !games.includes("tic-tac-toe")) {
    throw new Error("listGames did not return expected game names");
  }

  // 2. createMatch
  console.log("[verify] createMatch...");
  const { matchID } = await client.createMatch("tic-tac-toe", { numPlayers: 2 });
  console.log("[verify] matchID:", matchID);
  if (!matchID || typeof matchID !== "string") {
    throw new Error("createMatch did not return valid matchID");
  }

  // 3. listMatches
  console.log("[verify] listMatches...");
  const { matches } = await client.listMatches("tic-tac-toe");
  console.log("[verify] matches count:", matches.length);
  const found = matches.find((m) => m.matchID === matchID);
  if (!found) {
    throw new Error("listMatches did not include the created match");
  }
  if (found.players.length !== 2) {
    throw new Error("listMatches player count mismatch");
  }
  // Ensure no credentials leak
  if (found.players.some((p) => p.credentials !== undefined)) {
    throw new Error("listMatches leaked credentials");
  }

  // 4. getMatch
  console.log("[verify] getMatch...");
  const match = await client.getMatch("tic-tac-toe", matchID);
  console.log("[verify] match details:", JSON.stringify(match, (k, v) => k === "credentials" ? "<REDACTED>" : v));
  if (match.matchID !== matchID) {
    throw new Error("getMatch matchID mismatch");
  }
  if (match.players.length !== 2) {
    throw new Error("getMatch player count mismatch");
  }
  if (match.players.some((p) => p.credentials !== undefined)) {
    throw new Error("getMatch leaked credentials");
  }

  // 5. joinMatch
  console.log("[verify] joinMatch...");
  const joinResult = await client.joinMatch("tic-tac-toe", matchID, {
    playerID: "0",
    playerName: "Alice",
  });
  console.log("[verify] join result playerID:", joinResult.playerID);
  if (joinResult.playerID !== "0") {
    throw new Error("joinMatch playerID mismatch");
  }
  if (!joinResult.playerCredentials) {
    throw new Error("joinMatch did not return credentials");
  }

  // 6. joinMatch auto-assign (no playerID)
  const autoJoinResult = await client.joinMatch("tic-tac-toe", matchID, {
    playerName: "Bob",
  });
  console.log("[verify] auto join result playerID:", autoJoinResult.playerID);
  if (autoJoinResult.playerID !== "1") {
    throw new Error("joinMatch auto-assign did not return expected playerID");
  }

  console.log("[verify] All LobbyClient assertions passed.");
}

main().catch((err) => {
  console.error("[verify] FAILED:", err.message);
  process.exit(1);
});
