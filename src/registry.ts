import { ProcessGameConfig, getFilterPlayerView } from "boardgame.io/internal";
import type { Game } from "boardgame.io/dist/types/src/types";
import TicTacToe from "./games/tic-tac-toe";

export interface RegisteredGame {
  name: string;
  originalGame: Game;
  processedGame: ReturnType<typeof ProcessGameConfig>;
  filterPlayerView: ReturnType<typeof getFilterPlayerView>;
}

const registry = new Map<string, RegisteredGame>();

export function registerGame(game: Game): void {
  const name = game.name || "unnamed";
  if (registry.has(name)) {
    return;
  }
  // ProcessGameConfig mutates the object to add defaults (setup, moves, etc.)
  // and returns a new object with flow, moveNames etc. The mutation is
  // idempotent so we can pass the original directly.
  const processedGame = ProcessGameConfig(game);
  const filterPlayerView = getFilterPlayerView(processedGame);
  registry.set(name, {
    name,
    originalGame: game,
    processedGame,
    filterPlayerView,
  });
}

export function getGame(name: string): RegisteredGame | undefined {
  return registry.get(name);
}

export function listGames(): string[] {
  return Array.from(registry.keys());
}

export function getGames(): Game[] {
  return Array.from(registry.values()).map((g) => g.originalGame);
}

// Register built-in demo games
registerGame(TicTacToe);
