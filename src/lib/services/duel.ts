import "server-only";
import { db, newId, nowIso } from "../db";
import {
  addGamePlayer,
  appendGameEvent,
  createGame,
  createInvite,
  enqueue,
  findGameById,
  findGameByCode,
  findInviteByCode,
  findInviteByGame,
  listGamePlayers,
  listOpenPublicGames,
  staleWaitingGames,
  transitionGame,
  updateGame,
  updateInviteStatus,
} from "../db/repositories/duel";
import { findProfile, findUserById, primaryWallet } from "../db/repositories/identity";
import { createTransaction, findTransactionForGame } from "../db/repositories/economy";
import type { GameMode, GameRow, InviteRow } from "../db/types";
import {
  DUEL_JOIN_WINDOW_MS,
  ECONOMY,
  INVITE_TTL_MS,
  PULSE_DUEL,
  inviteCode,
} from "../config/game";
import { randomContractGameId } from "../auth/stellar";
import { secureSeed, secureToken } from "../game/rng";
import { DEFAULT_BOT } from "../config/game";
import { botAvailability } from "./treasury";
import { escrowUnavailableError } from "./errors";
import { onChainEscrowAvailable, messageOf } from "./escrow";
import { serverClaimRefund } from "../stellar/contract";
import { signerForUser } from "../wallet/signer";

export interface DuelCreation {
  game: GameRow;
  invite: InviteRow | null;
  escrow: {
    mode: "wallet-signature" | "confirmed" | "offchain";
    transactionId?: string;
    xdr?: string;
    txHash?: string;
    networkPassphrase?: string;
  };
  bot: { id: string; name: string } | null;
}

export interface CreateDuelInput {
  userId: string;
  mode: GameMode;
  entryStroops: number;
  demo: boolean;
  invitedUserId?: string | null;
  durationMs?: number;
}

function validateEntry(entryStroops: number, demo: boolean): void {
  if (!Number.isInteger(entryStroops) || entryStroops < 0) {
    throw Object.assign(new Error("Invalid entry amount."), { code: "invalid_entry" });
  }
  if (demo) return;
  if (entryStroops < ECONOMY.minEntryStroops || entryStroops > ECONOMY.maxEntryStroops) {
    throw Object.assign(new Error("That entry is outside the allowed range."), { code: "invalid_entry" });
  }
}

export async function createDuel(input: CreateDuelInput): Promise<DuelCreation> {
  validateEntry(input.entryStroops, input.demo);
  const database = await db();

  if (!input.demo && !onChainEscrowAvailable()) {
    throw escrowUnavailableError();
  }

  const durationMs = input.durationMs ?? PULSE_DUEL.durationMs;
  const expiresAt = new Date(Date.now() + DUEL_JOIN_WINDOW_MS).toISOString();
  const contractGameId = input.demo ? null : randomContractGameId();

  let botInfo: { id: string; name: string } | null = null;
  if (input.mode === "bot") {
    if (input.demo) {
      botInfo = { id: DEFAULT_BOT.id, name: DEFAULT_BOT.name };
    } else {
      const availability = await botAvailability(input.entryStroops);
      if (!availability.available) {
        throw Object.assign(new Error(availability.reason ?? "Computer matches are unavailable."), {
          code: "bot_unavailable",
        });
      }
      botInfo = { id: DEFAULT_BOT.id, name: DEFAULT_BOT.name };
    }
  }

  const game = await createGame(database, {
    code: inviteCode(),
    mode: input.mode,
    visibility: input.mode === "private" || input.mode === "bot" ? "private" : "public",
    creatorId: input.userId,
    entryStroops: input.entryStroops,
    feeBps: ECONOMY.feeBps,
    seed: secureSeed(16),
    durationMs,
    expiresAt,
    escrowState: input.demo ? "offchain" : "none",
    demo: input.demo,
    contractGameId,
  });

  const wallet = await primaryWallet(database, input.userId);
  if (!wallet) {
    throw Object.assign(new Error("Your account has no wallet."), { code: "no_wallet" });
  }

  await addGamePlayer(database, {
    gameId: game.id,
    userId: input.userId,
    seat: 1,
    address: wallet.address,
  });

  if (input.mode === "bot" && botInfo) {
    await addGamePlayer(database, {
      gameId: game.id,
      userId: `bot:${botInfo.id}`,
      seat: 2,
      address: null,
      isBot: true,
    });
    await updateGame(database, game.id, {
      opponent_id: `bot:${botInfo.id}`,
    });
  }

  let invite: InviteRow | null = null;
  if (input.mode === "private" || input.mode === "pvp" || input.invitedUserId) {
    invite = await createInvite(database, {
      code: game.code,
      gameId: game.id,
      creatorId: input.userId,
      invitedUserId: input.invitedUserId ?? null,
      channel: input.invitedUserId ? "direct" : "link",
      entryStroops: input.entryStroops,
      expiresAt: new Date(Date.now() + INVITE_TTL_MS).toISOString(),
    });
  }

  return {
    game,
    invite,
    escrow: { mode: input.demo ? "offchain" : "wallet-signature" },
    bot: botInfo,
  };
}

