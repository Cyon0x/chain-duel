import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { encodeFunctionData, keccak256, parseTransaction, type Hex, type Address } from "viem";
const mock = vi.hoisted(() => ({
  signer: null as unknown,
  receipts: new Map<string, { status: string }>(),
  latest: 7,
  pending: 7,
  prepare: vi.fn(),
  sign: vi.fn(),
  send: vi.fn(),
}));
vi.mock("@/lib/arc/signer", () => ({ arcSettlementSigner: () => mock.signer }));
vi.mock("@/lib/arc/chain", () => ({
  verifiedArcClient: async () => ({
    getTransactionCount: async ({ blockTag }: { blockTag: string }) =>
      blockTag === "latest" ? mock.latest : mock.pending,
    getTransactionReceipt: async ({ hash }: { hash: string }) => {
      const receipt = mock.receipts.get(hash);
      if (receipt) return receipt;
      throw Object.assign(new Error("pending"), { name: "TransactionReceiptNotFoundError" });
    },
    sendRawTransaction: mock.send,
  }),
}));
import { signInWithProvider } from "@/lib/services/accounts";
import { arcDb } from "@/lib/arc/db";
import { sendArcAuthority } from "@/lib/arc/authority";
import { arcDuelAbi } from "@/lib/arc/abi";
import { ARC_USDC } from "@/lib/networks/arc";
const account = privateKeyToAccount(`0x${"12".repeat(32)}`);
const CONTRACT: Address = "0x1111111111111111111111111111111111111111";
describe("Arc authority transaction persistence and nonces", () => {
  beforeEach(async () => {
    const database = await arcDb();
    await database.execute("DELETE FROM arc_authority_attempts");
    await database.execute("DELETE FROM arc_authority_transactions");
    await database.execute("DELETE FROM arc_signer_state");
    vi.stubEnv("ARC_NETWORK", "testnet");
    mock.latest = 7;
    mock.pending = 7;
    mock.receipts.clear();
    mock.prepare.mockImplementation(async (input) => ({
      ...input,
      chainId: 5042002,
      gas: 100000n,
      type: "eip1559",
    }));
    mock.sign.mockImplementation(async (input) => account.signTransaction(input));
    mock.send.mockImplementation(async ({ serializedTransaction }) => keccak256(serializedTransaction));
    mock.signer = { account, prepareTransactionRequest: mock.prepare, signTransaction: mock.sign };
  });
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });
  async function game() {
    const { userId } = await signInWithProvider({
      provider: "google",
      providerAccountId: crypto.randomUUID(),
    });
    const id = crypto.randomUUID();
    const contractId = `0x${id.replaceAll("-", "").padStart(64, "0")}` as Hex;
    const database = await arcDb();
    const stamp = new Date().toISOString();
    await database.execute(
      `INSERT INTO arc_games(id,code,network_id,request_key,currency,token_address,token_decimals,contract_address,contract_game_id,mode,game_type,status,creator_id,stake_units,seed,duration_ms,created_at,expires_at)
      VALUES(?,?, 'arc-testnet',?,'USDC',?,6,?,?,'private','pulse','joined',?,'500000','unit-seed',60000,?,?)`,
      [id, id.slice(0, 8), crypto.randomUUID(), ARC_USDC, CONTRACT, contractId, userId, stamp, stamp],
    );
    return {
      gameId: id,
      action: "start" as const,
      target: CONTRACT,
      calldata: encodeFunctionData({ abi: arcDuelAbi, functionName: "startGame", args: [contractId] }),
    };
  }
  it("allocates distinct nonces for simultaneous games despite a lagging pending nonce", async () => {
    const a = await game();
    const b = await game();
    const hashes = await Promise.all([sendArcAuthority(a), sendArcAuthority(b)]);
    expect(new Set(hashes).size).toBe(2);
    expect(mock.prepare.mock.calls.map((c) => c[0].nonce)).toEqual([7, 8]);
  });
  it("persists signed bytes and the hash before transmission, then reuses an uncertain transaction", async () => {
    const input = await game();
    mock.send.mockImplementationOnce(async ({ serializedTransaction }) => {
      const row = await (
        await arcDb()
      ).one<{ signed_transaction: string; tx_hash: string }>(
        "SELECT * FROM arc_authority_transactions WHERE game_id=?",
        [input.gameId],
      );
      expect(row?.signed_transaction).toBe(serializedTransaction);
      expect(row?.tx_hash).toBe(keccak256(serializedTransaction));
      throw new Error("RPC timeout");
    });
    await expect(sendArcAuthority(input)).rejects.toThrow("RPC timeout");
    const hash = await sendArcAuthority(input);
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(mock.sign).toHaveBeenCalledTimes(1);
  });
  it("archives a transaction only after its nonce is definitively consumed elsewhere", async () => {
    const input = await game();
    const old = await sendArcAuthority(input);
    mock.latest = 8;
    mock.pending = 8;
    const fresh = await sendArcAuthority(input);
    expect(fresh).not.toBe(old);
    expect(mock.prepare.mock.calls.at(-1)?.[0].nonce).toBe(8);
    expect(
      (
        await (
          await arcDb()
        ).one<{ status: string }>("SELECT status FROM arc_authority_attempts WHERE tx_hash=?", [old])
      )?.status,
    ).toBe("superseded");
  });
  it("rejects a substituted saved signature before submitting it", async () => {
    const input = await game();
    await sendArcAuthority(input);
    const row = await (
      await arcDb()
    ).one<{ signed_transaction: Hex }>(
      "SELECT signed_transaction FROM arc_authority_transactions WHERE game_id=?",
      [input.gameId],
    );
    const decoded = parseTransaction(row!.signed_transaction);
    const substituted = await account.signTransaction({
      ...decoded,
      to: "0x2222222222222222222222222222222222222222",
    } as Parameters<typeof account.signTransaction>[0]);
    await (
      await arcDb()
    ).execute("UPDATE arc_authority_transactions SET signed_transaction=?,tx_hash=? WHERE game_id=?", [
      substituted,
      keccak256(substituted),
      input.gameId,
    ]);
    mock.send.mockClear();
    await expect(sendArcAuthority(input)).rejects.toMatchObject({ code: "authority_invalid" });
    expect(mock.send).not.toHaveBeenCalled();
  });
});
