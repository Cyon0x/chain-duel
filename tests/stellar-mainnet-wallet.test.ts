import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Account, Asset, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { STELLAR_MAINNET_USDC_ISSUER } from "@/lib/stellar/shared";

const mock = vi.hoisted(() => ({ account: vi.fn(), build: vi.fn(), submit: vi.fn(), receipt: vi.fn(), reserve: vi.fn(), trustline: vi.fn() }));
vi.mock("@/lib/stellar/payments", async () => ({
  ...await vi.importActual<typeof import("@/lib/stellar/payments")>("@/lib/stellar/payments"),
  accountSnapshot: mock.account, buildPayment: mock.build, submitPaymentXdr: mock.submit,
  baseReserveUnits: mock.reserve, buildUsdcTrustline: mock.trustline,
}));
vi.mock("@/lib/stellar/server", async () => ({
  ...await vi.importActual<typeof import("@/lib/stellar/server")>("@/lib/stellar/server"),
  transactionReceipt: mock.receipt,
}));

// Ordinary, unfunded fixtures. None is the designated administrator; no network
// request, account creation or real transfer is performed by this test suite.
const player = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 8));
const other = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 9));
const usdc = new Asset("USDC", STELLAR_MAINNET_USDC_ISSUER);

function payment(amount = "2.5000000", asset = usdc, extra = false) {
  const builder = new TransactionBuilder(new Account(player.publicKey(), "5"), { fee: "100", networkPassphrase: Networks.PUBLIC })
    .addOperation(Operation.payment({ destination: other.publicKey(), asset, amount })).setTimeout(180);
  if (extra) builder.addOperation(Operation.payment({ destination: other.publicKey(), asset: Asset.native(), amount: "1" }));
  const transaction = builder.build();
  transaction.sign(player);
  return transaction.toXDR();
}

async function seed(custody: "managed" | "external" = "managed", mismatch = false) {
  const { db } = await import("@/lib/db");
  const { createUser, createProfile, createWallet, storeWalletKey } = await import("@/lib/db/repositories/identity");
  const { sealSecret } = await import("@/lib/stellar/wallet");
  const database = await db();
  const user = await createUser(database, { authProvider: "google" });
  await createProfile(database, { userId: user.id, username: `wallet_${user.id.slice(-8).replace(/-/g, "")}` });
  const wallet = await createWallet(database, { userId: user.id, address: player.publicKey(), custody, provider: custody === "managed" ? "chain-duel-managed" : "freighter", network: "testnet", isPrimary: true });
  if (custody === "managed") await storeWalletKey(database, wallet.id, sealSecret((mismatch ? other : player).secret()));
  return { database, userId: user.id, wallet };
}

beforeEach(async () => {
  if (globalThis.__chainDuelDb) await (await globalThis.__chainDuelDb).driver.close();
  delete globalThis.__chainDuelDb;
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv("STELLAR_NETWORK", "mainnet");
  mock.account.mockResolvedValue({ address: player.publicKey(), exists: true, xlm: "10", spendableXlm: "8", reserveXlm: "1.5", usdc: "100", spendableUsdc: "100", usdcTrustline: true, usdcAuthorized: true, subentries: 1 });
  mock.reserve.mockResolvedValue(5_000_000n);
  mock.receipt.mockResolvedValue(null);
  mock.build.mockImplementation(async (input: { source: string; destination: string; amountXlm: string; currency?: string }) => ({ xdr: new TransactionBuilder(new Account(input.source, "5"), { fee: "100", networkPassphrase: Networks.PUBLIC }).addOperation(Operation.payment({ destination: input.destination, asset: input.currency === "USDC" ? usdc : Asset.native(), amount: input.amountXlm })).setTimeout(180).build().toXDR(), sequence: "5" }));
  mock.submit.mockImplementation(async (signed: string) => ({ hash: Buffer.from(TransactionBuilder.fromXDR(signed, Networks.PUBLIC).hash()).toString("hex"), ledger: 1001 }));
  mock.trustline.mockImplementation(async (source: string) => new TransactionBuilder(new Account(source, "5"), { fee: "100", networkPassphrase: Networks.PUBLIC }).addOperation(Operation.changeTrust({ asset: usdc })).setTimeout(180).build().toXDR());
});
afterEach(() => vi.unstubAllEnvs());

