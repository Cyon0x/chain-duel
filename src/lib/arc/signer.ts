import "server-only";
import { readFileSync, statSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import { createWalletClient, http } from "viem";
import { arcNetwork } from "../networks/arc";
import { arcConfig } from "./config";

export function arcSettlementSigner() {
  let key = process.env.ARC_SETTLEMENT_PRIVATE_KEY;
  if (!key && process.env.ARC_SETTLEMENT_KEY_FILE) {
    const path = process.env.ARC_SETTLEMENT_KEY_FILE;
    if ((statSync(path).mode & 0o077) !== 0) throw new Error("Arc signer file must be private to its owner.");
    key = readFileSync(path, "utf8").trim();
  }
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("Arc settlement signer is not configured.");
  const account = privateKeyToAccount(key as `0x${string}`);
  const config = arcConfig();
  return createWalletClient({
    account,
    chain: arcNetwork(config.networkId),
    transport: http(config.rpcUrl, { timeout: 15_000, retryCount: 0 }),
  });
}
