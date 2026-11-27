import "server-only";
import { db, newId, nowIso } from "../db";
import {
  addGamePlayer,
  appendGameEvent,
  completeQueueEntriesForGame,
  createGame,
  createInvite,
  enqueue,
  findGameById,
  findGameByCode,
  findInviteByCode,
  findInviteByGame,
  listGamePlayers,
  listOpenPublicGames,
  removeGamePlayer,
  staleWaitingGames,
  transitionGame,
  updateGame,
  updateInviteStatus,
} from "../db/repositories/duel";
import { findProfile, findUserById, primaryWallet } from "../db/repositories/identity";
import { createTransaction, findTransaction, findTransactionForGame } from "../db/repositories/economy";
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
import { onChainEscrowAvailable, messageOf, gameEscrowContractId } from "./escrow";
import { contractId, stellarNetwork, stellarGamingAllowed, explorerTxUrl } from "../config/stellar";
import { financialNetwork, financialSymbol } from "../stellar/shared";
import { ChainDuelError } from "./errors";
import { validateEscrowTransaction } from "../stellar/escrow-validation";
import { getOnChainGame, serverCancelGame, serverClaimRefund } from "../stellar/contract";
import { latestLedger } from "../stellar/server";
import { signerForUser } from "../wallet/signer";
import { isVerifiedGame, stellarVerificationEnabled } from "../config/stellar-verification";
import { assertPlayerWalletReady } from "./player-authority";
import { prepareVerifiedEntry, verifiedPulseState, type PulseEnrollmentProof } from "../stellar/verified-contract";
import { updateTransaction } from "../db/repositories/economy";

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
  if (!input.demo && !stellarGamingAllowed(input.userId)) throw new ChainDuelError("Stellar Mainnet staked duels are paused while deployment verification is completed.", "mainnet_verification_pending", 503);
  const database = await db();

  if (!input.demo && !onChainEscrowAvailable()) {
    throw escrowUnavailableError();
  }

  const durationMs = input.durationMs ?? PULSE_DUEL.durationMs;
  if (!input.demo && stellarVerificationEnabled() && durationMs !== PULSE_DUEL.durationMs) throw new ChainDuelError("Verified Pulse Duel uses the existing 60-second game duration.", "invalid_duration", 422);
  const expiresAt = new Date(Date.now() + DUEL_JOIN_WINDOW_MS).toISOString();
  const contractGameId = input.demo ? null : randomContractGameId();

  let botInfo: { id: string; name: string } | null = null;
  if (input.mode === "bot") {
    if (input.demo) {
      botInfo = { id: DEFAULT_BOT.id, name: DEFAULT_BOT.name };
    } else {
      const availability = await botAvailability(input.entryStroops, input.userId);
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
    escrowContractId: input.demo ? null : contractId(),
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
  enrollment?: PulseEnrollmentProof;
}): Promise<EscrowHandoffResult> {
  const players = await listGamePlayers(await db(), input.game.id);
  const seat = players.find(player => player.user_id === input.userId);
  if (!seat || (input.role === "creator" ? input.game.creator_id !== input.userId || seat.seat !== 1 : seat.seat !== 2 || input.game.creator_id === input.userId)) throw new ChainDuelError("Only the player assigned to this duel seat can commit its entry.", "forbidden", 403);
  if (!input.game.demo && financialNetwork(input.game) === "mainnet" && !stellarGamingAllowed(input.userId)) throw new ChainDuelError("Stellar Mainnet staked duels are paused while deployment verification is completed.", "mainnet_verification_pending", 503);
  const signer = await signerForUser(input.userId);
  if (!signer) throw Object.assign(new Error("No wallet linked to this account."), { code: "no_wallet" });
  const priorEntry = await findTransactionForGame(await db(), input.userId, input.game.id, "entry");
  if (!input.game.demo && financialNetwork(input.game) === "mainnet" && priorEntry?.address && priorEntry.address !== signer.address) throw new ChainDuelError("Reconnect the wallet that originally prepared this entry before continuing the duel.", "wallet_mismatch", 409);
  if (!(input.role === "creator" ? input.game.create_tx_hash : input.game.join_tx_hash) && (!priorEntry || financialNetwork(input.game) !== "mainnet")) await (await db()).execute("UPDATE game_players SET address = ? WHERE game_id = ? AND user_id = ?", [signer.address, input.game.id, input.userId]);

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

  if (!onChainEscrowAvailable(financialNetwork(input.game)) || !input.game.contract_game_id) throw escrowUnavailableError();

  // Idempotency guard: once a seat has locked its entry we never call the
  // contract again. Retries (double click, refresh, network retry) must not
  // surface a raw contract error after the player's funds have already moved.
  const alreadyLocked = input.role === "creator" ? input.game.create_tx_hash : input.game.join_tx_hash;
  if (alreadyLocked) {
    return { mode: "confirmed", txHash: alreadyLocked, game: input.game };
  }

  if (isVerifiedGame(input.game)) {
    await assertPlayerWalletReady(input.userId, signer.address, financialNetwork(input.game));
    if (!input.enrollment) throw new ChainDuelError("Register a player-controlled gameplay key before signing the stake.", "input_enrollment_required", 409);
    const prepared = await prepareVerifiedEntry(input.game, signer.address, input.role, input.enrollment);
    const transaction = await createTransaction(await db(), { userId: input.userId, gameId: input.game.id, kind: "entry", direction: "out", amountStroops: input.game.entry_stroops,
      status: "awaiting_wallet", address: signer.address, demo: false, stellarNetwork: financialNetwork(input.game), currency: financialSymbol(input.game),
      metadata: { verificationVersion: 1, inputKeyHex: input.enrollment.publicKeyHex, expiryLedger: prepared.expiryLedger } });
    await updateTransaction(await db(), transaction.id, { preparedHash: prepared.hash });
    return { mode: "wallet-signature", transactionId: transaction.id, xdr: prepared.xdr, networkPassphrase: stellarNetwork(financialNetwork(input.game)).networkPassphrase, game: input.game };
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
  if (!game.demo && financialNetwork(game) === "mainnet" && !stellarGamingAllowed(input.userId)) throw new ChainDuelError("Stellar Mainnet staked duels are paused while deployment verification is completed.", "mainnet_verification_pending", 503);
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

  if (game.mode !== "bot" && game.contract_game_id && onChainEscrowAvailable(financialNetwork(game))) {
    // The creator must have locked their side before anyone can join; otherwise
    // the contract has no game to match against. Surface that as a plain
    // message instead of a raw simulation failure.
    try {
      const onChain = await getOnChainGame(game.contract_game_id, await gameEscrowContractId(game.id), financialNetwork(game));
      if (!onChain) {
        throw Object.assign(
          new Error("The duel creator has not locked their entry yet. Try again in a moment."),
          { code: "creator_not_ready" },
        );
      }
      const creator = players.find(player => player.seat === 1);
      if (onChain.creator !== creator?.address || onChain.entryAmount !== BigInt(game.entry_stroops)) throw new ChainDuelError("The on-chain escrow does not match this duel's depositor and stake.", "escrow_mismatch", 409);
    } catch (error) {
      if (["creator_not_ready", "escrow_mismatch"].includes((error as { code?: string }).code ?? "")) throw error;
      if (messageOf(error).includes("GameNotFound") || messageOf(error).includes("Error(Contract, #5)")) {
        throw Object.assign(
          new Error("The duel creator has not locked their entry yet. Try again in a moment."),
          { code: "creator_not_ready" },
        );
      }
      // A transient RPC hiccup should not block the join; the escrow call below
      // performs the authoritative check.
    }
  }

  await addGamePlayer(database, {
    gameId: game.id,
    userId: input.userId,
    seat: 2,
    address: (await primaryWallet(database, input.userId))?.address ?? null,
  });

  let escrow: EscrowHandoffResult;
  try {
    escrow = isVerifiedGame(game)
      ? { mode: "wallet-signature", game }
      : await commitEntry({ game: { ...game, status: "joined" }, userId: input.userId, role: "joiner" });
  } catch (error) {
    // Roll the tentative seat back so the duel stays open and a retry is clean.
    await removeGamePlayer(database, game.id, input.userId);
    if (messageOf(error).includes("GameNotFound") || messageOf(error).includes("Error(Contract, #5)")) {
      throw Object.assign(
        new Error("The duel creator has not locked their entry yet. Try again in a moment."),
        { code: "creator_not_ready" },
      );
    }
    throw error;
  }

  if (game.mode !== "bot") {
    await updateGame(database, game.id, { status: "joined", opponent_id: input.userId });
  }

  const invite = await findInviteByGame(database, game.id);
  if (invite) {
    await updateInviteStatus(database, invite.id, "accepted", input.userId);
  }

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

  const transaction = await findTransaction(database, input.transactionId);
  if (!transaction || transaction.user_id !== input.userId || transaction.game_id !== game.id || transaction.kind !== "entry" || transaction.demo || transaction.amount_stroops !== game.entry_stroops || !transaction.address || !game.contract_game_id) {
    throw Object.assign(new Error("That transaction does not belong to this duel entry."), { code: "invalid_escrow_transaction" });
  }
  if (transaction.status === "confirmed" && transaction.tx_hash) return advanceEscrowState(game, input.userId, transaction.tx_hash);
  if (financialNetwork(transaction) !== financialNetwork(game) || financialSymbol(transaction) !== financialSymbol(game)) throw new ChainDuelError("The entry belongs to a different network or asset.", "invalid_escrow_transaction");
  if (financialNetwork(game) === "mainnet" && !transaction.prepared_hash) throw new ChainDuelError("Prepare this Mainnet entry again before signing.", "invalid_escrow_transaction");
  validateEscrowTransaction({
    signedXdr: input.signedXdr,
    networkPassphrase: stellarNetwork(financialNetwork(game)).networkPassphrase,
    contractId: await gameEscrowContractId(game.id),
    address: transaction.address,
    gameIdHex: game.contract_game_id,
    role: game.creator_id === input.userId ? "creator" : "joiner",
    mode: game.mode === "bot" ? 1 : 0,
    entryStroops: game.entry_stroops,
    preparedHash: transaction.prepared_hash,
    verificationVersion: game.verification_version,
    inputKeyHex: isVerifiedGame(game) ? (JSON.parse(transaction.metadata ?? "{}") as { inputKeyHex?: string }).inputKeyHex : null,
  });

  const { submitWalletSigned } = await import("./escrow");
  const result = await submitWalletSigned({
    transactionId: input.transactionId,
    signedXdr: input.signedXdr,
  });
  if (isVerifiedGame(game)) {
    const actual = await verifiedPulseState(game);
    const actualAddress = player.seat === 1 ? actual.creator : actual.opponent;
    const actualKey = player.seat === 1 ? actual.one.publicKeyHex : actual.two.publicKeyHex;
    const expected = JSON.parse(transaction.metadata ?? "{}") as { inputKeyHex: string };
    if (actualAddress !== transaction.address || actualKey !== expected.inputKeyHex) throw new ChainDuelError("The confirmed stake or gameplay key belongs to a different participant.", "verified_entry_mismatch", 502);
  }
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

  if (!game.demo && game.escrow_state === "onchain") {
    try {
      if (!game.contract_game_id || !onChainEscrowAvailable(financialNetwork(game))) throw escrowUnavailableError();
      // A duel nobody joined is refunded immediately via cancel_game. A duel
      // where both sides already staked can only be unwound once the join
      // window has elapsed, using claim_refund.
      const result =
        game.status === "waiting"
          ? await serverCancelGame(game.contract_game_id, await gameEscrowContractId(game.id), financialNetwork(game))
          : await serverClaimRefund(game.contract_game_id, await gameEscrowContractId(game.id), financialNetwork(game));
      await database.transaction(tx => recordRefunds(tx, game, result.hash, "duel_cancelled"));
    } catch (error) {
      // Do not leave the duel marked cancelled while the funds are still
      // escrowed — roll the status back so a retry/refund can still happen.
      await transitionGame(database, game.id, ["cancelled"], game.status);
      await updateGame(database, game.id, { settlement_status: "failed" });
      const detail = messageOf(error);
      const notExpired = detail.includes("GameNotExpired") || detail.includes("Error(Contract, #11)");
      throw Object.assign(
        new Error(
          notExpired
            ? "Both players have already staked — this duel can be cancelled once the join window expires."
            : `Refund could not be submitted: ${detail}`,
        ),
        { code: "refund_failed" },
      );
    }
  }
  const invite = await findInviteByGame(database, game.id);
  if (invite) await updateInviteStatus(database, invite.id, "cancelled");
  await completeQueueEntriesForGame(database, game.id);
  const fresh = await findGameById(database, game.id);
  return fresh ?? game;
}

/** Refunds every duel whose join window elapsed. Safe to run repeatedly. */
export async function expireStaleDuels(limit = 25): Promise<{ refunded: number }> {
  const database = await db();
  const stale = await staleWaitingGames(database, nowIso());
  let refunded = 0;
  const ledgers = new Map<string, number | null>();
  for (const game of stale.slice(0, limit)) {
    // The on-chain expiry includes headroom on top of the database window, so
    // skip games the contract will not refund yet; the next run picks them up.
    if (!game.demo && game.escrow_state === "onchain") {
      const network = financialNetwork(game);
      if (!game.contract_game_id || !onChainEscrowAvailable(network)) continue;
      if (!ledgers.has(network)) ledgers.set(network, await latestLedger(network).catch(() => null));
      const ledger = ledgers.get(network);
      if (ledger == null) continue;
      const onChain = await getOnChainGame(game.contract_game_id, await gameEscrowContractId(game.id), financialNetwork(game)).catch(() => null);
      if (!onChain || ledger < onChain.expiryLedger) continue;
    }
    const claimed = await transitionGame(database, game.id, ["waiting", "joined"], "expired");
    if (!claimed) continue;
    if (!game.demo && game.contract_game_id && game.escrow_state === "onchain") {
      try {
        const result = await serverClaimRefund(game.contract_game_id, await gameEscrowContractId(game.id), financialNetwork(game));
        await database.transaction(tx => recordRefunds(tx, game, result.hash, "duel_expired"));
        refunded += 1;
      } catch {
        await updateGame(database, game.id, { status: game.status, settlement_status: "failed" });
        continue;
      }
    }
    const invite = await findInviteByGame(database, game.id);
    if (invite) await updateInviteStatus(database, invite.id, "expired");
    await completeQueueEntriesForGame(database, game.id);
  }
  return { refunded };
}

async function recordRefunds(database: import("../db/types").SqlDriver, game: GameRow, txHash: string, reason: string) {
  const players = await listGamePlayers(database, game.id);
  for (const player of players.filter(player => !player.is_bot && (player.seat === 1 || Boolean(game.join_tx_hash)))) {
    if (await database.one("SELECT id FROM transactions WHERE game_id = ? AND user_id = ? AND kind = 'refund' AND status = 'confirmed'", [game.id, player.user_id])) continue;
    await createTransaction(database, {
      userId: player.user_id, gameId: game.id, kind: "refund", direction: "in",
      amountStroops: game.entry_stroops, status: "confirmed", txHash,
      explorerUrl: explorerTxUrl(txHash, financialNetwork(game)), address: player.address,
      metadata: { reason },
    });
  }
  await updateGame(database, game.id, { escrow_state: "refunded", settlement_status: "confirmed" });
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
    const game = await findGameById(database, invite.game_id);
    if (!game) continue;
    withCreator.push({ ...invite, stellar_network: financialNetwork(game), currency: financialSymbol(game), username: profile.username, avatar: profile.avatar, rating: profile.rating });
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
