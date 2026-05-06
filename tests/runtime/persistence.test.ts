// @ts-nocheck
import { describe, it, expect, beforeEach } from "vitest";
import { PartyKitStorage } from "../../src/storage";
import { MatchRoom } from "../../src/match-room";
import { registerGame, getGame } from "../../src/registry";
import type { Game } from "boardgame.io/dist/types/src/types";
import type * as Party from "partykit/server";

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

  async getAlarm(): Promise<number | null> { return null; }
  async setAlarm(): Promise<void> {}
  async deleteAlarm(): Promise<void> {}
  async transaction<T>(closure: (txn: Party.Storage) => Promise<T>): Promise<T> { return closure(this); }
  sync(): Promise<void> { return Promise.resolve(); }
  transactionSync<T>(closure: (txn: Party.Storage) => T): T { return closure(this); }
}

const TicTacToeGame: Game = {
  name: "tic-tac-toe",
  minPlayers: 2,
  maxPlayers: 2,
  setup: () => ({ cells: Array(9).fill(null) }),
  moves: {
    clickCell: ({ G, playerID }, id: number) => {
      if (G.cells[id] !== null) return "INVALID_MOVE";
      G.cells[id] = playerID;
    },
  },
};

registerGame(TicTacToeGame);

function createMockSocket(id = "socket-1") {
  const emitted: Array<{ event: string; args: unknown[] }> = [];
  const rooms = new Set<string>();
  return {
    id,
    emitted,
    rooms,
    matchID: undefined as string | undefined,
    playerID: undefined as string | undefined,
    credentials: undefined as string | undefined,
    join(room: string) { rooms.add(room); },
    emit(event: string, ...args: unknown[]) { emitted.push({ event, args }); },
    nsp: {
      adapter: { sids: new Map() },
      sockets: new Map(),
      to: () => ({ emit: () => {} }),
    },
  };
}

function createMockLobby() {
  const storage = new Map<string, unknown>();
  return {
    parties: {
      match: {
        get: (id: string) => ({
          fetch: async (path: string, opts?: any) => {
            if (path === "/gameName" || path.endsWith("/gameName")) {
              return new Response(JSON.stringify({ gameName: storage.get(`match:${id}:gameName`) ?? "tic-tac-toe" }));
            }
            if (path === "/metadata" || path.endsWith("/metadata")) {
              const meta = storage.get(`match:${id}:metadata`);
              return new Response(JSON.stringify({ metadata: meta }));
            }
            if (path === "/state" || path.endsWith("/state")) {
              const state = storage.get(`match:${id}:state`);
              return new Response(JSON.stringify({ state }));
            }
            if (path === "/create" || path.endsWith("/create")) {
              if (opts?.body) {
                const body = JSON.parse(opts.body);
                storage.set(`match:${id}:state`, body.initialState);
                storage.set(`match:${id}:initialState`, body.initialState);
                storage.set(`match:${id}:metadata`, body.metadata);
                storage.set(`match:${id}:gameName`, body.gameName || "tic-tac-toe");
                storage.set(`match:${id}:log`, []);
              }
              return new Response("OK", { status: 200 });
            }
            if (path === "/wipe" || path.endsWith("/wipe")) {
              storage.delete(`match:${id}:state`);
              storage.delete(`match:${id}:initialState`);
              storage.delete(`match:${id}:metadata`);
              storage.delete(`match:${id}:gameName`);
              storage.delete(`match:${id}:log`);
              return new Response("OK", { status: 200 });
            }
            if (path.startsWith("/fetch")) {
              const result: Record<string, unknown> = {};
              if (path.includes("state=true")) result.state = storage.get(`match:${id}:state`);
              if (path.includes("log=true")) result.log = storage.get(`match:${id}:log`) ?? [];
              if (path.includes("metadata=true")) result.metadata = storage.get(`match:${id}:metadata`);
              if (path.includes("initialState=true")) result.initialState = storage.get(`match:${id}:state`);
              return new Response(JSON.stringify(result));
            }
            return new Response("Not found", { status: 404 });
          },
        }),
      },
    },
    storage,
  };
}