export interface EscrowHandoffResult {
  mode: "wallet-signature" | "confirmed" | "offchain";
  transactionId?: string;
  xdr?: string;
  txHash?: string;
  networkPassphrase?: string;
  game: GameRow;
}

/** Creator (or joiner) commits their entry into escrow. */
export async function commitEntry(input: {
  game: GameRow;
  userId: string;
  role: "creator" | "joiner";
}): Promise<EscrowHandoffResult> {
  const signer = await signerForUser(input.userId);
  if (!signer) throw Object.assign(new Error("No wallet linked to this account."), { code: "no_wallet" });

  if (input.game.demo) {
    // Demo duels move no money, but they still produce a clearly-labelled
    // simulated ledger line so the demo experience matches a real match and the
    // history page never looks broken. `demo = 1` and no transaction hash is
    // what keeps it honestly separated from Testnet results.
    const database = await db();
    const existing = await findTransactionForGame(database, input.userId, input.game.id, "entry");
    if (!existing) {
      await createTransaction(database, {
        userId: input.userId,
        gameId: input.game.id,
        kind: "entry",
        direction: "out",
        amountStroops: input.game.entry_stroops,
        status: "confirmed",
        address: signer.address,
        demo: true,
        metadata: { gameCode: input.game.code, mode: input.game.mode, demo: true },
      });
    }
    const updated = await advanceEscrowState(input.game, input.userId, null);
    return { mode: "offchain", game: updated };
  }

  if (!onChainEscrowAvailable() || !input.game.contract_game_id) throw escrowUnavailableError();

  // Idempotency guard: once a seat has locked its entry we never call the
  // contract again. Retries (double click, refresh, network retry) must not
  // surface a raw contract error after the player's funds have already moved.
  const alreadyLocked = input.role === "creator" ? input.game.create_tx_hash : input.game.join_tx_hash;
  if (alreadyLocked) {
    return { mode: "confirmed", txHash: alreadyLocked, game: input.game };
  }

  const { lockEntry, lockJoin } = await import("./escrow");
  const handoff =
    input.role === "creator"
      ? await lockEntry({
          game: input.game,
          userId: input.userId,
          address: signer.address,
          custody: signer.custody,
          keypair: signer.keypair,
        })
      : await lockJoin({
          game: input.game,
          userId: input.userId,
          address: signer.address,
          custody: signer.custody,
          keypair: signer.keypair,
        });

  if (handoff.mode === "confirmed") {
    const updated = await advanceEscrowState(input.game, input.userId, handoff.txHash);
    return {
      mode: "confirmed",
      transactionId: handoff.transactionId,
      txHash: handoff.txHash,
      game: updated,
    };
  }
  if (handoff.mode === "offchain") {
    const updated = await advanceEscrowState(input.game, input.userId, null);
    return { mode: "offchain", transactionId: handoff.transactionId, game: updated };
  }
  return {
    mode: "wallet-signature",
    transactionId: handoff.transactionId,
    xdr: handoff.xdr,
    networkPassphrase: handoff.networkPassphrase,
    game: input.game,
  };
}

