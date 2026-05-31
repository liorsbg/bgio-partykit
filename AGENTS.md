# AGENTS.md — bgio-partykit

Agent guidance for working in this repository.

---

## Project Overview

`bgio-partykit` is a TypeScript library and CLI that runs [boardgame.io](https://boardgame.io) game servers on [PartyKit](https://docs.partykit.io) (Cloudflare Durable Objects). It bridges the boardgame.io `SocketIO()` transport and `LobbyClient` to PartyKit's WebSocket infrastructure with zero client-side changes required.

**Key constraint:** The library must remain compatible with the published boardgame.io `^0.50.2` API surface. Do not rely on internal boardgame.io types beyond what is already imported in `src/`.

---

## Repository Layout

```
src/                    # Library source (public API)
  index.ts              # All public exports — the single source of truth for the API surface
  server.ts             # PartyKit Server entrypoint (lobby / match / bus routing)
  match-room.ts         # Per-match Durable Object logic (Master, queues, sockets)
  lobby.ts              # Lobby REST API handlers
  registry.ts           # Game registry (registerGame / getGame / listGames)
  storage.ts            # PartyKitStorage — StorageAPI.Async backed by room.storage
  remote-storage.ts     # RemoteStorage — HTTP-forwarding StorageAPI for lobby DO
  transport.ts          # createTransportAPI with playerView filtering
  games/
    tic-tac-toe.ts      # Built-in demo game

packages/
  party.io/             # Vendored Socket.IO server for PartyKit — do not edit directly
  create-bgio-partykit/ # Interactive CLI scaffolding package (separate build)

tests/
  runtime/              # Unit tests for storage, registry, security, persistence
  lobby/                # Unit tests for lobby REST API
  foundation/           # Unit tests for CLI scaffolding
  e2e/                  # End-to-end tests (excluded from `pnpm test`, run via scripts)

scripts/
  e2e-local.mjs         # Starts dev server, runs local E2E suite
  e2e-deployed.mjs      # Runs E2E suite against deployed instance
  deploy.mjs            # Deploy helper

static/
  index.html            # Demo page served by PartyKit
```

---

## Tech Stack

| Tool | Version | Purpose |
|------|---------|---------|
| TypeScript | ^5.8 | Primary language |
| Vitest | ^3.1 | Unit test runner |
| ESLint + typescript-eslint | ^9 / ^8 | Linting |
| pnpm | 10.28 | Package manager (workspaces) |
| partykit | ^0.0.115 | Runtime / deploy target |
| boardgame.io | ^0.50.2 | Game engine dependency |

---

## Commands

```bash
pnpm test           # Run unit tests (excludes e2e)
pnpm test:watch     # Watch mode
pnpm typecheck      # tsc --noEmit
pnpm lint           # ESLint over src/ and tests/
pnpm build          # tsc -p tsconfig.build.json → dist/
pnpm dev            # Start local PartyKit dev server on :1999
pnpm e2e:local      # Run Vitest E2E suite (starts dev server internally)
pnpm e2e:deployed   # Run E2E suite against deployed instance
pnpm deploy         # Build + deploy to Cloudflare via PartyKit
```

**Always run `pnpm typecheck && pnpm lint && pnpm test` before committing.**

---

## Architecture Decisions

### Three-party routing
`partykit.json` maps three party kinds (`lobby`, `match`, `bus`) to the same `src/server.ts` entrypoint. The `BgioPartyKitServer` class dispatches on `this.room.name` inside `onRequest`. Do not split these into separate files without updating `partykit.json`.

### `@ts-nocheck` in `server.ts`
`server.ts` uses `@ts-nocheck` because the vendored `party.io` types are not fully aligned with the PartyKit server types. This is intentional. Do not remove it without resolving the underlying type mismatches.

### Deep-clone before `ProcessGameConfig`
`registry.ts` deep-clones the game object before calling `ProcessGameConfig` because that function mutates its argument in-place. The clone must preserve functions (not JSON-serializable). See `deepCloneWithFunctions` in `registry.ts`.

### `RemoteStorage` vs `PartyKitStorage`
- `PartyKitStorage` — used inside a match Durable Object; reads/writes `room.storage` directly.
- `RemoteStorage` — used by the lobby Durable Object; forwards storage calls to the match DO via HTTP RPC. Do not use `PartyKitStorage` in the lobby context.
- `RemoteStorage.listMatches` intentionally returns `[]`. The lobby DO owns the authoritative match list via its own storage keys. Do not "fix" this method to query match DOs.

### Sequential queue in `match-room.ts`
The per-match update queue is a hand-rolled sequential promise queue. `p-queue` v6.6.2 hangs in the PartyKit/Miniflare Workers environment due to I/O isolation between request contexts. Do not replace the `setTimeout`-based queue with any external queue library.

### `ALLOWED_ORIGINS` is defined in two places
`server.ts` and `lobby.ts` each define their own allowed-origins array (`ALLOWED_ORIGINS` and `CORS_ALLOWED_ORIGINS` respectively). When adding a new allowed origin, update **both** files.

### boardgame.io import paths
- `boardgame.io/master` — `Master` class.
- `boardgame.io/internal` — `ProcessGameConfig`, `getFilterPlayerView`, `createMatch`.
- `boardgame.io/dist/types/src/types` — type-only imports (`State`, `LogEntry`, `Game`, `Server`).
- Do not import from `boardgame.io/core` or `boardgame.io/client` in server-side code.

### Vendored `party.io`
`packages/party.io/` is a fork of `party.io` that implements a Socket.IO server on top of PartyKit WebSockets. It is excluded from TypeScript compilation (`tsconfig.json` excludes it) and from ESLint. Do not upgrade it via npm — changes must be made directly in the package.

---

## Testing Conventions

- Unit tests live in `tests/runtime/`, `tests/lobby/`, `tests/foundation/`.
- E2E tests live in `tests/e2e/` and are excluded from `pnpm test` (run via `pnpm e2e:local`).
- `pnpm e2e:local` runs `vitest run --config vitest.e2e.config.ts`. The E2E tests spin up the PartyKit dev server themselves via `child_process.spawn` — do not start the dev server separately before running them.
- `scripts/e2e-local.mjs` is a legacy curl-based smoke runner; it is no longer wired into `package.json`.
- Use `// @ts-nocheck` at the top of test files only when mocking PartyKit internals that lack exported types.
- Mock `Party.Storage` by implementing the full interface (see `MockStorage` in `tests/runtime/storage.test.ts` as the canonical pattern).
- Test files use Vitest globals (`describe`, `it`, `expect`, `beforeEach`) — no explicit imports needed.

---

## Code Style

- **No `any` without justification** — `@typescript-eslint/no-explicit-any` is a warning. Prefer `unknown` with type guards.
- **`@ts-expect-error` requires a description** — enforced by ESLint. Never use `@ts-ignore` or `@ts-nocheck` in new source files.
- **Unused variables** — prefix with `_` to suppress the lint error (e.g., `_connection`).
- **ESM only** — the package is `"type": "module"`. All imports use `.js` extensions (TypeScript resolves to `.ts` at build time).
- **No barrel re-exports from internal modules** — only `src/index.ts` is the public API surface.

---

## Public API Contract

`src/index.ts` is the single source of truth for the public API. When adding exports:
1. Add the export to `src/index.ts`.
2. Add the corresponding type to the `exports` field in `package.json` if a new entry point is needed.
3. Update the API Reference section in `README.md`.

Do not remove or rename existing exports without a major version bump.

---

## Environment Variables (Deploy)

```
CLOUDFLARE_ACCOUNT_ID   # Required for pnpm deploy
CLOUDFLARE_API_TOKEN    # Required for pnpm deploy
```

These are never committed. Do not log or expose them in code.

---

## Packages Workspace

`packages/create-bgio-partykit/` is a separate npm package with its own `tsconfig.json`, `vitest.config.ts`, and build pipeline. When making changes there:
- Run `pnpm build` inside `packages/create-bgio-partykit/` before testing.
- Its tests run via `pnpm test` from the workspace root (Vitest picks them up via the workspace config).

---

## What Agents Should NOT Do

- Do not edit files under `packages/party.io/` unless explicitly asked.
- Do not commit `dist/` — it is built on publish via `prepack`.
- Do not add `console.log` debug statements to `src/` files.
- Do not change `partykit.json` party routing without updating `server.ts` dispatch logic.
- Do not use `JSON.parse(JSON.stringify(...))` for cloning — it drops functions. Use `deepCloneWithFunctions` from `registry.ts`.
- Do not replace the hand-rolled sequential queue in `match-room.ts` with `p-queue` or any external queue library.
- Do not add new allowed origins to only one of `server.ts` or `lobby.ts` — both must be updated.
- Do not "fix" `RemoteStorage.listMatches` to return real data — it intentionally returns `[]`.
- Do not remove `@ts-nocheck` from `server.ts` or `match-room.ts` without resolving the underlying type mismatches with the vendored `party.io`.
