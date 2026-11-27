"use client";
import { BASE_FEE, Contract, TransactionBuilder, nativeToScVal, rpc, scValToNative, StrKey, type xdr } from "@stellar/stellar-sdk";
import { walletPublicConfig } from "./public-config";
import { createStellarInputKey, signWithClientVault } from "./vault-crypto";
import { loadClientSigner, saveClientSigner, pulseSignerSlot } from "./vault-storage";
import { bytesHex, hexBytes, encodePulseTranscript, pulseEnrollmentMessage, pulseInputMessage, pulseRulesHash, sha256 } from "../stellar/pulse-codec";
import { decodeVerifiedPulseState, type VerifiedPulseState } from "../stellar/pulse-state";
import { STELLAR_DEPLOYMENT_ADMIN, STELLAR_MAINNET_USDC, STELLAR_PUBLIC_PASSPHRASE, STELLAR_TESTNET_PASSPHRASE, STELLAR_TESTNET_USDC, STELLAR_TESTNET_XLM, type StellarPublicConfig, type StellarFinancialContext } from "../stellar/shared";
import type { HitRecord, MissRecord } from "../game/pulse";

export interface ClientPulseGame extends StellarFinancialContext { id: string; contract_game_id: string | null; entry_stroops: number; mode: string }
let checked: Promise<{ config: StellarPublicConfig; server: rpc.Server }> | null = null;
let checkedRules: Promise<void> | null = null;
export async function verifiedClientConnection() {
  if (!checked) checked = (async () => {
    const config = await walletPublicConfig();
    const expectedNetwork = process.env.NEXT_PUBLIC_STELLAR_VERIFIED_NETWORK ?? "testnet";
    const id = process.env.NEXT_PUBLIC_STELLAR_VERIFIED_CONTRACT_ID;
    const wasm = process.env.NEXT_PUBLIC_STELLAR_VERIFIED_WASM_HASH;
    const passphrase = config.id === "mainnet" ? STELLAR_PUBLIC_PASSPHRASE : STELLAR_TESTNET_PASSPHRASE;
    if (!config.verification || config.playerSigning !== "client" || !id || !StrKey.isValidContract(id) || !/^[0-9a-f]{64}$/.test(wasm ?? "") || config.contractId !== id || config.verification.wasmHash !== wasm || config.verification.rulesHash !== await pulseRulesHash() || config.id !== expectedNetwork || config.networkPassphrase !== passphrase || config.verification.admin !== STELLAR_DEPLOYMENT_ADMIN || config.feeSplit.protocolBps !== 500 || config.feeSplit.ecosystemBps !== 500) throw new Error("The Stellar game configuration does not match this client's reviewed deployment pins.");
    if (config.asset.contractId !== (config.id === "mainnet" ? STELLAR_MAINNET_USDC : config.asset.symbol === "USDC" ? STELLAR_TESTNET_USDC : STELLAR_TESTNET_XLM)) throw new Error("The escrow token is not the official token for this network.");
    const server = new rpc.Server(config.id === "mainnet" ? "https://mainnet.sorobanrpc.com" : "https://soroban-testnet.stellar.org");
    server.httpClient.defaults.timeout = 10_000;
    if ((await server.getNetwork()).passphrase !== passphrase) throw new Error("The independent RPC belongs to another Stellar network.");
    const footprint = await server.getLedgerEntries(new Contract(id).getFootprint()); const value = footprint.entries[0]?.val;
    if (!value || value.type !== "contractData" || value.contractData.val.type !== "scvContractInstance" || value.contractData.val.instance.executable.type !== "contractExecutableWasm" || bytesHex(value.contractData.val.instance.executable.wasmHash.value) !== wasm) throw new Error("The on-chain Pulse WASM differs from the reviewed client artifact.");
    return { config, server };
  })().catch(error => { checked = null; checkedRules = null; throw error; });
  return checked;
}
async function directRead(method: string, args: xdr.ScVal[] = []): Promise<unknown> {
  const { config, server } = await verifiedClientConnection();
  const transaction = new TransactionBuilder(await server.getAccount(STELLAR_DEPLOYMENT_ADMIN), { fee: BASE_FEE, networkPassphrase: config.networkPassphrase }).addOperation(new Contract(config.contractId!).call(method, ...args)).setTimeout(60).build();
  const simulation = await server.simulateTransaction(transaction);
  if (rpc.Api.isSimulationError(simulation) || !simulation.result) throw new Error(`The independent Stellar read failed for ${method}.`);
  return scValToNative(simulation.result.retval);
}
export async function readDirectPulseState(game: ClientPulseGame): Promise<VerifiedPulseState> {
  if (game.verification_version !== 1 || !game.contract_game_id) throw new Error("This duel does not use the verified Pulse architecture.");
  const { config } = await verifiedClientConnection();
  // These fields are immutable in the pinned WASM (which has no upgrade entry
  // point). Verify them once; each poll still reads the current game directly.
  if (!checkedRules) checkedRules = (async () => {
    const [contractConfig, rules] = await Promise.all([directRead("get_config"), directRead("get_rules_hash")]) as [Record<string, unknown>, unknown];
    if (!["admin", "treasury", "protocol_fee_recipient", "ecosystem_fee_recipient", "ecosystem_beneficiary"].every(field => contractConfig[field] === STELLAR_DEPLOYMENT_ADMIN) || contractConfig.token !== config.asset.contractId || contractConfig.protocol_fee_bps !== 500 || contractConfig.ecosystem_fee_bps !== 500) throw new Error("The independently read escrow roles or fee allocations are incorrect.");
    if (!(rules instanceof Uint8Array) || bytesHex(rules) !== await pulseRulesHash()) throw new Error("The on-chain game rules differ from the player's approved Pulse rules.");
  })().catch(error => { checkedRules = null; throw error; });
  await checkedRules;
  const state = decodeVerifiedPulseState(await directRead("get_game", [nativeToScVal(hexBytes(game.contract_game_id, 32))]));
  if (state.id !== game.contract_game_id || state.entryAmount !== String(game.entry_stroops) || state.mode !== (game.mode === "bot" ? 1 : 0)) throw new Error("The independently read game does not match the player's expected stake or mode.");
  return state;
}
export async function createPulseEnrollment(game: ClientPulseGame, address: string, seat: number) {
  const { config } = await verifiedClientConnection();
  if (!game.contract_game_id) throw new Error("The verified contract game ID is missing.");
  const slot = pulseSignerSlot(config.contractId!, game.contract_game_id, address, config.id);
  let signer = await loadClientSigner(slot);
  if (!signer) { signer = await createStellarInputKey(address, config.id); await saveClientSigner(slot, signer); }
  const message = await pulseEnrollmentMessage({ networkPassphrase: config.networkPassphrase, contractId: config.contractId!, gameIdHex: game.contract_game_id, player: address, seat, publicKeyHex: signer.publicKeyHex });
  return { publicKeyHex: signer.publicKeyHex, proofHex: bytesHex(await signWithClientVault(signer, message)) };
}
async function sendDirectGameCall(game: ClientPulseGame, address: string, method: "submit_inputs" | "settle_game", args: xdr.ScVal[]): Promise<string> {
  const { config, server } = await verifiedClientConnection();
  const transaction = new TransactionBuilder(await server.getAccount(address), { fee: BASE_FEE, networkPassphrase: config.networkPassphrase }).addOperation(new Contract(config.contractId!).call(method, ...args)).setTimeout(120).build();
  const simulation = await server.simulateTransaction(transaction);
  if (rpc.Api.isSimulationError(simulation)) throw new Error(`The contract rejected ${method}: ${simulation.error}`);
  const unsigned = rpc.assembleTransaction(transaction, simulation).build().toXdr();
  const signed = await (await import("./client")).signTransactionXdr(unsigned, address, config.networkPassphrase, { method, contractId: config.contractId!, args });
  const envelope = TransactionBuilder.fromXDR(signed, config.networkPassphrase); const hash = bytesHex(envelope.hash());
  const sent = await server.sendTransaction(envelope);
  if (sent.status === "ERROR") throw new Error("Stellar rejected the signed gameplay transaction.");
  const stop = Date.now() + 90000;
  while (Date.now() < stop) {
    const receipt = await server.getTransaction(hash);
    if (receipt.status === "SUCCESS") return hash;
    if (receipt.status === "FAILED") throw new Error("The gameplay transaction failed on Stellar.");
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error("The gameplay transaction is awaiting confirmation. Check its receipt before retrying.");
}
export async function submitDirectPulseInputs(game: ClientPulseGame, address: string, hits: HitRecord[], misses: MissRecord[]): Promise<{ hash: string; state: VerifiedPulseState }> {
  const { config } = await verifiedClientConnection(); const state = await readDirectPulseState(game);
  const seat = state.creator === address ? 1 : state.mode === 0 && state.opponent === address ? 2 : 0;
  if (!seat) throw new Error("This wallet is not a verified game participant.");
  const input = seat === 1 ? state.one : state.two;
  if (input.closed) {
    const stored = sessionStorage.getItem(`cd.pulse-receipt:${config.id}:${game.contract_game_id}:${address}`);
    if (!stored) throw new Error("Your inputs are already verified. Refresh the game to synchronize its on-chain result.");
    return { hash: stored, state };
  }
  const signer = await loadClientSigner(pulseSignerSlot(config.contractId!, game.contract_game_id!, address, config.id));
  if (!signer || signer.publicKeyHex !== input.publicKeyHex) throw new Error("The locally controlled gameplay key does not match the registered player input key.");
  const all = encodePulseTranscript(hits, misses);
  const transcript = all.slice(input.sequence * 6);
  if (input.sequence > all.length / 6) throw new Error("The local transcript is missing previously accepted game inputs.");
  const context = { networkPassphrase: config.networkPassphrase, contractId: config.contractId!, gameIdHex: game.contract_game_id!, seedHex: state.seedHex,
    player: address, seat, keyEpoch: input.keyEpoch, sequence: input.sequence, previousCommitment: input.commitment,
    startedAtMs: state.startedAtMs, deadlineMs: state.deadlineMs, closed: true };
  const message = await pulseInputMessage(context, transcript);
  const signature = await signWithClientVault(signer, message);
  const hash = await sendDirectGameCall(game, address, "submit_inputs", [nativeToScVal(hexBytes(game.contract_game_id!, 32)), new (await import("@stellar/stellar-sdk")).Address(address).toScVal(), nativeToScVal(input.sequence, { type: "u32" }), nativeToScVal(true), nativeToScVal(transcript), nativeToScVal(signature)]);
  sessionStorage.setItem(`cd.pulse-receipt:${config.id}:${game.contract_game_id}:${address}`, hash);
  const verified = await readDirectPulseState(game); const result = seat === 1 ? verified.one : verified.two;
  if (!result.closed || result.commitment !== bytesHex(await sha256(message))) throw new Error("The confirmed player transcript differs from the authorization signed on this device.");
  return { hash, state: verified };
}
export async function settleDirectPulseGame(game: ClientPulseGame, address: string): Promise<VerifiedPulseState> {
  const state = await readDirectPulseState(game); if (state.status === 4) return state;
  await sendDirectGameCall(game, address, "settle_game", [nativeToScVal(hexBytes(game.contract_game_id!, 32))]);
  return readDirectPulseState(game);
}