async function advanceEscrowState(game: GameRow, userId: string, txHash: string | null): Promise<GameRow> {
  const database = await db();
  const isCreator = game.creator_id === userId;
  const patch: Record<string, unknown> = isCreator
    ? { escrow_state: game.demo ? "offchain" : "onchain", create_tx_hash: txHash }
    : { join_tx_hash: txHash };

  if (isCreator) {
    if (game.mode === "bot" || game.mode === "pvp" || game.mode === "private") {
      // A bot duel has both sides staked the moment the player's entry lands.
      if (game.mode === "bot") {
        patch.status = "joined";
        patch.pool_stroops = game.entry_stroops * 2;
        patch.opponent_id = game.opponent_id ?? `bot:${DEFAULT_BOT.id}`;
      }
    }
  } else {
    patch.opponent_id = userId;
    patch.status = "joined";
    patch.pool_stroops = game.entry_stroops * 2;
  }

  await updateGame(database, game.id, patch as Parameters<typeof updateGame>[2]);
  const updated = await findGameById(database, game.id);
  if (!updated) throw new Error("Duel disappeared");
  return updated;
}

export interface JoinResult {
  game: GameRow;
  escrow: EscrowHandoffResult;
}

export async function joinDuel(input: {
  userId: string;
  code?: string;
  gameId?: string;
}): Promise<JoinResult> {
  const database = await db();
  const game = input.gameId
    ? await findGameById(database, input.gameId)
    : input.code
      ? await findGameByCode(database, input.code)
      : null;
  if (!game) throw Object.assign(new Error("That duel does not exist."), { code: "not_found" });
  if (game.creator_id === input.userId) {
    throw Object.assign(new Error("You cannot duel yourself."), { code: "self_duel" });
  }
  if (game.status !== "waiting") {
    throw Object.assign(new Error("That duel is no longer open."), { code: "not_open" });
  }
  if (new Date(game.expires_at).getTime() < Date.now()) {
    throw Object.assign(new Error("That duel invitation has expired."), { code: "expired" });
  }
  const players = await listGamePlayers(database, game.id);
  if (players.length >= 2) {
    throw Object.assign(new Error("That duel is already full."), { code: "full" });
  }

  await addGamePlayer(database, {
    gameId: game.id,
    userId: input.userId,
    seat: 2,
    address: (await primaryWallet(database, input.userId))?.address ?? null,
  });

  if (game.mode !== "bot") {
    await updateGame(database, game.id, { status: "joined", opponent_id: input.userId });
  }

  const invite = await findInviteByGame(database, game.id);
  if (invite) {
    await updateInviteStatus(database, invite.id, "accepted", input.userId);
  }

  const escrow = await commitEntry({ game: { ...game, status: "joined" }, userId: input.userId, role: "joiner" });
  return { game: escrow.game, escrow };
}

export async function confirmWalletEscrow(input: {
  gameId: string;
  userId: string;
  signedXdr: string;
  transactionId: string;
}): Promise<GameRow> {
  const database = await db();
  const game = await findGameById(database, input.gameId);
  if (!game) throw Object.assign(new Error("That duel does not exist."), { code: "not_found" });
  const players = await listGamePlayers(database, game.id);
  const player = players.find((entry) => entry.user_id === input.userId);
  if (!player) throw Object.assign(new Error("You are not part of this duel."), { code: "forbidden" });

  const { submitWalletSigned } = await import("./escrow");
  const result = await submitWalletSigned({
    transactionId: input.transactionId,
    signedXdr: input.signedXdr,
  });
  const updated = await advanceEscrowState(
    game,
    input.userId,
    result.txHash,
  );
  return updated;
}

