"use client";

import { postStellar } from "@/lib/api/client";
import type { StellarFinancialContext } from "@/lib/stellar/shared";
import { signTransactionXdr } from "@/lib/wallet/client";
import type { EscrowHandoffView, GameViewRow } from "@/lib/api/views";

export type EscrowStep =
  | "idle"
  | "preparing"
  | "awaiting_wallet"
  | "signing"
  | "submitting"
  | "confirming"
  | "confirmed"
  | "failed";

export interface EscrowResult {
  game: GameViewRow;
  txHash: string | null;
  demo: boolean;
}

interface EntryResponse {
  game: GameViewRow;
  escrow: EscrowHandoffView;
}

/**
 * Runs the full escrow handshake for a duel entry:
 *   1. ask the server to prepare the escrow invocation (or take it off-chain);
 *   2. if a wallet signature is required, hand the XDR to the player's wallet;
 *   3. submit the signed XDR and let the server confirm it on Stellar before we
 *      ever treat the entry as locked.
 *
 * Nothing here is trusted: the server never accepts an unsigned "I paid" claim.
 */
export async function runEscrow(input: {
  gameId: string;
  address: string;
  role?: "creator" | "joiner";
  onStep?: (step: EscrowStep) => void;
  financial?: StellarFinancialContext;
}): Promise<EscrowResult> {
  const { gameId, address, role, onStep } = input;
  onStep?.("preparing");
  let enrollment: { publicKeyHex: string; proofHex: string } | undefined;
  if (input.financial?.verification_version === 1) {
    const response = await fetch(`/api/matches/${gameId}`, { cache: "no-store" });
    if (!response.ok) throw new Error("The verified game could not be loaded.");
    const view = await response.json() as { game: GameViewRow };
    enrollment = await (await import("./verified-pulse")).createPulseEnrollment(view.game, address, role === "joiner" ? 2 : 1);
  }

  const prepared = await postStellar<EntryResponse>(`/api/duels/${gameId}/entry`, {
    action: "commit",
    ...(role ? { role } : {}),
    ...(enrollment ? { enrollment } : {}),
  }, input.financial);

  if (prepared.escrow.mode !== "wallet-signature") {
    onStep?.("confirmed");
    return { game: prepared.game, txHash: prepared.escrow.txHash ?? null, demo: prepared.escrow.mode === "offchain" };
  }

  if (!prepared.escrow.xdr || !prepared.escrow.transactionId) {
    throw new Error("The escrow transaction could not be prepared.");
  }

  onStep?.("awaiting_wallet");
  let signedXdr: string;
  try {
    signedXdr = await signTransactionXdr(prepared.escrow.xdr, address, prepared.escrow.networkPassphrase);
  } catch (error) {
    onStep?.("failed");
    throw error;
  }

  onStep?.("signing");
  onStep?.("submitting");
  const confirmed = await postStellar<EntryResponse>(`/api/duels/${gameId}/entry`, {
    action: "confirm",
    signedXdr,
    transactionId: prepared.escrow.transactionId,
  }, prepared.game);

  onStep?.("confirming");
  onStep?.("confirmed");
  return {
    game: confirmed.game,
    txHash: confirmed.escrow.txHash ?? null,
    demo: false,
  };
}

export interface EscrowCompletion {
  txHash: string | null;
  demo: boolean;
}

/**
 * Finishes an escrow handshake the server already prepared — for example the
 * joiner's entry, which `POST /api/duels/join` starts as part of joining. If the
 * handoff needs a wallet signature we sign and confirm it; otherwise the entry
 * is already locked and there is nothing left to submit.
 */
export async function completeEscrow(input: {
  gameId: string;
  address: string;
  escrow: { mode: string; xdr?: string; transactionId?: string; txHash?: string; networkPassphrase?: string };
  onStep?: (step: EscrowStep) => void;
  financial?: StellarFinancialContext;
}): Promise<EscrowCompletion> {
  const { gameId, address, escrow, onStep } = input;

  if (escrow.mode !== "wallet-signature") {
    onStep?.("confirmed");
    return { txHash: escrow.txHash ?? null, demo: escrow.mode === "offchain" };
  }

  if (!escrow.xdr || !escrow.transactionId) {
    if (input.financial?.verification_version === 1) return runEscrow({ gameId, address, role: "joiner", onStep, financial: input.financial });
    throw new Error("The escrow transaction could not be prepared.");
  }

  onStep?.("awaiting_wallet");
  let signedXdr: string;
  try {
    signedXdr = await signTransactionXdr(escrow.xdr, address, escrow.networkPassphrase);
  } catch (error) {
    onStep?.("failed");
    throw error;
  }

  onStep?.("submitting");
  const confirmed = await postStellar<EntryResponse>(`/api/duels/${gameId}/entry`, {
    action: "confirm",
    signedXdr,
    transactionId: escrow.transactionId,
  }, input.financial);
  onStep?.("confirming");
  onStep?.("confirmed");
  return { txHash: confirmed.escrow.txHash ?? null, demo: false };
}
