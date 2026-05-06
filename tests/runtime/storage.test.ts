// @ts-nocheck
import { describe, it, expect, beforeEach } from "vitest";
import { PartyKitStorage } from "../../src/storage";
import type * as Party from "partykit/server";
import type { State, LogEntry, Server } from "boardgame.io/dist/types/src/types";

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

  async list<T = unknown>(options?: { prefix?: string; start?: string; startAfter?: string; end?: string; reverse?: boolean; limit?: number }): Promise<Map<string, T>> {
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

function createMockState(_matchID: string, stateID = 0): State {
  return {
    G: {},
    ctx: {
      numPlayers: 2,
      playOrder: ["0", "1"],
      playOrderPos: 0,
      activePlayers: null,
      currentPlayer: "0",
      turn: 1,
      phase: "default",
    },
    plugins: {},
    _undo: [],
    _redo: [],
    _stateID: stateID,
  } as unknown as State;
}

function createMockMetadata(_matchID: string): Server.MatchData {
  return {
    gameName: "tic-tac-toe",
    players: {
      0: { id: 0, name: "Alice", credentials: "secret0" },
      1: { id: 1, name: "Bob", credentials: "secret1" },
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

describe("PartyKitStorage", () => {
  let mockStorage: MockStorage;
  let storage: PartyKitStorage;

  beforeEach(() => {
    mockStorage = new MockStorage();
    storage = new PartyKitStorage(mockStorage);
  });

  it("connect is a no-op", async () => {
    await expect(storage.connect()).resolves.toBeUndefined();
  });

  it("creates a match with initial state, metadata, state, and empty log", async () => {
    const matchID = "test-match-1";
    const initialState = createMockState(matchID);
    const metadata = createMockMetadata(matchID);

    await storage.createMatch(matchID, { initialState, metadata });

    const result = await storage.fetch(matchID, {
      state: true,
      metadata: true,
      log: true,
      initialState: true,
    });

    expect(result.state).toEqual(initialState);
    expect(result.initialState).toEqual(initialState);
    expect(result.metadata).toEqual(metadata);
    expect(result.log).toEqual([]);
  });

  it("sets state and appends deltalog", async () => {
    const matchID = "test-match-2";
    const initialState = createMockState(matchID);
    const metadata = createMockMetadata(matchID);

    await storage.createMatch(matchID, { initialState, metadata });

    const newState = { ...initialState, _stateID: 1 };
    const deltalog: LogEntry[] = [
      {
        action: { type: "MAKE_MOVE", payload: { type: "clickCell", args: [0], playerID: "0" } },
        _stateID: 1,
        turn: 1,
        phase: "default",
      },
    ] as unknown as LogEntry[];

    await storage.setState(matchID, newState, deltalog);

    const result = await storage.fetch(matchID, { state: true, log: true });
    expect(result.state?._stateID).toBe(1);
    expect(result.log).toHaveLength(1);
  });

  it("sets metadata", async () => {
    const matchID = "test-match-3";
    const initialState = createMockState(matchID);
    const metadata = createMockMetadata(matchID);

    await storage.createMatch(matchID, { initialState, metadata });

    const newMetadata = { ...metadata, updatedAt: Date.now() + 1000 };
    await storage.setMetadata(matchID, newMetadata);

    const result = await storage.fetch(matchID, { metadata: true });
    expect(result.metadata?.updatedAt).toBe(newMetadata.updatedAt);
  });

  it("wipes a match", async () => {
    const matchID = "test-match-4";
    const initialState = createMockState(matchID);
    const metadata = createMockMetadata(matchID);

    await storage.createMatch(matchID, { initialState, metadata });
    await storage.wipe(matchID);

    const result = await storage.fetch(matchID, {
      state: true,
      metadata: true,
      log: true,
      initialState: true,
    });

    expect(result.state).toBeUndefined();
    expect(result.metadata).toBeUndefined();
    expect(result.log).toEqual([]);
    expect(result.initialState).toBeUndefined();
  });

  it("lists matches", async () => {
    await storage.createMatch("match-a", { initialState: createMockState("match-a"), metadata: createMockMetadata("match-a") });
    await storage.createMatch("match-b", { initialState: createMockState("match-b"), metadata: createMockMetadata("match-b") });

    const matches = await storage.listMatches();
    expect(matches).toContain("match-a");
    expect(matches).toContain("match-b");
    expect(matches).toHaveLength(2);
  });
});
