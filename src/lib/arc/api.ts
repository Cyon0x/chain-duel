import { z } from "zod";
import { arcConfig } from "./config";
import { ChainDuelError } from "../services/errors";
export const arcRequest = z.object({
  networkId: z.enum(["arc-mainnet", "arc-testnet"]),
  currency: z.literal("USDC"),
});
export function validateArcRequest(input: unknown) {
  const parsed = arcRequest.parse(input);
  if (parsed.networkId !== arcConfig().networkId)
    throw new ChainDuelError("Select the correct Arc network before continuing.", "wrong_network", 409);
  return parsed;
}
export const submissionSchema = z.object({
  seat: z.number().int().min(1).max(2),
  clientScore: z.number().int(),
  clientDurationMs: z.number().int().optional(),
  hits: z
    .array(z.object({ targetId: z.number().int().nonnegative(), atMs: z.number().int().nonnegative() }))
    .max(1500),
  misses: z.array(z.object({ atMs: z.number().int().nonnegative() })).max(2500),
});
