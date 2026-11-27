import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { nativeToScVal, StrKey } from "@stellar/stellar-sdk";
import { STELLAR_DEPLOYMENT_ADMIN, STELLAR_TESTNET_USDC } from "@/lib/stellar/shared";
import { PULSE_RULES_LABEL } from "@/lib/stellar/pulse-codec";
import type { GameRow } from "@/lib/db/types";
import type { VerifiedPulseState } from "@/lib/stellar/pulse-state";

const chain = vi.hoisted(() => ({ config: vi.fn(), read: vi.fn(), rpc: vi.fn(), receipt: vi.fn(), contract: vi.fn() }));
vi.mock("@/lib/stellar/server", async () => ({ ...await vi.importActual<typeof import("@/lib/stellar/server")>("@/lib/stellar/server"), readContractState: chain.read, rpcServer: chain.rpc, transactionReceipt: chain.receipt }));
vi.mock("@/lib/stellar/contract", () => ({ getOnChainConfig: chain.config }));
vi.mock("@/lib/services/escrow", () => ({ gameEscrowContractId: chain.contract }));

const contract = StrKey.encodeContract(new Uint8Array(32).fill(42));
const hash = "91".repeat(32);
const gameId = "72".repeat(32);
const wasm = "ab".repeat(32);
const game = { id: "receipt-fixture", contract_game_id: gameId, verification_version: 1, demo: 0, stellar_network: "testnet", token_contract_id: STELLAR_TESTNET_USDC } as GameRow;
const state = { status: 4, id: gameId, settledLedger: 100, startedLedger: 99, winner: STELLAR_DEPLOYMENT_ADMIN, payout: "900000000", protocolFee: "50000000", ecosystemFee: "50000000" } as VerifiedPulseState;
const events = vi.fn();
const event = (value: unknown, extra = {}) => ({ txHash: hash, ledger: 100, value: nativeToScVal(value), ...extra });
const settlement = () => event([new Uint8Array(32).fill(0x72), STELLAR_DEPLOYMENT_ADMIN, 900000000n, 50000000n, 50000000n]);

beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  vi.stubEnv("STELLAR_NETWORK", "testnet"); vi.stubEnv("STELLAR_PLAYER_SIGNING_MODE", "client"); vi.stubEnv("STELLAR_VERIFICATION_VERSION", "1"); vi.stubEnv("CHAIN_DUEL_VERIFIED_CONTRACT_ID", contract); vi.stubEnv("STELLAR_VERIFIED_WASM_HASH", wasm);
  chain.contract.mockResolvedValue(contract);
  chain.config.mockResolvedValue({ admin: STELLAR_DEPLOYMENT_ADMIN, treasury: STELLAR_DEPLOYMENT_ADMIN, protocolFeeRecipient: STELLAR_DEPLOYMENT_ADMIN, ecosystemFeeRecipient: STELLAR_DEPLOYMENT_ADMIN, ecosystemBeneficiary: STELLAR_DEPLOYMENT_ADMIN, token: STELLAR_TESTNET_USDC, protocolFeeBps: 500, ecosystemFeeBps: 500 });
  chain.read.mockResolvedValue(new Uint8Array(createHash("sha256").update(PULSE_RULES_LABEL).digest()));
  chain.rpc.mockReturnValue({ getEvents: events, getLedgerEntries: vi.fn().mockResolvedValue({ entries: [{ val: { type: "contractData", contractData: { val: { type: "scvContractInstance", instance: { executable: { type: "contractExecutableWasm", wasmHash: { value: new Uint8Array(32).fill(0xab) } } } } } } }] }) });
  chain.receipt.mockResolvedValue({ hash, ledger: 100, status: "SUCCESS" });
  events.mockResolvedValue({ events: [settlement()] });
});
afterEach(() => vi.unstubAllEnvs());

it("accepts a Protocol 30 settlement without the legacy success flag only after confirming the transaction", async () => {
  expect(await (await import("@/lib/stellar/verified-contract")).verifiedSettlementReceipt(game, state)).toBe(hash);
  expect(chain.receipt).toHaveBeenCalledWith(hash, "testnet");
});
it.each(["FAILED", null, { hash, ledger: 101, status: "SUCCESS" }])("rejects a failed, missing or wrong-ledger settlement receipt: %j", async receipt => {
  chain.receipt.mockResolvedValue(receipt);
  await expect((await import("@/lib/stellar/verified-contract")).verifiedSettlementReceipt(game, state)).rejects.toMatchObject({ code: "verified_receipt_missing" });
});
it("still rejects an event explicitly marked as a failed contract call", async () => {
  events.mockResolvedValue({ events: [{ ...settlement(), inSuccessfulContractCall: false }] });
  await expect((await import("@/lib/stellar/verified-contract")).verifiedSettlementReceipt(game, state)).rejects.toMatchObject({ code: "verified_receipt_mismatch" });
});
it("verifies a Protocol 30 input receipt for the exact game and participant", async () => {
  events.mockResolvedValue({ events: [event([new Uint8Array(32).fill(0x72), STELLAR_DEPLOYMENT_ADMIN])] });
  const verified = await import("@/lib/stellar/verified-contract");
  await verified.verifiedInputReceipt(game, STELLAR_DEPLOYMENT_ADMIN, hash);
  await expect(verified.verifiedInputReceipt(game, StrKey.encodeEd25519PublicKey(new Uint8Array(32).fill(19)), hash)).rejects.toMatchObject({ code: "verified_input_receipt_mismatch" });
});
it("requires a confirmed transaction at the exact start ledger when the legacy event flag is absent", async () => {
  events.mockResolvedValue({ events: [event(new Uint8Array(32).fill(0x72), { ledger: 99 })] });
  chain.receipt.mockResolvedValue({ hash, ledger: 99, status: "SUCCESS" });
  const verified = await import("@/lib/stellar/verified-contract");
  expect(await verified.verifiedStartReceipt(game, state)).toBe(hash);
  chain.receipt.mockResolvedValue("FAILED");
  await expect(verified.verifiedStartReceipt(game, state)).rejects.toMatchObject({ code: "verified_start_receipt_missing" });
});
