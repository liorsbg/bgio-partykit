// @ts-nocheck
import type * as Party from "partykit/server";
import { Server as SocketIOServer } from "../packages/party.io/src/socket.io/index.js";
import { getGame, listGames } from "./registry.js";
import { MatchRoom } from "./match-room.js";

// ---------------------------------------------------------------------------
// Module-level singletons for the Socket.IO server (Worker scope)
// ---------------------------------------------------------------------------
let ioSingleton: any = null;
let matchRoomSingleton: MatchRoom | null = null;

const ALLOWED_ORIGINS = ["http://127.0.0.1:1999", "http://127.0.0.1:5173"];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(message: string, status = 400): Response {
  return jsonResponse({ error: message }, status);
}

function getIO(lobby: Party.FetchLobby): any {
  if (!ioSingleton) {
    matchRoomSingleton = new MatchRoom(lobby);

    ioSingleton = new SocketIOServer({
      cors: {
        origin: ALLOWED_ORIGINS,
        credentials: true,
      },
      transports: ["websocket"],
      maxHttpBufferSize: 1_000_000,
      allowRequest: async (req: Request) => {
        const origin = req.headers.get("origin") || req.headers.get("host") || "";
        if (!origin) return; // same-origin, allow
        if (!ALLOWED_ORIGINS.includes(origin)) {
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
      const server = getIO(lobby);
      return server.handler()(req, lobby, ctx);
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

    // GET /games
    if (pathname === "/games" || pathname.endsWith("/games")) {
      if (req.method === "GET") {
        return jsonResponse(listGames());
      }
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204 });
      }
      return errorResponse("Method not allowed", 405);
    }

    // POST /games/:name/create
    const createMatchPath = pathname.match(/\/games\/([^/]+)\/create$/);
    if (createMatchPath) {
      if (req.method === "POST") {
        const gameName = decodeURIComponent(createMatchPath[1]);
        const game = getGame(gameName);
        if (!game) {
          return errorResponse(`Game "${gameName}" not found`, 404);
        }

        let body: { numPlayers?: number; setupData?: unknown } = {};
        try {
          body = await req.json();
        } catch {
          return errorResponse("Invalid JSON", 400);
        }

        const numPlayers = body.numPlayers ?? 2;
        if (typeof numPlayers !== "number" || numPlayers < 1) {
          return errorResponse("Invalid numPlayers", 400);
        }
        if (game.originalGame.maxPlayers && numPlayers > game.originalGame.maxPlayers) {
          return errorResponse("numPlayers exceeds maxPlayers", 400);
        }
        if (game.originalGame.minPlayers && numPlayers < game.originalGame.minPlayers) {
          return errorResponse("numPlayers below minPlayers", 400);
        }

        const matchID = crypto.randomUUID();
        const { createMatch: boardgameCreateMatch } = await import("boardgame.io/internal");
        const result = boardgameCreateMatch({
          game: game.processedGame,
          numPlayers,
          setupData: body.setupData,
          unlisted: false,
        });

        if ("setupDataError" in result) {
          return errorResponse(result.setupDataError || "Invalid setup data", 400);
        }

        // Store match metadata in lobby DO
        await this.room.storage.put(`match:${matchID}:metadata`, result.metadata);
        await this.room.storage.put(`match:${matchID}:gameName`, gameName);
        await this.room.storage.put(`match:${matchID}:createdAt`, Date.now());

        // Initialize match state in match DO
        const matchStub = this.room.context.parties.match.get(matchID);
        await matchStub.fetch("/create", {
          method: "POST",
          body: JSON.stringify({
            initialState: result.initialState,
            metadata: result.metadata,
            gameName,
          }),
        });

        return jsonResponse({ matchID }, 201);
      }
      return errorResponse("Method not allowed", 405);
    }

    // GET /games/:name
    const listMatchesPath = pathname.match(/\/games\/([^/]+)$/);
    if (listMatchesPath) {
      if (req.method === "GET") {
        const gameName = decodeURIComponent(listMatchesPath[1]);
        const game = getGame(gameName);
        if (!game) {
          return errorResponse(`Game "${gameName}" not found`, 404);
        }

        const keys = await this.room.storage.list({ prefix: "match:" });
        const matches: Array<{
          matchID: string;
          gameName: string;
          players: Array<{ id: number; name?: string; isConnected?: boolean }>;
          setupData?: unknown;
          createdAt: number;
          updatedAt: number;
        }> = [];

        for (const key of keys.keys()) {
          const parts = key.slice("match:".length).split(":");
          const matchID = parts[0];
          if (!matchID) continue;

          const meta = await this.room.storage.get<unknown>(`match:${matchID}:metadata`);
          const storedGameName = await this.room.storage.get<string>(`match:${matchID}:gameName`);
          if (!meta || storedGameName !== gameName) continue;

          const typedMeta = meta as Record<string, any>;
          const players = Object.values(typedMeta.players).map((p: any) => ({
            id: p.id,
            name: p.name,
            isConnected: p.isConnected,
          }));

          matches.push({
            matchID,
            gameName: storedGameName,
            players,
            setupData: typedMeta.setupData,
            createdAt: typedMeta.createdAt,
            updatedAt: typedMeta.updatedAt,
          });
        }

        return jsonResponse({ matches });
      }
      return errorResponse("Method not allowed", 405);
    }

    // GET /games/:name/:id
    const matchDetail = pathname.match(/\/games\/([^/]+)\/([^/]+)$/);
    if (matchDetail) {
      const gameName = decodeURIComponent(matchDetail[1]);
      const matchID = decodeURIComponent(matchDetail[2]);

      if (req.method === "GET") {
        const meta = await this.room.storage.get<unknown>(`match:${matchID}:metadata`);
        const storedGameName = await this.room.storage.get<string>(`match:${matchID}:gameName`);
        if (!meta || storedGameName !== gameName) {
          return errorResponse("Match not found", 404);
        }

        const typedMeta = meta as Record<string, any>;
        const players = Object.values(typedMeta.players).map((p: any) => ({
          id: p.id,
          name: p.name,
          isConnected: p.isConnected,
        }));

        return jsonResponse({
          matchID,
          gameName: storedGameName,
          players,
          setupData: typedMeta.setupData,
          createdAt: typedMeta.createdAt,
          updatedAt: typedMeta.updatedAt,
        });
      }

      if (req.method === "POST") {
        return errorResponse("Not found", 404);
      }

      return errorResponse("Method not allowed", 405);
    }

    // POST /games/:name/:id/join
    const joinMatchPath = pathname.match(/\/games\/([^/]+)\/([^/]+)\/join$/);
    if (joinMatchPath) {
      if (req.method === "POST") {
        const gameName = decodeURIComponent(joinMatchPath[1]);
        const matchID = decodeURIComponent(joinMatchPath[2]);

        const game = getGame(gameName);
        if (!game) {
          return errorResponse(`Game "${gameName}" not found`, 404);
        }

        const meta = await this.room.storage.get<unknown>(`match:${matchID}:metadata`);
        const storedGameName = await this.room.storage.get<string>(`match:${matchID}:gameName`);
        if (!meta || storedGameName !== gameName) {
          return errorResponse("Match not found", 404);
        }

        let body: { playerID?: string; playerName?: string } = {};
        try {
          body = await req.json();
        } catch {
          return errorResponse("Invalid JSON", 400);
        }

        const typedMeta = meta as Record<string, any>;
        let playerID = body.playerID;
        if (playerID === undefined || playerID === null) {
          // Auto-assign first available seat
          const numPlayers = Object.keys(typedMeta.players).length;
          for (let i = 0; i < numPlayers; i++) {
            if (!typedMeta.players[i]?.name) {
              playerID = String(i);
              break;
            }
          }
        }

        if (playerID === undefined || playerID === null) {
          return errorResponse("No available seats", 409);
        }

        const pid = String(playerID);
        const pidNum = Number(pid);
        if (!typedMeta.players[pidNum]) {
          return errorResponse("Invalid playerID", 400);
        }

        // If seat is already taken by another player with credentials
        if (typedMeta.players[pidNum].credentials && typedMeta.players[pidNum].credentials !== body.playerName) {
          return errorResponse("Seat already taken", 409);
        }

        const credentials = crypto.randomUUID();
        typedMeta.players[pidNum] = {
          ...typedMeta.players[pidNum],
          name: body.playerName || `Player ${pid}`,
          credentials,
        };
        typedMeta.updatedAt = Date.now();

        await this.room.storage.put(`match:${matchID}:metadata`, typedMeta);

        // Also update match DO metadata so Master can validate credentials
        const matchStub = this.room.context.parties.match.get(matchID);
        await matchStub.fetch("/metadata", {
          method: "POST",
          body: JSON.stringify(typedMeta),
        });

        return jsonResponse({ playerID: pid, playerCredentials: credentials });
      }
      return errorResponse("Method not allowed", 405);
    }

    // POST /games/:name/:id/leave
    const leaveMatchPath = pathname.match(/\/games\/([^/]+)\/([^/]+)\/leave$/);
    if (leaveMatchPath) {
      if (req.method === "POST") {
        return errorResponse("Leave not implemented in this milestone", 501);
      }
      return errorResponse("Method not allowed", 405);
    }

    // POST /games/:name/:id/update
    const updateMatchPath = pathname.match(/\/games\/([^/]+)\/([^/]+)\/update$/);
    if (updateMatchPath) {
      if (req.method === "POST") {
        return errorResponse("Update not implemented in this milestone", 501);
      }
      return errorResponse("Method not allowed", 405);
    }

    return errorResponse("Not found", 404);
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
