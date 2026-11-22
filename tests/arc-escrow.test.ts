import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { encodeEventTopics, encodeAbiParameters, type Hex } from "viem";
const mocks = vi.hoisted(() => ({
  wallets: new Map(),
  readContract: vi.fn(),
  receipt: vi.fn(),
  transaction: vi.fn(),
  challenge: vi.fn(),
  circleTransaction: vi.fn(),
  signingChallenge: vi.fn(),
  balance: vi.fn(),
  estimateFee: vi.fn(),
}));
vi.mock("@/lib/arc/chain", () => ({
  verifiedArcClient: async () => ({
    readContract: mocks.readContract,
    getTransactionReceipt: mocks.receipt,
    getTransaction: mocks.transaction,
    getBalance: mocks.balance,
  }),
}));
vi.mock("@/lib/arc/circle", () => ({
  associatedArcWallet: async (userId: string) => mocks.wallets.get(userId),
  circleCredentials: async () => ({
    userToken: "unit-test-token",
    encryptionKey: "unit-test-key",
  }),
  circleClient: () => ({
    getUserChallenge: mocks.challenge,
    getTransaction: mocks.circleTransaction,
    createUserTransactionContractExecutionChallenge: mocks.signingChallenge,
    estimateContractExecutionFee: mocks.estimateFee,
  }),
}));
import { signInWithProvider } from "@/lib/services/accounts";
import { arcDb } from "@/lib/arc/db";
import { createArcGame, joinArcGame, prepareArcEntry, loadArcGame } from "@/lib/arc/games";
import { refreshArcOperation, authorizeArcOperation } from "@/lib/arc/operations";
import { arcDuelAbi } from "@/lib/arc/abi";
const CONTRACT = "0x1111111111111111111111111111111111111111";
const ALICE = "0x2222222222222222222222222222222222222222";
const BOB = "0x3333333333333333333333333333333333333333";
const HASH = `0x${"a".repeat(64)}` as Hex;
describe("Arc escrow orchestration uses verified chain receipts", () => {
  beforeEach(() => {
    vi.stubEnv("ARC_NETWORK", "testnet");
    mocks.signingChallenge.mockResolvedValue({ data: { challengeId: "retry-challenge" } });
    mocks.balance.mockResolvedValue(10_000_000_000_000_000_000n);
    mocks.estimateFee.mockResolvedValue({ data: { high: {
      gasLimit: "257713", maxFee: "53.989159085", priorityFee: "13.989159085",
    } } });
    vi.stubEnv("ARC_WALLETS_ENABLED", "true");
    vi.stubEnv("ARC_GAMING_ENABLED", "true");
    vi.stubEnv("ARC_CONTRACT_REVIEWED", "true");
    vi.stubEnv("ARC_DUEL_CONTRACT_ADDRESS", CONTRACT);
    vi.stubEnv("ARC_SETTLEMENT_KEY_FILE", "unit-tests-only");
    vi.stubEnv("CIRCLE_API_KEY", "TEST_API_KEY:unit-tests-only");
    vi.stubEnv("NEXT_PUBLIC_CIRCLE_APP_ID", "unit-test-app");
    mocks.readContract.mockImplementation(async (input) =>
      input.functionName === "minStake"
        ? 1n
        : input.functionName === "maxStake"
          ? 10_000_000_000n
          : input.functionName === "botLiquidity"
            ? 100_000_000n
            : input.functionName === "botRecipient"
              ? BOB
              : input.functionName === "usdc"
                ? "0x3600000000000000000000000000000000000000"
                : input.functionName === "allowance"
                  ? 5_000_000n
                  : { status: 0 },
    );
    mocks.challenge.mockResolvedValue({
      data: {
        challenge: {
          status: "COMPLETE",
          correlationIds: ["unit-circle-transaction"],
        },
      },
    });
  });
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });
  async function account(address: string) {
    const { userId } = await signInWithProvider({
      provider: "google",
      providerAccountId: crypto.randomUUID(),
    });
    mocks.wallets.set(userId, {
      user_id: userId,
      network_id: "arc-testnet",
      app_id: "unit-test-app",
      circle_user_id: `circle-${userId}`,
      wallet_id: `wallet-${userId}`,
      address,
      status: "ready",
    });
    return userId;
  }
  async function game() {
    const userId = await account(ALICE);
    const row = await createArcGame({
      userId,
      mode: "private",
      amount: "5",
      requestKey: crypto.randomUUID(),
    });
    return { userId, row };
  }
  async function signedCreate() {
    const { userId, row } = await game();
    const operation = await prepareArcEntry(userId, row.id, "entry");
    await (
      await arcDb()
    ).execute("UPDATE arc_operations SET challenge_id='unit-challenge',status='submitted' WHERE id=?", [
      operation.id,
    ]);
    mocks.circleTransaction.mockResolvedValue({
      data: {
        transaction: {
          id: "unit-circle-transaction",
          walletId: `wallet-${userId}`,
          txHash: HASH,
        },
      },
    });
    const topics = encodeEventTopics({
      abi: arcDuelAbi,
      eventName: "GameCreated",
      args: { id: row.contract_game_id, creator: ALICE },
    });
    mocks.receipt.mockResolvedValue({
      status: "success",
      blockNumber: 100n,
      logs: [
        {
          address: CONTRACT,
          topics,
          data: encodeAbiParameters([{ type: "uint256" }, { type: "bool" }], [5_000_000n, false]),
        },
      ],
    });
    mocks.transaction.mockResolvedValue({
      from: ALICE,
      to: CONTRACT,
      input: operation.calldata,
    });
    return { userId, row, operation };
  }
  it("creates a lobby idempotently without accepting a stake", async () => {
    const userId = await account(ALICE);
    const requestKey = crypto.randomUUID();
    const first = await createArcGame({
      userId,
      mode: "private",
      amount: "5",
      requestKey,
    });
    const second = await createArcGame({
      userId,
      mode: "private",
      amount: "5.000000",
      requestKey,
    });
    expect(second.id).toBe(first.id);
    expect(
      await (await arcDb()).query("SELECT * FROM arc_transactions WHERE game_id=?", [first.id]),
    ).toHaveLength(0);
  });
  it("binds approval to the exact escrow and canonical six-decimal stake", async () => {
    const { userId, row } = await game();
    const approval = await prepareArcEntry(userId, row.id, "approve");
    expect(approval.target).toBe("0x3600000000000000000000000000000000000000");
    expect(approval.amount_units).toBe("0");
    expect(approval.calldata).toContain("00000000000000000000000000000000000000000000000000000000004c4b40");
  });
  it("prevents a third participant and creator self-join", async () => {
    const { userId, row } = await game();
    await expect(joinArcGame(userId, row.id)).rejects.toMatchObject({
      code: "invalid_state",
    });
    const rival = await account(BOB);
    await joinArcGame(rival, row.id);
    const third = await account("0x4444444444444444444444444444444444444444");
    await expect(joinArcGame(third, row.id)).rejects.toMatchObject({
      code: "full",
    });
  });
  it("marks a stake funded once, only after the escrow event and receipt match", async () => {
    const { userId, row, operation } = await signedCreate();
    expect((await refreshArcOperation(userId, operation.id)).status).toBe("confirmed");
    await refreshArcOperation(userId, operation.id);
    expect(
      (
        await (
          await arcDb()
        ).one<{ funded: number }>("SELECT funded FROM arc_players WHERE game_id=? AND user_id=?", [
          row.id,
          userId,
        ])
      )?.funded,
    ).toBe(1);
    const ledger = await (
      await arcDb()
    ).query<{ amount_units: string; tx_hash: string }>("SELECT * FROM arc_transactions WHERE game_id=?", [
      row.id,
    ]);
    expect(ledger).toHaveLength(1);
    expect(ledger[0].amount_units).toBe("5000000");
    expect(ledger[0].tx_hash).toBe(HASH);
  });
  it("rejects a successful but substituted on-chain transaction", async () => {
    const { userId, row, operation } = await signedCreate();
    mocks.transaction.mockResolvedValue({
      from: ALICE,
      to: BOB,
      input: operation.calldata,
    });
    await expect(refreshArcOperation(userId, operation.id)).rejects.toMatchObject({
      code: "transaction_invalid",
    });
    expect(
      (
        await (
          await arcDb()
        ).one<{ funded: number }>("SELECT funded FROM arc_players WHERE game_id=?", [row.id])
      )?.funded,
    ).toBe(0);
  });
  it("does not accept source receipt success without the escrow event", async () => {
    const { userId, operation } = await signedCreate();
    mocks.receipt.mockResolvedValue({
      status: "success",
      blockNumber: 100n,
      logs: [],
    });
    await expect(refreshArcOperation(userId, operation.id)).rejects.toMatchObject({
      code: "escrow_unverified",
    });
  });
  it("never loads an Arc game through a different environment", async () => {
    const { row } = await game();
    vi.stubEnv("ARC_NETWORK", "mainnet");
    await expect(loadArcGame(row.id)).rejects.toMatchObject({
      code: "not_found",
    });
  });
  it("archives a proved reverted transaction before allowing a fresh approval", async () => {
    const { userId, operation } = await signedCreate();
    mocks.receipt.mockResolvedValue({ status: "reverted", blockNumber: 100n, logs: [] });
    expect((await refreshArcOperation(userId, operation.id)).status).toBe("failed");
    const retry = await authorizeArcOperation(userId, operation.id);
    expect(retry.challengeId).toBe("retry-challenge");
    const history = await (
      await arcDb()
    ).query<{ tx_hash: string }>("SELECT * FROM arc_operation_attempts WHERE operation_id=?", [operation.id]);
    expect(history).toHaveLength(1);
    expect(history[0].tx_hash).toBe(HASH);
    expect(
      (
        await (
          await arcDb()
        ).one<{ tx_hash: string | null }>("SELECT tx_hash FROM arc_operations WHERE id=?", [operation.id])
      )?.tx_hash,
    ).toBeNull();
  });
  it("does not create a fresh approval for an uncertain submitted transaction", async () => {
    const { userId, operation } = await signedCreate();
    mocks.receipt.mockRejectedValue(
      Object.assign(new Error("pending"), { name: "TransactionReceiptNotFoundError" }),
    );
    expect((await refreshArcOperation(userId, operation.id)).status).toBe("submitted");
    await authorizeArcOperation(userId, operation.id);
    expect(mocks.signingChallenge).not.toHaveBeenCalled();
  });
  it("blocks the observed stake-plus-gas shortfall before requesting a PIN signature", async () => {
    const userId = await account(ALICE);
    const row = await createArcGame({ userId, mode: "bot", amount: "0.50", requestKey: crypto.randomUUID() });
    const operation = await prepareArcEntry(userId, row.id, "entry");
    mocks.balance.mockResolvedValue(504_682_000_000_000_000n);
    await expect(authorizeArcOperation(userId, operation.id)).rejects.toMatchObject({
      code: "insufficient_balance",
    });
    expect(mocks.signingChallenge).not.toHaveBeenCalled();
    const saved = await (await arcDb()).one<{ status: string; lease_until: string | null }>(
      "SELECT status,lease_until FROM arc_operations WHERE id=?", [operation.id],
    );
    expect(saved).toMatchObject({ status: "failed", lease_until: null });
    mocks.balance.mockResolvedValue(600_000_000_000_000_000n);
    await authorizeArcOperation(userId, operation.id);
    expect(mocks.signingChallenge).toHaveBeenCalledWith(expect.objectContaining({ fee: {
      type: "absolute", config: {
        gasLimit: "257713", maxFee: "53.989159085", priorityFee: "13.989159085",
      },
    } }));
  });
  it("checks the gas budget for a refund without requiring its incoming stake balance", async () => {
    const { userId, row } = await game();
    const operation = await prepareArcEntry(userId, row.id, "cancel");
    mocks.balance.mockResolvedValue(14_000_000_000_000_000n);
    await expect(authorizeArcOperation(userId, operation.id)).resolves.toMatchObject({
      challengeId: "retry-challenge",
    });
  });
  it("fails closed when Circle omits fee details", async () => {
    const { userId, row } = await game();
    const operation = await prepareArcEntry(userId, row.id, "entry");
    mocks.estimateFee.mockResolvedValue({ data: { high: { gasLimit: "257713" } } });
    await expect(authorizeArcOperation(userId, operation.id)).rejects.toMatchObject({ code: "fee_unavailable" });
    expect(mocks.signingChallenge).not.toHaveBeenCalled();
  });
});
