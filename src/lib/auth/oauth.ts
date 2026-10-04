import "server-only";
import { createHash } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { appUrl, rawEnv } from "../config/env";
import { secureToken } from "../game/rng";
import { ChainDuelError } from "../services/errors";

export type OAuthProvider = "google" | "x";

export interface ProviderProfile {
  provider: OAuthProvider;
  providerAccountId: string;
  email: string | null;
  displayName: string | null;
  avatar: string | null;
}

export function providerConfigured(provider: OAuthProvider): boolean {
  const env = rawEnv();
  return provider === "google"
    ? Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET)
    : Boolean(env.X_CLIENT_ID && env.X_CLIENT_SECRET);
}

export function configuredProviders(): OAuthProvider[] {
  return (["google", "x"] as OAuthProvider[]).filter(providerConfigured);
}

function credentials(provider: OAuthProvider): { clientId: string; clientSecret: string } {
  const env = rawEnv();
  if (provider === "google") {
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
      throw new ChainDuelError("Google sign-in is not configured on this deployment.", "not_configured", 503);
    }
    return { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET };
  }
  if (!env.X_CLIENT_ID || !env.X_CLIENT_SECRET) {
    throw new ChainDuelError("X sign-in is not configured on this deployment.", "not_configured", 503);
  }
  return { clientId: env.X_CLIENT_ID, clientSecret: env.X_CLIENT_SECRET };
}

export function redirectUri(provider: OAuthProvider): string {
  return `${appUrl()}/api/auth/oauth/${provider}/callback`;
}

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = secureToken(48);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function newState(): string {
  return secureToken(24);
}

export function authorizeUrl(input: {
  provider: OAuthProvider;
  state: string;
  codeChallenge: string;
}): string {
  const { clientId } = credentials(input.provider);
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri(input.provider),
    response_type: "code",
    state: input.state,
    code_challenge: input.codeChallenge,
    code_challenge_method: "S256",
  });
  if (input.provider === "google") {
    params.set("scope", "openid email profile");
    params.set("access_type", "online");
    params.set("prompt", "select_account");
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }
  params.set("scope", "users.read tweet.read");
  return `https://twitter.com/i/oauth2/authorize?${params.toString()}`;
}

export async function exchangeCode(input: {
  provider: OAuthProvider;
  code: string;
  codeVerifier: string;
}): Promise<ProviderProfile> {
  const { clientId, clientSecret } = credentials(input.provider);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: redirectUri(input.provider),
    code_verifier: input.codeVerifier,
    client_id: clientId,
  });

  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
  };
  if (input.provider === "x") {
    // X confidential clients authenticate the token request with HTTP Basic.
    headers.authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
  } else {
    // Google's token endpoint requires the client secret in the body for a
    // web-server client; omitting it makes every code exchange fail.
    body.set("client_secret", clientSecret);
  }

  const tokenResponse = await fetch(tokenEndpoint(input.provider), {
    method: "POST",
    headers,
    body,
  });
  if (!tokenResponse.ok) {
    // Log the provider's reason server-side; never surface it to the player.
    const detail = await tokenResponse.text().catch(() => "");
    console.error(
      `[chain-duel] ${input.provider} token exchange failed (${tokenResponse.status}):`,
      detail.slice(0, 500),
    );
    throw new ChainDuelError(
      `Sign-in with ${input.provider === "google" ? "Google" : "X"} failed.`,
      "oauth_failed",
      401,
    );
  }
  const tokens = (await tokenResponse.json()) as {
    access_token?: string;
    id_token?: string;
  };

  if (input.provider === "google") {
    return googleProfile(tokens);
  }
  if (!tokens.access_token) {
    throw new ChainDuelError("X did not return an access token.", "oauth_failed", 401);
  }
  return xProfile(tokens.access_token);
}

function tokenEndpoint(provider: OAuthProvider): string {
  return provider === "google"
    ? "https://oauth2.googleapis.com/token"
    : "https://api.twitter.com/2/oauth2/token";
}

const googleJwks = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

async function googleProfile(tokens: { access_token?: string; id_token?: string }): Promise<ProviderProfile> {
  const { clientId } = credentials("google");
  if (tokens.id_token) {
    const { payload } = await jwtVerify(tokens.id_token, googleJwks, {
      issuer: ["https://accounts.google.com", "accounts.google.com"],
      audience: clientId,
    });
    return {
      provider: "google",
      providerAccountId: String(payload.sub),
      email: payload.email ? String(payload.email) : null,
      displayName: payload.name ? String(payload.name) : null,
      avatar: payload.picture ? String(payload.picture) : null,
    };
  }
  if (!tokens.access_token) {
    throw new ChainDuelError("Google did not return an identity token.", "oauth_failed", 401);
  }
  const response = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { authorization: `Bearer ${tokens.access_token}` },
  });
  if (!response.ok) {
    throw new ChainDuelError("Could not read your Google profile.", "oauth_failed", 401);
  }
  const profile = (await response.json()) as {
    sub: string;
    email?: string;
    name?: string;
    picture?: string;
  };
  return {
    provider: "google",
    providerAccountId: profile.sub,
    email: profile.email ?? null,
    displayName: profile.name ?? null,
    avatar: profile.picture ?? null,
  };
}

async function xProfile(accessToken: string): Promise<ProviderProfile> {
  const response = await fetch(
    "https://api.twitter.com/2/users/me?user.fields=profile_image_url,username,name",
    { headers: { authorization: `Bearer ${accessToken}` } },
  );
  if (!response.ok) {
    throw new ChainDuelError("Could not read your X profile.", "oauth_failed", 401);
  }
  const payload = (await response.json()) as {
    data?: { id: string; username: string; name?: string; profile_image_url?: string };
  };
  if (!payload.data) {
    throw new ChainDuelError("X did not return a profile.", "oauth_failed", 401);
  }
  return {
    provider: "x",
    providerAccountId: payload.data.id,
    email: null,
    displayName: payload.data.name ?? payload.data.username,
    avatar: payload.data.profile_image_url ?? null,
  };
}