export async function cancelDuel(input: {
  userId: string;
  gameId: string;
}): Promise<GameRow> {
  const database = await db();
  const game = await findGameById(database, input.gameId);
  if (!game) throw Object.assign(new Error("That duel does not exist."), { code: "not_found" });
  if (game.creator_id !== input.userId && game.opponent_id !== input.userId) {
    throw Object.assign(new Error("You are not part of this duel."), { code: "forbidden" });
  }
  if (!["waiting", "joined"].includes(game.status)) {
    throw Object.assign(new Error("That duel can no longer be cancelled."), { code: "not_cancellable" });
  }

  const claimed = await transitionGame(database, game.id, ["waiting", "joined"], "cancelled");
  if (!claimed) {
    const fresh = await findGameById(database, game.id);
    return fresh ?? game;
  }

  const invite = await findInviteByGame(database, game.id);
  if (invite) await updateInviteStatus(database, invite.id, "cancelled");

  if (!game.demo && game.contract_game_id && onChainEscrowAvailable() && game.escrow_state === "onchain") {
    try {
      const result = await serverClaimRefund(game.contract_game_id);
      await createTransaction(database, {
        userId: game.creator_id,
        gameId: game.id,
        kind: "refund",
        direction: "in",
        amountStroops: game.entry_stroops,
        status: "confirmed",
        txHash: result.hash,
        explorerUrl: `https://stellar.expert/explorer/testnet/tx/${result.hash}`,
        metadata: { reason: "duel_cancelled" },
      });
    } catch (error) {
      await updateGame(database, game.id, { settlement_status: "failed" });
      throw Object.assign(new Error(`Refund could not be submitted: ${messageOf(error)}`), {
        code: "refund_failed",
      });
    }
  }
  const fresh = await findGameById(database, game.id);
  return fresh ?? game;
}

/** Refunds every duel whose join window elapsed. Safe to run repeatedly. */
export async function expireStaleDuels(limit = 25): Promise<{ refunded: number }> {
  const database = await db();
  const stale = await staleWaitingGames(database, nowIso());
  let refunded = 0;
  for (const game of stale.slice(0, limit)) {
    const claimed = await transitionGame(database, game.id, ["waiting", "joined"], "expired");
    if (!claimed) continue;
    const invite = await findInviteByGame(database, game.id);
    if (invite) await updateInviteStatus(database, invite.id, "expired");
    if (!game.demo && game.contract_game_id && onChainEscrowAvailable() && game.escrow_state === "onchain") {
      try {
        const result = await serverClaimRefund(game.contract_game_id);
        await createTransaction(database, {
          userId: game.creator_id,
          gameId: game.id,
          kind: "refund",
          direction: "in",
          amountStroops: game.entry_stroops,
          status: "confirmed",
          txHash: result.hash,
          metadata: { reason: "duel_expired" },
        });
        refunded += 1;
      } catch {
        await updateGame(database, game.id, { status: "joined", settlement_status: "failed" });
      }
    }
  }
  return { refunded };
}

export async function challengePlayer(input: {
  fromUserId: string;
  toUsername: string;
  entryStroops: number;
  demo: boolean;
}): Promise<DuelCreation> {
  const database = await db();
  const { findProfileByUsername } = await import("../db/repositories/identity");
  const opponentProfile = await findProfileByUsername(database, input.toUsername);
  if (!opponentProfile) {
    throw Object.assign(new Error("That player does not exist."), { code: "not_found" });
  }
  if (opponentProfile.user_id === input.fromUserId) {
    throw Object.assign(new Error("You cannot challenge yourself."), { code: "self_duel" });
  }

  const creation = await createDuel({
    userId: input.fromUserId,
    mode: "pvp",
    entryStroops: input.entryStroops,
    demo: input.demo,
    invitedUserId: opponentProfile.user_id,
  });
  return creation;
}

export async function openDuels(limit = 12): Promise<GameRow[]> {
  const database = await db();
  return listOpenPublicGames(database, limit);
}

export async function pendingInvites(userId: string): Promise<
  Array<InviteRow & { username: string; avatar: string | null; rating: number }>
