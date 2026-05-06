// @ts-nocheck
import { describe, it, expect, beforeEach } from "vitest";
import { handleLobbyRequest } from "../../src/lobby";
import type * as Party from "partykit/server";
import { registerGame } from "../../src/registry";
import type { Game } from "boardgame.io/dist/types/src/types";

const TestGame: Game = {
  name: "test-lobby-game",
  setup: () => ({ value: 0 }),
  minPlayers: 2,
  maxPlayers: 4,
  moves: {
    increment: ({ G }) => {
      G.value++;
    },
  },
};

registerGame(TestGame);

class MockMatchStub {
  private storage = new Map<string, unknown>();

  async fetch(path: string, opts?: any): Promise<Response> {
    if (path === "/create" || path.endsWith("/create")) {
      if (opts?.body) {
        const body = JSON.parse(opts.body);
        this.storage.set("initialState", body.initialState);
        this.storage.set("metadata", body.metadata);
        this.storage.set("gameName", body.gameName);
      }
      return new Response("OK", { status: 200 });
    }
    if (path === "/metadata" || path.endsWith("/metadata")) {
      if (opts?.body) {
        this.storage.set("metadata", JSON.parse(opts.body));
      }
      return new Response(
        JSON.stringify({ metadata: this.storage.get("metadata") }),
        { status: 200 }
      );
    }
    return new Response("Not found", { status: 404 });
  }
}

class MockStorage implements Party.Storage {
  private data = new Map<string, unknown>();

  async get<T = unknown>(key: string): Promise<T | undefined> {
    return this.data.get(key) as T | undefined;
  }
  async put<T>(key: string, value: T): Promise<void> {
    this.data.set(key, value);
  }
  async delete(key: string): Promise<boolean> {
    return this.data.delete(key);
  }
  async deleteAll(): Promise<void> {
    this.data.clear();
  }
  async list<T = unknown>(options?: { prefix?: string }): Promise<Map<string, T>> {
    const prefix = options?.prefix || "";
    const result = new Map<string, T>();
    for (const [key, value] of this.data) {
      if (key.startsWith(prefix)) {
        result.set(key, value as T);
      }
    }
    return result;
  }
  async getAlarm(): Promise<number | null> {
    return null;
  }
  async setAlarm(): Promise<void> {}
  async deleteAlarm(): Promise<void> {}
  async transaction<T>(closure: (txn: Party.Storage) => Promise<T>): Promise<T> {
    return closure(this);
  }
  sync(): Promise<void> {
    return Promise.resolve();
  }
  transactionSync<T>(closure: (txn: Party.Storage) => T): T {
    return closure(this);
  }
}

function createMockRoom(storage: MockStorage): Party.Room {
  const matchStubs = new Map<string, MockMatchStub>();
  return {
    id: "lobby",
    name: "lobby",
    storage,
    context: {
      parties: {
        match: {
          get: (id: string) => {
            if (!matchStubs.has(id)) {
              matchStubs.set(id, new MockMatchStub());
            }
            return matchStubs.get(id)!;
          },
        },
      },
    },
  } as unknown as Party.Room;
}

function createRequest(
  method: string,
  pathname: string,
  body?: unknown,
  headers?: Record<string, string>
): Party.Request {
  const url = `http://test.local${pathname}`;
  const h = new Headers();
  if (body !== undefined) {
    h.set("Content-Type", headers?.["Content-Type"] || "application/json");
  }
  for (const [key, value] of Object.entries(headers || {})) {
    h.set(key, value);
  }
  return new Request(url, {
    method,
    headers: h,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }) as Party.Request;
}

