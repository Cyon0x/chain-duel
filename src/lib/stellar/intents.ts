import "server-only";
import { randomUUID } from "node:crypto";
import { TransactionBuilder } from "@stellar/stellar-sdk";
import { db, nowIso } from "../db";
import { PostgresDriver } from "../db/drivers";
import { STELLAR_SIGNER_SCHEMA } from "../db/stellar-migrations";
import type { SqlDriver } from "../db/types";
import { rawEnv } from "../config/env";
import { stellarNetwork } from "../config/stellar";
import { ChainDuelError } from "../services/errors";
import type { SubmittedTransaction } from "./server";
import type { StellarNetworkId } from "./shared";

interface IntentRow {
  id: string; network_id: string; address: string; contract_id: string; method: string;
  tx_hash: string | null; signed_xdr: string | null; max_time: number | null;
  status: string; result_json: string | null; args_hash: string;
}
const coordinators = new Map<string, Promise<SqlDriver>>();
async function coordinator(networkId: StellarNetworkId) {
  const url = rawEnv().STELLAR_SIGNER_DATABASE_URL;
  if (process.env.VERCEL_ENV === "preview" && networkId === "mainnet" && !url) throw new ChainDuelError("The shared Mainnet signing coordinator is not configured.", "not_configured", 503);
  if (!url) return db();
  if (!coordinators.has(url)) coordinators.set(url, (async () => {
    const database = await PostgresDriver.open(url, []);
    await database.transaction(async tx => {
      await tx.execute("SELECT pg_advisory_xact_lock(73492012)");
      for (const sql of STELLAR_SIGNER_SCHEMA) await tx.execute(sql);
    });
    return database;
  })().catch(error => { coordinators.delete(url); throw error; }));
  return coordinators.get(url)!;
}
const serialize = (value: unknown) => JSON.stringify(value, (_key, v) => typeof v === "bigint" ? v.toString() : v);

export async function hasStellarIntent(id: string, networkId: StellarNetworkId): Promise<boolean> {
  return Boolean(await (await coordinator(networkId)).one("SELECT id FROM stellar_signer_intents WHERE id = ? AND network_id = ?", [id, networkId]));
}

export async function stellarTransactionExpiredWithoutReceipt(hash: string, maxTime: number, networkId: StellarNetworkId): Promise<boolean> {
  if (!maxTime || Date.now() <= maxTime * 1000 + 20000) return false;
  const net = stellarNetwork(networkId);
  const [transaction, ledgers] = await Promise.all([
    fetch(`${net.horizonUrl}/transactions/${hash}`, { cache: "no-store", signal: AbortSignal.timeout(15000) }),
    fetch(`${net.horizonUrl}/ledgers?order=desc&limit=1`, { cache: "no-store", signal: AbortSignal.timeout(15000) }),
  ]);
  if (transaction.status !== 404 || !ledgers.ok) return false;
  const payload = await ledgers.json() as { _embedded?: { records?: { closed_at: string }[] } };
  return Date.parse(payload._embedded?.records?.[0]?.closed_at ?? "") > maxTime * 1000;
}

/** Store the exact signed transaction before broadcast. All deployments using
 * the same Mainnet account share one coordinator; an unresolved transaction
 * prevents another operation from reusing its sequence. */
