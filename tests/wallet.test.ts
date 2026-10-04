/**
 * Wallet transfer safety.
 *
 * Horizon is mocked at the module boundary because these assertions are about
 * Chain Duel's own rules: who may spend, how much, and that a client cannot
 * change what it signed for. The real Horizon calls are exercised by the
 * opt-in live suite.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Account, Keypair, Operation, Asset, TransactionBuilder, BASE_FEE } from "@stellar/stellar-sdk";

const submitPaymentXdr = vi.fn();
const buildPayment = vi.fn();
const accountSnapshot = vi.fn();
const signPaymentXdr = vi.fn();

vi.mock("@/lib/stellar/payments", async () => {
  const actual = await vi.importActual<typeof import("@/lib/stellar/payments")>("@/lib/stellar/payments");
  return {
    ...actual,
    accountSnapshot: (...args: unknown[]) => accountSnapshot(...args),
    buildPayment: (...args: unknown[]) => buildPayment(...args),
    submitPaymentXdr: (...args: unknown[]) => submitPaymentXdr(...args),
    signPaymentXdr: (...args: unknown[]) => signPaymentXdr(...args),
    fundTestnetAccount: vi.fn(async () => ({ hash: "fund-hash", ledger: 42 })),
  };
});

import { db } from "@/lib/db";
import { createProfile, createUser, createWallet, storeWalletKey } from "@/lib/db/repositories/identity";
import { sealSecret } from "@/lib/stellar/wallet";
import { startTransfer, completeTransfer, walletOverview, fundOwnWallet } from "@/lib/services/wallet";
import { isValidStellarAddress } from "@/lib/stellar/payments";

const DESTINATION = Keypair.random().publicKey();
const NET = { networkPassphrase: "Test SDF Network ; September 2015" };

async function seedUser(options: { custody: "managed" | "external" }) {
  const database = await db();
  const user = await createUser(database, { authProvider: "google" });
  await createProfile(database, { userId: user.id, username: `p${Math.random().toString(36).slice(2, 8)}` });
  const keypair = Keypair.random();
  const address = options.custody === "managed" ? Keypair.random().publicKey() : keypair.publicKey();
  const wallet = await createWallet(database, {
    userId: user.id,
    address,
    provider: options.custody === "managed" ? "chain-duel-managed" : "freighter",
    custody: options.custody,
    isPrimary: true,
    network: "testnet",
  });
  if (options.custody === "managed") {
    await database.execute("UPDATE users SET primary_wallet = ? WHERE id = ?", [address, user.id]);
  } else {
    await database.execute("UPDATE users SET primary_wallet = ? WHERE id = ?", [address, user.id]);
  }
  return { userId: user.id, wallet, address, keypair };
}

function paymentXdr(source: string, destination: string, amount: string): string {
  return new TransactionBuilder(new Account(source, "1"), {
    fee: BASE_FEE,
    networkPassphrase: NET.networkPassphrase,
  })
    .addOperation(Operation.payment({ destination, asset: Asset.native(), amount }))
    .setTimeout(180)
    .build()
    .toXDR();
}

beforeEach(() => {
  vi.clearAllMocks();
  accountSnapshot.mockResolvedValue({
    address: "G",
    exists: true,
    xlm: "100",
    spendableXlm: "98.5",
    reserveXlm: "1.5",
    subentries: 0,
  });
  buildPayment.mockImplementation(async (input: { source: string; destination: string; amountXlm: string }) => ({
    xdr: paymentXdr(input.source, input.destination, input.amountXlm),
    sequence: "1",
  }));
  signPaymentXdr.mockImplementation((xdr: string) => xdr);
  submitPaymentXdr.mockResolvedValue({ hash: "abc123hash", ledger: 99 });
});

describe("stellar address validation", () => {
  it("accepts a real public key and rejects malformed input", () => {
    expect(isValidStellarAddress(Keypair.random().publicKey())).toBe(true);
    expect(isValidStellarAddress("not-an-address")).toBe(false);
    expect(isValidStellarAddress("")).toBe(false);
    expect(isValidStellarAddress(Keypair.random().secret())).toBe(false);
  });
});

describe("startTransfer validation", () => {
  it("rejects an invalid destination", async () => {
    const { userId } = await seedUser({ custody: "managed" });
    await expect(
      startTransfer({ userId, destination: "nope", amountXlm: "1" }),
    ).rejects.toThrow(/not a valid Stellar address/i);
    expect(submitPaymentXdr).not.toHaveBeenCalled();
  });

  it("rejects sending to your own wallet", async () => {
    const { userId, address } = await seedUser({ custody: "managed" });
    await expect(
      startTransfer({ userId, destination: address, amountXlm: "1" }),
    ).rejects.toThrow(/your own wallet/i);
  });

  it("rejects malformed and non-positive amounts", async () => {
    const { userId } = await seedUser({ custody: "managed" });
    for (const amountXlm of ["0", "-5", "abc", "1.123456789"]) {
      await expect(startTransfer({ userId, destination: DESTINATION, amountXlm })).rejects.toThrow(/amount/i);
    }
    expect(submitPaymentXdr).not.toHaveBeenCalled();
  });

  it("refuses to spend into the account reserve", async () => {
    const { userId } = await seedUser({ custody: "managed" });
    await expect(
      startTransfer({ userId, destination: DESTINATION, amountXlm: "99" }),
    ).rejects.toThrow(/reserve/i);
    expect(submitPaymentXdr).not.toHaveBeenCalled();
  });

  it("refuses to send from an unfunded wallet", async () => {
    accountSnapshot.mockResolvedValue({
      address: "G",
      exists: false,
      xlm: "0",
      spendableXlm: "0",
      reserveXlm: "0",
      subentries: 0,
    });
    const { userId } = await seedUser({ custody: "managed" });
    await expect(startTransfer({ userId, destination: DESTINATION, amountXlm: "1" })).rejects.toThrow(/no Testnet balance/i);
  });

  it("requires a wallet on the account", async () => {
    const database = await db();
    const user = await createUser(database, { authProvider: "demo" });
    await expect(startTransfer({ userId: user.id, destination: DESTINATION, amountXlm: "1" })).rejects.toThrow(
      /no wallet/i,
    );
  });
});

describe("managed custody", () => {
  it("signs server-side, submits, and books a confirmed transfer", async () => {
    const database = await db();
    const { userId, wallet } = await seedUser({ custody: "managed" });
    await storeWalletKey(database, wallet.id, sealSecret(Keypair.random().secret()));

    const result = await startTransfer({ userId, destination: DESTINATION, amountXlm: "5", memo: "gg" });

    expect(result.mode).toBe("confirmed");
    expect(signPaymentXdr).toHaveBeenCalledTimes(1);
    expect(submitPaymentXdr).toHaveBeenCalledTimes(1);
    const rows = await database.query<{ status: string; kind: string; amount_stroops: number; tx_hash: string }>(
      "SELECT status, kind, amount_stroops, tx_hash FROM transactions WHERE user_id = ?",
      [userId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "confirmed", kind: "transfer", amount_stroops: 50_000_000, tx_hash: "abc123hash" });
  });

  it("books a failed transfer and surfaces the error when submission fails", async () => {
    const database = await db();
    const { userId, wallet } = await seedUser({ custody: "managed" });
    await storeWalletKey(database, wallet.id, sealSecret(Keypair.random().secret()));
    submitPaymentXdr.mockRejectedValue(new Error("Stellar rejected the transfer. Nothing was sent."));

    await expect(startTransfer({ userId, destination: DESTINATION, amountXlm: "5" })).rejects.toThrow(/rejected/i);
    const rows = await database.query<{ status: string }>("SELECT status FROM transactions WHERE user_id = ?", [userId]);
    expect(rows[0].status).toBe("failed");
  });
});

describe("external custody", () => {
  it("hands back an unsigned XDR instead of signing", async () => {
    const { userId } = await seedUser({ custody: "external" });
    const result = await startTransfer({ userId, destination: DESTINATION, amountXlm: "5" });
    expect(result.mode).toBe("wallet-signature");
    expect(signPaymentXdr).not.toHaveBeenCalled();
    expect(submitPaymentXdr).not.toHaveBeenCalled();
  });

  it("accepts the wallet's signature when it matches the intent", async () => {
    const { userId, address } = await seedUser({ custody: "external" });
    const started = await startTransfer({ userId, destination: DESTINATION, amountXlm: "5" });
    if (started.mode !== "wallet-signature") throw new Error("expected a signature handoff");

    const signed = paymentXdr(address, DESTINATION, "5.0000000");
    const done = await completeTransfer({ userId, transactionId: started.transactionId, signedXdr: signed });
    expect(done.txHash).toBe("abc123hash");
    expect(submitPaymentXdr).toHaveBeenCalledTimes(1);
  });

  it("rejects a signed transaction that pays someone else", async () => {
    const { userId, address } = await seedUser({ custody: "external" });
    const started = await startTransfer({ userId, destination: DESTINATION, amountXlm: "5" });
    if (started.mode !== "wallet-signature") throw new Error("expected a signature handoff");

    const swapped = paymentXdr(address, Keypair.random().publicKey(), "5.0000000");
    await expect(
      completeTransfer({ userId, transactionId: started.transactionId, signedXdr: swapped }),
    ).rejects.toThrow(/different address/i);
    expect(submitPaymentXdr).not.toHaveBeenCalled();
  });

  it("rejects a signed transaction with a different amount", async () => {
    const { userId, address } = await seedUser({ custody: "external" });
    const started = await startTransfer({ userId, destination: DESTINATION, amountXlm: "5" });
    if (started.mode !== "wallet-signature") throw new Error("expected a signature handoff");

    const inflated = paymentXdr(address, DESTINATION, "50.0000000");
    await expect(
      completeTransfer({ userId, transactionId: started.transactionId, signedXdr: inflated }),
    ).rejects.toThrow(/different amount/i);
  });

  it("rejects a transaction sourced from another account", async () => {
    const { userId } = await seedUser({ custody: "external" });
    const started = await startTransfer({ userId, destination: DESTINATION, amountXlm: "5" });
    if (started.mode !== "wallet-signature") throw new Error("expected a signature handoff");

    const foreign = paymentXdr(Keypair.random().publicKey(), DESTINATION, "5.0000000");
    await expect(
      completeTransfer({ userId, transactionId: started.transactionId, signedXdr: foreign }),
    ).rejects.toThrow(/different wallet/i);
  });

  it("will not let one user complete another user's transfer", async () => {
    const owner = await seedUser({ custody: "external" });
    const attacker = await seedUser({ custody: "external" });
    const started = await startTransfer({ userId: owner.userId, destination: DESTINATION, amountXlm: "5" });
    if (started.mode !== "wallet-signature") throw new Error("expected a signature handoff");

    await expect(
      completeTransfer({
        userId: attacker.userId,
        transactionId: started.transactionId,
        signedXdr: paymentXdr(owner.address, DESTINATION, "5.0000000"),
      }),
    ).rejects.toThrow(/no longer exists/i);
  });
});

describe("wallet overview", () => {
  it("reports balance, custody and transfers without any key material", async () => {
    const { userId } = await seedUser({ custody: "managed" });
    await startTransfer({ userId, destination: DESTINATION, amountXlm: "2" });
    const overview = await walletOverview(userId);
    expect(overview.custody).toBe("managed");
    expect(overview.transfers).toHaveLength(1);
    expect(JSON.stringify(overview)).not.toMatch(/secret|S[A-Z0-9]{55}/);
  });

  it("still returns the address when Stellar is unreachable", async () => {
    accountSnapshot.mockRejectedValue(new Error("horizon down"));
    const { userId, address } = await seedUser({ custody: "managed" });
    const overview = await walletOverview(userId);
    expect(overview.address).toBe(address);
    expect(overview.balance.available).toBe(false);
  });
});

describe("testnet faucet", () => {
  it("refuses to fund a wallet that already holds XLM", async () => {
    const { userId } = await seedUser({ custody: "managed" });
    await expect(fundOwnWallet(userId)).rejects.toThrow(/already has a Testnet balance/i);
  });

  it("funds an empty wallet and records a confirmed deposit", async () => {
    const database = await db();
    accountSnapshot.mockResolvedValue({
      address: "G",
      exists: false,
      xlm: "0",
      spendableXlm: "0",
      reserveXlm: "0",
      subentries: 0,
    });
    const { userId } = await seedUser({ custody: "managed" });
    const result = await fundOwnWallet(userId);
    expect(result.funded).toBe(true);
    const rows = await database.query<{ status: string; kind: string; tx_hash: string }>(
      "SELECT status, kind, tx_hash FROM transactions WHERE user_id = ?",
      [userId],
    );
    expect(rows[0]).toMatchObject({ status: "confirmed", kind: "deposit", tx_hash: "fund-hash" });
  });
});
