import type * as Party from "partykit/server";
import { createMatch } from "boardgame.io/internal";
import type { Server } from "boardgame.io/dist/types/src/types";
import { getGame, listGames } from "./registry.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(message: string, status = 400): Response {
  return jsonResponse({ error: message }, status);
}

export async function handleLobbyRequest(req: Party.Request, room: Party.Room): Promise<Response> {
  const url = new URL(req.url);
  const pathname = url.pathname;

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
      const result = createMatch({
        game: game.processedGame,
        numPlayers,
        setupData: body.setupData,
        unlisted: false,
      });

      if ("setupDataError" in result) {
        return errorResponse(result.setupDataError || "Invalid setup data", 400);
      }

      // Store match metadata in lobby DO
      await room.storage.put(`match:${matchID}:metadata`, result.metadata);
      await room.storage.put(`match:${matchID}:gameName`, gameName);
      await room.storage.put(`match:${matchID}:createdAt`, Date.now());

      // Initialize match state in match DO
      const matchStub = room.context.parties.match.get(matchID);
      await matchStub.fetch("/create", {
        method: "POST",
        body: JSON.stringify({
          initialState: result.initialState,
          metadata: result.metadata,
        }),
      });

      return jsonResponse({ matchID }, 201);
    }
    return errorResponse("Method not allowed", 405);
  }

  // GET /games/:name
  const listMatches = pathname.match(/\/games\/([^/]+)$/);
  if (listMatches) {
    if (req.method === "GET") {
      const gameName = decodeURIComponent(listMatches[1]);
      const game = getGame(gameName);
      if (!game) {
        return errorResponse(`Game "${gameName}" not found`, 404);
      }

      const keys = await room.storage.list({ prefix: "match:" });
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

        const meta = await room.storage.get<Server.MatchData>(`match:${matchID}:metadata`);
        const storedGameName = await room.storage.get<string>(`match:${matchID}:gameName`);
        if (!meta || storedGameName !== gameName) continue;

        const players = Object.values(meta.players).map((p) => ({
          id: p.id,
          name: p.name,
          isConnected: p.isConnected,
        }));

        matches.push({
          matchID,
          gameName: storedGameName,
          players,
          setupData: meta.setupData,
          createdAt: meta.createdAt,
          updatedAt: meta.updatedAt,
        });
      }

      return jsonResponse({ matches });
    }
    return errorResponse("Method not allowed", 405);
  }

  // GET /games/:name/:id or POST /games/:name/:id/join/leave/update
  const matchDetail = pathname.match(/\/games\/([^/]+)\/([^/]+)$/);
  if (matchDetail) {
    const gameName = decodeURIComponent(matchDetail[1]);
    const matchID = decodeURIComponent(matchDetail[2]);

    if (req.method === "GET") {
      const meta = await room.storage.get<Server.MatchData>(`match:${matchID}:metadata`);
      const storedGameName = await room.storage.get<string>(`match:${matchID}:gameName`);
      if (!meta || storedGameName !== gameName) {
        return errorResponse("Match not found", 404);
      }

      const players = Object.values(meta.players).map((p) => ({
        id: p.id,
        name: p.name,
        isConnected: p.isConnected,
      }));

      return jsonResponse({
        matchID,
        gameName: storedGameName,
        players,
        setupData: meta.setupData,
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
      });
    }

    if (req.method === "POST") {
      return errorResponse("Not found", 404);
    }

    return errorResponse("Method not allowed", 405);
  }

  // POST /games/:name/:id/join
  const joinMatch = pathname.match(/\/games\/([^/]+)\/([^/]+)\/join$/);
  if (joinMatch) {
    if (req.method === "POST") {
      const gameName = decodeURIComponent(joinMatch[1]);
      const matchID = decodeURIComponent(joinMatch[2]);

      const game = getGame(gameName);
      if (!game) {
        return errorResponse(`Game "${gameName}" not found`, 404);
      }

      const meta = await room.storage.get<Server.MatchData>(`match:${matchID}:metadata`);
      const storedGameName = await room.storage.get<string>(`match:${matchID}:gameName`);
      if (!meta || storedGameName !== gameName) {
        return errorResponse("Match not found", 404);
      }

      let body: { playerID?: string; playerName?: string } = {};
      try {
        body = await req.json();
      } catch {
        return errorResponse("Invalid JSON", 400);
      }

      let playerID = body.playerID;
      if (playerID === undefined || playerID === null) {
        // Auto-assign first available seat
        const numPlayers = Object.keys(meta.players).length;
        for (let i = 0; i < numPlayers; i++) {
          if (!meta.players[i]?.name) {
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
      if (!meta.players[pidNum]) {
        return errorResponse("Invalid playerID", 400);
      }

      // If seat is already taken by another player with credentials
      if (meta.players[pidNum].credentials && meta.players[pidNum].credentials !== body.playerName) {
        return errorResponse("Seat already taken", 409);
      }

      const credentials = crypto.randomUUID();
      meta.players[pidNum] = {
        ...meta.players[pidNum],
        name: body.playerName || `Player ${pid}`,
        credentials,
      };
      meta.updatedAt = Date.now();

      await room.storage.put(`match:${matchID}:metadata`, meta);

      // Also update match DO metadata so Master can validate credentials
      const matchStub = room.context.parties.match.get(matchID);
      await matchStub.fetch("http://internal/metadata", {
        method: "POST",
        body: JSON.stringify(meta),
      });

      return jsonResponse({ playerID: pid, playerCredentials: credentials });
    }
    return errorResponse("Method not allowed", 405);
  }

  // POST /games/:name/:id/leave
  const leaveMatch = pathname.match(/\/games\/([^/]+)\/([^/]+)\/leave$/);
  if (leaveMatch) {
    if (req.method === "POST") {
      return errorResponse("Leave not implemented in this milestone", 501);
    }
    return errorResponse("Method not allowed", 405);
  }

  // POST /games/:name/:id/update
  const updateMatch = pathname.match(/\/games\/([^/]+)\/([^/]+)\/update$/);
  if (updateMatch) {
    if (req.method === "POST") {
      return errorResponse("Update not implemented in this milestone", 501);
    }
    return errorResponse("Method not allowed", 405);
  }

  return errorResponse("Not found", 404);
}
