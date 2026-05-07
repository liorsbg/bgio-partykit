/**
 * Tests for the create-bgio-partykit CLI scaffold logic.
 *
 * These tests validate:
 * - Template variable substitution
 * - Generated file structure and content
 * - End-to-end scaffolding (typecheck) of generated projects
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as cp from "node:child_process";
import { getTemplates, type TemplateVars } from "../src/templates/index.js";

const TEST_VARS: TemplateVars = {
  projectName: "test-game",
  gameName: "test-game",
  numPlayers: 2,
  bgioPkVersion: "^0.0.1",
};

describe("Template generation", () => {
  it("generates all expected template files", () => {
    const templates = getTemplates(TEST_VARS);
    const paths = templates.map((t) => t.path).sort();

    expect(paths).toContain("package.json");
    expect(paths).toContain("partykit.json");
    expect(paths).toContain("tsconfig.json");
    expect(paths).toContain("src/server.ts");
    expect(paths).toContain("src/game.ts");
    expect(paths).toContain("patches/capnp-ts@0.7.0.patch");
    expect(paths).toContain(".gitignore");
  });

  it("substitutes all template variables without leaving placeholders", () => {
    const templates = getTemplates(TEST_VARS);

    for (const { path: filePath, content } of templates) {
      const output = content(TEST_VARS);
      expect(output, `Unresolved variable in ${filePath}`).not.toMatch(
        /\{\{PROJECT_NAME\}\}/,
      );
      expect(output, `Unresolved variable in ${filePath}`).not.toMatch(
        /\{\{GAME_NAME\}\}/,
      );
      expect(output, `Unresolved variable in ${filePath}`).not.toMatch(
        /\{\{GAME_NAME_PASCAL\}\}/,
      );
      expect(output, `Unresolved variable in ${filePath}`).not.toMatch(
        /\{\{NUM_PLAYERS\}\}/,
      );
      expect(output, `Unresolved variable in ${filePath}`).not.toMatch(
        /\{\{BGIO_PK_VERSION\}\}/,
      );
    }
  });

  it("uses the correct project name in package.json", () => {
    const templates = getTemplates(TEST_VARS);
    const pkg = templates.find((t) => t.path === "package.json")!;
    const output = pkg.content(TEST_VARS);
    const parsed = JSON.parse(output);

    expect(parsed.name).toBe("test-game");
  });

  it("uses the correct project name in partykit.json", () => {
    const templates = getTemplates(TEST_VARS);
    const pk = templates.find((t) => t.path === "partykit.json")!;
    const output = pk.content(TEST_VARS);
    const parsed = JSON.parse(output);

    expect(parsed.name).toBe("test-game");
  });

  it("uses the correct game name in src/server.ts", () => {
    const templates = getTemplates(TEST_VARS);
    const server = templates.find((t) => t.path === "src/server.ts")!;
    const output = server.content(TEST_VARS);

    expect(output).toContain("TestGame");
    expect(output).toContain("registerGame(TestGame)");
  });

  it("uses the correct player count in game definition", () => {
    const templates = getTemplates(TEST_VARS);
    const game = templates.find((t) => t.path === "src/game.ts")!;
    const output = game.content(TEST_VARS);

    expect(output).toContain("minPlayers: 2");
    expect(output).toContain("maxPlayers: 2");
  });

  it("uses the bgio-partykit version in package.json", () => {
    const templates = getTemplates(TEST_VARS);
    const pkg = templates.find((t) => t.path === "package.json")!;
    const output = pkg.content(TEST_VARS);
    const parsed = JSON.parse(output);

    expect(parsed.dependencies["bgio-partykit"]).toBe("^0.0.1");
  });

  it("generates PascalCase state type name from kebab-case game name", () => {
    const vars: TemplateVars = {
      projectName: "my-cool-game",
      gameName: "my-cool-game",
      numPlayers: 4,
      bgioPkVersion: "^0.0.1",
    };
    const templates = getTemplates(vars);
    const game = templates.find((t) => t.path === "src/game.ts")!;
    const output = game.content(vars);

    expect(output).toContain("MyCoolGameState");
    expect(output).toContain("MyCoolGame");
  });

  it("generates correct player count for different values", () => {
    const vars: TemplateVars = {
      ...TEST_VARS,
      numPlayers: 4,
    };
    const templates = getTemplates(vars);
    const game = templates.find((t) => t.path === "src/game.ts")!;
    const output = game.content(vars);

    expect(output).toContain("minPlayers: 4");
    expect(output).toContain("maxPlayers: 4");
  });

  it("includes PartyKit parties configuration in partykit.json", () => {
    const templates = getTemplates(TEST_VARS);
    const pk = templates.find((t) => t.path === "partykit.json")!;
    const output = pk.content(TEST_VARS);
    const parsed = JSON.parse(output);

    expect(parsed.parties).toHaveProperty("lobby");
    expect(parsed.parties).toHaveProperty("match");
    expect(parsed.parties.lobby).toBe("src/server.ts");
    expect(parsed.parties.match).toBe("src/server.ts");
  });

  it("generates valid package.json with all required fields", () => {
    const templates = getTemplates(TEST_VARS);
    const pkg = templates.find((t) => t.path === "package.json")!;
    const output = pkg.content(TEST_VARS);
    const parsed = JSON.parse(output);

    expect(parsed).toHaveProperty("name", "test-game");
    expect(parsed).toHaveProperty("type", "module");
    expect(parsed).toHaveProperty("scripts");
    expect(parsed.scripts).toHaveProperty("dev");
    expect(parsed.scripts).toHaveProperty("build");
    expect(parsed.scripts).toHaveProperty("typecheck");
    expect(parsed.scripts).toHaveProperty("deploy");
    expect(parsed.dependencies).toHaveProperty("bgio-partykit");
    expect(parsed.dependencies).toHaveProperty("boardgame.io");
    expect(parsed.devDependencies).toHaveProperty("typescript");
    expect(parsed.devDependencies).toHaveProperty("partykit");
    expect(parsed.pnpm).toHaveProperty("patchedDependencies");
    expect(parsed.pnpm.patchedDependencies).toHaveProperty("capnp-ts@0.7.0");
  });

  it("generates valid tsconfig.json with required fields", () => {
    const templates = getTemplates(TEST_VARS);
    const tsconfig = templates.find((t) => t.path === "tsconfig.json")!;
    const output = tsconfig.content(TEST_VARS);
    const parsed = JSON.parse(output);

    expect(parsed.compilerOptions).toHaveProperty("strict", true);
    expect(parsed.compilerOptions).toHaveProperty("module", "ESNext");
    expect(parsed.compilerOptions).toHaveProperty("moduleResolution", "bundler");
  });
});

describe("End-to-end scaffold", () => {
  const tmpDir = path.join("/tmp", `create-bgio-partykit-test-${Date.now()}`);
  const projectDir = path.join(tmpDir, "test-game");

  beforeAll(() => {
    // Scaffold the project to a temp directory using the template generator
    fs.mkdirSync(projectDir, { recursive: true });

    const templates = getTemplates(TEST_VARS);
    for (const { path: filePath, content } of templates) {
      const fullPath = path.join(projectDir, filePath);
      const dir = path.dirname(fullPath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(fullPath, content(TEST_VARS), "utf-8");
    }

    // Build and pack the main bgio-partykit package first
    const rootDir = path.resolve(
      import.meta.dirname ?? __dirname,
      "..",
      "..",
      "..",
    );

    cp.execSync("pnpm build", { cwd: rootDir, stdio: "pipe" });

    const packResult = cp.execSync("pnpm pack --pack-destination /tmp", {
      cwd: rootDir,
      stdio: "pipe",
    });
    const packOutput = packResult.toString().trim();
    const tarballPath = packOutput.split("\n").pop()!.trim();

    // Update the generated package.json to use the local tarball
    const pkgPath = path.join(projectDir, "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    pkg.dependencies["bgio-partykit"] = `file:${tarballPath}`;
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf-8");

    // Install
    try {
      cp.execSync("pnpm install --no-frozen-lockfile", {
        cwd: projectDir,
        stdio: "pipe",
        env: {
          ...process.env,
          COREPACK_ENABLE_AUTO_PIN: "no",
          COREPACK_ENABLE_STRICT: "no",
        },
      });
    } catch (err: unknown) {
      const stderr =
        err instanceof Error && "stderr" in err && Buffer.isBuffer((err as any).stderr)
          ? ((err as any).stderr as Buffer).toString()
          : "unknown error";
      const stdout =
        err instanceof Error && "stdout" in err && Buffer.isBuffer((err as any).stdout)
          ? ((err as any).stdout as Buffer).toString()
          : "";
      throw new Error(`pnpm install failed: stderr=${stderr} stdout=${stdout}`);
    }
  }, 120_000);

  afterAll(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it("generated project typechecks successfully", () => {
    const result = cp.spawnSync("pnpm", ["typecheck"], {
      cwd: projectDir,
      stdio: "pipe",
    });

    if (result.status !== 0) {
      console.log("Typecheck stdout:", result.stdout?.toString());
      console.log("Typecheck stderr:", result.stderr?.toString());
    }

    expect(result.status).toBe(0);
  });

  it("template variables were substituted correctly in generated files", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(projectDir, "package.json"), "utf-8"),
    );
    expect(pkg.name).toBe("test-game");

    const pk = JSON.parse(
      fs.readFileSync(path.join(projectDir, "partykit.json"), "utf-8"),
    );
    expect(pk.name).toBe("test-game");

    const server = fs.readFileSync(
      path.join(projectDir, "src", "server.ts"),
      "utf-8",
    );
    expect(server).toContain("TestGame");
    expect(server).toContain("registerGame(TestGame)");

    const game = fs.readFileSync(
      path.join(projectDir, "src", "game.ts"),
      "utf-8",
    );
    expect(game).toContain("minPlayers: 2");
    expect(game).toContain("maxPlayers: 2");
    expect(game).toContain("TestGameState");
    expect(game).toContain("export const TestGame:");
  });

  it("generated server imports and exports bgio-partykit Server", () => {
    const server = fs.readFileSync(
      path.join(projectDir, "src", "server.ts"),
      "utf-8",
    );
    expect(server).toContain('import { Server, registerGame } from "bgio-partykit"');
    expect(server).toContain("export default Server");
  });

  it("generated game definition has numPlayers from prompt", () => {
    const game = fs.readFileSync(
      path.join(projectDir, "src", "game.ts"),
      "utf-8",
    );
    expect(game).toContain("minPlayers: 2");
    expect(game).toContain("maxPlayers: 2");
  });

  it("generated partykit.json references src/server.ts for both parties", () => {
    const pk = JSON.parse(
      fs.readFileSync(path.join(projectDir, "partykit.json"), "utf-8"),
    );
    expect(pk.parties.lobby).toBe("src/server.ts");
    expect(pk.parties.match).toBe("src/server.ts");
  });

  it("generated project includes capnp-ts patch file", () => {
    const patchPath = path.join(projectDir, "patches", "capnp-ts@0.7.0.patch");
    expect(fs.existsSync(patchPath)).toBe(true);
    const patchContent = fs.readFileSync(patchPath, "utf-8");
    expect(patchContent).toContain("single-segment-arena.js");
  });

  it("generated package.json configures patchedDependencies", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(projectDir, "package.json"), "utf-8"),
    );
    expect(pkg.pnpm).toHaveProperty("patchedDependencies");
    expect(pkg.pnpm.patchedDependencies).toHaveProperty("capnp-ts@0.7.0");
    expect(pkg.pnpm.patchedDependencies["capnp-ts@0.7.0"]).toBe(
      "patches/capnp-ts@0.7.0.patch",
    );
  });
});
