import "server-only";
import { randomUUID } from "node:crypto";
import {
  isAddressEqual,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  type Address,
  type Hex,
  type TransactionSerializedEIP1559,
} from "viem";
import { ARC_MIN_MAX_FEE } from "../networks/arc";
import { ChainDuelError } from "../services/errors";
import { arcConfig } from "./config";
import { arcDb } from "./db";
import { verifiedArcClient } from "./chain";
import { arcSettlementSigner } from "./signer";

interface AuthorityRow {
  id: string;
  network_id: string;
  game_id: string;
  action: string;
  address: string;
  target: Address;
  calldata: Hex;
  nonce: string | null;
  signed_transaction: Hex | null;
  tx_hash: Hex | null;
  status: string;
}
const now = () => new Date().toISOString();
async function verifySaved(row: AuthorityRow, chainId: number, address: Address) {
  if (!row.signed_transaction?.startsWith("0x02") || !row.tx_hash)
    throw new Error("Missing authority signature");
  const serialized = row.signed_transaction as TransactionSerializedEIP1559;
  const decoded = parseTransaction(serialized);
  if (
    keccak256(row.signed_transaction) !== row.tx_hash ||
    decoded.chainId !== chainId ||
    !decoded.to ||
    !isAddressEqual(decoded.to, row.target) ||
    decoded.data !== row.calldata ||
    decoded.nonce?.toString() !== row.nonce ||
    (decoded.value ?? 0n) !== 0n ||
    !isAddressEqual(await recoverTransactionAddress({ serializedTransaction: serialized }), address)
  )
    throw new ChainDuelError(
      "The saved authority signature could not be verified.",
      "authority_invalid",
      502,
    );
}
export async function sendArcAuthority(input: {
  gameId: string;
  action: "start" | "settle";
  target: Address;
  calldata: Hex;
}): Promise<Hex> {
  const config = arcConfig();
  const signer = arcSettlementSigner();
  const address = signer.account.address.toLowerCase();
  const database = await arcDb();
  const client = await verifiedArcClient();
  await database.execute(
    "INSERT INTO arc_signer_state(network_id,address) VALUES(?,?) ON CONFLICT(network_id,address) DO NOTHING",
    [config.networkId, address],
  );
  const leaseOwner = randomUUID();
  let claimed = false;
  for (let attempt = 0; attempt < 10 && !claimed; attempt++) {
    claimed = Boolean(
      await database.run(
        "UPDATE arc_signer_state SET lease_owner=?,lease_until=? WHERE network_id=? AND address=? AND (lease_until IS NULL OR lease_until<?)",
        [leaseOwner, new Date(Date.now() + 120000).toISOString(), config.networkId, address, now()],
      ),
    );
    if (!claimed) await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!claimed)
    throw new ChainDuelError(
      "Another Arc duel is submitting a transaction. Retry shortly.",
      "authority_pending",
      409,
    );
  let row: AuthorityRow | null = null;
  try {
    // Fill any pending nonce gap using only previously authorized, verified signed bytes.
    const queue = await database.query<AuthorityRow>(
      "SELECT * FROM arc_authority_transactions WHERE network_id=? AND address=? AND status IN ('prepared','submitted') ORDER BY LENGTH(nonce),nonce",
      [config.networkId, address],
    );
    for (const queued of queue) {
      if (!queued.tx_hash || !queued.signed_transaction) continue;
      let receipt;
      try {
        receipt = await client.getTransactionReceipt({ hash: queued.tx_hash });
      } catch (error) {
        if ((error as Error).name !== "TransactionReceiptNotFoundError") throw error;
      }
      if (receipt) {
        await database.execute("UPDATE arc_authority_transactions SET status=?,updated_at=? WHERE id=?", [
          receipt.status === "success" ? "confirmed" : "reverted",
          now(),
          queued.id,
        ]);
        continue;
      }
      if (
        queued.nonce !== null &&
        BigInt(await client.getTransactionCount({ address: signer.account.address, blockTag: "latest" })) >
          BigInt(queued.nonce)
      ) {
        await database.execute(
          "UPDATE arc_authority_transactions SET status='superseded',updated_at=? WHERE id=?",
          [now(), queued.id],
        );
        continue;
      }
      await verifySaved(queued, config.id, signer.account.address);
      try {
        await client.sendRawTransaction({ serializedTransaction: queued.signed_transaction });
      } catch (error) {
        if (
          !/already known|known transaction/i.test(
            (error as Error & { shortMessage?: string }).shortMessage ?? (error as Error).message,
          )
        )
          throw error;
      }
    }
    row = await database.one<AuthorityRow>(
      "SELECT * FROM arc_authority_transactions WHERE network_id=? AND game_id=? AND action=?",
      [config.networkId, input.gameId, input.action],
    );
    if (
      row &&
      (row.address !== address ||
        !isAddressEqual(row.target, input.target) ||
        row.calldata !== input.calldata)
    )
      throw new ChainDuelError(
        "The saved settlement request differs from this result.",
        "authority_conflict",
        409,
      );
    if (!row) {
      const id = randomUUID();
      await database.execute(
        "INSERT INTO arc_authority_transactions(id,network_id,game_id,action,address,target,calldata,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'preparing',?,?)",
        [
          id,
          config.networkId,
          input.gameId,
          input.action,
          address,
          input.target,
          input.calldata,
          now(),
          now(),
        ],
      );
      row = await database.one<AuthorityRow>("SELECT * FROM arc_authority_transactions WHERE id=?", [id]);
    }
    if (!row) throw new Error("Authority record unavailable");
    if (row.tx_hash) {
      let receipt;
      try {
        receipt = await client.getTransactionReceipt({ hash: row.tx_hash });
      } catch (error) {
        if ((error as Error).name !== "TransactionReceiptNotFoundError") throw error;
      }
      if (receipt?.status === "success") {
        await verifySaved(row, config.id, signer.account.address);
        await database.execute(
          "UPDATE arc_authority_transactions SET status='confirmed',updated_at=? WHERE id=?",
          [now(), row.id],
        );
        return row.tx_hash;
      }
      const consumed =
        !receipt &&
        row.nonce !== null &&
        BigInt(await client.getTransactionCount({ address: signer.account.address, blockTag: "latest" })) >
          BigInt(row.nonce);
      if (receipt?.status === "reverted" || consumed) {
        const old = row;
        await database.transaction(async (tx) => {
          await tx.execute(
            "INSERT INTO arc_authority_attempts(tx_hash,authority_id,status,snapshot,archived_at) VALUES(?,?,?,?,?) ON CONFLICT(tx_hash) DO NOTHING",
            [old.tx_hash, old.id, consumed ? "superseded" : "reverted", JSON.stringify(old), now()],
          );
          await tx.execute(
            "UPDATE arc_authority_transactions SET nonce=NULL,signed_transaction=NULL,tx_hash=NULL,status='preparing',updated_at=? WHERE id=?",
            [now(), old.id],
          );
          if (input.action === "settle")
            await tx.execute("UPDATE arc_games SET settle_tx_hash=NULL WHERE id=? AND settle_tx_hash=?", [
              input.gameId,
              old.tx_hash,
            ]);
        });
        row = { ...row, nonce: null, signed_transaction: null, tx_hash: null, status: "preparing" };
      }
    }
    if (!row.signed_transaction) {
      const state = await database.one<{ next_nonce: string }>(
        "SELECT next_nonce FROM arc_signer_state WHERE network_id=? AND address=?",
        [config.networkId, address],
      );
      const pending = BigInt(
        await client.getTransactionCount({ address: signer.account.address, blockTag: "pending" }),
      );
      const stored = BigInt(state?.next_nonce ?? "0");
      const nonce = pending > stored ? pending : stored;
      if (nonce > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Unsupported signer nonce");
      const request = await signer.prepareTransactionRequest({
        account: signer.account,
        to: input.target,
        data: input.calldata,
        value: 0n,
        nonce: Number(nonce),
        maxFeePerGas: ARC_MIN_MAX_FEE * 2n,
        maxPriorityFeePerGas: 1000000000n,
      });
      const signed = await signer.signTransaction(request);
      const hash = keccak256(signed);
      await database.transaction(async (tx) => {
        await tx.execute(
          "UPDATE arc_authority_transactions SET nonce=?,signed_transaction=?,tx_hash=?,status='prepared',updated_at=? WHERE id=?",
          [nonce.toString(), signed, hash, now(), row!.id],
        );
        await tx.execute(
          "UPDATE arc_signer_state SET next_nonce=? WHERE network_id=? AND address=? AND lease_owner=?",
          [(nonce + 1n).toString(), config.networkId, address, leaseOwner],
        );
        if (input.action === "settle")
          await tx.execute("UPDATE arc_games SET settle_tx_hash=? WHERE id=?", [hash, input.gameId]);
      });
      row = {
        ...row,
        nonce: nonce.toString(),
        signed_transaction: signed,
        tx_hash: hash,
        status: "prepared",
      };
    }
    if (!row.signed_transaction || !row.tx_hash) throw new Error("Authority signature is unavailable");
    const signed = row.signed_transaction;
    const hash = row.tx_hash;
    await verifySaved(row, config.id, signer.account.address);
    try {
      const sent = await client.sendRawTransaction({ serializedTransaction: signed });
      if (sent !== hash) throw new Error("Unexpected authority hash");
    } catch (error) {
      if (
        !/already known|known transaction/i.test(
          (error as Error & { shortMessage?: string }).shortMessage ?? (error as Error).message,
        )
      )
        throw error;
    }
    await database.execute(
      "UPDATE arc_authority_transactions SET status='submitted',updated_at=? WHERE id=?",
      [now(), row.id],
    );
    return hash;
  } finally {
    await database.execute(
      "UPDATE arc_signer_state SET lease_owner=NULL,lease_until=NULL WHERE network_id=? AND address=? AND lease_owner=?",
      [config.networkId, address, leaseOwner],
    );
  }
}
