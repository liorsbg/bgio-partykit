// @ts-nocheck
import type * as Party from "partykit/server";
import { createServer } from "../packages/party.io/src/index.js";

const GAMES = ["tic-tac-toe"];

export default class BgioPartyKitServer implements Party.Server {
  constructor(public room: Party.Room) {}

  static async onFetch(
    req: Request,
    lobby: Party.FetchLobby,
    ctx: Party.ExecutionContext
  ): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      return new Response(
        JSON.stringify({
          service: "bgio-partykit",
          status: "ok",
          version: "0.0.1",
          games: GAMES,
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        }
      );
    }

    // Delegate Socket.IO handling to party.io
    const io = createServer({
      cors: {
        origin: ["http://127.0.0.1:1999", "http://127.0.0.1:5173"],
        credentials: true,
      },
    });

    return io.onFetch(req, lobby, ctx);
  }

  onMessage(
    message: string | ArrayBuffer | ArrayBufferView
  ): void | Promise<void> {
    this.room.broadcast(message);
  }

  onRequest(req: Party.Request): Response | Promise<Response> {
    if (req.method === "POST") {
      const url = new URL(req.url);
      if (url.pathname.endsWith("/count")) {
        let count = 0;
        count = Array.from(this.room.getConnections()).length;
        return new Response(count.toString(), { status: 200 });
      }
    }
    return new Response("not found", { status: 404 });
  }
}