const request = { destination: other.publicKey(), amountXlm: "2.5000000", networkId: "stellar-mainnet", currency: "USDC" as const, requestId: "wallet-request-0001" };

describe("Mainnet wallet safety and recovery", () => {
  it("reuses the existing encrypted Testnet key for Mainnet USDC and records its true currency", async () => {
    const { userId, database } = await seed();
    const { startTransfer } = await import("@/lib/services/wallet");
    const result = await startTransfer({ userId, ...request });
    expect(result.mode).toBe("confirmed");
    const row = await database.one("SELECT stellar_network,currency,amount_stroops,status FROM transactions WHERE user_id = ?", [userId]);
    expect(row).toEqual({ stellar_network: "mainnet", currency: "USDC", amount_stroops: 25_000_000, status: "confirmed" });
    expect((await database.one<{ count: number }>("SELECT COUNT(*) AS count FROM wallets"))?.count).toBe(1);
    const sent = TransactionBuilder.fromXDR(mock.submit.mock.calls[0][0], Networks.PUBLIC);
    if ("innerTransaction" in sent) throw new Error("Expected ordinary payment");
    expect(sent.source).toBe(player.publicKey());
    expect(sent.operations).toHaveLength(1);
    expect(sent.signatures).toHaveLength(1);
    expect(mock.build.mock.calls[0][0]).toMatchObject({ source: player.publicKey(), currency: "USDC", networkId: "mainnet" });
  });

  it("a confirmed request remains idempotent after its funds have left the wallet", async () => {
    const { userId } = await seed();
    const { startTransfer } = await import("@/lib/services/wallet");
    const first = await startTransfer({ userId, ...request });
    mock.account.mockResolvedValue({ exists: true, xlm: "1.5", reserveXlm: "1.5", spendableXlm: "0", usdc: "0", spendableUsdc: "0" });
    expect(await startTransfer({ userId, ...request })).toEqual(first);
    expect(mock.submit).toHaveBeenCalledTimes(1);
  });

  it("requires explicit Mainnet asset/network context and rejects substituted request parameters", async () => {
    const { userId } = await seed();
    const { startTransfer } = await import("@/lib/services/wallet");
    await expect(startTransfer({ userId, destination: request.destination, amountXlm: "2.5" })).rejects.toThrow(/Refresh/);
    await expect(startTransfer({ userId, ...request, networkId: "stellar-testnet" })).rejects.toThrow(/different network/);
    await startTransfer({ userId, ...request });
    await expect(startTransfer({ userId, ...request, amountXlm: "3" })).rejects.toThrow(/different parameters/);
    expect(mock.submit).toHaveBeenCalledTimes(1);
  });

  it("refuses a managed key that does not derive its recorded address", async () => {
    const { userId } = await seed("managed", true);
    const { startTransfer } = await import("@/lib/services/wallet");
    await expect(startTransfer({ userId, ...request })).rejects.toThrow(/does not match/);
    expect(mock.submit).not.toHaveBeenCalled();
  });

  it("external signing cannot swap USDC issuer, asset, amount or add wallet operations", async () => {
    const { userId } = await seed("external");
    const { startTransfer, completeTransfer } = await import("@/lib/services/wallet");
    const handoff = await startTransfer({ userId, ...request });
    if (handoff.mode !== "wallet-signature") throw new Error("Expected external signing");
    for (const signedXdr of [payment("2.5", Asset.native()), payment("2.5", new Asset("USDC", other.publicKey())), payment("3"), payment("2.5", usdc, true)]) await expect(completeTransfer({ userId, transactionId: handoff.transactionId, signedXdr })).rejects.toThrow();
    expect(mock.submit).not.toHaveBeenCalled();
    const signed = TransactionBuilder.fromXDR(handoff.xdr, Networks.PUBLIC);
    if (!("sign" in signed)) throw new Error("Expected ordinary transaction");
    signed.sign(player);
    expect((await completeTransfer({ userId, transactionId: handoff.transactionId, signedXdr: signed.toXDR() })).txHash).toHaveLength(64);
  });

  it("a submission timeout is recovered by rebroadcasting identical signed bytes", async () => {
    const { userId, database } = await seed();
    const { startTransfer, recoverWalletTransaction } = await import("@/lib/services/wallet");
    mock.submit.mockRejectedValueOnce(new Error("Confirmation timed out"));
    await expect(startTransfer({ userId, ...request })).rejects.toThrow(/timed out/);
    const row = await database.one<{ id: string; tx_hash: string; status: string }>("SELECT id,tx_hash,status FROM transactions WHERE user_id = ?", [userId]);
    expect(row?.status).toBe("submitting");
    await recoverWalletTransaction(userId, row!.id);
    expect(mock.submit).toHaveBeenCalledTimes(2);
    expect(mock.submit.mock.calls[0][0]).toBe(mock.submit.mock.calls[1][0]);
    expect(mock.build).toHaveBeenCalledTimes(1);
    expect((await database.one<{ status: string }>("SELECT status FROM transactions WHERE id = ?", [row!.id]))?.status).toBe("confirmed");
  });

  it("a known successful receipt completes books without a second broadcast", async () => {
    const { userId, database } = await seed();
    const { startTransfer, recoverWalletTransaction } = await import("@/lib/services/wallet");
    mock.submit.mockRejectedValueOnce(new Error("Receipt response lost"));
    await expect(startTransfer({ userId, ...request })).rejects.toThrow();
    const row = await database.one<{ id: string; tx_hash: string }>("SELECT id,tx_hash FROM transactions WHERE user_id = ?", [userId]);
    mock.receipt.mockResolvedValue({ hash: row!.tx_hash, ledger: 1001, returnValue: null, status: "SUCCESS" });
    await recoverWalletTransaction(userId, row!.id);
    expect(mock.submit).toHaveBeenCalledTimes(1);
  });

  it("repeated external preparation reuses the same unsigned transaction", async () => {
    const { userId } = await seed("external");
    const { startTransfer } = await import("@/lib/services/wallet");
    expect(await startTransfer({ userId, ...request })).toEqual(await startTransfer({ userId, ...request }));
    expect(mock.build).toHaveBeenCalledTimes(1);
  });

  it("detects a wallet-submitted payment before preparing another transaction", async () => {
    const { userId } = await seed("external");
    const { startTransfer } = await import("@/lib/services/wallet");
    const first = await startTransfer({ userId, ...request });
    if (first.mode !== "wallet-signature") throw new Error("Expected external signing");
    const hash = Buffer.from(TransactionBuilder.fromXDR(first.xdr, Networks.PUBLIC).hash()).toString("hex");
    mock.receipt.mockResolvedValue({ hash, ledger: 1001, status: "SUCCESS", returnValue: null });
    mock.account.mockResolvedValue({ exists: true, usdc: "0", spendableUsdc: "0", xlm: "1.5", reserveXlm: "1.5" });
    expect(await startTransfer({ userId, ...request })).toMatchObject({ mode: "confirmed", txHash: hash });
    expect(mock.build).toHaveBeenCalledTimes(1);
    expect(mock.submit).not.toHaveBeenCalled();
  });

  it("USDC setup creates only a trustline and accounts for the extra XLM reserve", async () => {
    const { userId, database } = await seed();
    const { startUsdcTrustline } = await import("@/lib/services/wallet");
    mock.account.mockResolvedValue({ exists: true, xlm: "2", reserveXlm: "1", usdcTrustline: false, usdcAuthorized: false });
    const result = await startUsdcTrustline({ userId, networkId: "stellar-mainnet", requestId: "trustline-request-0001" });
    expect(result.mode).toBe("confirmed");
    expect(await database.one("SELECT kind,currency,amount_stroops,status FROM transactions WHERE user_id = ?", [userId])).toEqual({ kind: "trustline", currency: "XLM", amount_stroops: 0, status: "confirmed" });
    expect(mock.trustline).toHaveBeenCalledTimes(1);
  });
});
