import { readFileSync } from "fs";
import { LobbyClient } from "boardgame.io/dist/esm/client.js";
import { Client } from "boardgame.io/dist/esm/client.js";
import { SocketIO } from "boardgame.io/dist/esm/multiplayer.js";

const USER_AGENT = "Mozilla/5.0 (compatible; bgio-partykit-e2e/1.0)";

function getBaseUrl() {
  if (process.env.DEPLOYED_BASE_URL) {
    return process.env.DEPLOYED_BASE_URL.replace(/\/$/, "");
  }
  if (process.env.BASE_URL) {
    return process.env.BASE_URL.replace(/\/$/, "");
  }
  try {
    return readFileSync(".deployed-url", "utf-8").trim().replace(/\/$/, "");
  } catch {
    // ignore
  }
  throw new Error(
    "DEPLOYED_BASE_URL, BASE_URL env var or .deployed-url file required. Run deploy first."
  );
}

function log(msg) {
  console.log(`[e2e-deployed] ${msg}`);
}

async function fetchWithAgent(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      "User-Agent": USER_AGENT,
      ...(options.headers || {}),
    },
  });
  return res;
}

async function assertStatus(res, expected, msg) {
  if (res.status !== expected) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `${msg}: expected ${expected}, got ${res.status}. Body: ${body.slice(0, 200)}`
    );
  }
}

function simpleHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return h.toString(16);
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

async function waitForClientState(client, predicate, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    let unsub;
    const timer = setTimeout(() => {
      if (unsub) unsub();
      reject(new Error("Timeout waiting for client state"));
    }, timeoutMs);
    unsub = client.subscribe((state) => {
      if (state && predicate(state)) {
        clearTimeout(timer);
        if (unsub) unsub();
        resolve(state);
      }
    });
  });
}

