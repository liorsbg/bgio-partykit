import { describe, it, expect } from "vitest";
import { registerGame, getGame, listGames } from "../../src/registry";
import type { Game } from "boardgame.io/dist/types/src/types";

const TestGame: Game = {
  name: "test-game",
  setup: () => ({ value: 0 }),
  moves: {
    increment: ({ G }) => {
      G.value++;
    },
  },
};

describe("Game Registry", () => {
  it("registers a game and retrieves it", () => {
    registerGame(TestGame);
    const registered = getGame("test-game");
    expect(registered).toBeDefined();
    expect(registered?.name).toBe("test-game");
  });

  it("lists registered games", () => {
    const games = listGames();
    expect(games).toContain("tic-tac-toe");
    expect(games).toContain("test-game");
  });

  it("does not mutate the original game object when registering", () => {
    const originalJSON = JSON.stringify(TestGame);
    registerGame(TestGame);
    // ProcessGameConfig mutates in-place (adds playerView, deltaState, plugins, turn sub-object).
    // The original game object must remain completely untouched.
    expect(JSON.stringify(TestGame)).toBe(originalJSON);
  });

  it("returns processed game with playerView defaults", () => {
    const registered = getGame("test-game");
    expect(registered?.processedGame.playerView).toBeDefined();
  });

  it("returns undefined for unregistered games", () => {
    expect(getGame("does-not-exist")).toBeUndefined();
  });

  it("caches processed game so second match for same game behaves identically", () => {
    const registered = getGame("test-game");
    expect(registered).toBeDefined();

    // The processed game should be stable and not mutated by further usage
    const processedJSON = JSON.stringify(registered?.processedGame);

    // Simulate creating a second match (same code path uses getGame)
    const registeredAgain = getGame("test-game");
    expect(JSON.stringify(registeredAgain?.processedGame)).toBe(processedJSON);
  });
});