export async function executeStellarIntent(input: {
  id: string; networkId: StellarNetworkId; address: string; contractId: string; method: string; argsHash: string;
  prepare: () => Promise<string>;
  submit: (signedXdr: string) => Promise<SubmittedTransaction>;
  receipt: (hash: string) => Promise<SubmittedTransaction | "FAILED" | null>;
}): Promise<SubmittedTransaction> {
  const database = await coordinator(input.networkId);
  const lease = randomUUID();
  await database.execute("INSERT INTO stellar_signer_state(network_id,address) VALUES(?,?) ON CONFLICT(network_id,address) DO NOTHING", [input.networkId, input.address]);
  const acquired = await database.run("UPDATE stellar_signer_state SET lease_owner = ?, lease_until = ? WHERE network_id = ? AND address = ? AND (lease_until IS NULL OR lease_until < ?)", [lease, Date.now() + 300000, input.networkId, input.address, Date.now()]);
  if (!acquired) throw new ChainDuelError("Another Stellar transaction is being confirmed. Please try again shortly.", "signer_busy", 409);
  const complete = async (row: IntentRow, result: SubmittedTransaction) => {
    if (row.tx_hash !== result.hash || result.status !== "SUCCESS") throw new ChainDuelError("The Stellar receipt does not match its saved transaction.", "intent_mismatch", 409);
    await database.execute("UPDATE stellar_signer_intents SET status = 'confirmed', result_json = ?, updated_at = ? WHERE id = ?", [serialize(result), nowIso(), row.id]);
    await database.execute("UPDATE stellar_signer_state SET active_intent_id = NULL WHERE network_id = ? AND address = ? AND active_intent_id = ?", [input.networkId, input.address, row.id]);
    return result;
  };
  const expiredWithoutReceipt = async (row: IntentRow) => {
    return Boolean(row.tx_hash && row.max_time && await stellarTransactionExpiredWithoutReceipt(row.tx_hash, row.max_time, input.networkId));
  };
  const retire = async (row: IntentRow, status: "failed" | "expired") => {
    if (!row.tx_hash || !row.signed_xdr) throw new ChainDuelError("The saved Stellar transaction needs receipt review.", "signer_pending", 409);
    await database.transaction(async tx => {
      await tx.execute("INSERT INTO stellar_signer_attempts(tx_hash,intent_id,signed_xdr,max_time,status,archived_at) VALUES(?,?,?,?,?,?) ON CONFLICT(tx_hash) DO NOTHING", [row.tx_hash, row.id, row.signed_xdr, row.max_time, status, nowIso()]);
      await tx.execute("UPDATE stellar_signer_intents SET signed_xdr = NULL, tx_hash = NULL, max_time = NULL, status = 'preparing', error = ?, updated_at = ? WHERE id = ?", [status, nowIso(), row.id]);
      await tx.execute("UPDATE stellar_signer_state SET active_intent_id = NULL WHERE network_id = ? AND address = ? AND active_intent_id = ?", [input.networkId, input.address, row.id]);
    });
    row.signed_xdr = null; row.tx_hash = null; row.max_time = null; row.status = "preparing";
  };
  try {
    const state = await database.one<{ active_intent_id: string | null }>("SELECT active_intent_id FROM stellar_signer_state WHERE network_id = ? AND address = ?", [input.networkId, input.address]);
    if (state?.active_intent_id && state.active_intent_id !== input.id) {
      const previous = await database.one<IntentRow>("SELECT * FROM stellar_signer_intents WHERE id = ?", [state.active_intent_id]);
      if (!previous) throw new ChainDuelError("The previous signing intent needs receipt review.", "signer_pending", 409);
      if (previous?.tx_hash) {
        const result = await input.receipt(previous.tx_hash);
        if (result && result !== "FAILED") await complete(previous, result);
        else if (result === "FAILED" || await expiredWithoutReceipt(previous)) {
          await retire(previous, result === "FAILED" ? "failed" : "expired");
        } else throw new ChainDuelError("A prior Stellar transaction is awaiting confirmation. Its saved receipt must be resolved before signing another.", "signer_pending", 409);
      } else if (previous.signed_xdr) throw new ChainDuelError("The previous signing intent needs receipt review.", "signer_pending", 409);
    }
    let row = await database.one<IntentRow>("SELECT * FROM stellar_signer_intents WHERE id = ?", [input.id]);
    if (row && (row.args_hash !== input.argsHash || row.network_id !== input.networkId || row.address !== input.address || row.contract_id !== input.contractId || row.method !== input.method)) throw new ChainDuelError("The saved Stellar transaction has different parameters.", "intent_mismatch", 409);
    if (row?.status === "confirmed" && row.result_json) return JSON.parse(row.result_json) as SubmittedTransaction;
    if (row?.tx_hash) {
      const receipt = await input.receipt(row.tx_hash);
      if (receipt && receipt !== "FAILED") return complete(row, receipt);
      if (receipt === "FAILED") await retire(row, "failed");
      else if (await expiredWithoutReceipt(row)) await retire(row, "expired");
    }
    if (!row) {
      await database.execute("INSERT INTO stellar_signer_intents(id,network_id,address,contract_id,method,args_hash,status,created_at,updated_at) VALUES(?,?,?,?,?,?,'preparing',?,?)", [input.id, input.networkId, input.address, input.contractId, input.method, input.argsHash, nowIso(), nowIso()]);
      row = await database.one<IntentRow>("SELECT * FROM stellar_signer_intents WHERE id = ?", [input.id]);
    }
    if (!row) throw new ChainDuelError("The signing intent could not be persisted.", "database_unavailable", 503);
    if (!row.signed_xdr) {
      const signed = await input.prepare();
      const transaction = TransactionBuilder.fromXDR(signed, stellarNetwork(input.networkId).networkPassphrase);
      const inner = "innerTransaction" in transaction ? transaction.innerTransaction : transaction;
      if (inner.source !== input.address || !inner.timeBounds || Number(inner.timeBounds.maxTime) <= Date.now() / 1000 || inner.signatures.length === 0) throw new ChainDuelError("The signed transaction does not match its source or validity window.", "invalid_xdr", 409);
      const hash = Buffer.from(transaction.hash()).toString("hex");
      await database.transaction(async tx => {
        await tx.execute("UPDATE stellar_signer_intents SET signed_xdr = ?, tx_hash = ?, max_time = ?, status = 'prepared', updated_at = ? WHERE id = ?", [signed, hash, Number(inner.timeBounds?.maxTime ?? 0), nowIso(), input.id]);
        await tx.execute("UPDATE stellar_signer_state SET active_intent_id = ? WHERE network_id = ? AND address = ? AND lease_owner = ?", [input.id, input.networkId, input.address, lease]);
      });
      row.signed_xdr = signed; row.tx_hash = hash;
    }
    const owned = await database.run("UPDATE stellar_signer_state SET lease_until = ? WHERE network_id = ? AND address = ? AND lease_owner = ? AND lease_until > ?", [Date.now() + 300000, input.networkId, input.address, lease, Date.now()]);
    if (!owned) throw new ChainDuelError("The Stellar signing lease expired. Resolve the saved transaction before retrying.", "signer_pending", 409);
    await database.execute("UPDATE stellar_signer_state SET active_intent_id = ? WHERE network_id = ? AND address = ?", [input.id, input.networkId, input.address]);
    await database.execute("UPDATE stellar_signer_intents SET status = 'submitted', updated_at = ? WHERE id = ?", [nowIso(), input.id]);
    return complete(row, await input.submit(row.signed_xdr));
  } finally {
    await database.execute("UPDATE stellar_signer_state SET lease_owner = NULL, lease_until = NULL WHERE network_id = ? AND address = ? AND lease_owner = ?", [input.networkId, input.address, lease]);
  }
}
