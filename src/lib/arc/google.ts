import "server-only";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { appUrl } from "../config/env";
import { ChainDuelError } from "../services/errors";
import type { ProviderProfile } from "../auth/oauth";
const jwks = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));
export function arcGoogleConfigured() {
  return Boolean(process.env.ARC_GOOGLE_CLIENT_ID && process.env.ARC_GOOGLE_CLIENT_SECRET);
}
function credentials() {
  const clientId = process.env.ARC_GOOGLE_CLIENT_ID;
  const clientSecret = process.env.ARC_GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret)
    throw new ChainDuelError("Google sign-in for Arc is unavailable.", "arc_google_unavailable", 503);
  return { clientId, clientSecret };
}
export function arcGoogleRedirectUri() {
  return `${appUrl()}/api/arc/auth/google/callback`;
}
export function arcGoogleAuthorizeUrl(input: { state: string; challenge: string; nonce: string }) {
  const { clientId } = credentials();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: arcGoogleRedirectUri(),
    response_type: "code",
    scope: "openid email profile",
    state: input.state,
    code_challenge: input.challenge,
    code_challenge_method: "S256",
    nonce: input.nonce,
    access_type: "online",
    prompt: "select_account",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}
export async function exchangeArcGoogleCode(input: {
  code: string;
  verifier: string;
  nonce: string;
}): Promise<ProviderProfile> {
  const { clientId, clientSecret } = credentials();
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    client_secret: clientSecret,
    code: input.code,
    code_verifier: input.verifier,
    redirect_uri: arcGoogleRedirectUri(),
  });
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok)
    throw new ChainDuelError("Google sign-in did not complete. Please retry.", "arc_google_failed", 401);
  const tokens = (await response.json()) as { id_token?: string };
  if (!tokens.id_token)
    throw new ChainDuelError("Google did not return a verified identity.", "arc_google_failed", 401);
  const { payload } = await jwtVerify(tokens.id_token, jwks, {
    issuer: ["https://accounts.google.com", "accounts.google.com"],
    audience: clientId,
    algorithms: ["RS256"],
  });
  if (
    !payload.sub ||
    typeof payload.sub !== "string" ||
    payload.nonce !== input.nonce ||
    (payload.azp && payload.azp !== clientId)
  )
    throw new ChainDuelError(
      "Google identity verification failed. Please retry.",
      "arc_google_identity_invalid",
      401,
    );
  return {
    provider: "google",
    providerAccountId: payload.sub,
    email: payload.email_verified === true && typeof payload.email === "string" ? payload.email : null,
    displayName: typeof payload.name === "string" ? payload.name : null,
    avatar: typeof payload.picture === "string" ? payload.picture : null,
  };
}
