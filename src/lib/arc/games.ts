import "server-only";
import { randomUUID, randomBytes } from "node:crypto";
import { encodeFunctionData, erc20Abi, isAddressEqual, keccak256, toBytes, type Address } from "viem";
import { ARC_USDC, ARC_MIN_MAX_FEE, parseUsdc, arcPoolSplit } from "../networks/arc";
import { buildTargetSchedule, theoreticalMaxScore } from "../game/pulse";
import { verifySubmission, type SubmissionPayload } from "../game/verify";
import { PulseBot } from "../game/bot";
import { DEFAULT_BOT } from "../config/game";
import { ChainDuelError } from "../services/errors";
import { arcConfig } from "./config";
import { arcDb } from "./db";
import { arcWalletFor } from "./access";
import { arcDuelAbi } from "./abi";
import { verifiedArcClient } from "./chain";
import { createArcOperation, refreshArcOperation } from "./operations";
import { arcSettlementSigner } from "./signer";
import type { ArcGameRow, ArcPlayerRow } from "./types";

const DURATION = 60_000;
export async function loadArcGame(id: string) {
  const database = await arcDb();
  const config = arcConfig();
  const game = await database.one<ArcGameRow>(
    "SELECT * FROM arc_games WHERE (id=? OR code=?) AND network_id=?",
    [id, id.toUpperCase(), config.networkId],
  );
  if (!game) throw new ChainDuelError("That Arc duel was not found on this network.", "not_found", 404);
  return game;
}
export async function arcPlayers(gameId: string) {
  return (await arcDb()).query<ArcPlayerRow>("SELECT * FROM arc_players WHERE game_id=? ORDER BY seat", [
    gameId,
  ]);
}
function requireGaming() {
  const config = arcConfig();
  if (!config.gamingEnabled || !config.contractAddress)
    throw new ChainDuelError(
      "Arc gaming is awaiting activation. No stake has been taken.",
      "arc_gaming_unavailable",
      503,
    );
  return { ...config, contractAddress: config.contractAddress };
}
export async function createArcGame(input: {
  userId: string;
  mode: "pvp" | "private" | "bot";
  amount: string;
  requestKey: string;
  invitedUserId?: string;
  opponentId?: string;
}) {
  const config = requireGaming();
  const wallet = await arcWalletFor(input.userId);
  const database = await arcDb();
  const existing = await database.one<ArcGameRow>(
    "SELECT * FROM arc_games WHERE creator_id=? AND network_id=? AND request_key=?",
    [input.userId, config.networkId, input.requestKey],
  );
  const stake = parseUsdc(input.amount);
  if (existing) {
    if (existing.stake_units !== stake.toString() || existing.mode !== input.mode)
      throw new ChainDuelError(
        "This request was already used for another duel.",
        "idempotency_conflict",
        409,
      );
    return existing;
  }
  const client = await verifiedArcClient();
  const [minimum, maximum, botLiquidity, botRecipient, escrowToken] = await Promise.all([
    client.readContract({
      address: config.contractAddress,
      abi: arcDuelAbi,
      functionName: "minStake",
    }),
    client.readContract({
      address: config.contractAddress,
      abi: arcDuelAbi,
      functionName: "maxStake",
    }),
    client.readContract({
      address: config.contractAddress,
      abi: arcDuelAbi,
      functionName: "botLiquidity",
    }),
    client.readContract({
      address: config.contractAddress,
      abi: arcDuelAbi,
      functionName: "botRecipient",
    }),
    client.readContract({
      address: config.contractAddress,
      abi: arcDuelAbi,
      functionName: "usdc",
    }),
  ]);
  if (!isAddressEqual(escrowToken, ARC_USDC))
    throw new ChainDuelError("The Arc escrow token could not be verified.", "wrong_token", 503);
  if (stake < minimum || stake > maximum)
    throw new ChainDuelError("This stake is outside the Arc escrow limits.", "invalid_stake", 422);
  if (input.mode === "bot" && botLiquidity < stake)
    throw new ChainDuelError("Computer matches are temporarily unavailable.", "bot_liquidity", 503);
  if (input.invitedUserId === input.userId || input.opponentId === input.userId)
    throw new ChainDuelError("Choose another player.", "invalid_opponent", 422);
  const opponentWallet = input.opponentId ? await arcWalletFor(input.opponentId) : null;
  if (
    input.invitedUserId &&
    !(await database.one("SELECT id FROM users WHERE id=? AND status='active'", [input.invitedUserId]))
  )
    throw new ChainDuelError("That player was not found.", "not_found", 404);
  const id = `arc_${randomUUID()}`;
  const code = randomBytes(4).toString("hex").toUpperCase();
  const contractGameId = keccak256(
    toBytes(`${config.networkId}:${config.contractAddress}:${input.userId}:${input.requestKey}`),
  );
  const now = new Date().toISOString();
  const expires = new Date(Date.now() + 15 * 60_000).toISOString();
  await database.transaction(async (tx) => {
    await tx.execute(
      `INSERT INTO arc_games(id,code,network_id,request_key,currency,token_address,token_decimals,contract_address,contract_game_id,mode,game_type,status,creator_id,invited_user_id,stake_units,seed,duration_ms,created_at,expires_at)
      VALUES(?,?,?,?,'USDC',?,6,?,?,?,'pulse','awaiting_entry',?,?,?,?,?,?,?)`,
      [
        id,
        code,
        config.networkId,
        input.requestKey,
        ARC_USDC,
        config.contractAddress,
        contractGameId,
        input.mode,
        input.userId,
        input.invitedUserId ?? null,
        stake.toString(),
        randomBytes(24).toString("hex"),
        DURATION,
        now,
        expires,
      ],
    );
    await tx.execute("INSERT INTO arc_players(game_id,seat,user_id,address) VALUES(?,1,?,?)", [
      id,
      input.userId,
      wallet.address,
    ]);
    if (input.mode === "bot")
      await tx.execute("INSERT INTO arc_players(game_id,seat,user_id,address,funded) VALUES(?,2,NULL,?,1)", [
        id,
        botRecipient.toLowerCase(),
      ]);
    else if (opponentWallet)
      await tx.execute("INSERT INTO arc_players(game_id,seat,user_id,address) VALUES(?,2,?,?)", [
        id,
        input.opponentId,
        opponentWallet.address,
      ]);
  });
  return loadArcGame(id);
}
export async function joinArcGame(userId: string, id: string) {
  requireGaming();
  const game = await loadArcGame(id);
  const wallet = await arcWalletFor(userId);
  const database = await arcDb();
  if (
    game.mode === "bot" ||
    game.creator_id === userId ||
    !["waiting", "awaiting_entry"].includes(game.status)
  )
    throw new ChainDuelError("That duel cannot be joined.", "invalid_state", 409);
  if (game.invited_user_id && game.invited_user_id !== userId)
    throw new ChainDuelError("This challenge is for another player.", "forbidden", 403);
  if (Date.now() >= new Date(game.expires_at).getTime())
    throw new ChainDuelError("That duel has expired.", "expired", 409);
  const players = await arcPlayers(game.id);
  const opponent = players.find((p) => p.seat === 2);
  if (opponent) {
    if (opponent.user_id !== userId)
      throw new ChainDuelError("That duel already has two players.", "full", 409);
    return game;
  }
  await database.execute(
    "INSERT INTO arc_players(game_id,seat,user_id,address) VALUES(?,2,?,?) ON CONFLICT(game_id,seat) DO NOTHING",
    [game.id, userId, wallet.address],
  );
  const seat = (await arcPlayers(game.id)).find((p) => p.seat === 2);
  if (seat?.user_id !== userId)
    throw new ChainDuelError("Another player just joined this duel.", "full", 409);
  return game;
}
export async function prepareArcEntry(
  userId: string,
  id: string,
  action: "approve" | "entry" | "cancel" | "refund",
) {
  const game = await loadArcGame(id);
  const wallet = await arcWalletFor(userId);
  const players = await arcPlayers(game.id);
  const player = players.find((p) => p.user_id === userId);
  if (!player) throw new ChainDuelError("You are not part of this duel.", "forbidden", 403);
  if (["settled", "refunded"].includes(game.status))
    throw new ChainDuelError("That duel has already finished.", "invalid_state", 409);
  if (action === "cancel" && game.creator_id !== userId)
    throw new ChainDuelError("Only the creator can cancel.", "forbidden", 403);
  const stake = BigInt(game.stake_units);
  const contractAddress = game.contract_address as Address;
  const client = await verifiedArcClient();
  const escrowToken = await client.readContract({
    address: contractAddress,
    abi: arcDuelAbi,
    functionName: "usdc",
  });
  if (!isAddressEqual(escrowToken, ARC_USDC))
    throw new ChainDuelError("The Arc escrow token could not be verified.", "wrong_token", 503);
  if (action === "approve")
    return createArcOperation({
      userId,
      gameId: game.id,
      action: "approve",
      target: ARC_USDC,
      amount: 0n,
      calldata: encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [contractAddress, stake],
      }),
    });
  if (action === "entry") {
    requireGaming();
    if (player.funded) throw new ChainDuelError("This entry is already funded.", "already_funded", 409);
    if (
      (await client.readContract({
        address: ARC_USDC,
        abi: erc20Abi,
        functionName: "allowance",
        args: [wallet.address as Address, contractAddress],
      })) < stake
    )
      throw new ChainDuelError("Approve the exact USDC stake before depositing.", "approval_required", 409);
    const onchain = await client.readContract({
      address: contractAddress,
      abi: arcDuelAbi,
      functionName: "getGame",
      args: [game.contract_game_id],
    });
    if (player.seat === 2 && (onchain.status !== 1 || !players.find((p) => p.seat === 1)?.funded))
      throw new ChainDuelError("Wait for the creator’s stake to confirm first.", "creator_pending", 409);
    if (
      player.seat === 2 &&
      (onchain.stake !== stake ||
        !isAddressEqual(onchain.creator, players.find((p) => p.seat === 1)!.address as Address))
    )
      throw new ChainDuelError(
        "The on-chain creator or stake differs from this duel. Do not deposit.",
        "escrow_mismatch",
        409,
      );
    const create = player.seat === 1;
    const calldata = create
      ? encodeFunctionData({
          abi: arcDuelAbi,
          functionName: "createGame",
          args: [game.contract_game_id, stake, game.mode === "bot"],
        })
      : encodeFunctionData({
          abi: arcDuelAbi,
          functionName: "joinGame",
          args: [game.contract_game_id],
        });
    return createArcOperation({
      userId,
      gameId: game.id,
      action: create ? "create" : "join",
      target: contractAddress,
      calldata,
      amount: stake,
    });
  }
  return createArcOperation({
    userId,
    gameId: game.id,
    action,
    target: contractAddress,
    amount: stake,
    calldata: encodeFunctionData({
      abi: arcDuelAbi,
      functionName: action === "cancel" ? "cancelGame" : "claimRefund",
      args: [game.contract_game_id],
    }),
  });
}
export async function synchronizeArcGame(id: string) {
  const game = await loadArcGame(id);
  if (game.status === "settled" || game.status === "refunded") return game;
  const database = await arcDb();
  const client = await verifiedArcClient();
  const chainGame = await client.readContract({
    address: game.contract_address as Address,
    abi: arcDuelAbi,
    functionName: "getGame",
    args: [game.contract_game_id],
  });
  const players = await arcPlayers(game.id);
  if (
    chainGame.status !== 0 &&
    chainGame.status !== 5 &&
    (chainGame.stake !== BigInt(game.stake_units) ||
      !isAddressEqual(chainGame.creator, players.find((p) => p.seat === 1)!.address as Address) ||
      (chainGame.status >= 2 &&
        (!players.find((p) => p.seat === 2) ||
          !isAddressEqual(chainGame.opponent, players.find((p) => p.seat === 2)!.address as Address))))
  ) {
    await database.execute("UPDATE arc_games SET status='recovery_required' WHERE id=?", [game.id]);
    return loadArcGame(game.id);
  }
  if (chainGame.status === 1)
    await database.execute(
      `UPDATE arc_games SET status='waiting',expires_at=? WHERE id=? AND status IN ('awaiting_entry','waiting')`,
      [new Date(Number(chainGame.joinDeadline) * 1000).toISOString(), game.id],
    );
  if (chainGame.status === 2)
    await database.execute(
      `UPDATE arc_games SET status='joined' WHERE id=? AND status IN ('awaiting_entry','waiting')`,
      [game.id],
    );
  if (chainGame.status === 3)
    await database.execute(
      `UPDATE arc_games SET status='active',started_at=? WHERE id=? AND status <> 'settled'`,
      [new Date(Number(chainGame.startedAt) * 1000).toISOString(), game.id],
    );
  if (chainGame.status === 5) await reconcileArcRefund(game, client);
  return loadArcGame(game.id);
}
async function reconcileArcRefund(game: ArcGameRow, client: Awaited<ReturnType<typeof verifiedArcClient>>) {
  const database = await arcDb();
  const logs = await client.getContractEvents({
    address: game.contract_address as Address,
    abi: arcDuelAbi,
    eventName: "GameRefunded",
    args: { id: game.contract_game_id },
    fromBlock: game.create_block ? BigInt(game.create_block) : 0n,
    toBlock: "latest",
  });
  const event = logs.at(-1);
  if (!event?.transactionHash)
    throw new ChainDuelError(
      "The refund event is not yet available. Refresh to verify its transaction.",
      "refund_pending",
      409,
    );
  const receipt = await client.getTransactionReceipt({ hash: event.transactionHash });
  if (receipt.status !== "success")
    throw new ChainDuelError("The refund receipt could not be verified.", "refund_pending", 409);
  const players = await arcPlayers(game.id);
  await database.transaction(async (tx) => {
    for (const player of players.filter((p) => p.user_id && p.funded))
      await tx.execute(
        `INSERT INTO arc_transactions(id,user_id,game_id,operation_id,network_id,contract_address,token_address,currency,token_decimals,kind,direction,amount_units,status,tx_hash,created_at,confirmed_at)
      VALUES(?,?,?,?,?,?,?,'USDC',6,'refund','in',?,'confirmed',?,?,?) ON CONFLICT(operation_id,kind,user_id) DO NOTHING`,
        [
          randomUUID(),
          player.user_id,
          game.id,
          `refund:${game.id}`,
          game.network_id,
          game.contract_address,
          ARC_USDC,
          game.stake_units,
          event.transactionHash,
          game.created_at,
          new Date().toISOString(),
        ],
      );
    await tx.execute(
      "UPDATE arc_games SET status='refunded',settlement_status='refunded',settlement_lease_until=NULL WHERE id=?",
      [game.id],
    );
  });
}
export async function startArcGame(userId: string, id: string) {
  let game = await synchronizeArcGame(id);
  const players = await arcPlayers(game.id);
  if (!players.some((p) => p.user_id === userId))
    throw new ChainDuelError("You are not part of this duel.", "forbidden", 403);
  if (game.status === "active") return game;
  if (game.status !== "joined" || players.length !== 2 || players.some((p) => !p.funded))
    throw new ChainDuelError("Both entries must be confirmed before starting.", "not_ready", 409);
  const database = await arcDb();
  const claimed = await database.run(
    `UPDATE arc_games SET status='starting' WHERE id=? AND status='joined'`,
    [game.id],
  );
  if (!claimed) return loadArcGame(game.id);
  try {
    const client = await verifiedArcClient();
    const signer = arcSettlementSigner();
    const authority = await client.readContract({
      address: game.contract_address as Address,
      abi: arcDuelAbi,
      functionName: "settlementAuthority",
    });
    if (!isAddressEqual(authority, signer.account.address)) throw new Error("wrong authority");
    const hash = await signer.writeContract({
      address: game.contract_address as Address,
      abi: arcDuelAbi,
      functionName: "startGame",
      args: [game.contract_game_id],
      maxFeePerGas: ARC_MIN_MAX_FEE * 2n,
      maxPriorityFeePerGas: 1_000_000_000n,
    });
    const receipt = await client.waitForTransactionReceipt({
      hash,
      timeout: 20_000,
    });
    if (receipt.status !== "success") throw new Error("start reverted");
    game = await synchronizeArcGame(game.id);
    return game;
  } catch {
    await database.execute(`UPDATE arc_games SET status='joined' WHERE id=? AND status='starting'`, [
      game.id,
    ]);
    throw new ChainDuelError("The Arc duel could not start. Please retry.", "start_failed", 502);
  }
}
export async function submitArcResult(
  userId: string,
  id: string,
  payload: Omit<SubmissionPayload, "matchId">,
) {
  const game = await loadArcGame(id);
  const players = await arcPlayers(game.id);
  const player = players.find((p) => p.user_id === userId);
  if (!player || payload.seat !== player.seat)
    throw new ChainDuelError("You are not part of this duel.", "forbidden", 403);
  if (game.status === "settled") return game;
  if (!game.started_at || !["active", "finished"].includes(game.status))
    throw new ChainDuelError("That duel is not running.", "invalid_state", 409);
  if (Date.now() < new Date(game.started_at).getTime() + DURATION)
    throw new ChainDuelError("Wait for the duel to finish.", "too_early", 409);
  if (player.score === null) {
    const verified = verifySubmission(
      { ...payload, matchId: game.id },
      { seed: game.seed, durationMs: game.duration_ms },
    );
    if (!verified.valid)
      throw new ChainDuelError("Your event log could not be verified.", "verification_failed", 422);
    await (
      await arcDb()
    ).execute(
      `UPDATE arc_players SET score=?,max_combo=?,result='finished' WHERE game_id=? AND user_id=? AND score IS NULL`,
      [verified.score.score, verified.score.maxCombo, game.id, userId],
    );
  }
  if (game.mode === "bot") {
    const bot = new PulseBot(game.seed, DEFAULT_BOT, DURATION);
    bot.update(DURATION);
    const score = bot.snapshot();
    await (
      await arcDb()
    ).execute(
      `UPDATE arc_players SET score=?,max_combo=?,result='finished' WHERE game_id=? AND user_id IS NULL`,
      [score.score, score.maxCombo, game.id],
    );
  }
  if ((await arcPlayers(game.id)).some((p) => p.score === null)) return game;
  return settleArcGame(game.id);
}
export async function settleArcGame(id: string) {
  const game = await loadArcGame(id);
  if (game.status === "settled" || game.status === "refunded") return game;
  const players = await arcPlayers(game.id);
  if (players.length !== 2 || players.some((p) => p.score === null)) return game;
  const sorted = [...players].sort(
    (a, b) => (b.score ?? 0) - (a.score ?? 0) || (b.max_combo ?? 0) - (a.max_combo ?? 0) || a.seat - b.seat,
  );
  const winner = sorted[0];
  const resultHash = keccak256(
    toBytes(
      JSON.stringify({
        network: game.network_id,
        contract: game.contract_address,
        id: game.contract_game_id,
        players: players.map((p) => [p.seat, p.address, p.score, p.max_combo]),
      }),
    ),
  );
  const database = await arcDb();
  const claimed = await database.run(
    `UPDATE arc_games SET settlement_status='submitting',status='finished',settlement_lease_until=? WHERE id=? AND (settlement_status IS NULL OR settlement_status='failed' OR settlement_lease_until < ?)`,
    [new Date(Date.now() + 120_000).toISOString(), game.id, new Date().toISOString()],
  );
  if (!claimed) return loadArcGame(game.id);
  try {
    const client = await verifiedArcClient();
    const address = game.contract_address as Address;
    let hash = game.settle_tx_hash as `0x${string}` | null;
    let chainGame = await client.readContract({
      address,
      abi: arcDuelAbi,
      functionName: "getGame",
      args: [game.contract_game_id],
    });
    if (chainGame.status === 5) {
      await reconcileArcRefund(game, client);
      return loadArcGame(game.id);
    }
    if (
      chainGame.stake !== BigInt(game.stake_units) ||
      !isAddressEqual(chainGame.creator, players[0].address as Address) ||
      !isAddressEqual(chainGame.opponent, players[1].address as Address)
    )
      throw new Error("Escrow participants or stake mismatch");
    if (!hash && chainGame.status !== 4) {
      const signer = arcSettlementSigner();
      const authority = await client.readContract({
        address,
        abi: arcDuelAbi,
        functionName: "settlementAuthority",
      });
      if (!isAddressEqual(authority, signer.account.address)) throw new Error("wrong authority");
      hash = await signer.writeContract({
        address,
        abi: arcDuelAbi,
        functionName: "settleGame",
        args: [game.contract_game_id, winner.address as Address, resultHash],
        maxFeePerGas: ARC_MIN_MAX_FEE * 2n,
        maxPriorityFeePerGas: 1_000_000_000n,
      });
      await database.execute("UPDATE arc_games SET settle_tx_hash=? WHERE id=?", [hash, game.id]);
    }
    if (hash) {
      const receipt = await client.waitForTransactionReceipt({
        hash,
        timeout: 20_000,
      });
      if (receipt.status !== "success") {
        await database.transaction(async (tx) => {
          await tx.execute(
            "INSERT INTO arc_settlement_attempts(game_id,tx_hash,status,archived_at) VALUES(?,?,'reverted',?) ON CONFLICT(game_id,tx_hash) DO NOTHING",
            [game.id, hash, new Date().toISOString()],
          );
          await tx.execute("UPDATE arc_games SET settle_tx_hash=NULL WHERE id=? AND settle_tx_hash=?", [
            game.id,
            hash,
          ]);
        });
        throw new Error("settlement reverted");
      }
    }
    chainGame = await client.readContract({
      address,
      abi: arcDuelAbi,
      functionName: "getGame",
      args: [game.contract_game_id],
    });
    if (
      chainGame.status !== 4 ||
      chainGame.resultHash !== resultHash ||
      !isAddressEqual(chainGame.winner, winner.address as Address)
    )
      throw new Error("settlement mismatch");
    if (!hash) {
      const logs = await client.getLogs({
        address,
        event: arcDuelAbi.find((e) => e.type === "event" && e.name === "GameSettled")!,
        args: { id: game.contract_game_id },
        fromBlock: BigInt(game.create_block ?? "0"),
        toBlock: "latest",
      });
      hash = logs.at(-1)?.transactionHash ?? null;
      if (!hash) throw new Error("settlement reference missing");
    }
    const split = arcPoolSplit(BigInt(game.stake_units));
    const settledAt = new Date().toISOString();
    await database.transaction(async (tx) => {
      const updated = await tx.run(
        `UPDATE arc_games SET status='settled',settlement_status='confirmed',settlement_lease_until=NULL,winner_id=?,result_hash=?,settle_tx_hash=?,settled_at=? WHERE id=? AND status <> 'settled'`,
        [winner.user_id, resultHash, hash, settledAt, game.id],
      );
      if (!updated) return;
      if (winner.user_id)
        await tx.execute(
          `INSERT INTO arc_transactions(id,user_id,game_id,operation_id,network_id,contract_address,token_address,currency,token_decimals,kind,direction,amount_units,status,tx_hash,created_at,confirmed_at)
        VALUES(?,?,?,?,?,?,?,'USDC',6,'payout','in',?,'confirmed',?,?,?) ON CONFLICT(operation_id,kind,user_id) DO NOTHING`,
          [
            randomUUID(),
            winner.user_id,
            game.id,
            `settlement:${game.id}`,
            game.network_id,
            address,
            ARC_USDC,
            split.winner.toString(),
            hash,
            settledAt,
            settledAt,
          ],
        );
      for (const [kind, amount] of [
        ["protocol_fee", split.protocol],
        ["ecosystem_fee", split.ecosystem],
      ] as const)
        await tx.execute(
          `INSERT INTO arc_transactions(id,user_id,game_id,operation_id,network_id,contract_address,token_address,currency,token_decimals,kind,direction,amount_units,status,tx_hash,created_at,confirmed_at)
          VALUES(?,NULL,?,?,?,?,?,'USDC',6,?,'out',?,'confirmed',?,?,?)`,
          [
            randomUUID(),
            game.id,
            `settlement:${game.id}:${kind}`,
            game.network_id,
            address,
            ARC_USDC,
            kind,
            amount.toString(),
            hash,
            settledAt,
            settledAt,
          ],
        );
    });
    return loadArcGame(game.id);
  } catch {
    await database.execute(
      `UPDATE arc_games SET settlement_status='failed',settlement_lease_until=NULL WHERE id=? AND status <> 'settled'`,
      [game.id],
    );
    throw new ChainDuelError(
      "Settlement is pending recovery. Your result is saved; retry to check the chain.",
      "settlement_pending",
      502,
    );
  }
}
export async function arcGameView(userId: string, id: string) {
  const storedGame = await loadArcGame(id);
  const pending = await (
    await arcDb()
  ).query<{ id: string }>(
    "SELECT id FROM arc_operations WHERE game_id=? AND user_id=? AND status IN ('awaiting_approval','submitted')",
    [storedGame.id, userId],
  );
  // Reconcile already authorized deposits after reloads or lost API responses.
  await Promise.allSettled(pending.map((operation) => refreshArcOperation(userId, operation.id)));
  let game = await synchronizeArcGame(id);
  let players = await arcPlayers(game.id);
  if (!players.some((p) => p.user_id === userId) && game.invited_user_id && game.invited_user_id !== userId)
    throw new ChainDuelError("This challenge is for another player.", "forbidden", 403);
  if (
    ["failed", "submitting"].includes(game.settlement_status ?? "") &&
    players.every((p) => p.score !== null)
  ) {
    game = await settleArcGame(game.id);
    players = await arcPlayers(game.id);
  }
  const schedule = buildTargetSchedule(game.seed, game.duration_ms);
  const database = await arcDb();
  const profiles = await database.query<{ user_id: string; username: string }>(
    "SELECT user_id,username FROM profiles WHERE user_id IN (?,?)",
    [players[0]?.user_id, players[1]?.user_id],
  );
  const progress = await database.query<{ user_id: string; score: number }>(
    "SELECT user_id,score FROM arc_progress WHERE game_id=?",
    [game.id],
  );
  let botScore: number | null = null;
  if (game.mode === "bot" && game.started_at) {
    const bot = new PulseBot(game.seed, DEFAULT_BOT, DURATION);
    bot.update(Math.max(0, Date.now() - new Date(game.started_at).getTime()));
    botScore = bot.snapshot().score;
  }
  return {
    game,
    players: players.map((p) => ({
      ...p,
      username: p.user_id ? (profiles.find((f) => f.user_id === p.user_id)?.username ?? "Player") : "VEX-7",
    })),
    schedule,
    serverTimeMs: Date.now(),
    startAtMs: game.started_at ? new Date(game.started_at).getTime() : null,
    countdownMs: 0,
    maxScore: theoreticalMaxScore(schedule),
    botScore,
    liveScores: Object.fromEntries(
      players.map((p) => [p.seat, progress.find((r) => r.user_id === p.user_id)?.score ?? p.score ?? 0]),
    ),
  };
}