describe("Lobby API", () => {
  let storage: MockStorage;
  let room: Party.Room;

  beforeEach(() => {
    storage = new MockStorage();
    room = createMockRoom(storage);
  });

  describe("GET /games", () => {
    it("returns string[] of registered game names", async () => {
      const req = createRequest("GET", "/games");
      const res = await handleLobbyRequest(req, room);
      expect(res.status).toBe(200);
      const body = (await res.json()) as string[];
      expect(Array.isArray(body)).toBe(true);
      expect(body).toContain("tic-tac-toe");
      expect(body).toContain("test-lobby-game");
    });

    it("returns 405 for non-GET methods", async () => {
      const req = createRequest("POST", "/games", {});
      const res = await handleLobbyRequest(req, room);
      expect(res.status).toBe(405);
    });
  });

  describe("POST /games/:name/create", () => {
    it("returns 201 with valid matchID", async () => {
      const req = createRequest("POST", "/games/test-lobby-game/create", {
        numPlayers: 2,
      });
      const res = await handleLobbyRequest(req, room);
      expect(res.status).toBe(201);
      const body = (await res.json()) as { matchID: string };
      expect(body.matchID).toBeDefined();
      expect(typeof body.matchID).toBe("string");
      expect(body.matchID.length).toBeGreaterThan(0);
    });

    it("rejects unknown games with 404", async () => {
      const req = createRequest("POST", "/games/does-not-exist/create", {
        numPlayers: 2,
      });
      const res = await handleLobbyRequest(req, room);
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("not found");
    });

    it("rejects numPlayers < 1", async () => {
      const req = createRequest("POST", "/games/test-lobby-game/create", {
        numPlayers: 0,
      });
      const res = await handleLobbyRequest(req, room);
      expect(res.status).toBe(400);
    });

    it("rejects negative numPlayers", async () => {
      const req = createRequest("POST", "/games/test-lobby-game/create", {
        numPlayers: -1,
      });
      const res = await handleLobbyRequest(req, room);
      expect(res.status).toBe(400);
    });

    it("rejects non-integer numPlayers", async () => {
      const req = createRequest("POST", "/games/test-lobby-game/create", {
        numPlayers: 2.5,
      });
      const res = await handleLobbyRequest(req, room);
      expect(res.status).toBe(400);
    });

    it("rejects numPlayers > maxPlayers", async () => {
      const req = createRequest("POST", "/games/test-lobby-game/create", {
        numPlayers: 5,
      });
      const res = await handleLobbyRequest(req, room);
      expect(res.status).toBe(400);
    });

    it("rejects numPlayers < minPlayers", async () => {
      const req = createRequest("POST", "/games/test-lobby-game/create", {
        numPlayers: 1,
      });
      const res = await handleLobbyRequest(req, room);
      expect(res.status).toBe(400);
    });

    it("accepts numPlayers at minPlayers boundary", async () => {
      const req = createRequest("POST", "/games/test-lobby-game/create", {
        numPlayers: 2,
      });
      const res = await handleLobbyRequest(req, room);
      expect(res.status).toBe(201);
    });

    it("accepts numPlayers at maxPlayers boundary", async () => {
      const req = createRequest("POST", "/games/test-lobby-game/create", {
        numPlayers: 4,
      });
      const res = await handleLobbyRequest(req, room);
      expect(res.status).toBe(201);
    });

    it("rejects malformed JSON with 400", async () => {
      const req = new Request("http://test.local/games/test-lobby-game/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{ invalid json",
      }) as Party.Request;
      const res = await handleLobbyRequest(req, room);
      expect(res.status).toBe(400);
    });

    it("rejects non-JSON content-type with 415", async () => {
      const req = new Request("http://test.local/games/test-lobby-game/create", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: "not json",
      }) as Party.Request;
      const res = await handleLobbyRequest(req, room);
      expect(res.status).toBe(415);
    });

    it("allows default numPlayers when not specified", async () => {
      const req = createRequest("POST", "/games/tic-tac-toe/create", {});
      const res = await handleLobbyRequest(req, room);
      expect(res.status).toBe(201);
      const body = (await res.json()) as { matchID: string };
      expect(body.matchID).toBeDefined();
    });

    it("stores setupData in match metadata", async () => {
      const req = createRequest("POST", "/games/test-lobby-game/create", {
        numPlayers: 2,
        setupData: { custom: true },
      });
      const res = await handleLobbyRequest(req, room);
      expect(res.status).toBe(201);
      const body = (await res.json()) as { matchID: string };

      // Verify metadata stored
      const meta = await storage.get(`match:${body.matchID}:metadata`);
      expect(meta).toBeDefined();
      expect((meta as any).setupData).toEqual({ custom: true });
    });
  });

  describe("GET /games/:name", () => {
    it("returns match list for registered game", async () => {
      // Create a match
      const createReq = createRequest("POST", "/games/test-lobby-game/create", {
        numPlayers: 2,
      });
      const createRes = await handleLobbyRequest(createReq, room);
      const { matchID } = (await createRes.json()) as { matchID: string };

      const req = createRequest("GET", "/games/test-lobby-game");
      const res = await handleLobbyRequest(req, room);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { matches: any[] };
      expect(body.matches).toBeDefined();
      expect(Array.isArray(body.matches)).toBe(true);
      expect(body.matches.length).toBe(1);
      expect(body.matches[0].matchID).toBe(matchID);
      expect(body.matches[0].gameName).toBe("test-lobby-game");
      expect(body.matches[0].players).toBeDefined();
      expect(Array.isArray(body.matches[0].players)).toBe(true);
    });

    it("returns empty matches array when no matches exist", async () => {
      const req = createRequest("GET", "/games/test-lobby-game");
      const res = await handleLobbyRequest(req, room);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { matches: any[] };
      expect(body.matches).toEqual([]);
    });

    it("rejects unknown game with 404", async () => {
      const req = createRequest("GET", "/games/does-not-exist");
      const res = await handleLobbyRequest(req, room);
      expect(res.status).toBe(404);
    });

    it("does not include credentials in match list", async () => {
      // Create and join
      const createReq = createRequest("POST", "/games/test-lobby-game/create", {
        numPlayers: 2,
      });
      const createRes = await handleLobbyRequest(createReq, room);
      const { matchID } = (await createRes.json()) as { matchID: string };

      const joinReq = createRequest("POST", `/games/test-lobby-game/${matchID}/join`, {
        playerID: "0",
        playerName: "Alice",
      });
      await handleLobbyRequest(joinReq, room);

      const req = createRequest("GET", "/games/test-lobby-game");
      const res = await handleLobbyRequest(req, room);
      const body = (await res.json()) as { matches: any[] };
      const match = body.matches[0];
      expect(match.players[0].name).toBe("Alice");
      expect(match.players[0].credentials).toBeUndefined();
    });
  });

  describe("GET /games/:name/:id", () => {
    it("returns match details with players array", async () => {
      const createReq = createRequest("POST", "/games/test-lobby-game/create", {
        numPlayers: 2,
      });
      const createRes = await handleLobbyRequest(createReq, room);
      const { matchID } = (await createRes.json()) as { matchID: string };

      const req = createRequest("GET", `/games/test-lobby-game/${matchID}`);
      const res = await handleLobbyRequest(req, room);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.matchID).toBe(matchID);
      expect(body.gameName).toBe("test-lobby-game");
      expect(body.players).toBeDefined();
      expect(Array.isArray(body.players)).toBe(true);
      expect(body.players.length).toBe(2);
    });

    it("rejects unknown match with 404", async () => {
      const req = createRequest("GET", "/games/test-lobby-game/not-a-real-match");
      const res = await handleLobbyRequest(req, room);
      expect(res.status).toBe(404);
    });

    it("rejects match for wrong game with 404", async () => {
      const createReq = createRequest("POST", "/games/test-lobby-game/create", {
        numPlayers: 2,
      });
      const createRes = await handleLobbyRequest(createReq, room);
      const { matchID } = (await createRes.json()) as { matchID: string };

      const req = createRequest("GET", `/games/tic-tac-toe/${matchID}`);
      const res = await handleLobbyRequest(req, room);
      expect(res.status).toBe(404);
    });

    it("does not include credentials in match details", async () => {
      const createReq = createRequest("POST", "/games/test-lobby-game/create", {
        numPlayers: 2,
      });
      const createRes = await handleLobbyRequest(createReq, room);
      const { matchID } = (await createRes.json()) as { matchID: string };

      const joinReq = createRequest("POST", `/games/test-lobby-game/${matchID}/join`, {
        playerID: "0",
        playerName: "Alice",
      });
      await handleLobbyRequest(joinReq, room);

      const req = createRequest("GET", `/games/test-lobby-game/${matchID}`);
      const res = await handleLobbyRequest(req, room);
      const body = await res.json();
      expect(body.players[0].name).toBe("Alice");
      expect(body.players[0].credentials).toBeUndefined();
    });
  });

  describe("POST /games/:name/:id/join", () => {
    it("joins empty seat and returns credentials", async () => {
      const createReq = createRequest("POST", "/games/test-lobby-game/create", {
        numPlayers: 2,
      });
      const createRes = await handleLobbyRequest(createReq, room);
      const { matchID } = (await createRes.json()) as { matchID: string };

      const joinReq = createRequest("POST", `/games/test-lobby-game/${matchID}/join`, {
        playerID: "0",
        playerName: "Alice",
      });
      const joinRes = await handleLobbyRequest(joinReq, room);
      expect(joinRes.status).toBe(200);
      const body = (await joinRes.json()) as { playerID: string; playerCredentials: string };
      expect(body.playerID).toBe("0");
      expect(body.playerCredentials).toBeDefined();
      expect(typeof body.playerCredentials).toBe("string");
    });

    it("auto-assigns first available seat without playerID", async () => {
      const createReq = createRequest("POST", "/games/test-lobby-game/create", {
        numPlayers: 2,
      });
      const createRes = await handleLobbyRequest(createReq, room);
      const { matchID } = (await createRes.json()) as { matchID: string };

      const joinReq = createRequest("POST", `/games/test-lobby-game/${matchID}/join`, {
        playerName: "Auto",
      });
      const joinRes = await handleLobbyRequest(joinReq, room);
      expect(joinRes.status).toBe(200);
      const body = (await joinRes.json()) as { playerID: string; playerCredentials: string };
      expect(body.playerID).toBe("0");
    });

    it("rejects joining occupied seat without matching credentials", async () => {
      const createReq = createRequest("POST", "/games/test-lobby-game/create", {
        numPlayers: 2,
      });
      const createRes = await handleLobbyRequest(createReq, room);
      const { matchID } = (await createRes.json()) as { matchID: string };

      // Join player 0
      const joinReq = createRequest("POST", `/games/test-lobby-game/${matchID}/join`, {
        playerID: "0",
        playerName: "Alice",
      });
      await handleLobbyRequest(joinReq, room);

      // Try to join player 0 again without credentials
      const secondJoinReq = createRequest("POST", `/games/test-lobby-game/${matchID}/join`, {
        playerID: "0",
        playerName: "Bob",
      });
      const secondJoinRes = await handleLobbyRequest(secondJoinReq, room);
      expect([403, 409]).toContain(secondJoinRes.status);
    });

    it("rejects invalid playerID values", async () => {
      const createReq = createRequest("POST", "/games/test-lobby-game/create", {
        numPlayers: 2,
      });
      const createRes = await handleLobbyRequest(createReq, room);
      const { matchID } = (await createRes.json()) as { matchID: string };

      for (const invalidID of ["-1", "abc", "99", "2.5"]) {
        const joinReq = createRequest("POST", `/games/test-lobby-game/${matchID}/join`, {
          playerID: invalidID,
          playerName: "Hacker",
        });
        const joinRes = await handleLobbyRequest(joinReq, room);
        expect(joinRes.status).toBe(400);
      }
    });

    it("rejects join to unknown game with 404", async () => {
      const joinReq = createRequest("POST", "/games/does-not-exist/match-id/join", {
        playerID: "0",
        playerName: "Alice",
      });
      const joinRes = await handleLobbyRequest(joinReq, room);
      expect(joinRes.status).toBe(404);
    });

    it("rejects join to unknown match with 404", async () => {
      const joinReq = createRequest("POST", "/games/test-lobby-game/not-a-match/join", {
        playerID: "0",
        playerName: "Alice",
      });
      const joinRes = await handleLobbyRequest(joinReq, room);
      expect(joinRes.status).toBe(404);
    });
  });

  describe("POST /games/:name/:id/leave", () => {
    it("rejects leave with missing credentials", async () => {
      const createReq = createRequest("POST", "/games/test-lobby-game/create", {
        numPlayers: 2,
      });
      const createRes = await handleLobbyRequest(createReq, room);
      const { matchID } = (await createRes.json()) as { matchID: string };

      const joinReq = createRequest("POST", `/games/test-lobby-game/${matchID}/join`, {
        playerID: "0",
        playerName: "Alice",
      });
      await handleLobbyRequest(joinReq, room);

      const leaveReq = createRequest("POST", `/games/test-lobby-game/${matchID}/leave`, {
        playerID: "0",
      });
      const leaveRes = await handleLobbyRequest(leaveReq, room);
      expect([401, 403]).toContain(leaveRes.status);
    });

    it("rejects leave with wrong credentials", async () => {
      const createReq = createRequest("POST", "/games/test-lobby-game/create", {
        numPlayers: 2,
      });
      const createRes = await handleLobbyRequest(createReq, room);
      const { matchID } = (await createRes.json()) as { matchID: string };

      const joinReq = createRequest("POST", `/games/test-lobby-game/${matchID}/join`, {
        playerID: "0",
        playerName: "Alice",
      });
      await handleLobbyRequest(joinReq, room);

      const leaveReq = createRequest("POST", `/games/test-lobby-game/${matchID}/leave`, {
        playerID: "0",
        credentials: "wrong-creds",
      });
      const leaveRes = await handleLobbyRequest(leaveReq, room);
      expect([401, 403]).toContain(leaveRes.status);
    });

    it("accepts leave with valid credentials and frees seat", async () => {
      const createReq = createRequest("POST", "/games/test-lobby-game/create", {
        numPlayers: 2,
      });
      const createRes = await handleLobbyRequest(createReq, room);
      const { matchID } = (await createRes.json()) as { matchID: string };

      const joinReq = createRequest("POST", `/games/test-lobby-game/${matchID}/join`, {
        playerID: "0",
        playerName: "Alice",
      });
      const joinRes = await handleLobbyRequest(joinReq, room);
      const { playerCredentials } = (await joinRes.json()) as { playerCredentials: string };

      const leaveReq = createRequest("POST", `/games/test-lobby-game/${matchID}/leave`, {
        playerID: "0",
        credentials: playerCredentials,
      });
      const leaveRes = await handleLobbyRequest(leaveReq, room);
      expect(leaveRes.status).toBe(200);

      // Verify seat is freed in match details
      const detailReq = createRequest("GET", `/games/test-lobby-game/${matchID}`);
      const detailRes = await handleLobbyRequest(detailReq, room);
      const detail = await detailRes.json();
      expect(detail.players[0].name).toBeUndefined();
    });

    it("invalidates old credentials after leave", async () => {
      const createReq = createRequest("POST", "/games/test-lobby-game/create", {
        numPlayers: 2,
      });
      const createRes = await handleLobbyRequest(createReq, room);
      const { matchID } = (await createRes.json()) as { matchID: string };

      const joinReq = createRequest("POST", `/games/test-lobby-game/${matchID}/join`, {
        playerID: "0",
        playerName: "Alice",
      });
      const joinRes = await handleLobbyRequest(joinReq, room);
      const { playerCredentials } = (await joinRes.json()) as { playerCredentials: string };

      const leaveReq = createRequest("POST", `/games/test-lobby-game/${matchID}/leave`, {
        playerID: "0",
        credentials: playerCredentials,
      });
      await handleLobbyRequest(leaveReq, room);

      // Try to update with old credentials
      const updateReq = createRequest("POST", `/games/test-lobby-game/${matchID}/update`, {
        playerID: "0",
        credentials: playerCredentials,
        newName: "Should Fail",
      });
      const updateRes = await handleLobbyRequest(updateReq, room);
      expect([401, 403]).toContain(updateRes.status);

      // Try to leave again with old credentials
      const leaveAgainReq = createRequest("POST", `/games/test-lobby-game/${matchID}/leave`, {
        playerID: "0",
        credentials: playerCredentials,
      });
      const leaveAgainRes = await handleLobbyRequest(leaveAgainReq, room);
      expect([401, 403]).toContain(leaveAgainRes.status);
    });

    it("allows re-join after leave with new credentials", async () => {
      const createReq = createRequest("POST", "/games/test-lobby-game/create", {
        numPlayers: 2,
      });
      const createRes = await handleLobbyRequest(createReq, room);
      const { matchID } = (await createRes.json()) as { matchID: string };

      const joinReq = createRequest("POST", `/games/test-lobby-game/${matchID}/join`, {
        playerID: "0",
        playerName: "Alice",
      });
      const joinRes = await handleLobbyRequest(joinReq, room);
      const { playerCredentials } = (await joinRes.json()) as { playerCredentials: string };

      const leaveReq = createRequest("POST", `/games/test-lobby-game/${matchID}/leave`, {
        playerID: "0",
        credentials: playerCredentials,
      });
      await handleLobbyRequest(leaveReq, room);

      const rejoinReq = createRequest("POST", `/games/test-lobby-game/${matchID}/join`, {
        playerID: "0",
        playerName: "Bob",
      });
      const rejoinRes = await handleLobbyRequest(rejoinReq, room);
      expect(rejoinRes.status).toBe(200);
      const rejoinBody = (await rejoinRes.json()) as { playerID: string; playerCredentials: string };
      expect(rejoinBody.playerID).toBe("0");
      expect(rejoinBody.playerCredentials).toBeDefined();
      expect(rejoinBody.playerCredentials).not.toBe(playerCredentials);
    });

    it("rejects leave for unknown match with 404", async () => {
      const leaveReq = createRequest("POST", "/games/test-lobby-game/not-a-match/leave", {
        playerID: "0",
        credentials: "some-creds",
      });
      const leaveRes = await handleLobbyRequest(leaveReq, room);
      expect(leaveRes.status).toBe(404);
    });

    it("rejects leave for unknown game with 404", async () => {
      const leaveReq = createRequest("POST", "/games/does-not-exist/match-id/leave", {
        playerID: "0",
        credentials: "some-creds",
      });
      const leaveRes = await handleLobbyRequest(leaveReq, room);
      expect(leaveRes.status).toBe(404);
    });

    it("returns 405 for non-POST methods on leave", async () => {
      const leaveReq = createRequest("GET", "/games/test-lobby-game/match-id/leave");
      const leaveRes = await handleLobbyRequest(leaveReq, room);
      expect(leaveRes.status).toBe(405);
    });

    it("leave rejects non-JSON content-type with 415", async () => {
      const leaveReq = new Request("http://test.local/games/test-lobby-game/match-id/leave", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: "not json",
      }) as Party.Request;
      const leaveRes = await handleLobbyRequest(leaveReq, room);
      expect(leaveRes.status).toBe(415);
    });
  });

  describe("POST /games/:name/:id/update", () => {
    it("rejects update with missing credentials", async () => {
      const createReq = createRequest("POST", "/games/test-lobby-game/create", {
        numPlayers: 2,
      });
      const createRes = await handleLobbyRequest(createReq, room);
      const { matchID } = (await createRes.json()) as { matchID: string };

      const joinReq = createRequest("POST", `/games/test-lobby-game/${matchID}/join`, {
        playerID: "0",
        playerName: "Alice",
      });
      await handleLobbyRequest(joinReq, room);

      const updateReq = createRequest("POST", `/games/test-lobby-game/${matchID}/update`, {
        playerID: "0",
        newName: "NewAlice",
      });
      const updateRes = await handleLobbyRequest(updateReq, room);
      expect([401, 403]).toContain(updateRes.status);
    });

    it("rejects update with wrong credentials", async () => {
      const createReq = createRequest("POST", "/games/test-lobby-game/create", {
        numPlayers: 2,
      });
      const createRes = await handleLobbyRequest(createReq, room);
      const { matchID } = (await createRes.json()) as { matchID: string };

      const joinReq = createRequest("POST", `/games/test-lobby-game/${matchID}/join`, {
        playerID: "0",
        playerName: "Alice",
      });
      await handleLobbyRequest(joinReq, room);

      const updateReq = createRequest("POST", `/games/test-lobby-game/${matchID}/update`, {
        playerID: "0",
        credentials: "wrong-creds",
        newName: "NewAlice",
      });
      const updateRes = await handleLobbyRequest(updateReq, room);
      expect([401, 403]).toContain(updateRes.status);
    });

    it("accepts update with valid credentials and mutates metadata", async () => {
      const createReq = createRequest("POST", "/games/test-lobby-game/create", {
        numPlayers: 2,
      });
      const createRes = await handleLobbyRequest(createReq, room);
      const { matchID } = (await createRes.json()) as { matchID: string };

      const joinReq = createRequest("POST", `/games/test-lobby-game/${matchID}/join`, {
        playerID: "0",
        playerName: "Alice",
      });
      const joinRes = await handleLobbyRequest(joinReq, room);
      const { playerCredentials } = (await joinRes.json()) as { playerCredentials: string };

      const updateReq = createRequest("POST", `/games/test-lobby-game/${matchID}/update`, {
        playerID: "0",
        credentials: playerCredentials,
        newName: "AliceUpdated",
      });
      const updateRes = await handleLobbyRequest(updateReq, room);
      expect(updateRes.status).toBe(200);

      // Verify in match details
      const detailReq = createRequest("GET", `/games/test-lobby-game/${matchID}`);
      const detailRes = await handleLobbyRequest(detailReq, room);
      const detail = await detailRes.json();
      expect(detail.players[0].name).toBe("AliceUpdated");
    });

    it("advances updatedAt on successful update", async () => {
      const createReq = createRequest("POST", "/games/test-lobby-game/create", {
        numPlayers: 2,
      });
      const createRes = await handleLobbyRequest(createReq, room);
      const { matchID } = (await createRes.json()) as { matchID: string };

      const joinReq = createRequest("POST", `/games/test-lobby-game/${matchID}/join`, {
        playerID: "0",
        playerName: "Alice",
      });
      const joinRes = await handleLobbyRequest(joinReq, room);
      const { playerCredentials } = (await joinRes.json()) as { playerCredentials: string };

      const detailBeforeReq = createRequest("GET", `/games/test-lobby-game/${matchID}`);
      const detailBeforeRes = await handleLobbyRequest(detailBeforeReq, room);
      const detailBefore = await detailBeforeRes.json();

      await new Promise((r) => setTimeout(r, 10));

      const updateReq = createRequest("POST", `/games/test-lobby-game/${matchID}/update`, {
        playerID: "0",
        credentials: playerCredentials,
        newName: "AliceUpdated",
      });
      await handleLobbyRequest(updateReq, room);

      const detailAfterReq = createRequest("GET", `/games/test-lobby-game/${matchID}`);
      const detailAfterRes = await handleLobbyRequest(detailAfterReq, room);
      const detailAfter = await detailAfterRes.json();
      expect(detailAfter.updatedAt).toBeGreaterThan(detailBefore.updatedAt);
    });

    it("empty update returns 200 and advances updatedAt", async () => {
      const createReq = createRequest("POST", "/games/test-lobby-game/create", {
        numPlayers: 2,
      });
      const createRes = await handleLobbyRequest(createReq, room);
      const { matchID } = (await createRes.json()) as { matchID: string };

      const joinReq = createRequest("POST", `/games/test-lobby-game/${matchID}/join`, {
        playerID: "0",
        playerName: "Alice",
      });
      const joinRes = await handleLobbyRequest(joinReq, room);
      const { playerCredentials } = (await joinRes.json()) as { playerCredentials: string };

      const detailBeforeReq = createRequest("GET", `/games/test-lobby-game/${matchID}`);
      const detailBeforeRes = await handleLobbyRequest(detailBeforeReq, room);
      const detailBefore = await detailBeforeRes.json();

      await new Promise((r) => setTimeout(r, 10));

      const updateReq = createRequest("POST", `/games/test-lobby-game/${matchID}/update`, {
        playerID: "0",
        credentials: playerCredentials,
      });
      const updateRes = await handleLobbyRequest(updateReq, room);
      expect(updateRes.status).toBe(200);

      const detailAfterReq = createRequest("GET", `/games/test-lobby-game/${matchID}`);
      const detailAfterRes = await handleLobbyRequest(detailAfterReq, room);
      const detailAfter = await detailAfterRes.json();
      expect(detailAfter.updatedAt).toBeGreaterThan(detailBefore.updatedAt);
      expect(detailAfter.players[0].name).toBe("Alice");
    });

    it("persists update in match list", async () => {
      const createReq = createRequest("POST", "/games/test-lobby-game/create", {
        numPlayers: 2,
      });
      const createRes = await handleLobbyRequest(createReq, room);
      const { matchID } = (await createRes.json()) as { matchID: string };

      const joinReq = createRequest("POST", `/games/test-lobby-game/${matchID}/join`, {
        playerID: "0",
        playerName: "Alice",
      });
      const joinRes = await handleLobbyRequest(joinReq, room);
      const { playerCredentials } = (await joinRes.json()) as { playerCredentials: string };

      const updateReq = createRequest("POST", `/games/test-lobby-game/${matchID}/update`, {
        playerID: "0",
        credentials: playerCredentials,
        newName: "AliceInList",
      });
      await handleLobbyRequest(updateReq, room);

      const listReq = createRequest("GET", "/games/test-lobby-game");
      const listRes = await handleLobbyRequest(listReq, room);
      const list = await listRes.json();
      expect(list.matches[0].players[0].name).toBe("AliceInList");
    });

    it("rejects update for unknown match with 404", async () => {
      const updateReq = createRequest("POST", "/games/test-lobby-game/not-a-match/update", {
        playerID: "0",
        credentials: "some-creds",
        newName: "X",
      });
      const updateRes = await handleLobbyRequest(updateReq, room);
      expect(updateRes.status).toBe(404);
    });

    it("rejects update for unknown game with 404", async () => {
      const updateReq = createRequest("POST", "/games/does-not-exist/match-id/update", {
        playerID: "0",
        credentials: "some-creds",
        newName: "X",
      });
      const updateRes = await handleLobbyRequest(updateReq, room);
      expect(updateRes.status).toBe(404);
    });

    it("returns 405 for non-POST methods on update", async () => {
      const updateReq = createRequest("GET", "/games/test-lobby-game/match-id/update");
      const updateRes = await handleLobbyRequest(updateReq, room);
      expect(updateRes.status).toBe(405);
    });

    it("update rejects non-JSON content-type with 415", async () => {
      const updateReq = new Request("http://test.local/games/test-lobby-game/match-id/update", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: "not json",
      }) as Party.Request;
      const updateRes = await handleLobbyRequest(updateReq, room);
      expect(updateRes.status).toBe(415);
    });
  });

  describe("join edge cases and credentials", () => {
    it("returns distinct credentials per player", async () => {
      const createReq = createRequest("POST", "/games/test-lobby-game/create", {
        numPlayers: 2,
      });
      const createRes = await handleLobbyRequest(createReq, room);
      const { matchID } = (await createRes.json()) as { matchID: string };

      const join0Req = createRequest("POST", `/games/test-lobby-game/${matchID}/join`, {
        playerID: "0",
        playerName: "Alice",
      });
      const join0Res = await handleLobbyRequest(join0Req, room);
      const { playerCredentials: creds0 } = (await join0Res.json()) as { playerCredentials: string };

      const join1Req = createRequest("POST", `/games/test-lobby-game/${matchID}/join`, {
        playerID: "1",
        playerName: "Bob",
      });
      const join1Res = await handleLobbyRequest(join1Req, room);
      const { playerCredentials: creds1 } = (await join1Res.json()) as { playerCredentials: string };

      expect(creds0).not.toBe(creds1);
    });

    it("rejects join when all seats are full", async () => {
      const createReq = createRequest("POST", "/games/test-lobby-game/create", {
        numPlayers: 2,
      });
      const createRes = await handleLobbyRequest(createReq, room);
      const { matchID } = (await createRes.json()) as { matchID: string };

      await handleLobbyRequest(createRequest("POST", `/games/test-lobby-game/${matchID}/join`, {
        playerID: "0",
        playerName: "Alice",
      }), room);
      await handleLobbyRequest(createRequest("POST", `/games/test-lobby-game/${matchID}/join`, {
        playerID: "1",
        playerName: "Bob",
      }), room);

      // Try to join without playerID - should fail (no available seats)
      const thirdJoinReq = createRequest("POST", `/games/test-lobby-game/${matchID}/join`, {
        playerName: "Charlie",
      });
      const thirdJoinRes = await handleLobbyRequest(thirdJoinReq, room);
      expect([400, 409]).toContain(thirdJoinRes.status);
    });

    it("preserves playerName and does not advance updatedAt on re-join with matching credentials", async () => {
      const createReq = createRequest("POST", "/games/test-lobby-game/create", {
        numPlayers: 2,
      });
      const createRes = await handleLobbyRequest(createReq, room);
      const { matchID } = (await createRes.json()) as { matchID: string };

      const joinReq = createRequest("POST", `/games/test-lobby-game/${matchID}/join`, {
        playerID: "0",
        playerName: "Alice",
      });
      const joinRes = await handleLobbyRequest(joinReq, room);
      const { playerCredentials } = (await joinRes.json()) as { playerCredentials: string };

      const detailBeforeReq = createRequest("GET", `/games/test-lobby-game/${matchID}`);
      const detailBeforeRes = await handleLobbyRequest(detailBeforeReq, room);
      const detailBefore = await detailBeforeRes.json();

      await new Promise((r) => setTimeout(r, 10));

      const rejoinReq = createRequest("POST", `/games/test-lobby-game/${matchID}/join`, {
        playerID: "0",
        playerName: "ShouldNotChange",
        credentials: playerCredentials,
      });
      const rejoinRes = await handleLobbyRequest(rejoinReq, room);
      expect(rejoinRes.status).toBe(200);
      const rejoinBody = (await rejoinRes.json()) as { playerID: string; playerCredentials: string };
      expect(rejoinBody.playerCredentials).toBe(playerCredentials);

      const detailAfterReq = createRequest("GET", `/games/test-lobby-game/${matchID}`);
      const detailAfterRes = await handleLobbyRequest(detailAfterReq, room);
      const detailAfter = await detailAfterRes.json();
      expect(detailAfter.players[0].name).toBe("Alice");
      expect(detailAfter.updatedAt).toBe(detailBefore.updatedAt);
    });

    it("second join to same occupied seat fails", async () => {
      const createReq = createRequest("POST", "/games/test-lobby-game/create", {
        numPlayers: 2,
      });
      const createRes = await handleLobbyRequest(createReq, room);
      const { matchID } = (await createRes.json()) as { matchID: string };

      const joinReq = createRequest("POST", `/games/test-lobby-game/${matchID}/join`, {
        playerID: "0",
        playerName: "Alice",
      });
      await handleLobbyRequest(joinReq, room);

      const secondJoinReq = createRequest("POST", `/games/test-lobby-game/${matchID}/join`, {
        playerID: "0",
        playerName: "Bob",
      });
      const secondJoinRes = await handleLobbyRequest(secondJoinReq, room);
      expect([403, 409]).toContain(secondJoinRes.status);
    });
  });

  describe("POST content-type validation", () => {
    it("join rejects non-JSON content-type with 415", async () => {
      const createReq = createRequest("POST", "/games/test-lobby-game/create", {
        numPlayers: 2,
      });
      const createRes = await handleLobbyRequest(createReq, room);
      const { matchID } = (await createRes.json()) as { matchID: string };

      const joinReq = new Request(`http://test.local/games/test-lobby-game/${matchID}/join`, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: "not json",
      }) as Party.Request;
      const joinRes = await handleLobbyRequest(joinReq, room);
      expect(joinRes.status).toBe(415);
    });

    it("does not mutate state on malformed JSON", async () => {
      const createReq = createRequest("POST", "/games/test-lobby-game/create", {
        numPlayers: 2,
      });
      const createRes = await handleLobbyRequest(createReq, room);
      const { matchID } = (await createRes.json()) as { matchID: string };

      // Record pre-attempt state
      const metaBefore = await storage.get(`match:${matchID}:metadata`);

      const badReq = new Request(`http://test.local/games/test-lobby-game/${matchID}/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{ bad json",
      }) as Party.Request;
      const badRes = await handleLobbyRequest(badReq, room);
      expect(badRes.status).toBe(400);

      const metaAfter = await storage.get(`match:${matchID}:metadata`);
      expect(metaAfter).toEqual(metaBefore);
    });
  });

  describe("unsupported methods", () => {
    it("PUT /games/:name/create returns 405", async () => {
      const req = createRequest("PUT", "/games/test-lobby-game/create", { numPlayers: 2 });
      const res = await handleLobbyRequest(req, room);
      expect(res.status).toBe(405);
    });

    it("DELETE /games/:name/:id returns 405", async () => {
      const req = createRequest("DELETE", "/games/test-lobby-game/match-id");
      const res = await handleLobbyRequest(req, room);
      expect(res.status).toBe(405);
    });

    it("PATCH /games/:name/:id/join returns 405", async () => {
      const req = createRequest("PATCH", "/games/test-lobby-game/match-id/join", {});
      const res = await handleLobbyRequest(req, room);
      expect(res.status).toBe(405);
    });
  });
});