async function main() {
  const BASE_URL = getBaseUrl();
  log(`Testing deployed URL: ${BASE_URL}`);

  let failed = false;
  const createdMatches = [];

  try {
    // ── 1. Health endpoint ──────────────────────────────────────
    log("1. Checking health endpoint...");
    const healthRes = await fetchWithAgent(`${BASE_URL}/health`);
    await assertStatus(healthRes, 200, "Health endpoint");
    const healthBody = await healthRes.json();
    if (healthBody.service !== "bgio-partykit") {
      throw new Error(`Unexpected service: ${healthBody.service}`);
    }
    if (healthBody.status !== "ok") {
      throw new Error(`Unexpected status: ${healthBody.status}`);
    }
    if (!Array.isArray(healthBody.games) || !healthBody.games.includes("tic-tac-toe")) {
      throw new Error(`Games missing or incorrect: ${JSON.stringify(healthBody.games)}`);
    }
    log("   Health OK.");

    // ── 2. Static HTML ──────────────────────────────────────────
    log("2. Checking static HTML...");
    const htmlRes = await fetchWithAgent(`${BASE_URL}/`);
    await assertStatus(htmlRes, 200, "Static HTML");
    const ct = htmlRes.headers.get("content-type") || "";
    if (!ct.includes("text/html")) {
      throw new Error(`HTML content-type mismatch: ${ct}`);
    }
    const htmlBody = await htmlRes.text();
    if (!htmlBody.includes("bgio-partykit")) {
      throw new Error("Static HTML missing bgio-partykit marker");
    }
    log("   Static HTML OK.");

    // ── 3. Static CSS ───────────────────────────────────────────
    log("3. Checking static CSS...");
    const cssRes = await fetchWithAgent(`${BASE_URL}/demo.css`);
    await assertStatus(cssRes, 200, "Static CSS");
    const cssCt = cssRes.headers.get("content-type") || "";
    if (!cssCt.includes("text/css")) {
      throw new Error(`CSS content-type mismatch: ${cssCt}`);
    }
    log("   Static CSS OK.");

    // ── 4. Static JS ────────────────────────────────────────────
    log("4. Checking static JS...");
    const jsRes = await fetchWithAgent(`${BASE_URL}/demo.js`);
    await assertStatus(jsRes, 200, "Static JS");
    const jsCt = jsRes.headers.get("content-type") || "";
    if (!jsCt.includes("javascript")) {
      throw new Error(`JS content-type mismatch: ${jsCt}`);
    }
    log("   Static JS OK.");

    // ── 5. Missing asset returns 404 ────────────────────────────
    log("5. Checking missing asset boundary...");
    const missingRes = await fetchWithAgent(`${BASE_URL}/assets/__missing-bgio-partykit-test__.js`);
    await assertStatus(missingRes, 404, "Missing asset");
    log("   Missing asset returns 404.");

    // ── 6. Unknown route returns controlled error ───────────────
    log("6. Checking unknown route...");
    const unknownRes = await fetchWithAgent(`${BASE_URL}/__unknown__`, { method: "POST" });
    if (unknownRes.status !== 404 && unknownRes.status !== 405) {
      throw new Error(`Unknown route expected 404 or 405, got ${unknownRes.status}`);
    }
    const unknownBody = await unknownRes.json().catch(() => ({}));
    if (!unknownBody.error) {
      throw new Error("Unknown route missing error field in body");
    }
    log(`   Unknown route returns ${unknownRes.status} with error body.`);

    // ── 7. CORS preflight with allowed origin ───────────────────
    log("7. Checking CORS allowed origin...");
    const corsAllowedRes = await fetchWithAgent(`${BASE_URL}/games`, {
      method: "OPTIONS",
      headers: {
        Origin: "http://127.0.0.1:1999",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "Content-Type",
      },
    });
    if (corsAllowedRes.status !== 200 && corsAllowedRes.status !== 204) {
      throw new Error(`CORS preflight expected 200/204, got ${corsAllowedRes.status}`);
    }
    const allowedOrigin = corsAllowedRes.headers.get("access-control-allow-origin");
    if (!allowedOrigin) {
      throw new Error("CORS preflight missing Access-Control-Allow-Origin for allowed origin");
    }
    log("   CORS allowed origin OK.");

    // ── 8. CORS preflight with disallowed origin ────────────────
    log("8. Checking CORS disallowed origin...");
    const corsDisallowedRes = await fetchWithAgent(`${BASE_URL}/games`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://evil.example.invalid",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "Content-Type",
      },
    });
    const disallowedOrigin = corsDisallowedRes.headers.get("access-control-allow-origin");
    if (disallowedOrigin === "https://evil.example.invalid") {
      throw new Error("CORS preflight should not allow evil.example.invalid");
    }
    log("   CORS disallowed origin OK.");

    // ── 9. Secret/path scanning in assets ───────────────────────
    log("9. Scanning assets for secrets and local paths...");
    const assets = [
      { url: `${BASE_URL}/`, type: "html" },
      { url: `${BASE_URL}/demo.css`, type: "css" },
      { url: `${BASE_URL}/demo.js`, type: "js" },
    ];
    const forbiddenPatterns = [
      /CLOUDFLARE_API_TOKEN/,
      /CLOUDFLARE_ACCOUNT_ID/,
      /sk-[a-zA-Z0-9]{20,}/,
      /\/Users\/[^/]+/,
      /localhost:1999/,
      /127\.0\.0\.1:1999/,
    ];
    for (const asset of assets) {
      const res = await fetchWithAgent(asset.url);
      const text = await res.text();
      for (const pattern of forbiddenPatterns) {
        if (pattern.test(text)) {
          const match = text.match(pattern);
          throw new Error(`Asset ${asset.url} contains forbidden pattern ${pattern}: ${match[0].slice(0, 50)}`);
        }
      }
    }
    log("   No secrets or local paths found in assets.");

    // ── 10. HTTPS requirement ───────────────────────────────────
    log("10. Checking HTTPS requirement...");
    if (!BASE_URL.startsWith("https://")) {
      throw new Error("Deployed base URL must use HTTPS");
    }
    log("   HTTPS confirmed.");

    // ── 11. Full LobbyClient CRUD ───────────────────────────────
    log("11. Checking deployed lobby CRUD via LobbyClient...");
    const client = new LobbyClient({ server: BASE_URL });

    const games = await client.listGames();
    if (!games.includes("tic-tac-toe")) {
      throw new Error("tic-tac-toe not in game list");
    }
    log("   LobbyClient listGames OK.");

    const { matchID } = await client.createMatch("tic-tac-toe", { numPlayers: 2 });
    if (!matchID) {
      throw new Error("createMatch did not return matchID");
    }
    createdMatches.push(matchID);
    log(`   Created match: ${matchID}`);

    const match = await client.getMatch("tic-tac-toe", matchID);
    if (match.matchID !== matchID) {
      throw new Error("getMatch mismatch");
    }
    if (match.players.length !== 2) {
      throw new Error("getMatch player count mismatch");
    }
    // Ensure no credentials leak
    if (match.players.some((p) => p.credentials !== undefined)) {
      throw new Error("getMatch leaked credentials");
    }
    log("   LobbyClient getMatch OK.");

    // Join player 0
    const joined0 = await client.joinMatch("tic-tac-toe", matchID, {
      playerID: "0",
      playerName: "DeployAlice",
    });
    if (!joined0.playerCredentials) {
      throw new Error("joinMatch missing credentials");
    }
    log(`   Joined player 0, credentialHash: ${simpleHash(joined0.playerCredentials)}`);

    // Join player 1 via auto-assign
    const joined1 = await client.joinMatch("tic-tac-toe", matchID, {
      playerName: "DeployBob",
    });
    if (joined1.playerID !== "1") {
      throw new Error(`Expected auto-assigned playerID 1, got ${joined1.playerID}`);
    }
    if (!joined1.playerCredentials) {
      throw new Error("joinMatch auto-assign missing credentials");
    }
    log(`   Joined player 1 (auto-assign), credentialHash: ${simpleHash(joined1.playerCredentials)}`);

    // List matches and verify
    const { matches } = await client.listMatches("tic-tac-toe");
    const listed = matches.find((m) => m.matchID === matchID);
    if (!listed) {
      throw new Error("listMatches did not include created match");
    }
    if (listed.players[0].name !== "DeployAlice" || listed.players[1].name !== "DeployBob") {
      throw new Error("listMatches player names mismatch");
    }
    if (listed.players.some((p) => p.credentials !== undefined)) {
      throw new Error("listMatches leaked credentials");
    }
    log("   LobbyClient listMatches OK.");

    // Update player 0 name
    await client.updatePlayer("tic-tac-toe", matchID, {
      playerID: "0",
      credentials: joined0.playerCredentials,
      newName: "AliceUpdated",
    });
    const updatedMatch = await client.getMatch("tic-tac-toe", matchID);
    if (updatedMatch.players[0].name !== "AliceUpdated") {
      throw new Error("updatePlayer not persisted");
    }
    log("   LobbyClient updatePlayer OK.");

    // ── 12. Socket.IO moves, persistence, and reconnect ─────────
    log("12. Checking deployed Socket.IO moves, persistence, and reconnect...");

    // Connect client0 and make a move
    const client0 = Client({
      game: TicTacToe,
      numPlayers: 2,
      playerID: "0",
      matchID,
      credentials: joined0.playerCredentials,
      multiplayer: SocketIO({ server: BASE_URL, socketOpts: { transports: ["websocket"] } }),
    });
    client0.start();
    log("   Client0 started.");
    await new Promise((r) => setTimeout(r, 5000));

    const state0Before = client0.getState();
    log(`   Pre-move state0 cell0: ${state0Before?.G?.cells?.[0]}`);

    client0.moves.clickCell(0);
    log("   Sent move clickCell(0) from client0.");
    await new Promise((r) => setTimeout(r, 5000));

    const state0After = client0.getState();
    log(`   Post-move state0 cell0: ${state0After?.G?.cells?.[0]}, stateID: ${state0After?._stateID}`);

    if (state0After?.G?.cells?.[0] !== "0") {
      throw new Error("client0 did not see its own move");
    }
    if (state0After?._stateID !== 1) {
      throw new Error(`client0 stateID should be 1, got ${state0After?._stateID}`);
    }

    // Disconnect client0
    client0.stop();
    log("   Client0 stopped (disconnected).");
    await new Promise((r) => setTimeout(r, 2000));

    // Connect client1 and make a move (verifies persistence from client0's move)
    const client1 = Client({
      game: TicTacToe,
      numPlayers: 2,
      playerID: "1",
      matchID,
      credentials: joined1.playerCredentials,
      multiplayer: SocketIO({ server: BASE_URL, socketOpts: { transports: ["websocket"] } }),
    });
    client1.start();
    log("   Client1 started.");
    await new Promise((r) => setTimeout(r, 5000));

    const state1After = client1.getState();
    log(`   Client1 sync cell0: ${state1After?.G?.cells?.[0]}, stateID: ${state1After?._stateID}`);

    if (state1After?.G?.cells?.[0] !== "0") {
      throw new Error("client1 did not see persisted move from client0 on sync");
    }
    if (state1After?._stateID !== 1) {
      throw new Error(`client1 stateID should be 1 after sync, got ${state1After?._stateID}`);
    }

    client1.moves.clickCell(4);
    log("   Sent move clickCell(4) from client1.");
    await new Promise((r) => setTimeout(r, 5000));

    const state1After2 = client1.getState();
    log(`   After client1 move cell4: ${state1After2?.G?.cells?.[4]}, stateID: ${state1After2?._stateID}`);

    if (state1After2?.G?.cells?.[4] !== "1") {
      throw new Error("client1 did not see its own move");
    }
    if (state1After2?._stateID !== 2) {
      throw new Error(`client1 stateID should be 2, got ${state1After2?._stateID}`);
    }

    // Disconnect client1
    client1.stop();
    log("   Client1 stopped (disconnected).");
    await new Promise((r) => setTimeout(r, 2000));

    // ── 13. Reconnect to persisted state ────────────────────────
    log("13. Checking reconnect to persisted state...");

    // Reconnect client0 — should see both moves persisted
    const client0reconnect = Client({
      game: TicTacToe,
      numPlayers: 2,
      playerID: "0",
      matchID,
      credentials: joined0.playerCredentials,
      multiplayer: SocketIO({ server: BASE_URL, socketOpts: { transports: ["websocket"] } }),
    });
    client0reconnect.start();
    log("   Client0 reconnected.");

    await new Promise((r) => setTimeout(r, 5000));

    const state0Reconnect = client0reconnect.getState();
    log(`   Reconnected state0 cell0: ${state0Reconnect?.G?.cells?.[0]}, cell4: ${state0Reconnect?.G?.cells?.[4]}, stateID: ${state0Reconnect?._stateID}`);

    if (state0Reconnect?.G?.cells?.[0] !== "0") {
      throw new Error("reconnected client0 lost first move");
    }
    if (state0Reconnect?.G?.cells?.[4] !== "1") {
      throw new Error("reconnected client0 did not see client1's move");
    }
    if (state0Reconnect?._stateID !== 2) {
      throw new Error(`reconnect stateID should be 2, got ${state0Reconnect?._stateID}`);
    }
    log("   Reconnect to persisted state OK.");

    client0reconnect.stop();
    log("   All clients stopped.");

    // ── 14. E2E cleanup ─────────────────────────────────────────
    log("14. Cleaning up e2e matches...");

    // Leave all players from created matches
    for (const mid of createdMatches) {
      try {
        const m = await client.getMatch("tic-tac-toe", mid);
        for (const p of m.players) {
          if (p.name && p.name.startsWith("Deploy")) {
            // We don't have credentials for these; try cleanup endpoint
            break;
          }
        }
      } catch {
        // ignore
      }
    }

    // Try global cleanup endpoint
    const cleanupRes = await fetchWithAgent(`${BASE_URL}/e2e/cleanup`, { method: "POST" });
    if (cleanupRes.status === 200) {
      const cleanupBody = await cleanupRes.json().catch(() => ({}));
      log(`   Cleanup endpoint responded: ${JSON.stringify(cleanupBody)}`);
    } else {
      log(`   Cleanup endpoint returned ${cleanupRes.status} (may not be available in prod).`);
    }

    // Verify match is gone or unjoinable
    for (const mid of createdMatches) {
      try {
        await client.leaveMatch("tic-tac-toe", mid, {
          playerID: "0",
          credentials: joined0.playerCredentials,
        });
      } catch (err) {
        // May fail if already cleaned up — that's OK
        log(`   Leave match ${mid.slice(0, 8)}... result: ${err.message}`);
      }
      try {
        await client.leaveMatch("tic-tac-toe", mid, {
          playerID: "1",
          credentials: joined1.playerCredentials,
        });
      } catch (err) {
        log(`   Leave match ${mid.slice(0, 8)}... result: ${err.message}`);
      }
    }

    log("   Cleanup attempted.");

    log("All deployed e2e assertions passed.");
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
