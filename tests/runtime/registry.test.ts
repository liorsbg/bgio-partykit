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
    const originalMoves = TestGame.moves;
    registerGame(TestGame);
    // ProcessGameConfig adds default playerView and other fields.
    // The original game should remain untouched.
    expect(TestGame.moves).toBe(originalMoves);
  });

  it("returns processed game with playerView defaults", () => {
    const registered = getGame("test-game");
    expect(registered?.processedGame.playerView).toBeDefined();
  });

  it("returns undefined for unregistered games", () => {
    expect(getGame("does-not-exist")).toBeUndefined();
  });
});
