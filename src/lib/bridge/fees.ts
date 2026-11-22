import "server-only";
import { arcConfig } from "../arc/config";
import { ChainDuelError } from "../services/errors";
export function feeUnits(amount: bigint, bps: string) {
  if (!/^\d+(\.\d{1,6})?$/.test(bps)) throw new Error("Unsupported fee precision.");
  const [w, f = ""] = bps.split(".");
  const scaled = BigInt(w) * 1_000_000n + BigInt(f.padEnd(6, "0"));
  const denominator = 10_000n * 1_000_000n;
  return (amount * scaled + denominator - 1n) / denominator;
}
export async function cctpFeeQuote(sourceDomain: 26 | 27, amount: bigint) {
  const destination = sourceDomain === 26 ? 27 : 26;
  const base = arcConfig().testnet ? "https://iris-api-sandbox.circle.com" : "https://iris-api.circle.com";
  const response = await fetch(`${base}/v2/burn/USDC/fees/${sourceDomain}/${destination}`, {
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok)
    throw new ChainDuelError(
      "Circle's transfer fee is temporarily unavailable.",
      "bridge_fee_unavailable",
      503,
    );
  const entries = (await response.json()) as {
    finalityThreshold: number;
    minimumFee: string | number;
  }[];
  const entry = entries.find((e) => e.finalityThreshold === 2000);
  if (!entry)
    throw new ChainDuelError(
      "Circle did not quote the standard transfer route.",
      "bridge_fee_unavailable",
      503,
    );
  const bps = String(entry.minimumFee);
  return {
    bps,
    maxFee: feeUnits(amount, bps),
    quotedAt: new Date().toISOString(),
  };
}
