import "server-only";
import { StrKey } from "@stellar/stellar-sdk";
import { createHash } from "node:crypto";
import { rawEnv } from "./env";
import { PULSE_RULES_LABEL } from "../stellar/pulse-codec";
import type { StellarFinancialContext, StellarNetworkId } from "../stellar/shared";

export function playerControlledSigningEnabled(): boolean { return rawEnv().STELLAR_PLAYER_SIGNING_MODE === "client"; }
export function stellarVerificationEnabled(network?: StellarNetworkId): boolean {
  const env = rawEnv(); const configured = env.STELLAR_NETWORK ?? "testnet";
  return env.STELLAR_VERIFICATION_VERSION === "1" && (network === undefined || network === configured);
}
export function verifiedContractId(network?: StellarNetworkId): string | null {
  if (!stellarVerificationEnabled(network)) return null;
  const env = rawEnv(); const id = env.CHAIN_DUEL_VERIFIED_CONTRACT_ID?.trim();
  if (!id || !StrKey.isValidContract(id) || !/^[0-9a-f]{64}$/.test(env.STELLAR_VERIFIED_WASM_HASH ?? "") || !playerControlledSigningEnabled()) throw new Error("Verified Stellar requires a pinned contract, WASM hash and player-controlled signing.");
  if ((env.STELLAR_NETWORK ?? "testnet") === "mainnet" && env.STELLAR_VERIFIED_MAINNET_APPROVED !== "true") throw new Error("The independent-verification architecture has not been approved for Mainnet.");
  return id;
}
export function isVerifiedGame(game: StellarFinancialContext & { demo?: number }): boolean { return !game.demo && game.verification_version === 1; }
export function serverPulseRulesHash(): string { return createHash("sha256").update(PULSE_RULES_LABEL).digest("hex"); }
