import { Account, BASE_FEE, Networks, Operation, StrKey, TransactionBuilder } from "@stellar/stellar-sdk";
import { STELLAR_DEPLOYMENT_ADMIN, type StellarNetworkId } from "../stellar/shared";
import type { PublicStellarVault } from "./vault-types";
import type { StellarAccountAuthority } from "../stellar/player-authority";
import { bytesHex, sha256 } from "../stellar/pulse-codec";

export interface PlayerMigrationQuote {
  baseReserveUnits: bigint; nativeBalanceUnits: bigint; sellingLiabilitiesUnits: bigint;
  numSponsoring: number; numSponsored: number; baseFeeUnits?: bigint; activeGames: number; pendingTransactions: number;
}
/** Public, unsigned review artifact. There is deliberately no execution method. */
export async function preparePlayerSignerMigration(account: StellarAccountAuthority, vault: PublicStellarVault, network: StellarNetworkId, quote: PlayerMigrationQuote) {
  if (account.account_id === STELLAR_DEPLOYMENT_ADMIN || vault.walletAddress === STELLAR_DEPLOYMENT_ADMIN) throw new Error("The designated deployment/admin wallet must remain unchanged.");
  if (vault.kind !== "delegated-recovery" || vault.walletAddress !== account.account_id || vault.network !== network || vault.deviceSignerAddress === vault.recoverySignerAddress || [vault.deviceSignerAddress, vault.recoverySignerAddress].includes(account.account_id) || ![vault.walletAddress, vault.deviceSignerAddress, vault.recoverySignerAddress].every(StrKey.isValidEd25519PublicKey)) throw new Error("The signer proposal must preserve the existing player account and use independently chosen player keys.");
  const weighted = account.signers.filter(signer => signer.weight > 0);
  if (weighted.length !== 1 || weighted[0].key !== account.account_id || weighted[0].weight < Math.max(1, account.thresholds.high_threshold)) throw new Error("This account's existing authority requires a separate individual review.");
  if (quote.activeGames || quote.pendingTransactions) throw new Error("Reconcile all active game liabilities and pending wallet transactions before changing player authority.");
  if (quote.baseReserveUnits <= 0n || quote.nativeBalanceUnits < 0n || quote.sellingLiabilitiesUnits < 0n) throw new Error("The Stellar reserve or balance quote is invalid.");
  const newEntries = [vault.deviceSignerAddress, vault.recoverySignerAddress].filter(address => !account.signers.some(signer => signer.key === address)).length;
  const reserve = BigInt(2 + account.subentry_count + newEntries + quote.numSponsoring - quote.numSponsored) * quote.baseReserveUnits;
  const fee = (quote.baseFeeUnits ?? BigInt(BASE_FEE)) * 3n;
  if (quote.nativeBalanceUnits - quote.sellingLiabilitiesUnits < reserve + fee) throw new Error("Additional XLM is required to preserve reserves and complete this signer migration.");
  const passphrase = network === "mainnet" ? Networks.PUBLIC : network === "testnet" ? Networks.TESTNET : null;
  if (!passphrase) throw new Error("Signer migrations are prepared only for explicitly selected Stellar Testnet or Mainnet accounts.");
  const transaction = new TransactionBuilder(new Account(account.account_id, account.sequence), { fee: String(quote.baseFeeUnits ?? BigInt(BASE_FEE)), networkPassphrase: passphrase })
    .addOperation(Operation.setOptions({ signer: { ed25519PublicKey: vault.deviceSignerAddress, weight: 1 } }))
    .addOperation(Operation.setOptions({ signer: { ed25519PublicKey: vault.recoverySignerAddress, weight: 1 } }))
    .addOperation(Operation.setOptions({ masterWeight: 0, lowThreshold: 1, medThreshold: 1, highThreshold: 1 })).setTimeout(600).build();
  return { version: 1, purpose: "player-controlled Stellar account authority", walletAddress: account.account_id, network, networkPassphrase: passphrase,
    deviceSigner: vault.deviceSignerAddress, recoverySigner: vault.recoverySignerAddress, masterWeightAfter: 0, thresholdsAfter: { low: 1, medium: 1, high: 1 },
    unsignedXdr: transaction.toXdr(), transactionHash: bytesHex(transaction.hash()),
    accountSnapshotHash: bytesHex(await sha256(new TextEncoder().encode(JSON.stringify(account)))),
    recoveryEnvelopeHash: bytesHex(await sha256(new TextEncoder().encode(JSON.stringify(vault.recoveryEnvelope)))),
    additionalReserveUnits: String(BigInt(newEntries) * quote.baseReserveUnits), reserveAfterUnits: String(reserve), transactionFeeUnits: String(fee),
    addressPreserved: true, executionEnabled: false, independentPlayerKeyConfirmationRequired: true, explicitPerWalletApprovalRequired: true,
    securityConditions: ["Independently confirm the real player's chosen public keys outside the game backend.", "Confirm the player's recovery backup locally before revoking the old master.", "Obtain approval for this exact wallet authority transition.", "Verify on-chain signer weights and rejection of the old key after execution.", "Keep the live backend without legacy decryption credentials or usable player key material."],
  } as const;
}
