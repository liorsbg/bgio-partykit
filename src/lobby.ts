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

function isJsonContentType(req: Party.Request): boolean {
  const contentType = req.headers.get("content-type") || "";
  return contentType.includes("application/json");
}

async function parseJsonBody<T>(req: Party.Request): Promise<{ ok: true; body: T } | { ok: false; response: Response }> {
  if (!isJsonContentType(req)) {
    return { ok: false, response: errorResponse("Unsupported Media Type", 415) };
  }
  try {
    const body = await req.json() as T;
    return { ok: true, body };
  } catch {
    return { ok: false, response: errorResponse("Invalid JSON", 400) };
  }
}

function validateNumPlayers(numPlayers: unknown, min: number, max: number): Response | null {
  if (typeof numPlayers !== "number" || !Number.isInteger(numPlayers) || numPlayers < 1) {
    return errorResponse("Invalid numPlayers", 400);
  }
  if (numPlayers > max) {
    return errorResponse("numPlayers exceeds maxPlayers", 400);
  }
  if (numPlayers < min) {
    return errorResponse("numPlayers below minPlayers", 400);
  }
  return null;
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

      const parsed = await parseJsonBody<{ numPlayers?: number; setupData?: unknown }>(req);
      if (!parsed.ok) return parsed.response;
      const body = parsed.body;

      const numPlayers = body.numPlayers ?? 2;
      const validationError = validateNumPlayers(
        numPlayers,
        game.processedGame.minPlayers ?? 1,
        game.processedGame.maxPlayers ?? 100
      );
      if (validationError) return validationError;

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
          gameName,
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
      const seenMatchIDs = new Set<string>();
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
        if (!matchID || seenMatchIDs.has(matchID)) continue;

        const meta = await room.storage.get<Server.MatchData>(`match:${matchID}:metadata`);
        const storedGameName = await room.storage.get<string>(`match:${matchID}:gameName`);
        if (!meta || storedGameName !== gameName) continue;

        seenMatchIDs.add(matchID);

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

      const parsed = await parseJsonBody<{ playerID?: string; playerName?: string; credentials?: string }>(req);
      if (!parsed.ok) return parsed.response;
      const body = parsed.body;

      const result = await room.storage.transaction(async (txn) => {
        const meta = await txn.get<Server.MatchData>(`match:${matchID}:metadata`);
        const storedGameName = await txn.get<string>(`match:${matchID}:gameName`);
        if (!meta || storedGameName !== gameName) {
          return { status: 404, error: "Match not found" } as const;
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
          return { status: 409, error: "No available seats" } as const;
        }

        const pid = String(playerID);
        const pidNum = Number(pid);
        if (!meta.players[pidNum] || Number.isNaN(pidNum) || pidNum < 0) {
          return { status: 400, error: "Invalid playerID" } as const;
        }

        const existingPlayer = meta.players[pidNum];

        // If seat is occupied, check for re-join with matching credentials
        if (existingPlayer.name) {
          if (body.credentials && existingPlayer.credentials === body.credentials) {
            // Re-join: preserve original playerName, do NOT advance updatedAt
            return { status: 200, playerID: pid, playerCredentials: existingPlayer.credentials, meta: undefined } as const;
          }
          // Seat is taken and no valid re-join credentials
          return { status: 409, error: "Seat already taken" } as const;
        }

        // New join to empty seat
        const credentials = crypto.randomUUID();
        meta.players[pidNum] = {
          ...existingPlayer,
          name: body.playerName || `Player ${pid}`,
          credentials,
        };
        meta.updatedAt = Date.now();

        await txn.put(`match:${matchID}:metadata`, meta);
        return { status: 200, playerID: pid, playerCredentials: credentials, meta } as const;
      });

      if (result.status === 404 || result.status === 400 || result.status === 409) {
        return errorResponse(result.error, result.status);
      }

      // Re-join case - no metadata mutation, just return credentials
      if (!result.meta) {
        return jsonResponse({ playerID: result.playerID, playerCredentials: result.playerCredentials });
      }

      // New join - sync with match DO
      const matchStub = room.context.parties.match.get(matchID);
      await matchStub.fetch("/metadata", {
        method: "POST",
        body: JSON.stringify(result.meta),
      });

      return jsonResponse({ playerID: result.playerID, playerCredentials: result.playerCredentials });
    }
    return errorResponse("Method not allowed", 405);
  }

  // POST /games/:name/:id/leave
  const leaveMatch = pathname.match(/\/games\/([^/]+)\/([^/]+)\/leave$/);
  if (leaveMatch) {
    if (req.method === "POST") {
      const gameName = decodeURIComponent(leaveMatch[1]);
      const matchID = decodeURIComponent(leaveMatch[2]);

      const game = getGame(gameName);
      if (!game) {
        return errorResponse(`Game "${gameName}" not found`, 404);
      }

      const parsed = await parseJsonBody<{ playerID?: string; credentials?: string }>(req);
      if (!parsed.ok) return parsed.response;
      const body = parsed.body;

      if (!body.playerID) {
        return errorResponse("playerID is required", 400);
      }

      const pid = String(body.playerID);
      const pidNum = Number(pid);
      if (Number.isNaN(pidNum) || pidNum < 0) {
        return errorResponse("Invalid playerID", 400);
      }

      const result = await room.storage.transaction(async (txn) => {
        const meta = await txn.get<Server.MatchData>(`match:${matchID}:metadata`);
        const storedGameName = await txn.get<string>(`match:${matchID}:gameName`);
        if (!meta || storedGameName !== gameName) {
          return { status: 404, error: "Match not found" } as const;
        }

        const player = meta.players[pidNum];
        if (!player) {
          return { status: 400, error: "Invalid playerID" } as const;
        }

        if (!body.credentials || player.credentials !== body.credentials) {
          return { status: 403, error: "Invalid credentials" } as const;
        }

        if (!player.name) {
          return { status: 400, error: "Seat is not occupied" } as const;
        }

        // Free the seat and invalidate old credentials by generating new ones
        meta.players[pidNum] = {
          ...player,
          name: undefined,
          credentials: crypto.randomUUID(),
          data: undefined,
        };
        meta.updatedAt = Date.now();

        await txn.put(`match:${matchID}:metadata`, meta);
        return { status: 200, meta } as const;
      });

      if (result.status !== 200) {
        return errorResponse(result.error, result.status);
      }

      // Sync with match DO
      const matchStub = room.context.parties.match.get(matchID);
      await matchStub.fetch("/metadata", {
        method: "POST",
        body: JSON.stringify(result.meta),
      });

      return jsonResponse({}, 200);
    }
    return errorResponse("Method not allowed", 405);
  }

  // POST /games/:name/:id/update
  const updateMatch = pathname.match(/\/games\/([^/]+)\/([^/]+)\/update$/);
  if (updateMatch) {
    if (req.method === "POST") {
      const gameName = decodeURIComponent(updateMatch[1]);
      const matchID = decodeURIComponent(updateMatch[2]);

      const game = getGame(gameName);
      if (!game) {
        return errorResponse(`Game "${gameName}" not found`, 404);
      }

      const parsed = await parseJsonBody<{ playerID?: string; credentials?: string; newName?: string; data?: unknown }>(req);
      if (!parsed.ok) return parsed.response;
      const body = parsed.body;

      if (!body.playerID) {
        return errorResponse("playerID is required", 400);
      }

      const pid = String(body.playerID);
      const pidNum = Number(pid);
      if (Number.isNaN(pidNum) || pidNum < 0) {
        return errorResponse("Invalid playerID", 400);
      }

      const result = await room.storage.transaction(async (txn) => {
        const meta = await txn.get<Server.MatchData>(`match:${matchID}:metadata`);
        const storedGameName = await txn.get<string>(`match:${matchID}:gameName`);
        if (!meta || storedGameName !== gameName) {
          return { status: 404, error: "Match not found" } as const;
        }

        const player = meta.players[pidNum];
        if (!player) {
          return { status: 400, error: "Invalid playerID" } as const;
        }

        if (!body.credentials || player.credentials !== body.credentials) {
          return { status: 403, error: "Invalid credentials" } as const;
        }

        if (body.newName !== undefined) {
          player.name = body.newName;
        }
        if (body.data !== undefined) {
          player.data = body.data;
        }
        meta.updatedAt = Date.now();

        await txn.put(`match:${matchID}:metadata`, meta);
        return { status: 200, meta } as const;
      });

      if (result.status !== 200) {
        return errorResponse(result.error, result.status);
      }

      // Sync with match DO
      const matchStub = room.context.parties.match.get(matchID);
      await matchStub.fetch("/metadata", {
        method: "POST",
        body: JSON.stringify(result.meta),
      });

      return jsonResponse({}, 200);
    }
    return errorResponse("Method not allowed", 405);
  }

  return errorResponse("Not found", 404);
}
