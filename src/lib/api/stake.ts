import { parseStakeXlm, type StakeParseOptions } from "@/lib/config/game";
import { ChainDuelError } from "@/lib/services/errors";

/**
 * Validates a client-supplied XLM entry and returns the exact stroop amount the
 * duel/escrow will use. Reuses the same `parseStakeXlm` rules as the UI so the
 * API can never accept an amount the picker would reject (or vice versa).
 */
export function entryStroopsOrThrow(value: unknown, opts: StakeParseOptions = {}): number {
  const parsed = parseStakeXlm(value, opts);
  if (!parsed.ok) throw new ChainDuelError(parsed.error, "invalid_entry");
  return parsed.stroops;
}
