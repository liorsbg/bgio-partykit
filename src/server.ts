// @ts-nocheck
import type * as Party from "partykit/server";
import { Server as SocketIOServer } from "../packages/party.io/src/socket.io/index.js";
import { createAdapter } from "../packages/party.io/src/socket.io/lib/party-adapter.js";
import { listGames } from "./registry.js";
import { handleLobbyRequest } from "./lobby.js";
import { MatchRoom } from "./match-room.js";
import { ALLOWED_ORIGINS } from "./cors.js";

// ---------------------------------------------------------------------------
// Module-level singletons for the Socket.IO server (Worker scope)
// ---------------------------------------------------------------------------
let ioSingleton: any = null;
let matchRoomSingleton: MatchRoom | null = null;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(message: string, status = 400): Response {
  return jsonResponse({ error: message }, status);
}

function getIO(lobby: Party.FetchLobby, ctx: Party.ExecutionContext): any {
  if (!ioSingleton) {
    matchRoomSingleton = new MatchRoom(lobby);

    ioSingleton = new SocketIOServer({
      cors: {
        origin: ALLOWED_ORIGINS,
        credentials: true,
      },
      transports: ["websocket"],
      maxHttpBufferSize: 1_000_000,
      adapter: createAdapter(lobby, ctx, {}),
      allowRequest: async (req: Request) => {
        const origin = req.headers.get("origin") || req.headers.get("host") || "";
        if (!origin) return; // same-origin, allow
        const reqOrigin = new URL(req.url).origin;
        const reqHost = new URL(reqOrigin).host;
        // Allow same-origin (with or without protocol)
        if (origin === reqOrigin || origin === reqHost) return;
        try {
          if (new URL(origin).host === reqHost) return;
        } catch {
          // origin is not a valid URL, ignore
        }
        const allowed = ALLOWED_ORIGINS.some((allowedOrigin) => {
          if (allowedOrigin === origin) return true;
          try {
            return new URL(allowedOrigin).host === origin;
          } catch {
            return false;
          }
        });
        if (!allowed) {
          throw "origin_not_allowed";
        }
      },
    });

    const attachSocketHandlers = (socket: any) => {
      // boardgame.io events: sync, update, disconnect
      socket.on("sync", async (...args: unknown[]) => {
        const [matchID, playerID, credentials, numPlayers] = args as [string, string, string, number];
        await matchRoomSingleton!.handleSync(socket, matchID, playerID, credentials, numPlayers);
      });

      socket.on("update", async (...args: unknown[]) => {
        const [action, stateID, matchID, playerID] = args as [unknown, number, string, string];
        await matchRoomSingleton!.handleUpdate(socket, action as Record<string, unknown>, stateID, matchID, playerID);
      });

      socket.on("disconnect", async () => {
        await matchRoomSingleton!.handleDisconnect(socket);
      });

      // Catch-all for unknown events and chat
      socket.onAnyIncoming((eventName: string, ..._args: unknown[]) => {
        if (eventName === "sync" || eventName === "update" || eventName === "disconnect") {
          return; // handled by explicit handlers above
        }
        if (eventName === "chat") {
          matchRoomSingleton!.handleChat(socket, socket.matchID, socket.playerID, _args[0]);
          return;
        }
        matchRoomSingleton!.handleUnknownEvent(socket, eventName, _args[0]);
      });
    };

    ioSingleton.on("connection", attachSocketHandlers);
    ioSingleton.of(/^\/[-\w]+$/).on("connection", attachSocketHandlers);
  }
  return ioSingleton;
}

// ---------------------------------------------------------------------------
// Main PartyKit Server class
// ---------------------------------------------------------------------------

export default class BgioPartyKitServer implements Party.Server {
  constructor(public room: Party.Room) {}

