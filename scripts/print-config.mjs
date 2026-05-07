const config = {
  localBaseUrl: "http://127.0.0.1:1999",
  deployedBaseUrl: process.env.DEPLOYED_BASE_URL || null,
  gameNames: ["tic-tac-toe"],
  lobbyRoutePrefix: "/games",
  socketIORouteTemplate: "/socket.io/?EIO=4&transport=websocket",
  demoLegalMoves: [
    { gameName: "tic-tac-toe", moveName: "clickCell", args: [0], playerID: "0" },
    { gameName: "tic-tac-toe", moveName: "clickCell", args: [4], playerID: "1" },
  ],
  allowedOrigins: ["http://127.0.0.1:1999", "http://127.0.0.1:5173"],
  disallowedOrigins: ["https://evil.example.invalid"],
  localPartyKitDevPort: 1999,
  fixtureGames: ["tic-tac-toe"],
  multipleTabsPolicy: "multiple-tabs-allowed",
};

console.log(JSON.stringify(config, null, 2));
