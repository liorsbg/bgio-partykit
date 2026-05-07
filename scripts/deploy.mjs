import { spawn } from "child_process";

const SAFE_NAMES = ["e2e", "staging", "test", "dev"];
const DEFAULT_NAME = "bgio-partykit-e2e-staging";

function isSafeName(name) {
  const lower = name.toLowerCase();
  return SAFE_NAMES.some((safe) => lower.includes(safe));
}

function log(msg) {
  console.log(`[deploy] ${msg}`);
}

async function main() {
  const targetName = process.env.DEPLOY_TARGET || DEFAULT_NAME;

  if (!isSafeName(targetName)) {
    log(`ERROR: Deploy target name "${targetName}" is not safe.`);
    log(`Target name must include one of: ${SAFE_NAMES.join(", ")}`);
    log(`Set DEPLOY_TARGET env var to override, or use the default "${DEFAULT_NAME}".`);
    process.exit(1);
  }

  log(`Deploying to safe target: ${targetName}`);

  const child = spawn("npx", ["partykit", "deploy", "--name", targetName], {
    cwd: process.cwd(),
    stdio: "pipe",
    env: { ...process.env, FORCE_COLOR: "0" },
  });

  let deployedUrl = null;

  child.stdout.on("data", (d) => {
    const line = d.toString();
    process.stdout.write(line);
    // Parse deployed URL from output
    const match = line.match(/Deployed .* to (https:\/\/[^\s]+)/);
    if (match) {
      deployedUrl = match[1];
    }
  });

  child.stderr.on("data", (d) => {
    process.stderr.write(d.toString());
  });

  const exitCode = await new Promise((resolve) => {
    child.on("close", resolve);
  });

  if (exitCode !== 0) {
    log("Deploy failed.");
    process.exit(exitCode || 1);
  }

  if (deployedUrl) {
    log(`Deployed URL: ${deployedUrl}`);
    // Write to file for e2e consumption
    const fs = await import("fs");
    fs.writeFileSync(".deployed-url", deployedUrl, "utf-8");
    log("URL saved to .deployed-url");
  } else {
    log("WARNING: Could not parse deployed URL from output.");
  }

  log("Deploy complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
