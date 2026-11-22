import "server-only";
import { appUrl } from "../config/env";
import { ChainDuelError } from "../services/errors";
import type { ProviderProfile } from "../auth/oauth";
export function arcXConfigured() {
  return Boolean(process.env.ARC_X_CLIENT_ID && process.env.ARC_X_CLIENT_SECRET);
}
function credentials() {
  const clientId = process.env.ARC_X_CLIENT_ID;
  const clientSecret = process.env.ARC_X_CLIENT_SECRET;
  if (!clientId || !clientSecret)
    throw new ChainDuelError("X sign-in for Arc is unavailable.", "arc_x_unavailable", 503);
  return { clientId, clientSecret };
}
export function arcXRedirectUri() {
  return `${appUrl()}/api/arc/auth/x/callback`;
}
export function arcXAuthorizeUrl(input: { state: string; challenge: string }) {
  const { clientId } = credentials();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: arcXRedirectUri(),
    response_type: "code",
    scope: "users.read tweet.read",
    state: input.state,
    code_challenge: input.challenge,
    code_challenge_method: "S256",
  });
  return `https://x.com/i/oauth2/authorize?${params}`;
}
export async function exchangeArcX(input: { code: string; verifier: string }): Promise<ProviderProfile> {
  const { clientId, clientSecret } = credentials();
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    code_verifier: input.verifier,
    redirect_uri: arcXRedirectUri(),
    client_id: clientId,
  });
  const response = await fetch("https://api.x.com/2/oauth2/token", {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body,
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok)
    throw new ChainDuelError("X sign-in did not complete. Please retry.", "arc_x_failed", 401);
  const token = (await response.json()) as { access_token?: string; token_type?: string };
  if (!token.access_token || (token.token_type && token.token_type.toLowerCase() !== "bearer"))
    throw new ChainDuelError("X did not authorize a user session.", "arc_x_failed", 401);
  const profile = await fetch("https://api.x.com/2/users/me?user.fields=name,username,profile_image_url", {
    headers: { authorization: `Bearer ${token.access_token}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!profile.ok)
    throw new ChainDuelError("X could not verify your profile. Please retry.", "arc_x_profile_failed", 401);
  const result = (await profile.json()) as {
    data?: { id: string; username: string; name?: string; profile_image_url?: string };
  };
  const user = result.data;
  if (!user || typeof user.id !== "string" || !/^\d{1,24}$/.test(user.id) || !user.username)
    throw new ChainDuelError("X returned an invalid user identity.", "arc_x_profile_failed", 401);
  return {
    provider: "x",
    providerAccountId: user.id,
    email: null,
    displayName: user.name ?? user.username,
    avatar: user.profile_image_url ?? null,
  };
}
