import { newId, nowIso } from "../index";
import type {
  AdminActionRow,
  SettingRow,
  SqlDriver,
  TransactionKind,
  TransactionRow,
  TransactionStatus,
  TreasuryTransactionRow,
} from "../types";

// ------------------------------------------------------------- transactions

export async function createTransaction(
  db: SqlDriver,
  input: {
    id?: string;
    userId?: string | null;
    gameId?: string | null;
    kind: TransactionKind;
    direction: "in" | "out";
    amountStroops: number;
    status?: TransactionStatus;
    txHash?: string | null;
    address?: string | null;
    explorerUrl?: string | null;
    metadata?: unknown;
    demo?: boolean;
  },
): Promise<TransactionRow> {
  const id = input.id ?? newId("txn");
  const timestamp = nowIso();
  await db.execute(
    `INSERT INTO transactions (id, user_id, game_id, kind, direction, amount_stroops, status, tx_hash, address,
       explorer_url, metadata, demo, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.userId ?? null,
      input.gameId ?? null,
      input.kind,
      input.direction,
      input.amountStroops,
      input.status ?? "preparing",
      input.txHash ?? null,
      input.address ?? null,
      input.explorerUrl ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null,
      input.demo ? 1 : 0,
      timestamp,
      timestamp,
    ],
  );
  const row = await db.one<TransactionRow>("SELECT * FROM transactions WHERE id = ?", [id]);
  if (!row) throw new Error("Failed to create transaction");
  return row;
}

export async function findTransaction(db: SqlDriver, id: string): Promise<TransactionRow | null> {
  return db.one<TransactionRow>("SELECT * FROM transactions WHERE id = ?", [id]);
}

export async function findTransactionByHash(
  db: SqlDriver,
  hash: string,
): Promise<TransactionRow | null> {
  return db.one<TransactionRow>("SELECT * FROM transactions WHERE tx_hash = ?", [hash]);
}

/** Idempotency probe: has this user already booked a line of this kind for a game? */
export async function findTransactionForGame(
  db: SqlDriver,
  userId: string,
  gameId: string,
  kind: TransactionKind,
): Promise<TransactionRow | null> {
  return db.one<TransactionRow>(
    "SELECT * FROM transactions WHERE user_id = ? AND game_id = ? AND kind = ? ORDER BY created_at ASC LIMIT 1",
    [userId, gameId, kind],
  );
}

export async function updateTransaction(
  db: SqlDriver,
  id: string,
  patch: {
    status?: TransactionStatus;
    txHash?: string | null;
    ledger?: number | null;
    error?: string | null;
    explorerUrl?: string | null;
    confirmedAt?: string | null;
    address?: string | null;
  },
): Promise<void> {
  const assignments: string[] = [];
  const params: unknown[] = [];
  const map: Record<string, unknown> = {
    status: patch.status,
    tx_hash: patch.txHash,
    ledger: patch.ledger,
    error: patch.error,
    explorer_url: patch.explorerUrl,
    confirmed_at: patch.confirmedAt,
    address: patch.address,
  };
  for (const [column, value] of Object.entries(map)) {
    if (value !== undefined) {
      assignments.push(`${column} = ?`);
      params.push(value);
    }
  }
  assignments.push("updated_at = ?");
  params.push(nowIso(), id);
  await db.execute(`UPDATE transactions SET ${assignments.join(", ")} WHERE id = ?`, params);
}

export async function listTransactionsForUser(
  db: SqlDriver,
  userId: string,
  options: { limit?: number; offset?: number } = {},
): Promise<TransactionRow[]> {
  const limit = Math.min(Math.max(options.limit ?? 40, 1), 100);
  const offset = Math.max(options.offset ?? 0, 0);
  return db.query<TransactionRow>(
    "SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?",
    [userId, limit, offset],
  );
}

export async function listRecentTransactions(db: SqlDriver, limit = 25): Promise<TransactionRow[]> {
  return db.query<TransactionRow>(
    "SELECT * FROM transactions ORDER BY created_at DESC LIMIT ?",
    [limit],
  );
}

export async function countTransactionsForUser(db: SqlDriver, userId: string): Promise<number> {
  const row = await db.one<{ count: number }>(
    "SELECT COUNT(*) AS count FROM transactions WHERE user_id = ?",
    [userId],
  );
  return Number(row?.count ?? 0);
}

// ------------------------------------------------------ treasury accounting

export async function recordTreasuryTransaction(
  db: SqlDriver,
  input: {
    kind: string;
    direction: "in" | "out";
    amountStroops: number;
    balanceAfterStroops?: number | null;
    txHash?: string | null;
    gameId?: string | null;
    actor?: string | null;
    metadata?: unknown;
  },
): Promise<TreasuryTransactionRow> {
  const id = newId("trs");
  await db.execute(
    `INSERT INTO treasury_transactions (id, kind, direction, amount_stroops, balance_after_stroops, tx_hash, game_id, actor, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.kind,
      input.direction,
      input.amountStroops,
      input.balanceAfterStroops ?? null,
      input.txHash ?? null,
      input.gameId ?? null,
      input.actor ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null,
      nowIso(),
    ],
  );
  const row = await db.one<TreasuryTransactionRow>(
    "SELECT * FROM treasury_transactions WHERE id = ?",
    [id],
  );
  if (!row) throw new Error("Failed to record treasury transaction");
  return row;
}

