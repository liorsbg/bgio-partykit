import type * as Party from "partykit/server";
import type { State, LogEntry, Server } from "boardgame.io/dist/types/src/types";

// Re-create the StorageAPI interface locally since boardgame.io doesn't export
// the StorageAPI class values from its published bundles.
export interface FetchOpts {
  state?: boolean;
  log?: boolean;
  metadata?: boolean;
  initialState?: boolean;
}

export interface CreateMatchOpts {
  initialState: State;
  metadata: Server.MatchData;
}

export interface ListMatchesOpts {
  gameName?: string;
  where?: {
    isGameover?: boolean;
    updatedBefore?: number;
    updatedAfter?: number;
  };
}

export enum StorageType {
  SYNC = 0,
  ASYNC = 1,
}

export class PartyKitStorage {
  constructor(private storage: Party.Storage) {}

  type(): StorageType {
    return StorageType.ASYNC;
  }

  async connect(): Promise<void> {
    // No-op: PartyKit storage is always connected
  }

  async createMatch(matchID: string, opts: CreateMatchOpts): Promise<void> {
    const { initialState, metadata } = opts;
    await this.storage.put(`match:${matchID}:initialState`, initialState);
    await this.storage.put(`match:${matchID}:metadata`, metadata);
    await this.storage.put(`match:${matchID}:state`, initialState);
    await this.storage.put(`match:${matchID}:log`, []);
  }

  async setState(matchID: string, state: State, deltalog?: LogEntry[]): Promise<void> {
    await this.storage.put(`match:${matchID}:state`, state);
    if (deltalog && deltalog.length > 0) {
      const existingLog = (await this.storage.get<LogEntry[]>(`match:${matchID}:log`)) || [];
      await this.storage.put(`match:${matchID}:log`, [...existingLog, ...deltalog]);
    }
  }

  async setMetadata(matchID: string, metadata: Server.MatchData): Promise<void> {
    await this.storage.put(`match:${matchID}:metadata`, metadata);
  }

  async fetch<O extends FetchOpts>(matchID: string, opts: O): Promise<Record<string, unknown>> {
    const result: Record<string, unknown> = {};

    if (opts.state) {
      result.state = await this.storage.get<State>(`match:${matchID}:state`);
    }
    if (opts.log) {
      result.log = (await this.storage.get<LogEntry[]>(`match:${matchID}:log`)) || [];
    }
    if (opts.metadata) {
      result.metadata = await this.storage.get<Server.MatchData>(`match:${matchID}:metadata`);
    }
    if (opts.initialState) {
      result.initialState = await this.storage.get<State>(`match:${matchID}:initialState`);
    }

    return result;
  }

  async wipe(matchID: string): Promise<void> {
    await this.storage.delete(`match:${matchID}:state`);
    await this.storage.delete(`match:${matchID}:log`);
    await this.storage.delete(`match:${matchID}:metadata`);
    await this.storage.delete(`match:${matchID}:initialState`);
  }

  async listMatches(_opts?: ListMatchesOpts): Promise<string[]> {
    const prefix = "match:";
    const keys = await this.storage.list({ prefix });
    const matchIDs = new Set<string>();
    for (const key of keys.keys()) {
      const parts = key.slice(prefix.length).split(":");
      if (parts.length >= 1) {
        matchIDs.add(parts[0]);
      }
    }
    return Array.from(matchIDs);
  }
}
