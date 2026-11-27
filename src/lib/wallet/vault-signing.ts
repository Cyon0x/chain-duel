"use client";
import { Address, Asset, Transaction, TransactionBuilder, scValToNative, type xdr } from "@stellar/stellar-sdk";
import { bytesHex } from "../stellar/pulse-codec";
import { walletPublicConfig } from "./public-config";
import { loadClientSigner, walletSignerSlot, pulseSignerSlot } from "./vault-storage";
import { signWithClientVault } from "./vault-crypto";
import type { StellarVaultView } from "./vault-types";
import { STELLAR_MAINNET_USDC_ISSUER, STELLAR_TESTNET_USDC_ISSUER, type StellarPublicConfig } from "../stellar/shared";
import { CCTP_ADDRESSES } from "../bridge/cctp";

export const signatureBase64 = (bytes: Uint8Array): string => btoa(Array.from(bytes, value => String.fromCharCode(value)).join(""));
export async function playerVaultView(): Promise<StellarVaultView> {
  const response = await fetch("/api/wallet/vault", { cache: "no-store" });
  if (!response.ok) throw new Error("The player wallet association could not be checked.");
  return response.json() as Promise<StellarVaultView>;
}
export async function localPlayerWallet(address: string, config: StellarPublicConfig) {
  const view = await playerVaultView();
  if (view.walletAddress !== address || view.network !== config.id) throw new Error("Reconnect the original player wallet before signing.");
  if (view.custody === "managed" && view.status !== "client-delegated") throw new Error("This wallet's player-controlled signer migration is awaiting review.");
  const client = view.provider === "chain-duel-client" || view.status === "client-delegated";
  if (!client) return null;
  const signer = await loadClientSigner(walletSignerSlot(address, config.id));
  if (!signer || !view.publicVault || ![view.publicVault.deviceSignerAddress, view.publicVault.recoverySignerAddress].includes(signer.signerAddress)) throw new Error("Restore your saved recovery backup to unlock this wallet on this device.");
  return signer;
}
function callOf(transaction: Transaction) {
  if (transaction.operations.length !== 1 || transaction.operations[0].type !== "invokeHostFunction") return null;
  const operation = transaction.operations[0];
  if (operation.func.type !== "hostFunctionTypeInvokeContract") return null;
  const call = operation.func.invokeContract;
  return { contractId: Address.fromScAddress(call.contractAddress).toString(), method: call.functionName.toString(), args: call.args.map(scValToNative), rawArgs: call.args, operation };
}
async function reviewTransaction(transaction: Transaction, address: string, config: StellarPublicConfig): Promise<string> {
  if (transaction.source !== address || transaction.operations.length !== 1) throw new Error("This transaction does not belong to the connected player wallet.");
  const operation = transaction.operations[0];
  if (operation.source && operation.source !== address) throw new Error("Unexpected transaction source.");
  const fee = (Number(transaction.fee) / 10000000).toFixed(7);
  if (operation.type === "payment") {
    const issuer = config.id === "mainnet" ? STELLAR_MAINNET_USDC_ISSUER : STELLAR_TESTNET_USDC_ISSUER;
    if (!operation.asset.isNative() && (operation.asset.getCode() !== "USDC" || operation.asset.getIssuer() !== issuer)) throw new Error("This transfer does not use the official Stellar USDC asset.");
    return `Send ${operation.amount} ${operation.asset.getCode()} to\n${operation.destination}\n\nMaximum network fee: ${fee} XLM`;
  }
  if (operation.type === "changeTrust") {
    if (!(operation.line instanceof Asset) || operation.line.getCode() !== "USDC" || operation.line.getIssuer() !== config.asset.issuer) throw new Error("This trustline is not the approved Stellar USDC asset.");
    return `Enable USDC for ${address}.\nMaximum network fee: ${fee} XLM`;
  }
  const call = callOf(transaction);
  if (!call) throw new Error("This wallet operation requires a separate review.");
  if (["create_game", "join_game"].includes(call.method)) {
    if (!config.verification || call.contractId !== process.env.NEXT_PUBLIC_STELLAR_VERIFIED_CONTRACT_ID || call.contractId !== config.contractId || call.args[0] !== address || !(call.args[1] instanceof Uint8Array)) throw new Error("This stake is not bound to the reviewed verification contract.");
    const offset = call.method === "create_game" ? 5 : 2;
    const input = await loadClientSigner(pulseSignerSlot(call.contractId, bytesHex(call.args[1]), address, config.id));
    if (!input || !(call.args[offset] instanceof Uint8Array) || bytesHex(call.args[offset]) !== input.publicKeyHex || call.args.length !== (offset + 2)) throw new Error("The backend changed the player's locally registered gameplay key.");
    return `${call.method === "create_game" ? `Lock ${(Number(call.args[3]) / 10000000).toFixed(7)} ${config.asset.symbol}` : `Join the verified duel with its matching ${config.asset.symbol} stake`}.\nEscrow: ${call.contractId}\nMaximum network fee: ${fee} XLM`;
  }
  if (call.method === "transfer" && call.contractId === config.asset.contractId && call.args[0] === address) return `Send ${(Number(call.args[2]) / 10000000).toFixed(7)} ${config.asset.symbol} to\n${String(call.args[1])}\nMaximum network fee: ${fee} XLM`;
  if (call.method === "cancel_game" && call.contractId === config.contractId && call.args[0] === address) return `Cancel your waiting duel and return its entry to the original depositor.\nMaximum network fee: ${fee} XLM`;
  const cctp = CCTP_ADDRESSES[config.id === "mainnet" ? "mainnet" : "testnet"];
  if (call.method === "approve" && call.contractId === config.asset.contractId && call.args[0] === address && call.args[1] === cctp.stellarMessenger && call.args.length === 4) return `Approve ${(Number(call.args[2]) / 10000000).toFixed(7)} USDC for Circle's Stellar bridge.\nMaximum network fee: ${fee} XLM`;
  if (call.method === "deposit_for_burn" && call.contractId === cctp.stellarMessenger && call.args.length === 8 && call.args[0] === address && call.args[2] === 26 && call.args[4] === config.asset.contractId && call.args[3] instanceof Uint8Array) return `Bridge ${(Number(call.args[1]) / 10000000).toFixed(7)} USDC to Arc address\n0x${bytesHex(call.args[3]).slice(-40)}\nMaximum Circle fee: ${(Number(call.args[6]) / 10000000).toFixed(7)} USDC\nMaximum network fee: ${fee} XLM`;
  if (call.method === "mint_and_forward" && call.contractId === cctp.stellarForwarder && call.args.length === 2) return `Submit Circle's attested Stellar mint.\nMaximum network fee: ${fee} XLM`;
  throw new Error("This wallet cannot authorize unrelated contract or account-administration operations.");
}
export interface ApprovedPlayerGameCall { method: "submit_inputs" | "settle_game"; contractId: string; args: xdr.ScVal[] }
export async function signClientWalletTransaction(xdrBase64: string, address: string, passphrase: string, approvedGameCall?: ApprovedPlayerGameCall): Promise<string | null> {
  const config = await walletPublicConfig();
  if (config.playerSigning !== "client") return null;
  if (passphrase !== config.networkPassphrase) throw new Error("The signing request belongs to a different Stellar network.");
  const transaction = TransactionBuilder.fromXDR(xdrBase64, passphrase);
  if (!(transaction instanceof Transaction)) throw new Error("Review the inner transaction before a fee sponsor wraps it.");
  if (approvedGameCall) {
    if (!["submit_inputs", "settle_game"].includes(approvedGameCall.method)) throw new Error("This operation is outside the player's authorized gameplay scope.");
    const call = callOf(transaction);
    if (transaction.source !== address || !call || call.contractId !== config.contractId || call.contractId !== approvedGameCall.contractId || call.method !== approvedGameCall.method || call.rawArgs.length !== approvedGameCall.args.length || call.rawArgs.some((value, index) => bytesHex(value.toXdr()) !== bytesHex(approvedGameCall.args[index].toXdr())) || BigInt(transaction.fee) > 10000000n) throw new Error("The gameplay transaction changed after the player authorized its inputs.");
  } else {
    await reviewTransaction(transaction, address, config);
  }
  const signer = await localPlayerWallet(address, config); if (!signer) return null;
  if (!approvedGameCall && !window.confirm(`${await reviewTransaction(transaction, address, config)}\n\nApprove with your player-controlled wallet?`)) throw new Error("Wallet approval cancelled.");
  transaction.addSignature(signer.signerAddress, signatureBase64(await signWithClientVault(signer, transaction.hash())));
  return transaction.toXdr();
}
