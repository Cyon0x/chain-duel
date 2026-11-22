import "server-only";
import { randomUUID } from "node:crypto";
import { type Address, type Hex, isAddressEqual, decodeEventLog } from "viem";
import { ARC_USDC } from "../networks/arc";
import { ChainDuelError } from "../services/errors";
import { arcDb } from "./db";
import { circleClient, circleCredentials } from "./circle";
import { arcWalletFor } from "./access";
import { arcConfig } from "./config";
import { verifiedArcClient } from "./chain";
import { arcDuelAbi } from "./abi";
import { arcFeeBudget, requireArcFunds } from "./fees";
import type { ArcOperationRow } from "./types";

export async function createArcOperation(input: {
  userId: string;
  gameId: string;
  action: string;
  target: Address;
  calldata: Hex;
  amount: bigint;
}) {
  const config = arcConfig();
  const wallet = await arcWalletFor(input.userId);
  const database = await arcDb();
  const now = new Date().toISOString();
  const id = randomUUID();
  await database.execute(
    `INSERT INTO arc_operations(id,user_id,network_id,game_id,action,wallet_id,target,calldata,amount_units,status,idempotency_key,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,'preparing',?,?,?) ON CONFLICT(user_id,network_id,game_id,action) DO NOTHING`,
    [
      id,
      input.userId,
      config.networkId,
      input.gameId,
      input.action,
      wallet.wallet_id,
      input.target,
      input.calldata,
      input.amount.toString(),
      randomUUID(),
      now,
      now,
    ],
  );
  const row = await database.one<ArcOperationRow>(
    `SELECT * FROM arc_operations WHERE user_id=? AND network_id=? AND game_id=? AND action=?`,
    [input.userId, config.networkId, input.gameId, input.action],
  );
  if (!row || row.calldata !== input.calldata || row.target.toLowerCase() !== input.target.toLowerCase())
    throw new ChainDuelError("The saved transaction differs from this request.", "operation_conflict", 409);
  return row;
}
export async function authorizeArcOperation(userId: string, id: string) {
  const config = arcConfig();
  if (!config.walletEnabled)
    throw new ChainDuelError("Arc signing is currently unavailable.", "circle_unavailable", 503);
  const database = await arcDb();
  const wallet = await arcWalletFor(userId);
  let row = await database.one<ArcOperationRow>(
    "SELECT * FROM arc_operations WHERE id=? AND user_id=? AND network_id=?",
    [id, userId, config.networkId],
  );
  if (!row || row.wallet_id !== wallet.wallet_id)
    throw new ChainDuelError("That transaction does not belong to this wallet.", "forbidden", 403);
  if (row.status === "confirmed")
    return {
      operation: row,
      credentials: null,
      challengeId: null,
      appId: config.appId,
    };
  if (row.status === "failed" && row.tx_hash) {
    const receipt = await (await verifiedArcClient()).getTransactionReceipt({ hash: row.tx_hash as Hex });
    if (receipt.status !== "reverted")
      throw new ChainDuelError(
        "Refresh this submitted transaction before retrying.",
        "operation_pending",
        409,
      );
    await database.transaction(async (tx) => {
      await tx.execute(
        `INSERT INTO arc_operation_attempts(id,operation_id,idempotency_key,challenge_id,circle_transaction_id,tx_hash,status,error,archived_at)
        SELECT ?,id,idempotency_key,challenge_id,circle_transaction_id,tx_hash,status,error,? FROM arc_operations WHERE id=? AND status='failed' ON CONFLICT(idempotency_key) DO NOTHING`,
        [randomUUID(), new Date().toISOString(), id],
      );
      await tx.execute(
        "UPDATE arc_operations SET challenge_id=NULL,circle_transaction_id=NULL,tx_hash=NULL,status='preparing',error=NULL,idempotency_key=? WHERE id=? AND status='failed'",
        [randomUUID(), id],
      );
    });
    row = await database.one<ArcOperationRow>("SELECT * FROM arc_operations WHERE id=?", [id]);
    if (!row) throw new ChainDuelError("The operation record is unavailable.", "not_found", 404);
  }
  const credentials = await circleCredentials(wallet.circle_user_id);
  if (row.challenge_id) {
    const challenge = await circleClient().getUserChallenge({
      userToken: credentials.userToken,
      challengeId: row.challenge_id,
    });
    if (challenge.data?.challenge.status === "PENDING" || challenge.data?.challenge.status === "IN_PROGRESS")
      return {
        operation: row,
        credentials,
        challengeId: row.challenge_id,
        appId: config.appId,
      };
    if (challenge.data?.challenge.status === "COMPLETE") {
      const refreshed = await refreshArcOperation(userId, id);
      if (refreshed.status !== "failed" || refreshed.tx_hash)
        return { operation: refreshed, credentials: null, challengeId: null, appId: config.appId };
    } else if (
      challenge.data?.challenge.status !== "FAILED" &&
      challenge.data?.challenge.status !== "EXPIRED"
    ) {
      throw new ChainDuelError("The wallet authorization is still pending.", "operation_pending", 409);
    }
    // Archive only definitively failed, expired, or unsubmitted terminal transactions.
    const previousKey = row.idempotency_key;
    await database.transaction(async (tx) => {
      await tx.execute(
        `INSERT INTO arc_operation_attempts(id,operation_id,idempotency_key,challenge_id,circle_transaction_id,tx_hash,status,error,archived_at)
        SELECT ?,id,idempotency_key,challenge_id,circle_transaction_id,tx_hash,status,error,? FROM arc_operations WHERE id=? AND idempotency_key=? AND tx_hash IS NULL ON CONFLICT(idempotency_key) DO NOTHING`,
        [randomUUID(), new Date().toISOString(), id, previousKey],
      );
      await tx.execute(
        "UPDATE arc_operations SET challenge_id=NULL,circle_transaction_id=NULL,status='preparing',error=NULL,idempotency_key=? WHERE id=? AND idempotency_key=? AND tx_hash IS NULL",
        [randomUUID(), id, previousKey],
      );
    });
    row = await database.one<ArcOperationRow>("SELECT * FROM arc_operations WHERE id=?", [id]);
  }
  if (!row) throw new ChainDuelError("Transaction record is unavailable.", "not_found", 404);
  const claimed = await database.run(
    `UPDATE arc_operations SET lease_until=? WHERE id=? AND status <> 'confirmed' AND (lease_until IS NULL OR lease_until < ?)`,
    [new Date(Date.now() + 120_000).toISOString(), id, new Date().toISOString()],
  );
  if (!claimed)
    throw new ChainDuelError(
      "This transaction is already being prepared. Please retry shortly.",
      "operation_pending",
      409,
    );
  try {
    const client = await verifiedArcClient();
    const debitUnits = row.action === "create" || row.action === "join" ? BigInt(row.amount_units) : 0n;
    const balance = await client.getBalance({ address: wallet.address as Address });
    // Arc's ERC-20 USDC and native gas currency share a balance. Gas is reserved
    // before transferFrom executes, so stake-only balance checks are insufficient.
    requireArcFunds(balance, debitUnits, 0n);
    const estimate = await circleClient().estimateContractExecutionFee({
      userToken: credentials.userToken,
      source: { walletId: wallet.wallet_id },
      contractAddress: row.target,
      callData: row.calldata,
    });
    const budget = arcFeeBudget(estimate.data?.high);
    requireArcFunds(balance, debitUnits, budget.reserve);
    const challenge = await circleClient().createUserTransactionContractExecutionChallenge({
      userToken: credentials.userToken,
      walletId: wallet.wallet_id,
      contractAddress: row.target,
      callData: row.calldata,
      idempotencyKey: row.idempotency_key,
      refId: row.id,
      fee: budget.fee,
    });
    if (!challenge.data?.challengeId) throw new Error("challenge missing");
    await database.execute(
      `UPDATE arc_operations SET challenge_id=?,status='awaiting_approval',lease_until=NULL,updated_at=? WHERE id=?`,
      [challenge.data.challengeId, new Date().toISOString(), id],
    );
    return {
      operation: row,
      credentials,
      challengeId: challenge.data.challengeId,
      appId: config.appId,
    };
  } catch (error) {
    const message = error instanceof ChainDuelError ? error.message : "Transaction preparation failed. Please retry.";
    await database.execute(
      `UPDATE arc_operations SET status='failed',error=?,lease_until=NULL,updated_at=? WHERE id=?`,
      [message, new Date().toISOString(), id],
    );
    if (error instanceof ChainDuelError) throw error;
    throw new ChainDuelError(
      "Circle could not prepare this transaction. Please retry.",
      "operation_failed",
      502,
    );
  }
}
export async function refreshArcOperation(userId: string, id: string): Promise<ArcOperationRow> {
  const config = arcConfig();
  const database = await arcDb();
  const wallet = await arcWalletFor(userId);
  const row = await database.one<ArcOperationRow>(
    "SELECT * FROM arc_operations WHERE id=? AND user_id=? AND network_id=?",
    [id, userId, config.networkId],
  );
  if (!row || row.wallet_id !== wallet.wallet_id)
    throw new ChainDuelError("That transaction was not found.", "not_found", 404);
  if (row.status === "confirmed" || !row.challenge_id) return row;
  let hash = row.tx_hash as Hex | null;
  if (!hash) {
    const credentials = await circleCredentials(wallet.circle_user_id);
    const result = await circleClient().getUserChallenge({
      userToken: credentials.userToken,
      challengeId: row.challenge_id,
    });
    const challenge = result.data?.challenge;
    if (challenge?.status === "FAILED" || challenge?.status === "EXPIRED") {
      await database.execute(
        `UPDATE arc_operations SET status='failed',error='The wallet authorization failed or expired.' WHERE id=?`,
        [id],
      );
      return {
        ...row,
        status: "failed",
        error: "The wallet authorization failed or expired.",
      };
    }
    if (challenge?.status !== "COMPLETE" || !challenge.correlationIds?.[0]) return row;
    const transaction = await circleClient().getTransaction({
      userToken: credentials.userToken,
      id: challenge.correlationIds[0],
    });
    const upstream = transaction.data?.transaction;
    if (!upstream || upstream.walletId !== wallet.wallet_id)
      throw new ChainDuelError(
        "Circle transaction ownership could not be verified.",
        "transaction_invalid",
        502,
      );
    if (!upstream.txHash && ["FAILED", "DENIED", "CANCELLED"].includes(upstream.state)) {
      await database.execute(
        "UPDATE arc_operations SET status='failed',error='Circle could not submit this transaction.' WHERE id=?",
        [id],
      );
      return {
        ...row,
        status: "failed",
        error: "Circle could not submit this transaction.",
      };
    }
    if (!upstream.txHash) return { ...row, status: "submitted" };
    hash = upstream.txHash as Hex;
    await database.execute(
      `UPDATE arc_operations SET tx_hash=?,circle_transaction_id=?,status='submitted',updated_at=? WHERE id=?`,
      [hash, upstream.id, new Date().toISOString(), id],
    );
  }
  const client = await verifiedArcClient();
  let receipt;
  try {
    receipt = await client.getTransactionReceipt({ hash });
  } catch (error) {
    if ((error as Error).name === "TransactionReceiptNotFoundError")
      return { ...row, tx_hash: hash, status: "submitted" };
    throw error;
  }
  const transaction = await client.getTransaction({ hash });
  if (
    !transaction.to ||
    !isAddressEqual(transaction.from, wallet.address as Address) ||
    !isAddressEqual(transaction.to, row.target) ||
    transaction.input !== row.calldata
  )
    throw new ChainDuelError(
      "The on-chain transaction differs from the approved request.",
      "transaction_invalid",
      502,
    );
  if (receipt.status !== "success") {
    await database.execute(
      `UPDATE arc_operations SET status='failed',error='The Arc transaction reverted.' WHERE id=?`,
      [id],
    );
    return {
      ...row,
      tx_hash: hash,
      status: "failed",
      error: "The Arc transaction reverted.",
    };
  }
  if (["create", "join", "cancel", "refund"].includes(row.action)) {
    const expected =
      row.action === "create" ? "GameCreated" : row.action === "join" ? "GameJoined" : "GameRefunded";
    const game = await database.one<{ contract_game_id: Hex }>(
      "SELECT contract_game_id FROM arc_games WHERE id=?",
      [row.game_id],
    );
    const event = receipt.logs.find((log) => {
      if (!isAddressEqual(log.address, row.target)) return false;
      try {
        const decoded = decodeEventLog({
          abi: arcDuelAbi,
          data: log.data,
          topics: log.topics,
        });
        return (
          decoded.eventName === expected && "id" in decoded.args && decoded.args.id === game?.contract_game_id
        );
      } catch {
        return false;
      }
    });
    if (!event)
      throw new ChainDuelError("The escrow deposit event could not be verified.", "escrow_unverified", 502);
  }
  await database.transaction(async (tx) => {
    const claimed = await tx.run(
      `UPDATE arc_operations SET status='confirmed',tx_hash=?,error=NULL,updated_at=? WHERE id=? AND status <> 'confirmed'`,
      [hash, new Date().toISOString(), id],
    );
    if (!claimed) return;
    if (row.action === "create" || row.action === "join") {
      await tx.execute(`UPDATE arc_players SET funded=1,entry_tx_hash=? WHERE game_id=? AND user_id=?`, [
        hash,
        row.game_id,
        userId,
      ]);
      if (row.action === "create")
        await tx.execute("UPDATE arc_games SET create_block=? WHERE id=?", [
          receipt.blockNumber.toString(),
          row.game_id,
        ]);
    }
    if (row.action === "refund" || row.action === "cancel") {
      await tx.execute(`UPDATE arc_games SET status='refunded' WHERE id=?`, [row.game_id]);
      const players = await tx.query<{
        user_id: string | null;
        funded: number;
      }>("SELECT user_id,funded FROM arc_players WHERE game_id=?", [row.game_id]);
      for (const player of players.filter((p) => p.user_id && p.funded)) {
        await tx.execute(
          `INSERT INTO arc_transactions(id,user_id,game_id,operation_id,network_id,contract_address,token_address,currency,token_decimals,kind,direction,amount_units,status,tx_hash,created_at,confirmed_at)
          VALUES(?,?,?,?,?,?,?,'USDC',6,'refund','in',?,'confirmed',?,?,?) ON CONFLICT(operation_id,kind,user_id) DO NOTHING`,
          [
            randomUUID(),
            player.user_id,
            row.game_id,
            `refund:${row.game_id}`,
            config.networkId,
            row.target,
            ARC_USDC,
            row.amount_units,
            hash,
            row.created_at,
            new Date().toISOString(),
          ],
        );
      }
      return;
    }
    await tx.execute(
      `INSERT INTO arc_transactions(id,user_id,game_id,operation_id,network_id,contract_address,token_address,currency,token_decimals,kind,direction,amount_units,status,tx_hash,created_at,confirmed_at)
      VALUES(?,?,?,?,?,?,?,'USDC',6,?,?,?,'confirmed',?,?,?) ON CONFLICT(operation_id,kind,user_id) DO NOTHING`,
      [
        randomUUID(),
        userId,
        row.game_id,
        row.id,
        config.networkId,
        row.target,
        ARC_USDC,
        row.action === "approve" ? "approval" : row.action,
        row.action === "refund" || row.action === "cancel" ? "in" : "out",
        row.amount_units,
        hash,
        row.created_at,
        new Date().toISOString(),
      ],
    );
  });
  return { ...row, tx_hash: hash, status: "confirmed", error: null };
}
