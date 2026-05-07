import { readFileSync } from "fs";
import { LobbyClient } from "boardgame.io/dist/esm/client.js";

const USER_AGENT = "Mozilla/5.0 (compatible; bgio-partykit-e2e/1.0)";

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

async function main() {
  const BASE_URL = getBaseUrl();
  log(`Testing deployed URL: ${BASE_URL}`);

  let failed = false;

  try {
    // 1. Health endpoint
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

    // 2. Static HTML
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

    // 3. Static CSS
    log("3. Checking static CSS...");
    const cssRes = await fetchWithAgent(`${BASE_URL}/demo.css`);
    await assertStatus(cssRes, 200, "Static CSS");
    const cssCt = cssRes.headers.get("content-type") || "";
    if (!cssCt.includes("text/css")) {
      throw new Error(`CSS content-type mismatch: ${cssCt}`);
    }
    log("   Static CSS OK.");

    // 4. Static JS
    log("4. Checking static JS...");
    const jsRes = await fetchWithAgent(`${BASE_URL}/demo.js`);
    await assertStatus(jsRes, 200, "Static JS");
    const jsCt = jsRes.headers.get("content-type") || "";
    if (!jsCt.includes("javascript")) {
      throw new Error(`JS content-type mismatch: ${jsCt}`);
    }
    log("   Static JS OK.");

    // 5. Missing asset returns 404
    log("5. Checking missing asset boundary...");
    const missingRes = await fetchWithAgent(`${BASE_URL}/assets/__missing-bgio-partykit-test__.js`);
    await assertStatus(missingRes, 404, "Missing asset");
    log("   Missing asset returns 404.");

    // 6. Unknown route returns controlled error
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

    // 7. CORS preflight with allowed origin
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

    // 8. CORS preflight with disallowed origin
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

    // 9. Secret/path scanning in assets
    log("9. Scanning assets for secrets and local paths...");
    const assets = [
      { url: `${BASE_URL}/`, type: "html" },
      { url: `${BASE_URL}/demo.css`, type: "css" },
      { url: `${BASE_URL}/demo.js`, type: "js" },
    ];
    const forbiddenPatterns = [
      /CLOUDFLARE_API_TOKEN/,
      /CLOUDFLARE_ACCOUNT_ID/,
      /sk-[a-zA-Z0-9]{20,}/, // API key-like
      /\/Users\/[^/]+/, // macOS local paths
      /localhost:1999/, // hardcoded local URL
      /127\.0\.0\.1:1999/, // hardcoded local URL
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

    // 10. HTTPS requirement
    log("10. Checking HTTPS requirement...");
    if (!BASE_URL.startsWith("https://")) {
      throw new Error("Deployed base URL must use HTTPS");
    }
    log("   HTTPS confirmed.");

    // 11. Lobby CRUD via LobbyClient
    log("11. Checking deployed lobby CRUD...");
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
    log(`   Created match: ${matchID}`);

    const match = await client.getMatch("tic-tac-toe", matchID);
    if (match.matchID !== matchID) {
      throw new Error("getMatch mismatch");
    }
    log("   LobbyClient getMatch OK.");

    const joined = await client.joinMatch("tic-tac-toe", matchID, {
      playerID: "0",
      playerName: "DeployAlice",
    });
    if (!joined.playerCredentials) {
      throw new Error("joinMatch missing credentials");
    }
    log("   LobbyClient joinMatch OK.");

    // Cleanup created match
    log("12. Cleaning up e2e match...");
    try {
      await client.leaveMatch("tic-tac-toe", matchID, {
        playerID: "0",
        credentials: joined.playerCredentials,
      });
      log("   Leave match OK.");
    } catch (err) {
      log(`   Leave match warning: ${err.message}`);
    }

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
