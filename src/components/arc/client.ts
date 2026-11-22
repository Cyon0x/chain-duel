import type { ArcNetworkId } from "@/lib/networks/arc";
export async function arcFetch<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    cache: "no-store",
    ...options,
    headers: { "content-type": "application/json", ...options?.headers },
  });
  const body = await response.json();
  if (!response.ok)
    throw new Error(
      typeof body.error === "string" ? body.error : "This Arc action could not complete. Please retry.",
    );
  return body as T;
}
export function arcBody(networkId: ArcNetworkId, extra: Record<string, unknown> = {}) {
  return JSON.stringify({ networkId, currency: "USDC", ...extra });
}
export async function executeCircle(input: {
  appId: string | null;
  credentials: { userToken: string; encryptionKey: string } | null;
  challengeId: string | null;
}) {
  if (!input.credentials || !input.challengeId) return;
  if (!input.appId) throw new Error("Circle wallet authorization is unavailable.");
  const { W3SSdk } = await import("@circle-fin/w3s-pw-web-sdk");
  const sdk = new W3SSdk({ appSettings: { appId: input.appId } });
  sdk.setAuthentication(input.credentials);
  await new Promise<void>((resolve, reject) =>
    sdk.execute(input.challengeId!, (error) =>
      error ? reject(new Error(error.message || "Wallet authorization was cancelled.")) : resolve(),
    ),
  );
}