  static async onFetch(
    req: Request,
    lobby: Party.FetchLobby,
    ctx: Party.ExecutionContext
  ): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      return jsonResponse({
        service: "bgio-partykit",
        status: "ok",
        version: "0.0.1",
        games: listGames(),
      });
    }

    // Socket.IO endpoint
    if (url.pathname.startsWith("/socket.io/")) {
      const server = getIO(lobby, ctx);
      return server.handler()(req, lobby, ctx);
    }

    // E2E cleanup endpoint -> forward to lobby party DO
    if (url.pathname === "/e2e/cleanup") {
      const lobbyStub = lobby.parties.lobby.get("index");
      return lobbyStub.fetch(url.pathname, {
        method: req.method,
        headers: req.headers,
        body: req.body,
      });
    }

    // Lobby REST API -> forward to lobby party DO
    if (url.pathname.startsWith("/games")) {
      const lobbyStub = lobby.parties.lobby.get("index");
      return lobbyStub.fetch(url.pathname, {
        method: req.method,
        headers: req.headers,
        body: req.body,
      });
    }

    return jsonResponse({ error: "Not found" }, 404);
  }

  onConnect(_connection: Party.Connection): void | Promise<void> {
    // Accept all WebSocket connections (used by party.io PartyAdapter connectors)
  }

  onClose(_connection: Party.Connection): void | Promise<void> {
    // Connection closed
  }

  onMessage(
    message: string | ArrayBuffer | ArrayBufferView
  ): void | Promise<void> {
    this.room.broadcast(message);
  }

  async onRequest(req: Party.Request): Promise<Response> {
    if (this.room.name === "lobby") {
      return this.handleLobbyRequest(req);
    }

    if (this.room.name === "match") {
      return this.handleMatchRequest(req);
    }

    if (this.room.name === "bus") {
      return this.handleBusRequest(req);
    }

    return jsonResponse({ error: "Not found" }, 404);
  }

  // -----------------------------------------------------------------------
  // Lobby party DO handlers
  // -----------------------------------------------------------------------

  private async handleLobbyRequest(req: Party.Request): Promise<Response> {
    const url = new URL(req.url);
    let pathname = url.pathname;
    // Strip party path prefix if present (e.g., /parties/lobby/index/games -> /games)
    const partyPrefix = `/parties/lobby/${this.room.id}`;
    if (pathname.startsWith(partyPrefix)) {
      pathname = pathname.slice(partyPrefix.length) || "/";
    }

    // Delegate all /games routes to lobby handler
    if (pathname.startsWith("/games")) {
      // Create a new Request with the stripped pathname for the lobby handler
      const lobbyUrl = new URL(req.url);
      lobbyUrl.pathname = pathname;
      const lobbyReq = new Request(lobbyUrl.toString(), req) as Party.Request;
      return handleLobbyRequest(lobbyReq, this.room);
    }

    // POST /e2e/cleanup
    if (pathname === "/e2e/cleanup") {
      if (req.method === "POST") {
        const keys = await this.room.storage.list({ prefix: "match:" });
        const matchIDs = new Set<string>();
        for (const key of keys.keys()) {
          const parts = key.slice("match:".length).split(":");
          if (parts.length >= 1) {
            matchIDs.add(parts[0]);
          }
        }
        for (const matchID of matchIDs) {
          const matchStub = this.room.context.parties.match.get(matchID);
          try {
            await matchStub.fetch("/wipe", { method: "POST" });
          } catch {
            // match DO may not exist, ignore
          }
          await this.room.storage.delete(`match:${matchID}:metadata`);
          await this.room.storage.delete(`match:${matchID}:gameName`);
          await this.room.storage.delete(`match:${matchID}:createdAt`);
        }
        return jsonResponse({ cleaned: matchIDs.size });
      }
      return errorResponse("Method not allowed", 405);
    }

    return errorResponse("Not found", 404);
  }

  // -----------------------------------------------------------------------
  // Bus party DO handlers (PartyAdapter connector)
  // -----------------------------------------------------------------------

  private async handleBusRequest(req: Party.Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/count" && req.method === "POST") {
      return jsonResponse(this.room.connections.size);
    }

    return jsonResponse({ error: "Not found" }, 404);
  }

  // -----------------------------------------------------------------------
  // Match party DO handlers (StorageAPI RPC)
  // -----------------------------------------------------------------------

  private async handleMatchRequest(req: Party.Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname.endsWith("/create") && req.method === "POST") {
      const body = await req.json() as { initialState: unknown; metadata: unknown; gameName?: string };
      await this.room.storage.put("state", body.initialState);
      await this.room.storage.put("initialState", body.initialState);
      await this.room.storage.put("metadata", body.metadata);
      if (body.gameName) {
        await this.room.storage.put("gameName", body.gameName);
      }
      await this.room.storage.put("log", []);
      return new Response("OK", { status: 200 });
    }

    if (url.pathname.endsWith("/gameName") && req.method === "GET") {
      const gameName = await this.room.storage.get("gameName");
      return jsonResponse({ gameName });
    }

    if (url.pathname.endsWith("/state")) {
      if (req.method === "GET") {
        const state = await this.room.storage.get("state");
        return jsonResponse({ state });
      }
      if (req.method === "POST") {
        const body = await req.json() as { state: unknown; deltalog?: unknown[] };
        await this.room.storage.put("state", body.state);
        if (body.deltalog && body.deltalog.length > 0) {
          const log = (await this.room.storage.get("log")) || [];
          await this.room.storage.put("log", [...(log as unknown[]), ...body.deltalog]);
        }
        return new Response("OK", { status: 200 });
      }
    }

    if (url.pathname.endsWith("/metadata")) {
      if (req.method === "GET") {
        const metadata = await this.room.storage.get("metadata");
        return jsonResponse({ metadata });
      }
      if (req.method === "POST") {
        const metadata = await req.json();
        await this.room.storage.put("metadata", metadata);
        return new Response("OK", { status: 200 });
      }
    }

    if (url.pathname.endsWith("/log")) {
      if (req.method === "GET") {
        const log = (await this.room.storage.get("log")) || [];
        return jsonResponse({ log });
      }
    }

    if (url.pathname.endsWith("/fetch")) {
      if (req.method === "GET") {
        const result: Record<string, unknown> = {};
        if (url.searchParams.get("state") === "true") {
          result.state = await this.room.storage.get("state");
        }
        if (url.searchParams.get("log") === "true") {
          result.log = (await this.room.storage.get("log")) || [];
        }
        if (url.searchParams.get("metadata") === "true") {
          result.metadata = await this.room.storage.get("metadata");
        }
        if (url.searchParams.get("initialState") === "true") {
          result.initialState = await this.room.storage.get("initialState");
        }
        return jsonResponse(result);
      }
    }

    if (url.pathname.endsWith("/wipe")) {
      if (req.method === "POST") {
        await this.room.storage.delete("state");
        await this.room.storage.delete("initialState");
        await this.room.storage.delete("metadata");
        await this.room.storage.delete("log");
        return new Response("OK", { status: 200 });
      }
    }

    return jsonResponse({ error: "Not found" }, 404);
  }
}
