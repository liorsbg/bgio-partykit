import { spawn, execSync } from "child_process";

const BASE_URL = "http://127.0.0.1:1999";
const HEALTH_URL = `${BASE_URL}/health`;
const TIMEOUT_MS = 15000;
const POLL_INTERVAL_MS = 500;

function log(msg) {
  console.log(`[e2e-local] ${msg}`);
}

function runCurl(args) {
  return execSync(`curl -s -i ${args}`, { encoding: "utf-8", timeout: 10000 });
}

function assertContains(haystack, needle, msg) {
  if (!haystack.includes(needle)) {
    throw new Error(`Assertion failed: ${msg}. Expected to contain: ${needle}`);
  }
}

function assertStatus(response, expectedStatus, msg) {
  const statusLine = response.split("\r\n")[0];
  const code = parseInt(statusLine.split(" ")[1], 10);
  if (code !== expectedStatus) {
    throw new Error(
      `Assertion failed: ${msg}. Expected status ${expectedStatus}, got ${code}`
    );
  }
}

async function waitForHealth(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const out = runCurl(`-sf "${url}"`);
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
      throw new Error(
        `Port 1999 is still occupied by PIDs: ${pids.split("\n").join(", ")}`
      );
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
    // 1. Verify port is free before starting
    try {
      const pids = execSync("lsof -ti :1999", { encoding: "utf-8" }).trim();
      if (pids) {
        log("Port 1999 was occupied before test. Killing existing processes...");
        execSync("lsof -ti :1999 | xargs kill 2>/dev/null; sleep 1; lsof -ti :1999 | xargs kill -9 2>/dev/null");
      }
    } catch {
      // port is free
    }

    // 2. Verify print-config output
    log("Running e2e:print-config...");
    const configRaw = execSync("node scripts/print-config.mjs", {
      encoding: "utf-8",
      cwd: process.cwd(),
    });
    const config = JSON.parse(configRaw);
    if (config.localBaseUrl !== "http://127.0.0.1:1999") {
      throw new Error(
        `print-config localBaseUrl mismatch: ${config.localBaseUrl}`
      );
    }
    if (!Array.isArray(config.gameNames) || config.gameNames.length === 0) {
      throw new Error("print-config gameNames missing or empty");
    }
    log("print-config output is valid.");

    // 3. Start PartyKit dev server
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

    // 4. Wait for health endpoint
    log("Waiting for health endpoint...");
    const healthBody = await waitForHealth(HEALTH_URL, TIMEOUT_MS);
    log("Health endpoint is up.");

    // 5. Verify health response
    assertContains(healthBody, '"service":"bgio-partykit"', "health service identity");
    assertContains(healthBody, '"status":"ok"', "health status");
    assertContains(healthBody, '"games"', "health games field");
    log("Health endpoint returns correct service identity.");

    // 6. Verify static HTML
    log("Checking static HTML...");
    const htmlRes = runCurl(`"${BASE_URL}/"`);
    assertStatus(htmlRes, 200, "static HTML");
    assertContains(htmlRes, "text/html", "static HTML content-type");
    assertContains(htmlRes, "bgio-partykit", "static HTML body marker");
    log("Static HTML is reachable.");

    // 7. Verify static CSS
    log("Checking static CSS...");
    const cssRes = runCurl(`"${BASE_URL}/demo.css"`);
    assertStatus(cssRes, 200, "static CSS");
    assertContains(cssRes, "text/css", "static CSS content-type");
    log("Static CSS is reachable.");

    // 8. Verify static JS
    log("Checking static JS...");
    const jsRes = runCurl(`"${BASE_URL}/demo.js"`);
    assertStatus(jsRes, 200, "static JS");
    assertContains(jsRes, "javascript", "static JS content-type");
    log("Static JS is reachable.");

    // 9. Verify missing asset returns 404
    log("Checking missing asset boundary...");
    const missingRes = runCurl(`"${BASE_URL}/assets/__missing-bgio-partykit-test__.js"`);
    assertStatus(missingRes, 404, "missing asset");
    log("Missing asset returns 404.");

    // 10. Verify unknown route returns controlled error
    log("Checking unknown route...");
    const unknownRes = runCurl(`-X POST "${BASE_URL}/__unknown__"`);
    const unknownStatus = parseInt(unknownRes.split("\r\n")[0].split(" ")[1], 10);
    if (unknownStatus !== 404 && unknownStatus !== 405) {
      throw new Error(
        `Unknown route expected 404 or 405, got ${unknownStatus}`
      );
    }
    log(`Unknown route returns ${unknownStatus}.`);

    log("All local e2e assertions passed.");
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
