import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { initiateUserControlledWalletsClient, type Wallet } from "@circle-fin/user-controlled-wallets";
import { isAddress } from "viem";
import { ChainDuelError } from "../services/errors";
import { arcConfig } from "./config";
import { arcDb } from "./db";
import type { ArcWalletRow } from "./types";

let client: ReturnType<typeof initiateUserControlledWalletsClient> | undefined;
let clientKey: string | undefined;
export function circleClient() {
  const apiKey = process.env.CIRCLE_API_KEY;
  if (!apiKey)
    throw new ChainDuelError("Arc wallet setup is currently unavailable.", "circle_unavailable", 503);
  if (!client || clientKey !== apiKey) {
    client = initiateUserControlledWalletsClient({ apiKey });
    clientKey = apiKey;
  }
  return client;
}
export function circleIdentity(userId: string, appId: string): string {
  const bytes = createHash("sha256").update(`chain-duel:circle:${appId}:${userId}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 80;
  bytes[8] = (bytes[8] & 63) | 128;
  const h = bytes.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
export function circleHttpStatus(error: unknown): number | undefined {
  return (error as { status?: number } | null)?.status;
}
function assertEnabled() {
  const config = arcConfig();
  if (!config.walletEnabled || !config.appId)
    throw new ChainDuelError(
      "Arc wallet setup is currently unavailable. Your Stellar wallet is ready as usual.",
      "circle_unavailable",
      503,
    );
  return { ...config, appId: config.appId };
}
export async function associatedArcWallet(userId: string): Promise<ArcWalletRow | null> {
  const config = arcConfig();
  const database = await arcDb();
  return database.one<ArcWalletRow>(
    "SELECT * FROM arc_wallets WHERE user_id = ? AND network_id = ? AND app_id = ?",
    [userId, config.networkId, config.appId ?? ""],
  );
}
export async function circleCredentials(circleUserId: string) {
  const result = await circleClient().createUserToken({ userId: circleUserId });
  if (!result.data?.userToken || !result.data.encryptionKey)
    throw new ChainDuelError(
      "Circle could not open your wallet session. Please retry.",
      "circle_session_failed",
      502,
    );
  return { userToken: result.data.userToken, encryptionKey: result.data.encryptionKey };
}
async function ensureCircleUser(userId: string, appId: string) {
  const database = await arcDb();
  const circleUserId = circleIdentity(userId, appId);
  await database.execute(
    `INSERT INTO circle_users(user_id, app_id, circle_user_id, created_at) VALUES(?,?,?,?) ON CONFLICT(user_id,app_id) DO NOTHING`,
    [userId, appId, circleUserId, new Date().toISOString()],
  );
  try {
    await circleClient().getUser({ userId: circleUserId });
  } catch (error) {
    if (circleHttpStatus(error) !== 404) throw error;
    try {
      await circleClient().createUser({ userId: circleUserId });
    } catch (creationError) {
      // Concurrent login or an upstream retry may already have created the same stable ID.
      if (circleHttpStatus(creationError) !== 409) throw creationError;
      await circleClient().getUser({ userId: circleUserId });
    }
  }
  return circleUserId;
}
export async function listOwnedArcWallets(circleUserId: string): Promise<Wallet[]> {
  const config = arcConfig();
  // Circle's list-wallets API accepts at most 50 records per page.
  const pageSize = 50;
  const wallets: Wallet[] = [];
  let pageAfter: string | undefined;
  const seen = new Set<string>();
  for (;;) {
    const response = await circleClient().listWallets({
      userId: circleUserId,
      blockchain: config.circle,
      pageSize,
      pageAfter,
    });
    const page = response.data?.wallets ?? [];
    for (const wallet of page) {
      if (
        wallet.blockchain !== config.circle ||
        wallet.userId !== circleUserId ||
        wallet.custodyType !== "ENDUSER" ||
        !isAddress(wallet.address)
      )
        throw new ChainDuelError(
          "Circle returned a wallet that could not be verified for this account.",
          "wallet_ownership_failed",
          502,
        );
      wallets.push(wallet);
    }
    if (page.length < pageSize) return wallets;
    const cursor = page.at(-1)?.id;
    if (!cursor || seen.has(cursor))
      throw new ChainDuelError(
        "Circle wallet retrieval could not finish. Please retry.",
        "circle_pagination_failed",
        502,
      );
    seen.add(cursor);
    pageAfter = cursor;
  }
}
export async function reconcileArcWallet(userId: string): Promise<ArcWalletRow | null> {
  const row = await associatedArcWallet(userId);
  if (!row) return null;
  const wallets = await listOwnedArcWallets(row.circle_user_id);
  if (wallets.length > 1)
    throw new ChainDuelError(
      "Multiple Arc wallets need account review before continuing.",
      "wallet_conflict",
      409,
    );
  const wallet = wallets[0];
  if (!wallet) return row;
  if (row.wallet_id && row.wallet_id !== wallet.id)
    throw new ChainDuelError(
      "The saved Arc wallet association could not be verified.",
      "wallet_conflict",
      409,
    );
  if (wallet.state !== "LIVE")
    throw new ChainDuelError("Your Circle wallet is temporarily unavailable.", "wallet_unavailable", 503);
  const database = await arcDb();
  const config = arcConfig();
  await database.execute(
    `UPDATE arc_wallets SET wallet_id=?, address=?, status='ready', challenge_id=NULL, error=NULL, lease_until=NULL, updated_at=?
    WHERE user_id=? AND network_id=? AND app_id=?`,
    [
      wallet.id,
      wallet.address.toLowerCase(),
      new Date().toISOString(),
      userId,
      config.networkId,
      config.appId,
    ],
  );
  return associatedArcWallet(userId);
}
export async function provisionArcWallet(userId: string) {
  const config = assertEnabled();
  const database = await arcDb();
  const previousApp = await database.one<{ app_id: string }>(
    "SELECT app_id FROM arc_wallets WHERE user_id=? AND network_id=? AND wallet_id IS NOT NULL AND app_id<>?",
    [userId, config.networkId, config.appId],
  );
  if (previousApp)
    throw new ChainDuelError(
      "Your Arc wallet belongs to a different Circle application. Please contact support before changing the association.",
      "wallet_app_conflict",
      409,
    );
  const circleUserId = await ensureCircleUser(userId, config.appId);
  const now = new Date().toISOString();
  await database.execute(
    `INSERT INTO arc_wallets(user_id,network_id,app_id,circle_user_id,idempotency_key,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?) ON CONFLICT(user_id,network_id,app_id) DO NOTHING`,
    [userId, config.networkId, config.appId, circleUserId, randomUUID(), now, now],
  );
  let row = await reconcileArcWallet(userId);
  if (row?.status === "ready")
    return { wallet: row, credentials: null, challengeId: null, appId: config.appId };
  const credentials = await circleCredentials(circleUserId);
  if (row?.challenge_id) {
    const challenge = await circleClient().getUserChallenge({
      userToken: credentials.userToken,
      challengeId: row.challenge_id,
    });
    if (challenge.data?.challenge.status === "PENDING" || challenge.data?.challenge.status === "IN_PROGRESS")
      return { wallet: row, credentials, challengeId: row.challenge_id, appId: config.appId };
    row = await reconcileArcWallet(userId);
    if (row?.status === "ready")
      return { wallet: row, credentials: null, challengeId: null, appId: config.appId };
    if (challenge.data?.challenge.status === "COMPLETE")
      throw new ChainDuelError(
        "Circle is still making your wallet available. Please retry shortly.",
        "wallet_pending",
        409,
      );
    await database.execute(
      `UPDATE arc_wallets SET challenge_id=NULL,idempotency_key=?,status='pending' WHERE user_id=? AND network_id=? AND app_id=?`,
      [randomUUID(), userId, config.networkId, config.appId],
    );
  }
  const lease = new Date(Date.now() + 120_000).toISOString();
  const claimed = await database.run(
    `UPDATE arc_wallets SET lease_until=? WHERE user_id=? AND network_id=? AND app_id=?
    AND status <> 'ready' AND (lease_until IS NULL OR lease_until < ?)`,
    [lease, userId, config.networkId, config.appId, now],
  );
  if (!claimed)
    throw new ChainDuelError(
      "Arc wallet setup is already in progress. Please retry shortly.",
      "wallet_pending",
      409,
    );
  try {
    row = await associatedArcWallet(userId);
    if (!row) throw new Error("wallet record missing");
    const user = await circleClient().getUser({ userId: circleUserId });
    const params = {
      userToken: credentials.userToken,
      blockchains: [config.circle],
      accountType: "EOA" as const,
      idempotencyKey: row.idempotency_key,
    };
    const result =
      user.data?.user.pinStatus === "ENABLED"
        ? await circleClient().createWallet(params)
        : await circleClient().createUserPinWithWallets(params);
    const challengeId = result.data?.challengeId;
    if (!challengeId) throw new Error("challenge missing");
    await database.execute(
      `UPDATE arc_wallets SET challenge_id=?,status='awaiting_authorization',error=NULL,lease_until=NULL,updated_at=? WHERE user_id=? AND network_id=? AND app_id=?`,
      [challengeId, new Date().toISOString(), userId, config.networkId, config.appId],
    );
    return { wallet: await associatedArcWallet(userId), credentials, challengeId, appId: config.appId };
  } catch {
    await database.execute(
      `UPDATE arc_wallets SET status='failed',error=?,lease_until=NULL,updated_at=? WHERE user_id=? AND network_id=? AND app_id=?`,
      [
        "Circle wallet setup failed. Please retry.",
        new Date().toISOString(),
        userId,
        config.networkId,
        config.appId,
      ],
    );
    throw new ChainDuelError(
      "Circle wallet setup failed. Your account is intact; please retry.",
      "circle_provisioning_failed",
      502,
    );
  }
}
export async function recoverArcWallet(userId: string) {
  const config = assertEnabled();
  const wallet = await associatedArcWallet(userId);
  if (!wallet?.wallet_id)
    throw new ChainDuelError("Create your Arc wallet before using recovery.", "wallet_missing", 409);
  const credentials = await circleCredentials(wallet.circle_user_id);
  const challenge = await circleClient().restoreUserPin({
    userToken: credentials.userToken,
    idempotencyKey: randomUUID(),
  });
  return { credentials, challengeId: challenge.data?.challengeId, appId: config.appId };
}
