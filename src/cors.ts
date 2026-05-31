/**
 * Allowed CORS origins shared across server.ts and lobby.ts.
 *
 * Add new origins here — do not duplicate this list in individual files.
 * In production the PartyKit host is the same origin as the client, so
 * same-origin requests are always allowed regardless of this list.
 */
export const ALLOWED_ORIGINS: readonly string[] = [
  "http://127.0.0.1:1999",
  "http://127.0.0.1:5173",
];
