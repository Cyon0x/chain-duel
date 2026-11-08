/**
 * Soroban submission envelope invariants.
 *
 * `assembleTransaction` clones the pre-simulation timebounds, so a slow
 * simulation can produce a transaction that expires before the network includes
 * it — the submission is then dropped and never appears in a ledger. These
 * checks pin the re-stamping behaviour without touching the network.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Account,
  BASE_FEE,
  Contract,
  Keypair,
  Operation,
  SorobanDataBuilder,
  TransactionBuilder,
  Asset,
} from "@stellar/stellar-sdk";
import { latestLedger, refreshTimebounds } from "@/lib/stellar/server";

const PASSPHRASE = "Test SDF Network ; September 2015";

describe("ledger sequence compatibility", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("reads the sequence without decoding unsupported ledger header extensions", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ result: { sequence: 123456, headerXdr: "unsupported-header-extension", metadataXdr: "unsupported-metadata" } })));
    vi.stubGlobal("fetch", fetcher);
    expect(await latestLedger()).toBe(123456);
    expect(JSON.parse(fetcher.mock.calls[0][1].body).method).toBe("getLatestLedger");
  });
  it.each([{}, { result: { sequence: 0 } }, { result: { sequence: 1.5 } }, { result: { sequence: "123" } }, { error: { code: -32603 } }])("rejects an invalid sequence response %j", async (payload) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(payload))));
    await expect(latestLedger()).rejects.toThrow(/invalid ledger sequence/);
  });
  it("rejects unsuccessful RPC responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("unavailable", { status: 503 })));
    await expect(latestLedger()).rejects.toThrow(/current Stellar ledger/);
  });
});

function assembledLike(windowSeconds: number) {
  const source = Keypair.random().publicKey();
  const contract = new Contract("CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC");
  const sorobanData = new SorobanDataBuilder().setResourceFee(12345).build();
  return new TransactionBuilder(new Account(source, "1"), {
    fee: BASE_FEE,
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(contract.call("get_config"))
    .setTimeout(windowSeconds)
    .setSorobanData(sorobanData)
    .build();
}

describe("refreshTimebounds", () => {
  it("replaces a nearly-expired window with a fresh one", () => {
    const assembled = assembledLike(60);
    const before = Number(assembled.timeBounds!.maxTime);
    const refreshed = refreshTimebounds(assembled, 180);
    const after = Number(refreshed.timeBounds!.maxTime);
    expect(after).toBeGreaterThan(before + 100);
    expect(after).toBeGreaterThan(Math.floor(Date.now() / 1000) + 150);
    expect(Number(refreshed.timeBounds!.minTime)).toBe(0);
  });

  it("preserves the Soroban extension so the transaction is not malformed", () => {
    const assembled = assembledLike(60);
    const refreshed = refreshTimebounds(assembled, 180);
    const envelope = refreshed.toEnvelope();
    expect(envelope.type).toBe("envelopeTypeTx");
    if (envelope.type !== "envelopeTypeTx") return;
    const ext = envelope.value.tx.ext;
    expect(ext.type).toBe("sorobanData");
    if (ext.type === "sorobanData") {
      expect(ext.value.resourceFee.toString()).toBe("12345");
    }
  });

  it("does not double-count the resource fee", () => {
    const assembled = assembledLike(60);
    const refreshed = refreshTimebounds(assembled, 180);
    // Classic fee (one operation) plus the resource fee, exactly once.
    expect(Number(refreshed.fee)).toBe(Number(BASE_FEE) * 1 + 12345);
  });

  it("keeps the operation and source account intact", () => {
    const assembled = assembledLike(60);
    const refreshed = refreshTimebounds(assembled, 180);
    expect(refreshed.source).toBe(assembled.source);
    expect(refreshed.sequence).toBe(assembled.sequence);
    expect(refreshed.operations).toHaveLength(1);
    expect(refreshed.operations[0].type).toBe("invokeHostFunction");
  });

  it("survives a round trip through XDR", () => {
    const refreshed = refreshTimebounds(assembledLike(60), 180);
    const reparsed = TransactionBuilder.fromXDR(refreshed.toXDR(), PASSPHRASE);
    expect(reparsed.toXDR()).toBe(refreshed.toXDR());
  });

  it("refuses to re-stamp a transaction with no Soroban data", () => {
    const source = Keypair.random().publicKey();
    const classic = new TransactionBuilder(new Account(source, "1"), {
      fee: BASE_FEE,
      networkPassphrase: PASSPHRASE,
    })
      .addOperation(Operation.payment({ destination: source, asset: Asset.native(), amount: "1" }))
      .setTimeout(60)
      .build();
    expect(() => refreshTimebounds(classic)).toThrow(/Soroban transaction data/i);
  });
});
