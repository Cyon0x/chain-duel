import "server-only";
import { Keypair, nativeToScVal, scValToNative, type xdr } from "@stellar/stellar-sdk";
import { createHash } from "node:crypto";
import { verifiedContractId, serverPulseRulesHash, isVerifiedGame } from "../config/stellar-verification";
import { stellarNetwork } from "../config/stellar";
import { STELLAR_DEPLOYMENT_ADMIN, financialNetwork } from "./shared";
import { bytesHex, hexBytes, pulseEnrollmentMessage, type SignedPulseInputs } from "./pulse-codec";
import { decodeVerifiedPulseState, type VerifiedPulseState } from "./pulse-state";
import { getOnChainConfig } from "./contract";
import { invokeWithServerKey, prepareInvocation, readContractState, rpcServer, scv, transactionReceipt, latestLedger } from "./server";
import { gameEscrowContractId } from "../services/escrow";
import type { GameRow } from "../db/types";
import { ChainDuelError } from "../services/errors";

export interface PulseEnrollmentProof { publicKeyHex: string; proofHex: string }
export async function verifiedGameContract(game: GameRow): Promise<string> {
  const id = await gameEscrowContractId(game.id); const pinned = verifiedContractId(financialNetwork(game));
  if (!isVerifiedGame(game) || !pinned || id !== pinned || !game.contract_game_id) throw new ChainDuelError("This duel is not bound to the reviewed independent-verification contract.", "verified_contract_mismatch", 409);
  const config = await getOnChainConfig(id, financialNetwork(game));
  if (!config || config.admin !== STELLAR_DEPLOYMENT_ADMIN || config.treasury !== STELLAR_DEPLOYMENT_ADMIN || config.protocolFeeRecipient !== STELLAR_DEPLOYMENT_ADMIN || config.ecosystemFeeRecipient !== STELLAR_DEPLOYMENT_ADMIN || config.ecosystemBeneficiary !== STELLAR_DEPLOYMENT_ADMIN || config.token !== game.token_contract_id || config.protocolFeeBps !== 500 || config.ecosystemFeeBps !== 500) throw new ChainDuelError("The verified escrow administrator, asset or fee allocation does not match this game.", "verified_config_mismatch", 409);
  const rules = await readContractState("get_rules_hash", [], id, financialNetwork(game));
  if (!(rules instanceof Uint8Array) || bytesHex(rules) !== serverPulseRulesHash()) throw new ChainDuelError("The contract's Pulse rules do not match the approved implementation.", "verified_rules_mismatch", 409);
  const entry = await rpcServer(financialNetwork(game)).getLedgerEntries(new (await import("@stellar/stellar-sdk")).Contract(id).getFootprint());
  const instance = entry.entries[0]?.val;
  if (!instance || instance.type !== "contractData" || instance.contractData.val.type !== "scvContractInstance" || instance.contractData.val.instance.executable.type !== "contractExecutableWasm" || bytesHex(instance.contractData.val.instance.executable.wasmHash.value) !== (await import("../config/env")).rawEnv().STELLAR_VERIFIED_WASM_HASH) throw new ChainDuelError("The deployed Pulse WASM does not match the reviewed artifact.", "verified_wasm_mismatch", 409);
  return id;
}
export async function verifiedPulseState(game: GameRow): Promise<VerifiedPulseState> {
  const id = await verifiedGameContract(game);
  const state = decodeVerifiedPulseState(await readContractState("get_game", [scv.bytes32(game.contract_game_id!)], id, financialNetwork(game)));
  if (state.id !== game.contract_game_id || state.entryAmount !== String(game.entry_stroops) || state.mode !== (game.mode === "bot" ? 1 : 0)) throw new ChainDuelError("The on-chain Pulse game does not match its escrow record.", "verified_game_mismatch", 409);
  return state;
}
export async function prepareVerifiedEntry(game: GameRow, address: string, role: "creator" | "joiner", enrollment: PulseEnrollmentProof) {
  const id = await verifiedGameContract(game); const net = stellarNetwork(financialNetwork(game)); const seat = role === "creator" ? 1 : 2;
  const message = await pulseEnrollmentMessage({ networkPassphrase: net.networkPassphrase, contractId: id, gameIdHex: game.contract_game_id!, player: address, seat, publicKeyHex: enrollment.publicKeyHex });
  const pub = (await import("@stellar/stellar-sdk")).StrKey.encodeEd25519PublicKey(hexBytes(enrollment.publicKeyHex, 32));
  if (!Keypair.fromPublicKey(pub).verify(message, hexBytes(enrollment.proofHex, 64))) throw new ChainDuelError("The gameplay key proof was not signed by the player's device.", "input_enrollment_invalid", 422);
  const current = await latestLedger(financialNetwork(game));
  const expiryLedger = current + Math.ceil(Math.max(60000, Date.parse(game.expires_at) - Date.now()) / 5000) + 40;
  const args: xdr.ScVal[] = role === "creator"
    ? [scv.address(address), scv.bytes32(game.contract_game_id!), scv.u32(game.mode === "bot" ? 1 : 0), scv.i128(game.entry_stroops), scv.u32(expiryLedger), nativeToScVal(hexBytes(enrollment.publicKeyHex, 32)), nativeToScVal(hexBytes(enrollment.proofHex, 64))]
    : [scv.address(address), scv.bytes32(game.contract_game_id!), nativeToScVal(hexBytes(enrollment.publicKeyHex, 32)), nativeToScVal(hexBytes(enrollment.proofHex, 64))];
  return { ...await prepareInvocation({ publicKey: address, method: role === "creator" ? "create_game" : "join_game", args, escrowContractId: id, networkId: financialNetwork(game) }), expiryLedger };
}
export async function relayVerifiedInputs(game: GameRow, input: SignedPulseInputs) {
  const id = await verifiedGameContract(game);
  if (input.version !== 1 || !Number.isInteger(input.sequence) || input.sequence < 0 || typeof input.closed !== "boolean") throw new ChainDuelError("Invalid player input authorization.", "invalid_input_authorization", 422);
  const transcript = hexBytes(input.transcriptHex); if (transcript.length > 24000 || transcript.length % 6) throw new ChainDuelError("Invalid Pulse transcript size.", "invalid_transcript", 422);
  const signature = hexBytes(input.signatureHex, 64);
  const digest = createHash("sha256").update(signature).update(transcript).digest("hex");
  return invokeWithServerKey({ networkId: financialNetwork(game), escrowContractId: id, method: "submit_inputs", intentId: `pulse-input:${game.id}:${input.player}:${input.sequence}:${digest}`,
    args: [scv.bytes32(game.contract_game_id!), scv.address(input.player), scv.u32(input.sequence), scv.bool(input.closed), nativeToScVal(transcript), nativeToScVal(signature)] });
}
export async function settleVerifiedGame(game: GameRow) {
  const id = await verifiedGameContract(game);
  return invokeWithServerKey({ networkId: financialNetwork(game), escrowContractId: id, method: "settle_game", intentId: `pulse-settlement:${game.id}`, args: [scv.bytes32(game.contract_game_id!)] });
}

