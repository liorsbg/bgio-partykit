/**
 * Public API exports for bgio-partykit.
 *
 * Consumers import these to build their own PartyKit server entrypoint,
 * register custom games, and configure standard boardgame.io clients.
 */

// Server (PartyKit room entrypoint)
export { default as Server, default } from "./server.js";

// Game registry
export {
  registerGame,
  getGame,
  listGames,
  getGames,
} from "./registry.js";
export type { RegisteredGame } from "./registry.js";

// Storage API backed by PartyKit room.storage
export { PartyKitStorage, StorageType } from "./storage.js";
export type {
  FetchOpts,
  CreateMatchOpts,
  ListMatchesOpts,
} from "./storage.js";

// Remote storage helper for match rooms
export { RemoteStorage } from "./remote-storage.js";

// Match room (advanced consumers)
export { MatchRoom } from "./match-room.js";

// Lobby request handler
export { handleLobbyRequest } from "./lobby.js";

// Transport API factory
export { createTransportAPI } from "./transport.js";

// Demo game (built-in)
export { default as TicTacToe } from "./games/tic-tac-toe.js";
export type { TicTacToeState } from "./games/tic-tac-toe.js";

/**
 * Build the base URL that a standard boardgame.io LobbyClient should use.
 *
 * @example
 *   const lobby = new LobbyClient({ server: lobbyClientUrl("http://localhost:1999") });
 */
export function lobbyClientUrl(baseUrl: string): string {
  return baseUrl.replace(/\/$/, "");
}

/**
 * Build the server URL for boardgame.io Client + SocketIO() transport.
 *
 * @example
 *   const client = Client({
 *     game: TicTacToe,
 *     transport: SocketIO({ server: socketIOServerUrl("http://localhost:1999") }),
 *   });
 */
export function socketIOServerUrl(baseUrl: string): string {
  return baseUrl.replace(/\/$/, "");
}
