import { spawn, execSync } from "child_process";
import { LobbyClient } from "boardgame.io/dist/esm/client.js";

const BASE_URL = "http://127.0.0.1:1999";
const TIMEOUT_MS = 15000;
const POLL_INTERVAL_MS = 500;

function log(msg) {
  console.log(`[e2e-lobby-client] ${msg}`);
}

async function waitForHealth(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const out = execSync(`curl -sf "${url}"`, { encoding: "utf-8", timeout: 5000 });
      if (out) return out;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
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

async function cleanup(devProcess) {
  log("Cleaning up...");
  if (devProcess && devProcess.pid) {
    killProcessTree(devProcess.pid);
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
      throw new Error(`Port 1999 is still occupied by PIDs: ${pids.split("\n").join(", ")}`);
    }
  } catch (err) {
    if (err.message.includes("Port 1999 is still occupied")) {
      throw err;
    }
    // lsof returns empty → port is free
  }
  log("Port 1999 is free after cleanup.");
}

async function main() {
  let devProcess;
  let failed = false;

  try {
    // Ensure port is free
    try {
      const pids = execSync("lsof -ti :1999", { encoding: "utf-8" }).trim();
      if (pids) {
        log("Port 1999 was occupied before test. Killing existing processes...");
        execSync("lsof -ti :1999 | xargs kill 2>/dev/null; sleep 1; lsof -ti :1999 | xargs kill -9 2>/dev/null");
      }
    } catch {
      // port is free
    }

    // Start PartyKit dev server
    log("Starting PartyKit dev server on port 1999...");
    devProcess = spawn("pnpm", ["dev"], {
      cwd: process.cwd(),
      detached: false,
      stdio: "pipe",
      env: { ...process.env, FORCE_COLOR: "0" },
    });

    devProcess.stdout.on("data", (d) => {
      const line = d.toString().trim();
      if (line) log(`[dev] ${line}`);
    });
    devProcess.stderr.on("data", (d) => {
      const line = d.toString().trim();
      if (line) log(`[dev:err] ${line}`);
    });

    // Wait for health
    log("Waiting for health endpoint...");
    await waitForHealth(`${BASE_URL}/health`, TIMEOUT_MS);
    log("Health endpoint is up.");

    // Create LobbyClient
    const client = new LobbyClient({ server: BASE_URL });

    // 1. List games
    log("Listing games...");
    const games = await client.listGames();
    log(`Games: ${JSON.stringify(games)}`);
    if (!games.includes("tic-tac-toe")) {
      throw new Error("tic-tac-toe not found in game list");
    }

    // 2. Create match
    log("Creating match...");
    const { matchID } = await client.createMatch("tic-tac-toe", { numPlayers: 2 });
    log(`Created match: ${matchID}`);
    if (!matchID) {
      throw new Error("matchID missing from createMatch response");
    }

    // 3. Get match details
    log("Getting match details...");
    const match = await client.getMatch("tic-tac-toe", matchID);
    log(`Match details: ${JSON.stringify({ matchID: match.matchID, players: match.players })}`);
    if (match.matchID !== matchID) {
      throw new Error("matchID mismatch");
    }
    if (match.players.length !== 2) {
      throw new Error("Expected 2 player slots");
    }

    // 4. Join player 0 without playerID (auto-assign)
    log("Joining player without playerID (auto-assign)...");
    const joined0 = await client.joinMatch("tic-tac-toe", matchID, {
      playerName: "AutoAlice",
    });
    log(`Joined: ${JSON.stringify({ playerID: joined0.playerID, hasCredentials: !!joined0.playerCredentials })}`);
    if (joined0.playerID !== "0") {
      throw new Error(`Expected auto-assigned playerID 0, got ${joined0.playerID}`);
    }
    if (!joined0.playerCredentials) {
      throw new Error("playerCredentials missing");
    }

    // 5. Join player 1
    log("Joining player 1...");
    const joined1 = await client.joinMatch("tic-tac-toe", matchID, {
      playerID: "1",
      playerName: "Bob",
    });
    log(`Joined player 1: ${JSON.stringify({ playerID: joined1.playerID, hasCredentials: !!joined1.playerCredentials })}`);
    if (joined1.playerID !== "1") {
      throw new Error("playerID mismatch for player 1");
    }
    if (!joined1.playerCredentials) {
      throw new Error("playerCredentials missing for player 1");
    }
    if (joined1.playerCredentials === joined0.playerCredentials) {
      throw new Error("Credentials should be distinct per player");
    }

    // 6. List matches and verify players appear
    log("Listing matches...");
    const matchList = await client.listMatches("tic-tac-toe");
    const listedMatch = matchList.matches.find((m) => m.matchID === matchID);
    if (!listedMatch) {
      throw new Error("Match not found in list");
    }
    if (listedMatch.players[0].name !== "AutoAlice" || listedMatch.players[1].name !== "Bob") {
      throw new Error("Player names not reflected in match list");
    }
    log("Match list reflects joined players.");

    // 7. Update player 0 name
    log("Updating player 0 name...");
    await client.updatePlayer("tic-tac-toe", matchID, {
      playerID: "0",
      credentials: joined0.playerCredentials,
      newName: "AliceUpdated",
    });
    log("Update succeeded.");

    // Verify update persisted
    const updatedMatch = await client.getMatch("tic-tac-toe", matchID);
    if (updatedMatch.players[0].name !== "AliceUpdated") {
      throw new Error("Update not persisted in match details");
    }
    log("Update persisted in match details.");

    // 8. Leave player 0
    log("Leaving player 0...");
    await client.leaveMatch("tic-tac-toe", matchID, {
      playerID: "0",
      credentials: joined0.playerCredentials,
    });
    log("Leave succeeded.");

    // Verify seat is freed
    const postLeaveMatch = await client.getMatch("tic-tac-toe", matchID);
    if (postLeaveMatch.players[0].name) {
      throw new Error("Seat should be freed after leave");
    }
    log("Seat freed after leave.");

    // 9. Re-join player 0
    log("Re-joining player 0...");
    const rejoined0 = await client.joinMatch("tic-tac-toe", matchID, {
      playerID: "0",
      playerName: "NewAlice",
    });
    log(`Re-joined: ${JSON.stringify({ playerID: rejoined0.playerID, hasCredentials: !!rejoined0.playerCredentials })}`);
    if (rejoined0.playerCredentials === joined0.playerCredentials) {
      throw new Error("Re-join should return new credentials after leave");
    }

    // 10. Verify old credentials are invalidated
    log("Testing old credentials are invalidated...");
    try {
      await client.updatePlayer("tic-tac-toe", matchID, {
        playerID: "0",
        credentials: joined0.playerCredentials,
        newName: "ShouldFail",
      });
      throw new Error("Old credentials should be rejected");
    } catch (err) {
      if (!err.message.includes("Invalid credentials") && !err.message.includes("HTTP status")) {
        throw err;
      }
      log("Old credentials correctly rejected.");
    }

    log("All LobbyClient e2e assertions passed.");
  } catch (err) {
    failed = true;
    log(`FAILED: ${err.message}`);
    console.error(err);
  } finally {
    await cleanup(devProcess);
    await assertPortFree();
  }

  if (failed) {
    process.exit(1);
  }
}

main();
