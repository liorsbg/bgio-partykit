// @ts-nocheck
import type { State, LogEntry, Server } from "boardgame.io/dist/types/src/types";
import type * as Party from "partykit/server";

export class RemoteStorage {
  type() { return 1; } // ASYNC
  constructor(private lobby: Party.FetchLobby) {}

  async connect(): Promise<void> {}

  async createMatch(matchID: string, opts: { initialState: State; metadata: Server.MatchData }): Promise<void> {
    const stub = this.lobby.parties.match.get(matchID);
    await stub.fetch("/create", {
      method: "POST",
      body: JSON.stringify(opts),
    });
  }

  async setState(matchID: string, state: State, deltalog?: LogEntry[]): Promise<void> {
    const stub = this.lobby.parties.match.get(matchID);
    await stub.fetch("/state", {
      method: "POST",
      body: JSON.stringify({ state, deltalog }),
    });
  }

  async setMetadata(matchID: string, metadata: Server.MatchData): Promise<void> {
    const stub = this.lobby.parties.match.get(matchID);
    await stub.fetch("/metadata", {
      method: "POST",
      body: JSON.stringify(metadata),
    });
  }

  async fetch(matchID: string, opts: any): Promise<any> {
    const stub = this.lobby.parties.match.get(matchID);
    const params = new URLSearchParams();
    if (opts.state) params.set("state", "true");
    if (opts.log) params.set("log", "true");
    if (opts.metadata) params.set("metadata", "true");
    if (opts.initialState) params.set("initialState", "true");
    const query = params.toString();
    const url = "/fetch" + (query ? `?${query}` : "");
    const res = await stub.fetch(url);
    return await res.json();
  }

  async wipe(matchID: string): Promise<void> {
    const stub = this.lobby.parties.match.get(matchID);
    await stub.fetch("/wipe", { method: "POST" });
  }

  async listMatches(): Promise<string[]> {
    // Intentional: the lobby DO owns the authoritative match list (stored as
    // "match:<id>:metadata" keys in lobby storage). Match DOs do not maintain
    // their own list, so there is nothing to return here.
    return [];
  }
}
