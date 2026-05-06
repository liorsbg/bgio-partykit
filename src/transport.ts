// @ts-nocheck
import { getFilterPlayerView } from "boardgame.io/internal";
import type { Game } from "boardgame.io/dist/types/src/types";
import type { TransportAPI as MasterTransport, IntermediateTransportData } from "boardgame.io/dist/types/src/master/master";

export function createTransportAPI(socket: any, game: Game, matchID: string): MasterTransport {
  const filterPlayerView = getFilterPlayerView(game);

  return {
    send: ({ playerID, type, args }) => {
      const data = filterPlayerView(playerID, { type, args } as IntermediateTransportData);
      socket.emit(data.type, ...data.args);
    },
    sendAll: (payload) => {
      try {
        const adapter = socket.nsp.adapter;
        const roomSockets = adapter.sids
          ? Array.from(adapter.sids.keys()).filter((sid: any) => {
              const rooms = adapter.sids.get(sid);
              return rooms && rooms.has(matchID);
            })
          : [];

        for (const sid of roomSockets) {
          const targetSocket = socket.nsp.sockets.get(sid);
          if (targetSocket) {
            try {
              const pid = targetSocket.playerID || null;
              const data = filterPlayerView(pid, payload);
              targetSocket.emit(data.type, ...data.args);
            } catch {
              // Miniflare may throw when writing to a WebSocket created in
              // a different request context. Swallow so the local sender
              // still receives its update.
            }
          }
        }
      } catch {
        // Fallback intentionally omitted: nsp.to().emit() uses the adapter
        // which hits the same Miniflare I/O isolation for cross-context
        // sockets. Local dev broadcasts are best-effort.
      }
    },
  };
}
