# AGENTS.md Improvement Spec

This document records the audit findings and the concrete changes made (or to be made) to `AGENTS.md`.

---

## Audit Summary

### What's Good

1. **No prior AGENTS.md existed** — the file was created from scratch with full codebase context.
2. **README is thorough** — architecture, API reference, project structure, and deploy instructions are all present and accurate. The new AGENTS.md can reference rather than duplicate them.
3. **Test conventions are consistent** — `MockStorage` pattern, `@ts-nocheck` usage, and Vitest globals are applied uniformly across test files.
4. **ESLint config is well-scoped** — `@ts-expect-error` requires a description, `any` is warned, unused vars use `_` prefix. These are worth encoding as agent rules.
5. **Architecture decisions are non-obvious** — the three-party routing, `@ts-nocheck` in `server.ts`, deep-clone before `ProcessGameConfig`, and `RemoteStorage` vs `PartyKitStorage` split are all footguns that agents would hit without guidance.
6. **Commit history is clean** — conventional-style messages, no noise. Agents should follow the same pattern.

---

### What's Missing

| Gap | Impact |
|-----|--------|
| No AGENTS.md at all | Agents have no project-specific guidance; will make avoidable mistakes |
| No guidance on `@ts-nocheck` scope | Agents may add it to new source files or remove it from existing ones |
| No guidance on the `party.io` vendored package | Agents may try to `npm update` it or edit it without understanding the fork |
| No guidance on the sequential queue in `match-room.ts` | Agents may replace `setTimeout`-based queue with `p-queue` (which hangs in Miniflare) |
| No guidance on CORS hardcoding | Agents may add new origins to `ALLOWED_ORIGINS` without understanding the deploy-time implication |
| No guidance on `RemoteStorage.listMatches` returning `[]` | This is intentional (lobby owns the list); agents may "fix" it |
| No guidance on `create-bgio-partykit` separate build | Agents may forget to build the package before running its tests |
| No guidance on what NOT to commit | `dist/`, debug scripts, `console.log` in `src/` |
| No guidance on the `partykit.json` / `server.ts` coupling | Agents may add a new party kind without updating both files |
| No guidance on boardgame.io internal import paths | Agents may use wrong import paths for `boardgame.io/internal` vs `boardgame.io/master` |
| No guidance on E2E test exclusion from `pnpm test` | Agents may wonder why E2E tests don't run |
| No guidance on `deepCloneWithFunctions` vs `JSON.parse(JSON.stringify(...))` | Agents may use the wrong clone method |

---

### What's Wrong

| Issue | File | Severity |
|-------|------|----------|
| `RemoteStorage.listMatches` silently returns `[]` with no comment explaining why | `src/remote-storage.ts:52` | Medium — agents will "fix" this |
| `server.ts` has `@ts-nocheck` at the top with no inline explanation | `src/server.ts:1` | Low — agents may remove it |
| `match-room.ts` sequential queue uses `setTimeout(r, 10)` busy-wait with no comment | `src/match-room.ts:~170` | Medium — agents may replace with `p-queue` |
| `ALLOWED_ORIGINS` is hardcoded in two places (`server.ts` and `lobby.ts`) | both files | Low — agents may add origins in only one place |
| `src/index.ts` exports `MatchRoom` and `handleLobbyRequest` as "advanced consumers" but README doesn't document them | `src/index.ts` | Low — agents may add docs or remove exports |
| `vitest.e2e.config.ts` exists but is not referenced in `package.json` scripts | root | Low — agents may not know which config to use for E2E |

---

## Improvement Spec: Changes Applied to AGENTS.md

The following sections were added or improved in the initial `AGENTS.md` creation. This spec documents the rationale for each decision.

---

### 1. Architecture Decisions section

**Rationale:** The four non-obvious decisions (three-party routing, `@ts-nocheck` in `server.ts`, deep-clone before `ProcessGameConfig`, `RemoteStorage` vs `PartyKitStorage`) are the most likely sources of agent mistakes. Each is documented with the reason it exists and what not to do.

**Specific additions needed beyond initial AGENTS.md:**

