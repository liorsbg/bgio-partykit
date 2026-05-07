// @ts-nocheck
import type * as Party from "partykit/server";
import { Master } from "boardgame.io/master";
import { getFilterPlayerView } from "boardgame.io/internal";
import type { Game as GameType, Server as GameServer } from "boardgame.io/dist/types/src/types";
import type { TransportAPI as MasterTransport, IntermediateTransportData } from "boardgame.io/dist/types/src/master/master";
import { getGame, deepCloneWithFunctions } from "./registry.js";
import { RemoteStorage } from "./remote-storage.js";

// ---------------------------------------------------------------------------
// Per-match connection tracking for multiple-tabs-allowed policy
// ---------------------------------------------------------------------------
interface SocketMeta {
  matchID: string;
  playerID: string;
  socket: any;
  credentials?: string;
}

// Simple sequential promise queue (p-queue v6.6.2 hangs in PartyKit/Miniflare Workers environment)
interface SimpleQueue {
  running: boolean;
  tasks: Array<() => Promise<void>>;
}

export class MatchRoom {
  private clientInfo = new Map<string, SocketMeta>();
  private perMatchQueue = new Map<string, SimpleQueue>();
  private playerConnections = new Map<string, Set<string>>(); // key = `${matchID}:${playerID}` -> Set<socket.id>

  constructor(private lobby: Party.FetchLobby) {}

  // -------------------------------------------------------------------------
  // Test helpers
  // -------------------------------------------------------------------------
  registerSocket(socket: any, matchID: string, playerID: string, credentials?: string) {
    this.clientInfo.set(socket.id, { matchID, playerID, socket, credentials });
    const key = `${matchID}:${playerID}`;
    if (!this.playerConnections.has(key)) {
      this.playerConnections.set(key, new Set());
    }
    this.playerConnections.get(key)!.add(socket.id);
    socket.matchID = matchID;
    socket.playerID = playerID;
    socket.credentials = credentials;
  }

  getConnectionCount(matchID: string, playerID: string): number {
    const key = `${matchID}:${playerID}`;
    return this.playerConnections.get(key)?.size ?? 0;
  }

  // -------------------------------------------------------------------------
  // Event handlers
  // -------------------------------------------------------------------------
  async handleSync(socket: any, matchID: string, playerID: string | undefined, credentials: string | undefined, numPlayers = 2) {
    // Look up game name from match DO
    const matchStub = this.lobby.parties.match.get(matchID);
    const gameNameRes = await matchStub.fetch("/gameName", { method: "GET" });
    const { gameName } = (await gameNameRes.json()) as { gameName: string | null };
    if (!gameName) {
      socket.emit("sync_error", "unknown_game");
      return;
    }

    const game = getGame(gameName);
    if (!game) {
      socket.emit("sync_error", "unknown_game");
      return;
    }

    // Authenticate when playerID is provided; missing or wrong credentials rejected
    if (playerID !== undefined && playerID !== null) {
      if (credentials === undefined || credentials === null) {
        socket.emit("sync_error", "auth_invalid");
        return;
      }
      const authentic = await this.authenticatePlayer(matchID, playerID, credentials);
      if (!authentic) {
        socket.emit("sync_error", "auth_invalid");
        return;
      }
    }

    // Track connection
    socket.matchID = matchID;
    socket.playerID = playerID || null;
    socket.credentials = credentials;
    this.clientInfo.set(socket.id, { matchID, playerID: playerID || "0", socket, credentials });

    if (playerID !== undefined) {
      const key = `${matchID}:${playerID}`;
      if (!this.playerConnections.has(key)) {
        this.playerConnections.set(key, new Set());
      }
      this.playerConnections.get(key)!.add(socket.id);
    }

    socket.join(matchID);

    const storage = new RemoteStorage(this.lobby);
    // Master mutates the game config in-place via ProcessGameConfig; always deep-clone
    const gameForMaster = deepCloneWithFunctions(game.processedGame);
    const transport = this.createTransportAPI(socket, gameForMaster, matchID);
    const master = new Master(gameForMaster, storage as any, transport);

    const result = await master.onSync(matchID, playerID, credentials, numPlayers);
    if (result && "error" in result) {
      socket.emit("sync_error", result.error);
      return;
    }

    await master.onConnectionChange(matchID, playerID, credentials, true);
  }

