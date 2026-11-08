import { describe, expect, it } from "vitest";
import { Account, Contract, Keypair, Networks, TransactionBuilder } from "@stellar/stellar-sdk";
import { createGameArgs, joinGameArgs } from "@/lib/stellar/contract";
import { validateEscrowTransaction } from "@/lib/stellar/escrow-validation";
import { STAKE_PRESETS_XLM, xlmToStroops } from "@/lib/config/game";

const player = Keypair.random();
const contractId = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const gameIdHex = "a1".repeat(32);
const base = { networkPassphrase: Networks.TESTNET, contractId, address: player.publicKey(), gameIdHex, role: "creator" as const, mode: 0, entryStroops: xlmToStroops(50) };
function envelope(entry: number, options: { contract?: string; id?: string; mode?: 0 | 1; method?: string; join?: boolean } = {}) {
  const args = options.join ? joinGameArgs({ player: player.publicKey(), gameIdHex: options.id ?? gameIdHex }) : createGameArgs({ creator: player.publicKey(), gameIdHex: options.id ?? gameIdHex, mode: options.mode ?? 0, entryStroops: xlmToStroops(entry), expiryLedger: 1000 });
  const transaction = new TransactionBuilder(new Account(player.publicKey(), "1"), { fee: "100", networkPassphrase: Networks.TESTNET })
    .addOperation(new Contract(options.contract ?? contractId).call(options.method ?? (options.join ? "join_game" : "create_game"), ...args)).setTimeout(30).build();
  transaction.sign(player);
  return transaction.toXDR();
}

describe("signed escrow invocation validation", () => {
  it.each([25, ...STAKE_PRESETS_XLM, 125.1234567])("encodes and accepts the exact %s XLM entry", (entry) => {
    expect(() => validateEscrowTransaction({ ...base, entryStroops: xlmToStroops(entry), signedXdr: envelope(entry) })).not.toThrow();
  });
  it.each([24, 25, 100, 10001])("rejects a substituted %s XLM amount against a 50 XLM entry", (entry) => {
    expect(() => validateEscrowTransaction({ ...base, signedXdr: envelope(entry) })).toThrow(/does not match/);
  });
  it("rejects a different game, mode, method or contract", () => {
    for (const options of [{ id: "b2".repeat(32) }, { mode: 1 as const }, { method: "fund_bot_pool" }, { contract: "CBBDWEWBBQVQXNYUJ4FA6C2CXXUVDAJSNUOVPZNKTQWK5P2EON7KEGMZ" }]) {
      expect(() => validateEscrowTransaction({ ...base, signedXdr: envelope(50, options) })).toThrow(/does not match/);
    }
  });
  it("accepts only the join for the same player and game", () => {
    expect(() => validateEscrowTransaction({ ...base, role: "joiner", signedXdr: envelope(50, { join: true }) })).not.toThrow();
    expect(() => validateEscrowTransaction({ ...base, role: "joiner", signedXdr: envelope(50, { join: true, id: "b2".repeat(32) }) })).toThrow(/does not match/);
  });
  it("rejects malformed envelopes and the wrong source player", () => {
    expect(() => validateEscrowTransaction({ ...base, signedXdr: "invalid" })).toThrow(/does not match/);
    expect(() => validateEscrowTransaction({ ...base, address: Keypair.random().publicKey(), signedXdr: envelope(50) })).toThrow(/does not match/);
  });
});
