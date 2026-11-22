import "server-only";
import { createPublicClient, http, erc20Abi, type Address } from "viem";
import { ARC_USDC, arcNetwork, formatUsdc } from "../networks/arc";
import { arcConfig } from "./config";
import { ChainDuelError } from "../services/errors";

export function arcPublicClient() {
  const config = arcConfig();
  return createPublicClient({
    chain: arcNetwork(config.networkId),
    transport: http(config.rpcUrl, { timeout: 15_000, retryCount: 1 }),
  });
}
export async function verifiedArcClient() {
  const config = arcConfig();
  const client = arcPublicClient();
  if ((await client.getChainId()) !== config.id)
    throw new ChainDuelError(
      "The Arc connection has the wrong network. Transactions are paused.",
      "wrong_network",
      503,
    );
  const decimals = await client.readContract({ address: ARC_USDC, abi: erc20Abi, functionName: "decimals" });
  if (decimals !== 6)
    throw new ChainDuelError("The Arc USDC configuration could not be verified.", "wrong_token", 503);
  return client;
}
export async function arcBalance(address: Address) {
  const client = await verifiedArcClient();
  const units = await client.readContract({
    address: ARC_USDC,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address],
  });
  return { units: units.toString(), formatted: formatUsdc(units) };
}
