import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { Keypair, StrKey, Asset, Networks } from "@stellar/stellar-sdk";
import { type Hex } from "viem";
import { ARC_USDC } from "@/lib/networks/arc";
import {
  CCTP_ADDRESSES,
  evmRecipientBytes32,
  stellarContractBytes32,
  stellarForwarderHook,
} from "@/lib/bridge/cctp";
import { validateBridgeMessage } from "@/lib/bridge/validation";
import { feeUnits } from "@/lib/bridge/fees";
import type { BridgeRow } from "@/lib/bridge/types";

const mocks = vi.hoisted(() => ({
  wallets: new Map(),
  stellar: new Map(),
  submit: vi.fn(),
  receipt: vi.fn(),
  prepare: vi.fn(),
  sign: vi.fn(),
  mint: vi.fn(),
  fetch: vi.fn(),
  balance: vi.fn(),
  estimateFee: vi.fn(),
  challenge: vi.fn(),
}));
vi.mock("@/lib/arc/circle", () => ({
  associatedArcWallet: async (id: string) => mocks.wallets.get(id),
  circleCredentials: async () => ({ userToken: "unit-token", encryptionKey: "unit-key" }),
  circleClient: () => ({
    estimateContractExecutionFee: mocks.estimateFee,
    createUserTransactionContractExecutionChallenge: mocks.challenge,
  }),
}));
vi.mock("@/lib/arc/chain", () => ({
  arcBalance: async () => ({ formatted: "100", units: "100000000" }),
  verifiedArcClient: async () => ({ readContract: async () => 100000000n, getBalance: mocks.balance }),
}));
vi.mock("@/lib/bridge/stellar", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/bridge/stellar")>();
  return {
    ...actual,
    bridgeStellarSigner: async (id: string) => ({
      address: mocks.stellar.get(id).address,
    }),
    bridgeStellarWallet: async (id: string) => ({
      address: mocks.stellar.get(id).address,
      custody: "managed",
    }),
    stellarBridgeInfo: async (id: string) => mocks.stellar.get(id),
    prepareStellarBridgeStep: mocks.prepare,
    signStellarBridgePayload: mocks.sign,
    submitStellarBridgePayload: mocks.submit,
    stellarBridgeReceipt: mocks.receipt,
    verifyStellarMintReference: mocks.mint,
  };
});
import { signInWithProvider } from "@/lib/services/accounts";
import { arcDb } from "@/lib/arc/db";
import {
  createBridge,
  loadBridge,
  prepareBridgeStep,
  authorizeBridgeStep,
  refreshBridge,
  recoverBridgeDestination,
} from "@/lib/bridge/service";
const ARC_ADDRESS = "0x2222222222222222222222222222222222222222";
const STELLAR_ADDRESS = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 8)).publicKey();
const USDC = new Asset("USDC", "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5").contractId(
  Networks.TESTNET,
);
function row(fromArc = false): BridgeRow {
  return {
    id: crypto.randomUUID(),
    user_id: "unit-user",
    idempotency_key: crypto.randomUUID(),
    source_network: fromArc ? "arc-testnet" : "stellar-testnet",
    destination_network: fromArc ? "stellar-testnet" : "arc-testnet",
    currency: "USDC",
    amount_units: "5000000",
    max_fee_units: "0",
    source_address: fromArc ? ARC_ADDRESS : STELLAR_ADDRESS,
    destination_address: fromArc ? STELLAR_ADDRESS : ARC_ADDRESS,
    status: "attestation_pending",
    source_tx_hash: "a".repeat(64),
    message_hash: null,
    message_nonce: null,
    destination_tx_hash: null,
    message: null,
    attestation: null,
    error: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}
function message(transfer: BridgeRow): Hex {
  const fromArc = transfer.source_network.startsWith("arc-");
  const a = CCTP_ADDRESSES.testnet;
  const hook = fromArc ? stellarForwarderHook(transfer.destination_address) : "0x";
  const b = Buffer.alloc(376 + (hook.length - 2) / 2);
  const put = (offset: number, value: string) => Buffer.from(value.replace(/^0x/, ""), "hex").copy(b, offset);
  b.writeUInt32BE(1, 0);
  b.writeUInt32BE(fromArc ? 26 : 27, 4);
  b.writeUInt32BE(fromArc ? 27 : 26, 8);
  put(12, `0x${"1".repeat(64)}`);
  put(44, fromArc ? evmRecipientBytes32(a.arcMessenger) : stellarContractBytes32(a.stellarMessenger));
  put(76, fromArc ? stellarContractBytes32(a.stellarMessenger) : evmRecipientBytes32(a.arcMessenger));
  put(108, fromArc ? stellarContractBytes32(a.stellarForwarder) : `0x${"0".repeat(64)}`);
  b.writeUInt32BE(2000, 140);
  b.writeUInt32BE(2000, 144);
  b.writeUInt32BE(1, 148);
  put(152, fromArc ? evmRecipientBytes32(ARC_USDC) : stellarContractBytes32(USDC));
  put(
    184,
    fromArc ? stellarContractBytes32(a.stellarForwarder) : evmRecipientBytes32(transfer.destination_address),
  );
  put(216, BigInt(transfer.amount_units).toString(16).padStart(64, "0"));
  put(
    248,
    fromArc
      ? evmRecipientBytes32(transfer.source_address)
      : Buffer.from(StrKey.decodeEd25519PublicKey(transfer.source_address)).toString("hex"),
  );
  put(280, BigInt(transfer.max_fee_units).toString(16).padStart(64, "0"));
  put(376, hook);
  return `0x${b.toString("hex")}`;
}
describe("CCTP message and fee validation", () => {
  it.each([false, true])("validates every attested route field in direction %s", (fromArc) => {
    const transfer = row(fromArc);
    const original = message(transfer);
    expect(validateBridgeMessage(transfer, original, USDC).receiveUnits).toBe(5000000n);
    for (const offset of [
      0,
      4,
      8,
      44,
      76,
      108,
      140,
      148,
      152,
      184,
      216,
      248,
      280,
      312,
      ...(fromArc ? [376, 410] : []),
    ]) {
      const bytes = Buffer.from(original.slice(2), "hex");
      bytes[offset] ^= 1;
      expect(
        () => validateBridgeMessage(transfer, `0x${bytes.toString("hex")}`, USDC),
        `offset ${offset}`,
      ).toThrow();
    }
  });
  it("refuses to replace a previously saved message or nonce", () => {
    const transfer = row();
    const payload = message(transfer);
    transfer.message_hash = `0x${"f".repeat(64)}`;
    expect(() => validateBridgeMessage(transfer, payload, USDC)).toThrow("cannot be replaced");
  });
  it("rejects an attestation below standard finality and a substituted saved nonce", () => {
    const transfer = row();
    const original = message(transfer);
    const bytes = Buffer.from(original.slice(2), "hex");
    bytes.writeUInt32BE(1999, 144);
    expect(() => validateBridgeMessage(transfer, `0x${bytes.toString("hex")}`, USDC)).toThrow();
    transfer.message_nonce = `0x${"2".repeat(64)}`;
    expect(() => validateBridgeMessage(transfer, original, USDC)).toThrow("nonce cannot be replaced");
  });
  it("rounds dynamic fractional BPS fees upward using integer arithmetic", () => {
    expect(feeUnits(1000001n, "0.01")).toBe(2n);
    expect(feeUnits(999999999999999999n, "0")).toBe(0n);
    expect(() => feeUnits(1n, "NaN")).toThrow();
  });
});
describe("Durable bridge orchestration", () => {
  beforeEach(() => {
    mocks.balance.mockResolvedValue(6_000_000_000_000_000_000n);
    mocks.estimateFee.mockResolvedValue({ data: { high: {
      gasLimit: "257713", maxFee: "53.989159085", priorityFee: "13.989159085",
    } } });
    mocks.challenge.mockResolvedValue({ data: { challengeId: "unit-burn-challenge" } });
    for (const [name, value] of Object.entries({
      ARC_NETWORK: "testnet",
      ARC_WALLETS_ENABLED: "true",
      CIRCLE_API_KEY: "TEST_API_KEY:unit-test",
      NEXT_PUBLIC_CIRCLE_APP_ID: "unit-app",
      BRIDGE_ENABLED: "true",
      BRIDGE_E2E_VERIFIED: "true",
      BRIDGE_SECURITY_REVIEWED: "true",
    }))
      vi.stubEnv(name, value);
    mocks.prepare.mockResolvedValue({
      target: USDC,
      xdr: "unit-unsigned-xdr",
      gasFee: "10000",
    });
    mocks.sign.mockResolvedValue({
      xdr: "unit-signed-xdr",
      hash: "a".repeat(64),
    });
    mocks.submit.mockResolvedValue({ status: "PENDING" });
    mocks.receipt.mockResolvedValue({ confirmed: false, failed: false });
    mocks.mint.mockResolvedValue(false);
    mocks.fetch.mockImplementation(async (url: string) =>
      url.includes("/fees/")
        ? Response.json([{ finalityThreshold: 2000, minimumFee: 0 }])
        : new Response("pending", { status: 404 }),
    );
    vi.stubGlobal("fetch", mocks.fetch);
  });
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  async function account() {
    const { userId } = await signInWithProvider({
      provider: "google",
      providerAccountId: crypto.randomUUID(),
    });
    mocks.wallets.set(userId, {
      wallet_id: `wallet-${userId}`,
      address: ARC_ADDRESS,
      status: "ready",
    });
    mocks.stellar.set(userId, {
      address: STELLAR_ADDRESS,
      networkId: "stellar-testnet",
      networkName: "Stellar Testnet",
      accountExists: true,
      trustline: true,
      balance: "100.0000000",
      xlmBalance: "100.0000000",
    });
    return userId;
  }
  async function preparedBurn() {
    const userId = await account();
    const transfer = await createBridge(userId, "stellar", "5", crypto.randomUUID());
    const database = await arcDb();
    const timestamp = new Date().toISOString();
    await database.execute(
      "INSERT INTO bridge_steps(id,bridge_id,phase,network_id,target,status,idempotency_key,created_at,updated_at) VALUES(?,?,'source_approval','stellar-testnet',?,'confirmed',?,?,?)",
      [crypto.randomUUID(), transfer.id, USDC, crypto.randomUUID(), timestamp, timestamp],
    );
    const prepared = await prepareBridgeStep(userId, transfer.id, "source_burn");
    return { userId, transfer, prepared };
  }
  it("reuses one transfer for repeated and concurrent identical intents", async () => {
    const userId = await account();
    const key = crypto.randomUUID();
    const first = await createBridge(userId, "stellar", "5", key);
    expect((await createBridge(userId, "stellar", "5.000000", key)).id).toBe(first.id);
    const results = await Promise.all([
      createBridge(userId, "stellar", "5", crypto.randomUUID()),
      createBridge(userId, "stellar", "5", crypto.randomUUID()),
    ]);
    expect(results.every((t) => t.id === first.id)).toBe(true);
    await expect(createBridge(userId, "stellar", "6", key)).rejects.toMatchObject({
      code: "bridge_conflict",
    });
  });
  it("limits owner Preview validation without opening other accounts or oversized saved transfers", async () => {
    const userId = await account();
    const existing = await createBridge(userId, "stellar", "5", crypto.randomUUID());
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("BRIDGE_ENABLED", "false");
    vi.stubEnv("BRIDGE_E2E_VERIFIED", "false");
    vi.stubEnv("BRIDGE_VALIDATION_ENABLED", "true");
    vi.stubEnv("BRIDGE_VALIDATION_USER_ID", userId);
    const allowed = await createBridge(userId, "arc", "0.10", crypto.randomUUID());
    expect(allowed.amount_units).toBe("100000");
    await expect(createBridge(userId, "arc", "0.100001", crypto.randomUUID())).rejects.toMatchObject({ code: "bridge_validation_limit" });
    await expect(prepareBridgeStep(userId, existing.id, "source_approval")).rejects.toMatchObject({ code: "bridge_validation_limit" });
    await expect(authorizeBridgeStep(userId, existing.id, crypto.randomUUID())).rejects.toMatchObject({ code: "bridge_validation_limit" });
    const other = await account();
    await expect(createBridge(other, "arc", "0.10", crypto.randomUUID())).rejects.toMatchObject({ code: "bridge_unavailable" });
  });
  it("requires Arc source funds for both the burn and Circle's pinned gas reserve", async () => {
    const userId = await account();
    const transfer = await createBridge(userId, "arc", "5", crypto.randomUUID());
    const database = await arcDb();
    const timestamp = new Date().toISOString();
    for (const [phase, status] of [["source_approval", "confirmed"], ["source_burn", "awaiting_approval"]]) {
      await database.execute(
        "INSERT INTO bridge_steps(id,bridge_id,phase,network_id,target,calldata,status,idempotency_key,created_at,updated_at) VALUES(?,?,?,'arc-testnet',?,'0x1234',?,?,?,?)",
        [crypto.randomUUID(), transfer.id, phase, CCTP_ADDRESSES.testnet.arcMessenger, status, crypto.randomUUID(), timestamp, timestamp],
      );
    }
    const step = await database.one<{ id: string }>("SELECT id FROM bridge_steps WHERE bridge_id=? AND phase='source_burn'", [transfer.id]);
    mocks.balance.mockResolvedValue(5_004_682_000_000_000_000n);
    await expect(authorizeBridgeStep(userId, transfer.id, step!.id)).rejects.toMatchObject({ code: "insufficient_balance" });
    expect(mocks.challenge).not.toHaveBeenCalled();
    mocks.balance.mockResolvedValue(6_000_000_000_000_000_000n);
    await authorizeBridgeStep(userId, transfer.id, step!.id);
    expect(mocks.challenge).toHaveBeenCalledWith(expect.objectContaining({ fee: {
      type: "absolute", config: { gasLimit: "257713", maxFee: "53.989159085", priorityFee: "13.989159085" },
    } }));
    await authorizeBridgeStep(userId, transfer.id, step!.id);
    expect(mocks.challenge).toHaveBeenCalledTimes(1);
  });
  it("refuses an unverified user's transfer record", async () => {
    const { userId, transfer } = await preparedBurn();
    const other = await account();
    await expect(loadBridge(other, transfer.id)).rejects.toMatchObject({
      code: "not_found",
    });
    expect((await loadBridge(userId, transfer.id)).status).toBe("awaiting_approval");
  });
  it("persists signed source bytes before broadcast and never recreates an uncertain burn", async () => {
    const { userId, transfer, prepared } = await preparedBurn();
    mocks.submit.mockImplementation(async () => {
      const saved = await (
        await arcDb()
      ).one<{ signed_xdr: string; tx_hash: string }>("SELECT * FROM bridge_steps WHERE id=?", [
        prepared.stepId,
      ]);
      expect(saved?.signed_xdr).toBe("unit-signed-xdr");
      expect(saved?.tx_hash).toBe("a".repeat(64));
      throw new Error("network timeout");
    });
    await expect(authorizeBridgeStep(userId, transfer.id, prepared.stepId)).rejects.toThrow(
      "network timeout",
    );
    await expect(authorizeBridgeStep(userId, transfer.id, prepared.stepId)).rejects.toThrow(
      "network timeout",
    );
    expect(mocks.sign).toHaveBeenCalledTimes(1);
    const view = await refreshBridge(userId, transfer.id);
    expect(view.transfer.status).toBe("submitted");
    expect(view.nextPhase).toBeNull();
  });
  it("does not complete on source receipt success alone", async () => {
    const { userId, transfer, prepared } = await preparedBurn();
    await authorizeBridgeStep(userId, transfer.id, prepared.stepId);
    mocks.receipt.mockResolvedValue({ confirmed: true, failed: false });
    const view = await refreshBridge(userId, transfer.id);
    expect(view.transfer.status).toBe("attestation_pending");
    expect(view.transfer.destination_tx_hash).toBeNull();
  });
  it("retains the source reference and requires recovery on substituted attestations", async () => {
    const { userId, transfer, prepared } = await preparedBurn();
    await authorizeBridgeStep(userId, transfer.id, prepared.stepId);
    mocks.receipt.mockResolvedValue({ confirmed: true, failed: false });
    const bytes = Buffer.from(message(transfer).slice(2), "hex");
    bytes[216] = 1;
    mocks.fetch.mockResolvedValue(
      Response.json({
        messages: [
          {
            status: "complete",
            message: `0x${bytes.toString("hex")}`,
            attestation: `0x${"1".repeat(130)}`,
          },
        ],
      }),
    );
    await expect(refreshBridge(userId, transfer.id)).rejects.toThrow("differs");
    const saved = await loadBridge(userId, transfer.id);
    expect(saved.status).toBe("recovery_required");
    expect(saved.source_tx_hash).toBe("a".repeat(64));
    expect(saved.message).toBeNull();
  });
  it("accepts destination recovery only after verified mint and forwarding", async () => {
    const userId = await account();
    const transfer = await createBridge(userId, "arc", "5", crypto.randomUUID());
    const payload = message(transfer);
    await (
      await arcDb()
    ).execute(
      "UPDATE bridge_transfers SET status='destination_pending',source_tx_hash=?,message=?,attestation=? WHERE id=?",
      [`0x${"a".repeat(64)}`, payload, `0x${"1".repeat(130)}`, transfer.id],
    );
    await expect(recoverBridgeDestination(userId, transfer.id, "b".repeat(64))).rejects.toMatchObject({
      code: "bridge_destination_unverified",
    });
    mocks.mint.mockResolvedValue(true);
    expect((await recoverBridgeDestination(userId, transfer.id, "b".repeat(64))).transfer.status).toBe(
      "completed",
    );
  });
  it("requires environment and wallet checks even when activation flags are set", async () => {
    const userId = await account();
    vi.stubEnv("CIRCLE_API_KEY", "");
    await expect(createBridge(userId, "stellar", "5", crypto.randomUUID())).rejects.toMatchObject({
      code: "bridge_unavailable",
    });
  });
});