describe("Persistence via room.storage", () => {
  let mockStorage: MockStorage;
  let storage: PartyKitStorage;

  beforeEach(() => {
    mockStorage = new MockStorage();
    storage = new PartyKitStorage(mockStorage);
  });

  it("persists state and log after setState", async () => {
    const matchID = "persist-match-1";
    const initialState = {
      G: { cells: Array(9).fill(null) },
      ctx: { numPlayers: 2, playOrder: ["0", "1"], playOrderPos: 0, activePlayers: null, currentPlayer: "0", turn: 1, phase: "default" },
      plugins: {},
      _undo: [],
      _redo: [],
      _stateID: 0,
    };

    await storage.createMatch(matchID, { initialState, metadata: { gameName: "tic-tac-toe", players: {}, createdAt: Date.now(), updatedAt: Date.now() } as any });

    const newState = { ...initialState, _stateID: 1, G: { cells: ["0", null, null, null, null, null, null, null, null] } };
    const deltalog = [{ action: { type: "MAKE_MOVE", payload: { type: "clickCell", args: [0], playerID: "0" } }, _stateID: 1, turn: 1, phase: "default" }];

    await storage.setState(matchID, newState, deltalog);

    const result = await storage.fetch(matchID, { state: true, log: true });
    expect(result.state?._stateID).toBe(1);
    expect(result.log).toHaveLength(1);
  });

  it("wipe removes all persisted match data", async () => {
    const matchID = "persist-match-2";
    const initialState = {
      G: { cells: Array(9).fill(null) },
      ctx: { numPlayers: 2, playOrder: ["0", "1"], playOrderPos: 0, activePlayers: null, currentPlayer: "0", turn: 1, phase: "default" },
      plugins: {},
      _undo: [],
      _redo: [],
      _stateID: 0,
    };

    await storage.createMatch(matchID, { initialState, metadata: { gameName: "tic-tac-toe", players: {}, createdAt: Date.now(), updatedAt: Date.now() } as any });
    await storage.wipe(matchID);

    const result = await storage.fetch(matchID, { state: true, log: true, metadata: true, initialState: true });
    expect(result.state).toBeUndefined();
    expect(result.metadata).toBeUndefined();
    expect(result.log).toEqual([]);
    expect(result.initialState).toBeUndefined();
  });

  it("lists matches across multiple creates", async () => {
    await storage.createMatch("m1", { initialState: { _stateID: 0 } as any, metadata: { gameName: "tic-tac-toe" } as any });
    await storage.createMatch("m2", { initialState: { _stateID: 0 } as any, metadata: { gameName: "tic-tac-toe" } as any });

    const matches = await storage.listMatches();
    expect(matches).toContain("m1");
    expect(matches).toContain("m2");
  });
});

