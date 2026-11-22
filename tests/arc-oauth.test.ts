import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
const mock = vi.hoisted(() => ({ jwk: {} as Record<string, unknown>, fetch: vi.fn() }));
vi.mock("jose", async (importOriginal) => {
  const actual = await importOriginal<typeof import("jose")>();
  return { ...actual, createRemoteJWKSet: () => async () => actual.importJWK(mock.jwk, "RS256") };
});
import { SignJWT, generateKeyPair, exportJWK } from "jose";
import { arcGoogleAuthorizeUrl, exchangeArcGoogleCode } from "@/lib/arc/google";
import { arcXAuthorizeUrl, exchangeArcX } from "@/lib/arc/x";
let privateKey: CryptoKey;
describe("Independent Arc social OAuth", () => {
  beforeEach(async () => {
    vi.stubEnv("APP_URL", "https://chainduel.unit");
    vi.stubEnv("GOOGLE_CLIENT_ID", "stellar-google");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "stellar-google-secret");
    vi.stubEnv("X_CLIENT_ID", "stellar-x");
    vi.stubEnv("X_CLIENT_SECRET", "stellar-x-secret");
    vi.stubEnv("ARC_GOOGLE_CLIENT_ID", "arc-google");
    vi.stubEnv("ARC_GOOGLE_CLIENT_SECRET", "unit-arc-google-secret");
    vi.stubEnv("ARC_X_CLIENT_ID", "arc-x");
    vi.stubEnv("ARC_X_CLIENT_SECRET", "unit-arc-x-secret");
    const pair = await generateKeyPair("RS256");
    privateKey = pair.privateKey;
    mock.jwk = await exportJWK(pair.publicKey);
    vi.stubGlobal("fetch", mock.fetch);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });
  async function googleToken(nonce = "expected", audience = "arc-google") {
    return new SignJWT({
      sub: "verified-google-id",
      nonce,
      name: "Duelist",
      email: "user@example.com",
      email_verified: true,
    })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer("https://accounts.google.com")
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
  }
  it("uses Arc clients, isolated callback paths and PKCE without changing Stellar credentials", () => {
    const google = new URL(arcGoogleAuthorizeUrl({ state: "state", challenge: "challenge", nonce: "nonce" }));
    expect(google.searchParams.get("client_id")).toBe("arc-google");
    expect(google.searchParams.get("redirect_uri")).toBe(
      "https://chainduel.unit/api/arc/auth/google/callback",
    );
    expect(google.searchParams.get("nonce")).toBe("nonce");
    expect(google.searchParams.get("code_challenge_method")).toBe("S256");
    const x = new URL(arcXAuthorizeUrl({ state: "state", challenge: "challenge" }));
    expect(x.searchParams.get("client_id")).toBe("arc-x");
    expect(x.searchParams.get("redirect_uri")).toBe("https://chainduel.unit/api/arc/auth/x/callback");
    expect(x.searchParams.get("code_challenge_method")).toBe("S256");
    expect(process.env.GOOGLE_CLIENT_ID).toBe("stellar-google");
    expect(process.env.X_CLIENT_ID).toBe("stellar-x");
  });
  it("verifies Google's signed identity and nonce using the Arc audience", async () => {
    mock.fetch.mockResolvedValue(Response.json({ id_token: await googleToken() }));
    const profile = await exchangeArcGoogleCode({ code: "code", verifier: "verifier", nonce: "expected" });
    expect(profile.providerAccountId).toBe("verified-google-id");
    expect(profile.email).toBe("user@example.com");
    const body = mock.fetch.mock.calls[0][1].body as URLSearchParams;
    expect(body.get("client_secret")).toBe("unit-arc-google-secret");
    expect(body.get("code_verifier")).toBe("verifier");
  });
  it("rejects a substituted Google nonce", async () => {
    mock.fetch.mockResolvedValue(Response.json({ id_token: await googleToken("other") }));
    await expect(
      exchangeArcGoogleCode({ code: "code", verifier: "verifier", nonce: "expected" }),
    ).rejects.toMatchObject({ code: "arc_google_identity_invalid" });
  });
  it("rejects Google identity tokens issued for Stellar's client", async () => {
    mock.fetch.mockResolvedValue(
      Response.json({ id_token: await googleToken("expected", "stellar-google") }),
    );
    await expect(
      exchangeArcGoogleCode({ code: "code", verifier: "verifier", nonce: "expected" }),
    ).rejects.toThrow();
  });
  it("does not replace a missing Google identity token with an unverified profile", async () => {
    mock.fetch.mockResolvedValue(Response.json({ access_token: "unit-access-token" }));
    await expect(
      exchangeArcGoogleCode({ code: "code", verifier: "verifier", nonce: "expected" }),
    ).rejects.toMatchObject({ code: "arc_google_failed" });
  });
  it("authenticates X's code exchange as the Arc client and reads the user-context identity", async () => {
    mock.fetch
      .mockResolvedValueOnce(Response.json({ access_token: "user-context-token", token_type: "bearer" }))
      .mockResolvedValueOnce(
        Response.json({ data: { id: "1234567890123456789", username: "duelist", name: "Duelist" } }),
      );
    const profile = await exchangeArcX({ code: "code", verifier: "verifier" });
    expect(profile.providerAccountId).toBe("1234567890123456789");
    expect(mock.fetch.mock.calls[0][1].headers.authorization).toBe(
      "Basic " + Buffer.from("arc-x:unit-arc-x-secret").toString("base64"),
    );
    expect(mock.fetch.mock.calls[1][1].headers.authorization).toBe("Bearer user-context-token");
    expect((mock.fetch.mock.calls[0][1].body as URLSearchParams).get("code_verifier")).toBe("verifier");
  });
  it("refuses X application or error responses that do not prove a user identity", async () => {
    mock.fetch
      .mockResolvedValueOnce(Response.json({ access_token: "user-context-token" }))
      .mockResolvedValueOnce(Response.json({ data: { id: "not-an-id", username: "duelist" } }));
    await expect(exchangeArcX({ code: "code", verifier: "verifier" })).rejects.toMatchObject({
      code: "arc_x_profile_failed",
    });
  });
});