> {
  const database = await db();
  const { listInvitesForUser } = await import("../db/repositories/duel");
  const invites = await listInvitesForUser(database, userId, ["pending", "created"]);
  const withCreator = [] as Array<InviteRow & { username: string; avatar: string | null; rating: number }>;
  for (const invite of invites) {
    const profile = await findProfile(database, invite.creator_id);
    if (!profile) continue;
    withCreator.push({ ...invite, username: profile.username, avatar: profile.avatar, rating: profile.rating });
  }
  return withCreator;
}

export async function inviteByCode(code: string): Promise<{
  invite: InviteRow;
  game: GameRow;
  creatorUsername: string;
} | null> {
  const database = await db();
  const invite = await findInviteByCode(database, code);
  if (!invite) return null;
  const game = await findGameById(database, invite.game_id);
  if (!game) return null;
  const profile = await findProfile(database, invite.creator_id);
  return { invite, game, creatorUsername: profile?.username ?? "Unknown" };
}

export async function respondToInvite(input: {
  inviteId: string;
  userId: string;
  accept: boolean;
}): Promise<{ accepted: boolean; gameId: string | null }> {
  const database = await db();
  const invite = await database.one<InviteRow>("SELECT * FROM invites WHERE id = ?", [input.inviteId]);
  if (!invite) throw Object.assign(new Error("That invitation does not exist."), { code: "not_found" });
  if (invite.invited_user_id && invite.invited_user_id !== input.userId) {
    throw Object.assign(new Error("That invitation is not for you."), { code: "forbidden" });
  }
  if (invite.status !== "pending" && invite.status !== "created") {
    throw Object.assign(new Error("That invitation is no longer open."), { code: "not_open" });
  }
  if (new Date(invite.expires_at).getTime() < Date.now()) {
    await updateInviteStatus(database, invite.id, "expired");
    throw Object.assign(new Error("That invitation has expired."), { code: "expired" });
  }

  const updated = await updateInviteStatus(
    database,
    invite.id,
    input.accept ? "accepted" : "declined",
    input.accept ? input.userId : null,
  );
  if (!updated) {
    throw Object.assign(new Error("That invitation was already resolved."), { code: "conflict" });
  }

  if (!input.accept) {
    await appendGameEvent(database, {
      gameId: invite.game_id,
      seq: Date.now() % 1_000_000,
      type: "invite_declined",
      seat: null,
      payload: { userId: input.userId },
    });
    return { accepted: false, gameId: null };
  }
  return { accepted: true, gameId: invite.game_id };
}

export async function linkQueueTicket(userId: string, gameType: string, entryStroops: number, demo: boolean) {
  const database = await db();
  return enqueue(database, {
    userId,
    gameType,
    entryStroops,
    demo,
    expiresAt: new Date(Date.now() + 90_000).toISOString(),
  });
}

export function duelShareUrl(code: string): string {
  return `/duel/${code}`;
}

export async function gameWithPlayers(gameId: string) {
  const database = await db();
  const game = await findGameById(database, gameId);
  if (!game) return null;
  const players = await listGamePlayers(database, game.id);
  const hydrated = [];
  for (const player of players) {
    if (player.is_bot === 1) {
      hydrated.push({ ...player, username: DEFAULT_BOT.name, avatar: null, rating: 0, custody: "bot" as const });
      continue;
    }
    const profile = await findProfile(database, player.user_id);
    const user = await findUserById(database, player.user_id);
    hydrated.push({
      ...player,
      username: profile?.username ?? "Player",
      avatar: profile?.avatar ?? null,
      rating: profile?.rating ?? 1000,
      theme: profile?.theme ?? "neon",
      custody: user?.auth_provider === "stellar" ? ("external" as const) : ("managed" as const),
    });
  }
  return { game, players: hydrated };
}

export function newDuelCode(): string {
  return inviteCode();
}

export function inviteToken(): string {
  return secureToken(12);
}

export function duelId(): string {
  return newId("gam");
}