  async handleUpdate(socket: any, action: Record<string, unknown>, stateID: number, matchID: string, playerID: string) {
    // Validate socket-player binding
    const socketMeta = this.clientInfo.get(socket.id);
    if (socketMeta && socketMeta.playerID !== playerID) {
      socket.emit("error", "spoofed_player");
      return;
    }

    // Payload size check
    const payloadCheck = this.checkPayloadSize(action);
    if (!payloadCheck.allowed) {
      socket.emit("error", payloadCheck.error);
      return;
    }

    // Authenticate credentials on update (defense-in-depth)
    if (socketMeta?.credentials) {
      const authentic = await this.authenticatePlayer(matchID, playerID, socketMeta.credentials);
      if (!authentic) {
        socket.emit("error", "auth_invalid");
        return;
      }
    }

    const gameNameRes = await this.lobby.parties.match.get(matchID).fetch("/gameName", { method: "GET" });
    const { gameName } = (await gameNameRes.json()) as { gameName: string | null };
    const game = gameName ? getGame(gameName) : undefined;
    if (!game) {
      socket.emit("error", "unknown_game");
      return;
    }

    const storage = new RemoteStorage(this.lobby);
    const gameForMaster = deepCloneWithFunctions(game.processedGame);
    const transport = this.createTransportAPI(socket, gameForMaster, matchID);
    const master = new Master(gameForMaster, storage as any, transport);

    const queue = this.getMatchQueue(matchID);
    await queue.add(async () => {
      const result = await master.onUpdate(action as never, stateID, matchID, playerID);
      if (result && "error" in result) {
        socket.emit("error", result.error);
      }
    });
  }

  async handleDisconnect(socket: any) {
    const info = this.clientInfo.get(socket.id);
    if (!info) return;

    const { matchID, playerID, credentials } = info;

    // Remove from connection tracking
    this.clientInfo.delete(socket.id);
    if (playerID !== undefined) {
      const key = `${matchID}:${playerID}`;
      const set = this.playerConnections.get(key);
      if (set) {
        set.delete(socket.id);
        if (set.size === 0) {
          this.playerConnections.delete(key);
        }
      }
    }

    const gameNameRes = await this.lobby.parties.match.get(matchID).fetch("/gameName", { method: "GET" });
    const { gameName } = (await gameNameRes.json()) as { gameName: string | null };
    const game = gameName ? getGame(gameName) : undefined;
    if (!game) return;

    const storage = new RemoteStorage(this.lobby);
    const gameForMaster = deepCloneWithFunctions(game.processedGame);
    const transport = this.createTransportAPI(socket, gameForMaster, matchID);
    const master = new Master(gameForMaster, storage as any, transport);

    // Only mark disconnected if this was the last connection for this player
    if (!this.playerConnections.has(`${matchID}:${playerID}`)) {
      await master.onConnectionChange(matchID, playerID, credentials, false);
    }
  }

  async handleChat(socket: any, _matchID: string, _playerID: string, _payload: unknown) {
    socket.emit("error", "unsupported_frame_type");
  }

  async handleUnknownEvent(socket: any, _eventName: string, _payload: unknown) {
    socket.emit("error", "unsupported_frame_type");
  }

  checkPayloadSize(payload: unknown): { allowed: boolean; error?: string } {
    try {
      const serialized = JSON.stringify(payload);
      // Reject payloads larger than 1MB
      if (serialized.length > 1_000_000) {
        return { allowed: false, error: "payload_too_large" };
      }
      return { allowed: true };
    } catch {
      return { allowed: false, error: "invalid_payload" };
    }
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------
  private getMatchQueue(matchID: string): { add: (fn: () => Promise<void>) => Promise<void> } {
    if (!this.perMatchQueue.has(matchID)) {
      this.perMatchQueue.set(matchID, { running: false, tasks: [] });
    }
    const q = this.perMatchQueue.get(matchID)!;
    return {
      add: async (fn: () => Promise<void>) => {
        q.tasks.push(fn);
        if (q.running) {
          // Wait until this task reaches the front
          while (q.tasks[0] !== fn) {
            await new Promise(r => setTimeout(r, 10));
          }
        }
        q.running = true;
        try {
          await fn();
        } finally {
          q.tasks.shift();
          q.running = q.tasks.length > 0;
        }
      }
    };
  }

  private async authenticatePlayer(matchID: string, playerID: string, credentials: string): Promise<boolean> {
    try {
      const stub = this.lobby.parties.match.get(matchID);
      const res = await stub.fetch("/metadata");
      const { metadata } = await res.json() as { metadata?: GameServer.MatchData };
      if (!metadata || !metadata.players) return false;
      const player = metadata.players[Number(playerID)];
      if (!player) return false;
      return player.credentials === credentials;
    } catch {
      return false;
    }
  }

  private createTransportAPI(socket: any, game: GameType, matchID: string): MasterTransport {
    const filterPlayerView = getFilterPlayerView(game);

    return {
      send: ({ playerID, type, args }) => {
        const data = filterPlayerView(playerID, { type, args } as IntermediateTransportData);
        socket.emit(data.type, ...data.args);
      },
      sendAll: (payload) => {
        try {
          const adapter = socket.nsp.adapter;
          const roomSockets = adapter.sids
            ? Array.from(adapter.sids.keys()).filter((sid: any) => {
                const rooms = adapter.sids.get(sid);
                return rooms && rooms.has(matchID);
              })
            : [];

          for (const sid of roomSockets) {
            const targetSocket = socket.nsp.sockets.get(sid);
            if (targetSocket) {
              const pid = targetSocket.playerID || null;
              const data = filterPlayerView(pid, payload);
              targetSocket.emit(data.type, ...data.args);
            }
          }
        } catch {
          // Fallback broadcast (unfiltered for non-local sockets)
          socket.nsp.to(matchID).emit(payload.type, ...payload.args);
        }
      },
    };
  }
}