export async function listTreasuryTransactions(
  db: SqlDriver,
  limit = 40,
): Promise<TreasuryTransactionRow[]> {
  return db.query<TreasuryTransactionRow>(
    "SELECT * FROM treasury_transactions ORDER BY created_at DESC LIMIT ?",
    [limit],
  );
}

export async function botLiabilitySince(db: SqlDriver, sinceIso: string): Promise<number> {
  const row = await db.one<{ total: number }>(
    `SELECT COALESCE(SUM(CASE WHEN treasury_delta_stroops < 0 THEN -treasury_delta_stroops ELSE 0 END), 0) AS total
     FROM bot_matches WHERE created_at >= ?`,
    [sinceIso],
  );
  return Number(row?.total ?? 0);
}

// ------------------------------------------------------------ admin actions

export async function recordAdminAction(
  db: SqlDriver,
  input: {
    adminWallet: string;
    action: string;
    target?: string | null;
    payload?: unknown;
    txHash?: string | null;
  },
): Promise<AdminActionRow> {
  const id = newId("adm");
  await db.execute(
    `INSERT INTO admin_actions (id, admin_wallet, action, target, payload, tx_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.adminWallet,
      input.action,
      input.target ?? null,
      input.payload ? JSON.stringify(input.payload) : null,
      input.txHash ?? null,
      nowIso(),
    ],
  );
  const row = await db.one<AdminActionRow>("SELECT * FROM admin_actions WHERE id = ?", [id]);
  if (!row) throw new Error("Failed to record admin action");
  return row;
}

export async function listAdminActions(db: SqlDriver, limit = 50): Promise<AdminActionRow[]> {
  return db.query<AdminActionRow>(
    "SELECT * FROM admin_actions ORDER BY created_at DESC LIMIT ?",
    [limit],
  );
}

// ---------------------------------------------------------------- settings

export async function getSetting(db: SqlDriver, key: string): Promise<string | null> {
  const row = await db.one<SettingRow>("SELECT * FROM settings WHERE key = ?", [key]);
  return row?.value ?? null;
}

export async function setSetting(
  db: SqlDriver,
  key: string,
  value: string,
  updatedBy?: string | null,
): Promise<void> {
  const existing = await db.one<SettingRow>("SELECT * FROM settings WHERE key = ?", [key]);
  if (existing) {
    await db.execute("UPDATE settings SET value = ?, updated_at = ?, updated_by = ? WHERE key = ?", [
      value,
      nowIso(),
      updatedBy ?? null,
      key,
    ]);
    return;
  }
  await db.execute(
    "INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)",
    [key, value, nowIso(), updatedBy ?? null],
  );
}

export async function listSettings(db: SqlDriver): Promise<SettingRow[]> {
  return db.query<SettingRow>("SELECT * FROM settings ORDER BY key ASC");
}
