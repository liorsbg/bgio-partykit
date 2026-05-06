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

function deepCloneWithFunctions<T>(obj: T): T {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }
  if (typeof obj === "function") {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(deepCloneWithFunctions) as unknown as T;
  }
  const clone = {} as T;
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      clone[key] = deepCloneWithFunctions(obj[key]);
    }
  }
  return clone;
}

export function registerGame(game: Game): void {
  const name = game.name || "unnamed";
  if (registry.has(name)) {
    return;
  }
  // ProcessGameConfig mutates the object in-place (adding playerView, deltaState,
  // disableUndo, plugins, and expanding turn sub-object). Always deep-clone
  // before passing to prevent corrupting the original and subsequent matches.
  const cloned = deepCloneWithFunctions(game);
  const processedGame = ProcessGameConfig(cloned);
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
