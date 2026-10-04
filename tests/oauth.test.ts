/**
 * OAuth 2.0 + PKCE shape checks. These never touch the network: they assert the
 * authorization request we hand to Google/X, the PKCE derivation, and the
 * configured callback URI, so a provider integration cannot silently regress.
 *
 * `rawEnv()` caches on first read, so each case sets env vars and then imports
 * the module fresh via `vi.resetModules()`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

const env = process.env as Record<string, string | undefined>;
const touched = ["APP_URL", "X_CLIENT_ID", "X_CLIENT_SECRET", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"];
const saved: Record<string, string | undefined> = {};
for (const key of touched) saved[key] = env[key];

async function oauth() {
  vi.resetModules();
  return import("@/lib/auth/oauth");
}

beforeEach(() => {
  env.APP_URL = "https://chain-duel.vercel.app";
  env.X_CLIENT_ID = "test-x-client";
  env.X_CLIENT_SECRET = "test-x-secret";
  env.GOOGLE_CLIENT_ID = "test-google-client";
  env.GOOGLE_CLIENT_SECRET = "test-google-secret";
});

afterEach(() => {
  for (const key of touched) {
    if (saved[key] === undefined) delete env[key];
    else env[key] = saved[key];
  }
});

describe("oauth", () => {
  it("detects configured providers", async () => {
    const { providerConfigured } = await oauth();
    expect(providerConfigured("x")).toBe(true);
    expect(providerConfigured("google")).toBe(true);
  });

  it("treats a provider as unconfigured when the secret is missing", async () => {
    delete env.X_CLIENT_SECRET;
    const { providerConfigured } = await oauth();
    expect(providerConfigured("x")).toBe(false);
    expect(providerConfigured("google")).toBe(true);
  });

  it("uses the production callback URI for each provider", async () => {
    const { redirectUri } = await oauth();
    expect(redirectUri("x")).toBe("https://chain-duel.vercel.app/api/auth/oauth/x/callback");
    expect(redirectUri("google")).toBe("https://chain-duel.vercel.app/api/auth/oauth/google/callback");
  });

  it("derives an S256 PKCE challenge from a legal verifier", async () => {
    const { createPkcePair } = await oauth();
    const { verifier, challenge } = createPkcePair();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]+$/);
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
    expect(challenge).toMatch(/^[A-Za-z0-9\-_]+$/);
    expect(challenge).not.toContain("=");
  });

  it("produces unpredictable state values", async () => {
    const { newState } = await oauth();
    const values = new Set(Array.from({ length: 50 }, () => newState()));
    expect(values.size).toBe(50);
    for (const value of values) expect(value.length).toBeGreaterThanOrEqual(32);
  });

  it("builds the X authorization request with PKCE and no client secret", async () => {
    const { authorizeUrl, createPkcePair } = await oauth();
    const { verifier, challenge } = createPkcePair();
    const url = new URL(authorizeUrl({ provider: "x", state: "state-123", codeChallenge: challenge }));
    expect(url.origin + url.pathname).toBe("https://twitter.com/i/oauth2/authorize");
    expect(url.searchParams.get("client_id")).toBe("test-x-client");
    expect(url.searchParams.get("redirect_uri")).toBe("https://chain-duel.vercel.app/api/auth/oauth/x/callback");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBe("state-123");
    expect(url.searchParams.get("code_challenge")).toBe(challenge);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toContain("users.read");
    // The secret must never leak into the browser-facing URL.
    expect(url.toString()).not.toContain("test-x-secret");
    expect(url.toString()).not.toContain(verifier);
  });

  it("builds the Google authorization request with OpenID scopes", async () => {
    const { authorizeUrl, createPkcePair } = await oauth();
    const { challenge } = createPkcePair();
    const url = new URL(authorizeUrl({ provider: "google", state: "s", codeChallenge: challenge }));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("scope")).toBe("openid email profile");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.toString()).not.toContain("test-google-secret");
  });

  it("refuses to build a request for an unconfigured provider", async () => {
    delete env.X_CLIENT_ID;
    const { authorizeUrl } = await oauth();
    expect(() => authorizeUrl({ provider: "x", state: "s", codeChallenge: "c" })).toThrow(/not configured/i);
  });
});

describe("oauth token exchange", () => {
  it("sends the client secret in the body for Google and never logs it", async () => {
    const calls: { url: string; body: string; headers: Record<string, string> }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      calls.push({ url: String(url), body: String(init.body ?? ""), headers: (init.headers ?? {}) as Record<string, string> });
      if (String(url).includes("/token")) {
        return new Response(JSON.stringify({ access_token: "at-123" }), { status: 200 });
      }
      return new Response(JSON.stringify({ sub: "google-1", email: "player@example.com", name: "Player" }), { status: 200 });
    });
    const { exchangeCode } = await oauth();
    const profile = await exchangeCode({ provider: "google", code: "the-code", codeVerifier: "the-verifier" });

    const tokenCall = calls.find((c) => c.url.includes("oauth2.googleapis.com/token"));
    expect(tokenCall).toBeDefined();
    const body = new URLSearchParams(tokenCall!.body);
    expect(body.get("client_secret")).toBe("test-google-secret");
    expect(body.get("client_id")).toBe("test-google-client");
    expect(body.get("code")).toBe("the-code");
    expect(body.get("code_verifier")).toBe("the-verifier");
    expect(body.get("redirect_uri")).toBe("https://chain-duel.vercel.app/api/auth/oauth/google/callback");
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(profile.providerAccountId).toBe("google-1");
    vi.unstubAllGlobals();
  });

  it("authenticates X with HTTP Basic and keeps the secret out of the body", async () => {
    const calls: { url: string; body: string; headers: Record<string, string> }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      calls.push({ url: String(url), body: String(init.body ?? ""), headers: (init.headers ?? {}) as Record<string, string> });
      if (String(url).includes("/oauth2/token")) {
        return new Response(JSON.stringify({ access_token: "at-123" }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: { id: "x-1", username: "duelist", name: "Duelist" } }), { status: 200 });
    });
    const { exchangeCode } = await oauth();
    const profile = await exchangeCode({ provider: "x", code: "the-code", codeVerifier: "the-verifier" });

    const tokenCall = calls.find((c) => c.url.includes("api.twitter.com/2/oauth2/token"));
    expect(tokenCall).toBeDefined();
    expect(new URLSearchParams(tokenCall!.body).get("client_secret")).toBeNull();
    const expected = `Basic ${Buffer.from("test-x-client:test-x-secret").toString("base64")}`;
    expect(tokenCall!.headers.authorization).toBe(expected);
    expect(profile.providerAccountId).toBe("x-1");
    vi.unstubAllGlobals();
  });

  it("surfaces a provider-neutral error when the exchange is rejected", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }));
    const { exchangeCode } = await oauth();
    await expect(exchangeCode({ provider: "google", code: "c", codeVerifier: "v" })).rejects.toThrow(
      /Sign-in with Google failed/i,
    );
    vi.unstubAllGlobals();
  });
});