describe("MatchRoom reconnect from persisted state", () => {
  let room: MatchRoom;
  let lobby: any;

  beforeEach(() => {
    lobby = createMockLobby();
    room = new MatchRoom(lobby);
  });

  it("syncs latest persisted state after simulated restart", async () => {
    const matchID = "reconnect-match-1";
    const initialState = {
      G: { cells: Array(9).fill(null) },
      ctx: { numPlayers: 2, playOrder: ["0", "1"], playOrderPos: 0, activePlayers: null, currentPlayer: "0", turn: 1, phase: "default" },
      plugins: {},
      _undo: [],
      _redo: [],
      _stateID: 0,
    };
    const metadata = {
      gameName: "tic-tac-toe",
      players: {
        0: { id: 0, name: "Alice", credentials: "creds-0" },
        1: { id: 1, name: "Bob", credentials: "creds-1" },
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    // Initialize match in mock storage
    await lobby.parties.match.get(matchID).fetch("/create", {
      method: "POST",
      body: JSON.stringify({ initialState, metadata, gameName: "tic-tac-toe" }),
    });

    // Simulate a move by mutating state in storage
    const mutatedState = { ...initialState, _stateID: 1, G: { cells: ["0", null, null, null, null, null, null, null, null] } };
    lobby.storage.set(`match:${matchID}:state`, mutatedState);
    lobby.storage.set(`match:${matchID}:log`, [{ action: { type: "MAKE_MOVE", payload: { type: "clickCell", args: [0], playerID: "0" } }, _stateID: 1, turn: 1, phase: "default" }]);

    // Simulate "restart" by creating a fresh MatchRoom (in-memory state lost)
    const freshRoom = new MatchRoom(lobby);

    // Reconnect player 0
    const socket = createMockSocket("reconnect-socket");
    await freshRoom.handleSync(socket, matchID, "0", "creds-0", 2);

    const syncEvent = socket.emitted.find((e) => e.event === "sync");
    expect(syncEvent).toBeDefined();
    const syncInfo = syncEvent.args[1];
    expect(syncInfo.state._stateID).toBe(1);
    expect(syncInfo.state.G.cells[0]).toBe("0");
    expect(syncInfo.log).toHaveLength(1);
  });

  it("cold-start: new MatchRoom syncs persisted state when no connections exist", async () => {
    const matchID = "coldstart-match-1";
    const initialState = {
      G: { cells: Array(9).fill(null) },
      ctx: { numPlayers: 2, playOrder: ["0", "1"], playOrderPos: 0, activePlayers: null, currentPlayer: "0", turn: 1, phase: "default" },
      plugins: {},
      _undo: [],
      _redo: [],
      _stateID: 0,
    };
    const metadata = {
      gameName: "tic-tac-toe",
      players: {
        0: { id: 0, name: "Alice", credentials: "creds-0" },
        1: { id: 1, name: "Bob", credentials: "creds-1" },
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await lobby.parties.match.get(matchID).fetch("/create", {
      method: "POST",
      body: JSON.stringify({ initialState, metadata, gameName: "tic-tac-toe" }),
    });

    // Make two moves in storage (simulating previous session)
    const state1 = { ...initialState, _stateID: 1, G: { cells: ["0", null, null, null, null, null, null, null, null] } };
    const state2 = { ...initialState, _stateID: 2, G: { cells: ["0", null, null, null, "1", null, null, null, null] } };
    lobby.storage.set(`match:${matchID}:state`, state2);
    lobby.storage.set(`match:${matchID}:log`, [
      { action: { type: "MAKE_MOVE", payload: { type: "clickCell", args: [0], playerID: "0" } }, _stateID: 1, turn: 1, phase: "default" },
      { action: { type: "MAKE_MOVE", payload: { type: "clickCell", args: [4], playerID: "1" } }, _stateID: 2, turn: 2, phase: "default" },
    ]);

    // No prior connections. Create a fresh room (cold start).
    const coldRoom = new MatchRoom(lobby);
    const socket = createMockSocket("coldstart-socket");
    await coldRoom.handleSync(socket, matchID, "0", "creds-0", 2);

    const syncEvent = socket.emitted.find((e) => e.event === "sync");
    expect(syncEvent).toBeDefined();
    const syncInfo = syncEvent.args[1];
    expect(syncInfo.state._stateID).toBe(2);
    expect(syncInfo.state.G.cells[0]).toBe("0");
    expect(syncInfo.state.G.cells[4]).toBe("1");
    expect(syncInfo.log).toHaveLength(2);
  });
});

describe("Game registry idempotency for second match", () => {
  it("getGame returns stable processed game for multiple match creations", () => {
    const game = getGame("tic-tac-toe");
    expect(game).toBeDefined();

    const processed1 = JSON.stringify(game!.processedGame);
    const processed2 = JSON.stringify(getGame("tic-tac-toe")!.processedGame);
    expect(processed1).toBe(processed2);
  });
});
