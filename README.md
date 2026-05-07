# bgio-partykit

> Deploy [boardgame.io](https://boardgame.io) multiplayer games to [Cloudflare Workers](https://workers.cloudflare.com) using [PartyKit](https://docs.partykit.io) — with **zero client-side changes**.

`bgio-partykit` is a library and CLI that lets you run boardgame.io game servers on PartyKit's Durable Objects infrastructure. Your existing `Client` with `SocketIO()` transport and `LobbyClient` work exactly as they do today — no UI or networking code needs to change.

---

## ✨ Key Features

- **Zero client-side changes** — Use the standard boardgame.io `Client` with `SocketIO()` transport. Existing games and frontends work out of the box.
- **Standard `LobbyClient` compatibility** — The full boardgame.io lobby REST API (`/games`, `/games/:name/create`, `/games/:name/:id/join`, etc.) is implemented and served from PartyKit.
- **Match persistence via PartyKit `room.storage`** — Every match is a Durable Object with its own `StorageAPI.Async` backend. Game state, metadata, and logs survive restarts and are replicated across Cloudflare's edge.
- **Deploy to Cloudflare Workers via PartyKit** — One-command deploy to Cloudflare's global edge network. No server management, no Docker, no scaling headaches.
- **Interactive CLI scaffolding** — `pnpm create bgio-partykit` scaffolds a complete, working project with your game definition, TypeScript configs, and PartyKit manifest in seconds.
- **TypeScript-first** — Full type definitions for the public API, game registry, storage layer, and transport adapters.

---

## 🚀 Quick Start

The fastest way to get started is with the interactive CLI:

```bash
pnpm create bgio-partykit my-game
cd my-game
pnpm dev        # starts the local PartyKit dev server on localhost:1999
```

The CLI will ask you for a project name, game name, and number of players. It then:

1. Copies bundled templates with your variables substituted.
2. Runs `pnpm install`.
3. Runs `git init`.
4. Prints next steps.

Open the generated demo page or point your existing boardgame.io client at `http://localhost:1999` and it will just work.

---

## 🔧 Manual Setup (for Existing Projects)

If you already have a boardgame.io game and want to host it on PartyKit:

### 1. Install the package

```bash
npm install bgio-partykit
```

### 2. Create a server entrypoint

Create a file (e.g., `src/server.ts`) that exports the default `Server` class and registers your games:

```typescript
import Server, { registerGame } from "bgio-partykit";
import MyGame from "./game";

// Register your game(s)
registerGame(MyGame);

// Export the Server as the PartyKit room entrypoint
export default Server;
```

### 3. Configure `partykit.json`

Create a `partykit.json` at the project root:

```json
{
  "name": "my-bgio-game",
  "main": "src/server.ts",
  "serve": {
    "path": "static"
  },
  "compatibilityDate": "2024-07-01",
  "parties": {
    "lobby": "src/server.ts",
    "match": "src/server.ts",
    "bus": "src/server.ts"
  }
}
```

All three party kinds (`lobby`, `match`, `bus`) point to the same server file. The runtime routes requests to the appropriate internal handler based on the room name.

### 4. Wire up your client

Your existing client code requires only the server URL:

```typescript
import { Client } from "boardgame.io/react";
import { SocketIO } from "boardgame.io/multiplayer";
import { LobbyClient } from "boardgame.io/client";
import MyGame from "./game";
import { socketIOServerUrl, lobbyClientUrl } from "bgio-partykit";

const BASE_URL = "http://localhost:1999";   // or your deployed URL

const App = Client({
  game: MyGame,
  transport: SocketIO({ server: socketIOServerUrl(BASE_URL) }),
});

const lobby = new LobbyClient({ server: lobbyClientUrl(BASE_URL) });
```

---

## 🏗 Architecture Overview

```
┌─────────────────┐     WebSocket      ┌─────────────────────────────┐
│  boardgame.io   │ ◄─────────────────►│   PartyKit Durable Object   │
│  Client +       │   Socket.IO        │   (one per match room)      │
│  LobbyClient    │                    │                             │
└─────────────────┘                    │  ┌───────────────────────┐  │
                                       │  │  vendored party.io    │  │
                                       │  │  Socket.IO server     │  │
                                       │  └───────────────────────┘  │
                                       │            │                │
                                       │  ┌───────────────────────┐  │
                                       │  │  boardgame.io Master  │  │
                                       │  │  (authoritative logic)│  │
                                       │  └───────────────────────┘  │
                                       │            │                │
                                       │  ┌───────────────────────┐  │
                                       │  │  StorageAPI.Async     │  │
                                       │  │  backed by            │  │
                                       │  │  room.storage         │  │
                                       │  └───────────────────────┘  │
                                       └─────────────────────────────┘
```

- **Each match is a PartyKit room** — A Cloudflare Durable Object that maintains WebSocket connections, game state, and in-memory queues for that specific match.
- **Socket.IO server via vendored `party.io`** — The project bundles a fork of `party.io` that implements a Socket.IO server on top of PartyKit's WebSocket infrastructure, enabling `SocketIO()` transport compatibility.
- **Authoritative `Master` class** — The standard boardgame.io `Master` processes all moves server-side. Game rules, turn order, and state transitions run inside the Durable Object exactly as they would on a Node.js server.
- **`StorageAPI.Async` backed by `room.storage`** — Match state, metadata, logs, and initial state are persisted to PartyKit's transactional key-value storage. The `PartyKitStorage` class implements the full `StorageAPI` contract.
- **`TransportAPI` adapter with `playerView` filtering** — `createTransportAPI` builds a boardgame.io-compatible transport layer that broadcasts updates to all connected sockets, applying per-player `playerView` filtering so clients only see the state they are allowed to see.

---

## 📚 API Reference

### `Server` (default export)

The PartyKit room entrypoint. Implements `Party.Server` and handles HTTP requests, WebSocket upgrades, lobby routing, and Socket.IO handshakes.

```typescript
import Server from "bgio-partykit";
export default Server;
```

### Game Registry

```typescript
import { registerGame, getGame, listGames, getGames } from "bgio-partykit";
import type { RegisteredGame } from "bgio-partykit";

registerGame(myGame);
const names = listGames();          // ["tic-tac-toe", "my-game"]
const game = getGame("my-game");    // RegisteredGame | undefined
```

### Storage API

```typescript
import {
  PartyKitStorage,
  StorageType,
  RemoteStorage,
} from "bgio-partykit";
import type {
  FetchOpts,
  CreateMatchOpts,
  ListMatchesOpts,
} from "bgio-partykit";
```

- **`PartyKitStorage`** — Direct `StorageAPI` implementation backed by a `Party.Storage` instance. Used inside the match Durable Object.
- **`RemoteStorage`** — Async `StorageAPI` implementation that forwards CRUD operations to the match Durable Object via HTTP. Used by the lobby Durable Object.
- **`StorageType.SYNC` / `StorageType.ASYNC`** — Storage type constants.

### Transport API

```typescript
import { createTransportAPI } from "bgio-partykit";
```

Builds a boardgame.io `TransportAPI` for a given socket, game definition, and match ID. Handles per-player state filtering and broadcast/fallback logic for PartyKit's I/O isolation.

### URL Helpers

```typescript
import { lobbyClientUrl, socketIOServerUrl } from "bgio-partykit";

const lobby = new LobbyClient({ server: lobbyClientUrl("http://localhost:1999") });
const client = Client({
  game: TicTacToe,
  transport: SocketIO({ server: socketIOServerUrl("http://localhost:1999") }),
});
```

### Demo Game

```typescript
import { TicTacToe } from "bgio-partykit";
import type { TicTacToeState } from "bgio-partykit";
```

A built-in Tic-Tac-Toe game definition, useful for testing and as a reference implementation.

---

## 🌐 Deploying

Deploy your game to Cloudflare Workers with a single command:

```bash
pnpm deploy
```

Before deploying, make sure the following environment variables are set:

```bash
export CLOUDFLARE_ACCOUNT_ID=your-account-id
export CLOUDFLARE_API_TOKEN=your-api-token
```

You can find these in your [Cloudflare dashboard](https://dash.cloudflare.com). The deploy script builds the project and pushes it to PartyKit's edge infrastructure, making your game server available globally within seconds.

---

## 🧪 Testing

The repository includes unit tests, local end-to-end tests, and deployed end-to-end tests.

| Command | Description |
|---------|-------------|
| `pnpm test` | Run unit tests with Vitest |
| `pnpm dev` | Start local PartyKit dev server on `localhost:1999` |
| `pnpm e2e:local` | Run E2E suite against the local dev server |
| `pnpm e2e:deployed` | Run E2E suite against the currently deployed instance |
| `pnpm e2e:lobby-client` | Verify `LobbyClient` compatibility |
| `pnpm lint` | ESLint |
| `pnpm typecheck` | TypeScript `--noEmit` |

### E2E Tests

E2E scripts spin up the dev server, create matches via the lobby API, connect Socket.IO clients, play moves, assert state transitions, and clean up. They exercise the full stack: lobby → match DO → storage → transport → Socket.IO broadcast.

---

## 📁 Project Structure

```
bgio-partykit/
├── src/
│   ├── index.ts              # Public API exports
│   ├── server.ts             # PartyKit Server entrypoint (lobby / match / bus routing)
│   ├── match-room.ts         # Per-match Durable Object logic (Master, queues, sockets)
│   ├── lobby.ts              # Lobby REST API handlers (create, join, leave, play again)
│   ├── registry.ts           # Game registry (registerGame, getGame, listGames)
│   ├── storage.ts            # PartyKitStorage (StorageAPI.Async via room.storage)
│   ├── remote-storage.ts     # RemoteStorage (HTTP-forwarding StorageAPI for lobby)
│   ├── transport.ts          # createTransportAPI with playerView filtering
│   └── games/
│       └── tic-tac-toe.ts    # Built-in demo game
├── packages/
│   ├── party.io/             # Vendored Socket.IO server for PartyKit
│   └── create-bgio-partykit/ # Interactive CLI scaffolding package
├── scripts/
│   ├── e2e-local.mjs         # Local E2E test runner
│   ├── e2e-deployed.mjs      # Deployed E2E test runner
│   └── deploy.mjs            # Deploy helper script
├── static/
│   └── index.html            # Static demo page served by PartyKit
├── tests/
│   ├── e2e/                  # End-to-end test suites
│   ├── foundation/             # Unit tests for core utilities
│   ├── lobby/                  # Lobby API unit tests
│   └── runtime/                # Runtime / integration tests
├── partykit.json             # PartyKit manifest (parties, compat date, serve)
├── package.json              # Package manifest & scripts
└── README.md                 # You are here
```

---

## 📄 License

MIT