```markdown
### Sequential queue in `match-room.ts`
The per-match update queue uses a hand-rolled sequential promise queue (not `p-queue`).
`p-queue` v6.6.2 hangs in the PartyKit/Miniflare Workers environment due to I/O isolation.
Do not replace the `setTimeout`-based queue with any external queue library.

### `ALLOWED_ORIGINS` is defined in two places
`server.ts` and `lobby.ts` each define their own `ALLOWED_ORIGINS` / `CORS_ALLOWED_ORIGINS` array.
When adding a new allowed origin, update **both** files. A future refactor should extract this to a shared constant.

### `RemoteStorage.listMatches` returns `[]`
This is intentional. The lobby Durable Object owns the authoritative match list (stored as `match:${id}:metadata` keys in lobby storage). The match DO does not maintain its own list. Do not "fix" `RemoteStorage.listMatches` to return real data.
```

---

### 2. Testing Conventions section

**Rationale:** The `@ts-nocheck` pattern in test files, the `MockStorage` canonical pattern, and the E2E exclusion from `pnpm test` are all things agents need to know.

**Specific addition needed:**

```markdown
- `vitest.e2e.config.ts` exists but is not wired into `package.json`. E2E tests are run via
  `pnpm e2e:local` (which invokes `scripts/e2e-local.mjs`), not via Vitest directly.
```

---

### 3. Code Style section

**Rationale:** The boardgame.io internal import paths are fragile and non-obvious.

**Specific addition needed:**

```markdown
### boardgame.io import paths
- Use `boardgame.io/master` for `Master`.
- Use `boardgame.io/internal` for `ProcessGameConfig`, `getFilterPlayerView`, `createMatch`.
- Use `boardgame.io/dist/types/src/types` for type-only imports (`State`, `LogEntry`, `Game`, `Server`).
- Do not import from `boardgame.io/core` or `boardgame.io/client` in server-side code.
```

---

### 4. What Agents Should NOT Do section

**Rationale:** Negative constraints are as important as positive guidance.

**Additions needed:**

```markdown
- Do not replace the hand-rolled sequential queue in `match-room.ts` with `p-queue` or any external queue library.
- Do not add new allowed origins to only one of `server.ts` or `lobby.ts` — both must be updated.
- Do not "fix" `RemoteStorage.listMatches` to return real data — it intentionally returns `[]`.
- Do not remove `@ts-nocheck` from `server.ts` or `match-room.ts` without resolving the underlying type mismatches with `party.io`.
```

---

## Remaining Work (Not Yet Applied)

The following improvements are identified but not yet applied to `AGENTS.md`. They require either code changes or further discussion:

### Code-level fixes

1. **Add a comment to `RemoteStorage.listMatches`** explaining why it returns `[]`.
   - File: `src/remote-storage.ts`, line ~52
   - Change: `// Intentional: lobby DO owns the match list; match DOs do not maintain their own.`

2. **Add a comment to the sequential queue** in `match-room.ts` explaining why `p-queue` is not used.
   - File: `src/match-room.ts`, near the `SimpleQueue` interface
   - Change: `// p-queue v6.6.2 hangs in PartyKit/Miniflare due to I/O isolation. Hand-rolled queue only.`

3. **Extract `ALLOWED_ORIGINS`** to a shared constant (e.g., `src/cors.ts`) to eliminate the duplication between `server.ts` and `lobby.ts`.

4. **Document `MatchRoom` and `handleLobbyRequest`** in README under a new "Advanced API" section, or remove them from `src/index.ts` exports if they are not intended for public use.

### AGENTS.md additions

5. **Add boardgame.io import path guidance** (see section 3 above).
6. **Add sequential queue guidance** (see section 1 above).
7. **Add `ALLOWED_ORIGINS` duplication note** (see section 1 above).
8. **Add `RemoteStorage.listMatches` note** (see section 1 above).
9. **Add `vitest.e2e.config.ts` note** (see section 2 above).

---

## Priority Order

| Priority | Item | Effort |
|----------|------|--------|
| High | Add comments to `RemoteStorage.listMatches` and the sequential queue | 5 min |
| High | Add missing AGENTS.md sections (queue, CORS, listMatches, import paths) | 15 min |
| Medium | Extract `ALLOWED_ORIGINS` to shared constant | 30 min |
| Low | Document or remove `MatchRoom`/`handleLobbyRequest` from public exports | 1 hr |
| Low | Wire `vitest.e2e.config.ts` into a `package.json` script or delete it | 10 min |
