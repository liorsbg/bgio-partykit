#!/usr/bin/env node

/**
 * create-bgio-partykit — Scaffold a new boardgame.io game project
 * for PartyKit with Socket.IO transport.
 *
 * Usage:
 *   pnpm create bgio-partykit [target-dir]
 *   pnpm dlx create-bgio-partykit [target-dir]
 *
 * Interactive prompts guide the user through:
 *   1. Project name (defaults to target directory name)
 *   2. Game name (defaults to project name)
 *   3. Number of players (default 2)
 *   4. Confirm summary
 *
 * Then it:
 *   - Copies bundled templates with variable substitution
 *   - Runs pnpm install
 *   - Runs git init
 *   - Prints next steps
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as cp from "node:child_process";
import * as clack from "@clack/prompts";
import { getTemplates, type TemplateVars } from "./templates/index.js";

// ── Helpers ─────────────────────────────────────────────────────

function toKebabCase(name: string): string {
  return name
    .trim()
    .replace(/[^a-zA-Z0-9]+(.)/g, (_, c: string) => `-${c}`)
    .replace(/^[^a-zA-Z]+/, "")
    .replace(/[^a-zA-Z0-9]+$/, "")
    .toLowerCase();
}

function isValidNpmName(name: string): boolean {
  // Simplified npm package name validation
  return /^[a-z][a-z0-9_-]*$/.test(name) && name.length <= 214;
}

function run(cmd: string, args: string[], cwd: string): number {
  const result = cp.spawnSync(cmd, args, {
    cwd,
    stdio: "inherit",
    shell: true,
  });
  return result.status ?? 1;
}

function getBgioPartykitVersion(): string {
  // Try to read version from the parent bgio-partykit package
  try {
    const parentPkgPath = path.resolve(
      import.meta.dirname ?? __dirname,
      "..",
      "..",
      "..",
      "package.json",
    );
    if (fs.existsSync(parentPkgPath)) {
      const parentPkg = JSON.parse(
        fs.readFileSync(parentPkgPath, "utf-8"),
      );
      if (parentPkg.name === "bgio-partykit" && parentPkg.version) {
        return `^${parentPkg.version}`;
      }
    }
  } catch {
    // Ignore — fall through to default
  }
  // Published fallback
  return "^0.1.0";
}

// ── Main ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argTarget = process.argv[2]?.trim();
  const isInteractive = process.stdin.isTTY && !process.env.CI;

  if (!isInteractive) {
    // Non-interactive mode: use defaults and scaffold directly
    const targetDir = argTarget
      ? path.resolve(argTarget)
      : path.resolve("my-bgio-game");
    const projectName = toKebabCase(
      argTarget ? path.basename(path.resolve(argTarget)) : "my-bgio-game",
    );
    const gameName = projectName;
    const numPlayers = 2;

    await scaffold({ targetDir, projectName, gameName, numPlayers });
    return;
  }

  clack.intro("create-bgio-partykit");

  // 1. Project name
  const defaultName = argTarget
    ? path.basename(path.resolve(argTarget))
    : "my-bgio-game";

  const projectNameRaw = await clack.text({
    message: "Project name",
    placeholder: defaultName,
    initialValue: defaultName,
  });

  if (clack.isCancel(projectNameRaw)) {
    clack.cancel("Cancelled.");
    process.exit(1);
  }

  const projectName = toKebabCase(String(projectNameRaw) || defaultName);

  if (!isValidNpmName(projectName)) {
    clack.outro(
      `Invalid project name: "${projectName}". Use lowercase letters, numbers, hyphens, and underscores.`,
    );
    process.exit(1);
  }

  // 2. Game name
  const gameNameRaw = await clack.text({
    message: "Game name (boardgame.io game identifier)",
    placeholder: projectName,
    initialValue: projectName,
  });

  if (clack.isCancel(gameNameRaw)) {
    clack.cancel("Cancelled.");
    process.exit(1);
  }

  const gameName =
    toKebabCase(String(gameNameRaw) || projectName) || projectName;

  // 3. Number of players
  const numPlayersRaw = await clack.text({
    message: "Number of players",
    placeholder: "2",
    initialValue: "2",
  });

  if (clack.isCancel(numPlayersRaw)) {
    clack.cancel("Cancelled.");
    process.exit(1);
  }

  const numPlayers = parseInt(String(numPlayersRaw), 10);
  if (isNaN(numPlayers) || numPlayers < 1 || numPlayers > 99) {
    clack.outro(
      `Invalid number of players: "${numPlayersRaw}". Must be an integer between 1 and 99.`,
    );
    process.exit(1);
  }

  // 4. Confirm
  const confirmed = await clack.confirm({
    message: `Scaffold "${projectName}" with game "${gameName}" for ${numPlayers} player(s)?`,
    initialValue: true,
  });

  if (clack.isCancel(confirmed) || !confirmed) {
    clack.cancel("Cancelled.");
    process.exit(1);
  }

  // ── Scaffold ────────────────────────────────────────────────────

  const targetDir = argTarget
    ? path.resolve(argTarget)
    : path.resolve(projectName);

  await scaffold({ targetDir, projectName, gameName, numPlayers });
}

interface ScaffoldOptions {
  targetDir: string;
  projectName: string;
  gameName: string;
  numPlayers: number;
}

async function scaffold(options: ScaffoldOptions): Promise<void> {
  const { targetDir, projectName, gameName, numPlayers } = options;

  if (fs.existsSync(targetDir)) {
    const entries = fs.readdirSync(targetDir);
    if (entries.length > 0) {
      const msg = `Directory "${targetDir}" already exists and is not empty. Aborting.`;
      if (process.stdin.isTTY && !process.env.CI) {
        clack.outro(msg);
      } else {
        console.error(msg);
      }
      process.exit(1);
    }
  }

  const bgioPkVersion = getBgioPartykitVersion();

  const vars: TemplateVars = {
    projectName,
    gameName,
    numPlayers,
    bgioPkVersion,
  };

  // Generate template files
  const templates = getTemplates(vars);

  // Create target directory and write files
  fs.mkdirSync(targetDir, { recursive: true });

  const s =
    process.stdin.isTTY && !process.env.CI
      ? clack.spinner()
      : null;

  s?.start("Scaffolding project files");

  for (const { path: filePath, content } of templates) {
    const fullPath = path.join(targetDir, filePath);
    const dir = path.dirname(fullPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fullPath, content(vars), "utf-8");
  }

  s?.stop("Project files created");

  // ── pnpm install ────────────────────────────────────────────────

  s?.start("Installing dependencies");

  const installExit = run("pnpm", ["install"], targetDir);

  if (installExit !== 0) {
    s?.stop("pnpm install failed (you can run it manually)");
  } else {
    s?.stop("Dependencies installed");
  }

  // ── git init ────────────────────────────────────────────────────

  s?.start("Initializing git repository");

  const gitExit = run("git", ["init"], targetDir);

  if (gitExit !== 0) {
    s?.stop("git init failed (you can run it manually)");
  } else {
    s?.stop("Git repository initialized");
  }

  // ── Next steps ──────────────────────────────────────────────────

  const relativeDir = path.relative(process.cwd(), targetDir) || targetDir;
  const nextSteps = [
    `cd ${relativeDir}`,
    "pnpm dev         # Start local dev server on http://127.0.0.1:1999",
    "pnpm typecheck   # Type check your project",
    "pnpm deploy      # Deploy to PartyKit",
    "",
    "Edit src/game.ts to customize your game logic.",
    "Edit src/server.ts to add more games or configure origins.",
  ].join("\n");

  if (process.stdin.isTTY && !process.env.CI) {
    clack.note(nextSteps, "Next steps");
    clack.outro(`${projectName} is ready! 🎮`);
  } else {
    console.log("\nNext steps:\n");
    console.log(nextSteps);
    console.log(`\n${projectName} is ready! 🎮`);
  }
}

main().catch((err) => {
  const msg = `Error: ${err instanceof Error ? err.message : String(err)}`;
  if (process.stdin.isTTY && !process.env.CI) {
    clack.outro(msg);
  } else {
    console.error(msg);
  }
  process.exit(1);
});
