import "server-only";
import { parseUnits } from "viem";
import type { TransactionFee } from "@circle-fin/user-controlled-wallets";
import { ARC_MIN_MAX_FEE, formatUsdc } from "../networks/arc";
import { ChainDuelError } from "../services/errors";

const NATIVE_PER_USDC_UNIT = 1_000_000_000_000n;

export function arcFeeBudget(estimate: TransactionFee | undefined) {
  if (
    !estimate?.gasLimit || !/^[1-9]\d*$/.test(estimate.gasLimit) ||
    !estimate.maxFee || !/^(0|[1-9]\d*)(\.\d{1,9})?$/.test(estimate.maxFee) ||
    !estimate.priorityFee || !/^(0|[1-9]\d*)(\.\d{1,9})?$/.test(estimate.priorityFee)
  ) throw new ChainDuelError("Arc network fees could not be verified. Please retry.", "fee_unavailable", 503);
  const gas = BigInt(estimate.gasLimit);
  const maxFee = parseUnits(estimate.maxFee, 9);
  const priorityFee = parseUnits(estimate.priorityFee, 9);
  if (maxFee < ARC_MIN_MAX_FEE || priorityFee > maxFee)
    throw new ChainDuelError("Arc network fees could not be verified. Please retry.", "fee_unavailable", 503);
  return {
    reserve: gas * maxFee,
    fee: {
      type: "absolute" as const,
      config: { gasLimit: estimate.gasLimit, maxFee: estimate.maxFee, priorityFee: estimate.priorityFee },
    },
  };
}

export function requireArcFunds(balance: bigint, debitUnits: bigint, reserve: bigint) {
  const required = debitUnits * NATIVE_PER_USDC_UNIT + reserve;
  if (balance < required) {
    const gasUnits = (reserve + NATIVE_PER_USDC_UNIT - 1n) / NATIVE_PER_USDC_UNIT;
    throw new ChainDuelError(
      `This transaction needs at least ${formatUsdc(debitUnits + gasUnits)} USDC, ` +
      `including up to ${formatUsdc(gasUnits)} USDC for gas. Add USDC and retry.`,
      "insufficient_balance", 422,
    );
  }
}
