/**
 * Canonical arena/invite links. The copied link, the shared link and the QR
 * code all build from these helpers so they can never point at different
 * arenas — the QR is just another way to open the exact same invite.
 */

/** App-relative path for an arena invite (shared by server and client). */
export function arenaInvitePath(code: string): string {
  return `/duel/${code}`;
}

/** Absolute arena invite URL built from the current origin. */
export function arenaInviteUrl(origin: string, code: string): string {
  const base = origin.replace(/\/+$/, "");
  return `${base}${arenaInvitePath(code)}`;
}