/** Also recovers a permissionless settlement submitted directly by a player. */
export async function verifiedSettlementReceipt(game: GameRow, state: VerifiedPulseState): Promise<string> {
  if (state.status !== 4 || state.settledLedger <= 0) throw new ChainDuelError("The contract has not settled this duel.", "verified_settlement_pending", 409);
  const id = await verifiedGameContract(game);
  const events = await rpcServer(financialNetwork(game)).getEvents({ startLedger: state.settledLedger, endLedger: state.settledLedger + 1, limit: 100,
    filters: [{ type: "contract", contractIds: [id], topics: [[nativeToScVal("game", { type: "symbol" }).toXdr("base64"), nativeToScVal("settle", { type: "symbol" }).toXdr("base64")]] }] });
  const event = events.events.find(entry => {
    const values = scValToNative(entry.value) as unknown[];
    // Protocol 30 omits this legacy flag. The transaction's independently
    // confirmed success and exact ledger below establish inclusion.
    return entry.inSuccessfulContractCall !== false && Array.isArray(values) && values[0] instanceof Uint8Array && bytesHex(values[0]) === state.id && values[1] === state.winner && String(values[2]) === state.payout && String(values[3]) === state.protocolFee && String(values[4]) === state.ecosystemFee;
  });
  if (!event || (game.settle_tx_hash && game.settle_tx_hash !== event.txHash)) throw new ChainDuelError("The settlement receipt does not match the verified game and allocations.", "verified_receipt_mismatch", 502);
  const receipt = await transactionReceipt(event.txHash, financialNetwork(game));
  if (!receipt || receipt === "FAILED" || receipt.ledger !== state.settledLedger) throw new ChainDuelError("The verified settlement receipt could not be confirmed independently.", "verified_receipt_missing", 502);
  return event.txHash;
}

export async function verifiedStartReceipt(game: GameRow, state: VerifiedPulseState): Promise<string> {
  const id = await verifiedGameContract(game);
  const events = await rpcServer(financialNetwork(game)).getEvents({ startLedger: state.startedLedger, endLedger: state.startedLedger + 1, limit: 100,
    filters: [{ type: "contract", contractIds: [id], topics: [[nativeToScVal("game", { type: "symbol" }).toXdr("base64"), nativeToScVal("start", { type: "symbol" }).toXdr("base64")]] }] });
  const event = events.events.find(entry => { const value = scValToNative(entry.value); return entry.inSuccessfulContractCall !== false && value instanceof Uint8Array && bytesHex(value) === state.id; });
  if (!event) throw new ChainDuelError("The permissionless game start receipt is unavailable.", "verified_start_receipt_missing", 502);
  const receipt = await transactionReceipt(event.txHash, financialNetwork(game));
  if (!receipt || receipt === "FAILED" || receipt.ledger !== state.startedLedger) throw new ChainDuelError("The permissionless game start transaction was not independently confirmed.", "verified_start_receipt_missing", 502);
  return event.txHash;
}
export async function verifiedInputReceipt(game: GameRow, player: string, hash: string): Promise<void> {
  const id = await verifiedGameContract(game); const receipt = await transactionReceipt(hash, financialNetwork(game));
  if (!receipt || receipt === "FAILED" || !receipt.ledger) throw new ChainDuelError("The submitted player input transaction was not confirmed.", "verified_input_receipt_missing", 409);
  const events = await rpcServer(financialNetwork(game)).getEvents({ startLedger: receipt.ledger, endLedger: receipt.ledger + 1, limit: 100,
    filters: [{ type: "contract", contractIds: [id], topics: [[nativeToScVal("game", { type: "symbol" }).toXdr("base64"), nativeToScVal("inputs", { type: "symbol" }).toXdr("base64")]] }] });
  if (!events.events.some(entry => { const value = scValToNative(entry.value) as unknown[]; return entry.txHash === hash && entry.inSuccessfulContractCall !== false && Array.isArray(value) && value[0] instanceof Uint8Array && bytesHex(value[0]) === game.contract_game_id && value[1] === player; })) throw new ChainDuelError("The input receipt belongs to a different game or player.", "verified_input_receipt_mismatch", 409);
}
