// @ts-nocheck
import { describe, it, expect, beforeEach } from "vitest";
import { MatchRoom } from "../../src/match-room";
import { registerGame } from "../../src/registry";
import type { Game } from "boardgame.io/dist/types/src/types";

const HiddenDataGame: Game = {
  name: "hidden-data",
  setup: () => ({ secrets: { "0": "secret-0", "1": "secret-1" } }),
  moves: {
    reveal: ({ G: _G, playerID }) => {
      return { revealed: playerID };
    },
  },
  playerView: ({ G: _G, playerID }) => {
    return {
      secrets: {
        [playerID]: _G.secrets[playerID],
      },
    };
  },
};

registerGame(HiddenDataGame);

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
              return new Response(JSON.stringify({ gameName: storage.get(`match:${id}:gameName`) ?? "hidden-data" }));
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
                storage.set(`match:${id}:metadata`, body.metadata);
                storage.set(`match:${id}:gameName`, body.gameName || "hidden-data");
              }
              return new Response("OK", { status: 200 });
            }
            if (path.startsWith("/fetch")) {
              const result: Record<string, unknown> = {};
              if (path.includes("state=true") || (opts?.body && JSON.parse(opts.body || '{}').state)) {
                result.state = storage.get(`match:${id}:state`);
              }
              if (path.includes("log=true")) {
                result.log = storage.get(`match:${id}:log`) ?? [];
              }
              if (path.includes("metadata=true")) {
                result.metadata = storage.get(`match:${id}:metadata`);
              }
              if (path.includes("initialState=true")) {
                result.initialState = storage.get(`match:${id}:state`);
              }
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

describe("MatchRoom security and boundaries", () => {
  let room: MatchRoom;
  let lobby: any;

  beforeEach(() => {
    lobby = createMockLobby();
    room = new MatchRoom(lobby);
  });

  it("rejects sync with missing credentials before state access", async () => {
    const socket = createMockSocket();
    await room.handleSync(socket, "match-1", "0", undefined, 2);
    const errorEvent = socket.emitted.find((e) => e.event === "sync_error");
    expect(errorEvent).toBeDefined();
    expect(errorEvent!.args[0]).toBe("auth_invalid");
  });

  it("rejects sync with wrong credentials before state access", async () => {
    const socket = createMockSocket();
    await room.handleSync(socket, "match-1", "0", "wrong-credentials", 2);
    const errorEvent = socket.emitted.find((e) => e.event === "sync_error");
    expect(errorEvent).toBeDefined();
    expect(errorEvent!.args[0]).toBe("auth_invalid");
  });

  it("rejects update from socket with mismatched playerID (spoofed_player)", async () => {
    const socket = createMockSocket();
    socket.playerID = "0";
    room.registerSocket(socket, "match-1", "0", "valid-creds");

    const socket2 = createMockSocket("socket-2");
    socket2.playerID = "1";
    room.registerSocket(socket2, "match-1", "1", "valid-creds-1");

    // socket authenticated as player 0 tries to send update claiming player 1
    await room.handleUpdate(socket, { type: "MAKE_MOVE", payload: { type: "reveal", args: [], playerID: "1" } }, 0, "match-1", "1");
    const errorEvent = socket.emitted.find((e) => e.event === "error");
    expect(errorEvent).toBeDefined();
    expect(errorEvent!.args[0]).toBe("spoofed_player");
  });

  it("allows multiple connections for the same player (multiple-tabs-allowed)", async () => {
    const socket1 = createMockSocket("tab-1");
    const socket2 = createMockSocket("tab-2");

    room.registerSocket(socket1, "match-1", "0", "creds");
    room.registerSocket(socket2, "match-1", "0", "creds");

    expect(room.getConnectionCount("match-1", "0")).toBe(2);
  });

  it("keeps isConnected true until ALL connections for that player close", async () => {
    const socket1 = createMockSocket("tab-1");
    const socket2 = createMockSocket("tab-2");

    room.registerSocket(socket1, "match-1", "0", "creds");
    room.registerSocket(socket2, "match-1", "0", "creds");

    // Close one tab
    await room.handleDisconnect(socket1);
    expect(room.getConnectionCount("match-1", "0")).toBe(1);

    // Close the other tab
    await room.handleDisconnect(socket2);
    expect(room.getConnectionCount("match-1", "0")).toBe(0);
  });

  it("returns unsupported_frame_type for chat events without disconnecting", async () => {
    const socket = createMockSocket();
    room.registerSocket(socket, "match-1", "0", "creds");

    await room.handleChat(socket, "match-1", "0", { message: "hello" });
    const errorEvent = socket.emitted.find((e) => e.event === "error");
    expect(errorEvent).toBeDefined();
    expect(errorEvent!.args[0]).toBe("unsupported_frame_type");
  });

  it("returns unsupported_frame_type for unknown event names without disconnecting", async () => {
    const socket = createMockSocket();
    room.registerSocket(socket, "match-1", "0", "creds");

    await room.handleUnknownEvent(socket, "random_event", { data: 1 });
    const errorEvent = socket.emitted.find((e) => e.event === "error");
    expect(errorEvent).toBeDefined();
    expect(errorEvent!.args[0]).toBe("unsupported_frame_type");
  });

  it("rejects oversized payloads", async () => {
    const socket = createMockSocket();
    room.registerSocket(socket, "match-1", "0", "creds");

    const hugePayload = { data: "x".repeat(1024 * 1024 + 1) }; // > 1MB
    const result = await room.checkPayloadSize(hugePayload);
    expect(result.allowed).toBe(false);
    expect(result.error).toBe("payload_too_large");
  });

  it("filters playerView for opponent secrets in sync", async () => {
    // Setup match with hidden data
    const matchID = "hidden-match-1";
    const initialState = {
      G: { secrets: { "0": "secret-0", "1": "secret-1" } },
      ctx: { numPlayers: 2, playOrder: ["0", "1"], playOrderPos: 0, activePlayers: null, currentPlayer: "0", turn: 1, phase: "default" },
      plugins: {},
      _undo: [],
      _redo: [],
      _stateID: 0,
    };
    const metadata = {
      gameName: "hidden-data",
      players: {
        0: { id: 0, name: "Alice", credentials: "creds-0" },
        1: { id: 1, name: "Bob", credentials: "creds-1" },
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    // Store in mock lobby
    await lobby.parties.match.get(matchID).fetch("/create", {
      method: "POST",
      body: JSON.stringify({ initialState, metadata, gameName: "hidden-data" }),
    });

    const socket0 = createMockSocket("s0");
    await room.handleSync(socket0, matchID, "0", "creds-0", 2);

    // The sync event should have playerView-filtered state for player 0
    const syncEvent = socket0.emitted.find((e) => e.event === "sync");
    expect(syncEvent).toBeDefined();
    const state = syncEvent!.args[1]?.state;
    expect(state?.G?.secrets?.["0"]).toBe("secret-0");
    expect(state?.G?.secrets?.["1"]).toBeUndefined();
  });
});
