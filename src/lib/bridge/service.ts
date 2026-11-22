import "server-only";
import { randomUUID } from "node:crypto";
import { erc20Abi, isAddressEqual, type Address, type Hex } from "viem";
import { arcDb } from "../arc/db";
import { arcWalletFor } from "../arc/access";
import { arcConfig } from "../arc/config";
import { circleClient, circleCredentials } from "../arc/circle";
import { verifiedArcClient, arcBalance } from "../arc/chain";
import { arcFeeBudget, requireArcFunds } from "../arc/fees";
import { ARC_USDC, parseUsdc, formatUsdc } from "../networks/arc";
import { ChainDuelError } from "../services/errors";
import { bridgeAvailability } from "./config";
import { cctpFeeQuote } from "./fees";
import { CCTP_ADDRESSES } from "./cctp";
import { validateBridgeMessage } from "./validation";
import { prepareArcBridgeStep, verifyArcMintReference } from "./evm";
import {
  bridgeStellarWallet,
  stellarBridgeInfo,
  stellarBridgeNetwork,
  prepareStellarBridgeStep,
  signStellarBridgePayload,
  submitStellarBridgePayload,
  stellarBridgeReceipt,
  verifyStellarMintReference,
} from "./stellar";
import type { BridgeRow, BridgeStep, BridgePhase } from "./types";

const now = () => new Date().toISOString();
function requireBridge(userId: string, amount?: bigint) {
  const availability = bridgeAvailability(userId);
  if (!availability.enabled) throw new ChainDuelError(availability.reason, "bridge_unavailable", 503);
  if (availability.maxAmountUsdc && amount !== undefined && amount > parseUsdc(availability.maxAmountUsdc))
    throw new ChainDuelError("Owner validation allows transfers up to 0.10 USDC.", "bridge_validation_limit", 422);
}
export async function loadBridge(userId: string, id: string) {
  const row = await (
    await arcDb()
  ).one<BridgeRow>("SELECT * FROM bridge_transfers WHERE id=? AND user_id=?", [id, userId]);
  if (!row) throw new ChainDuelError("That USDC transfer was not found.", "not_found", 404);
  const config = arcConfig();
  const stellar = stellarBridgeNetwork();
  const fromArc = row.source_network.startsWith("arc-");
  if (
    row.source_network !== (fromArc ? config.networkId : stellar.networkId) ||
    row.destination_network !== (fromArc ? stellar.networkId : config.networkId)
  )
    throw new ChainDuelError(
      "Switch to the transfer's original network environment to continue.",
      "bridge_wrong_network",
      409,
    );
  const wallet = await arcWalletFor(userId);
  const signer = await bridgeStellarWallet(userId);
  if (
    !isAddressEqual(
      (fromArc ? row.source_address : row.destination_address) as Address,
      wallet.address as Address,
    ) ||
    (fromArc ? row.destination_address : row.source_address) !== signer.address
  )
    throw new ChainDuelError(
      "The transfer's saved wallets differ from this account.",
      "bridge_owner_mismatch",
      403,
    );
  return row;
}
export async function quoteBridge(userId: string, source: "arc" | "stellar", amount: string) {
  const units = parseUsdc(amount);
  requireBridge(userId, units);
  if (units <= 0n) throw new ChainDuelError("Enter a positive USDC amount.", "invalid_amount", 400);
  const wallet = await arcWalletFor(userId);
  const stellar = await stellarBridgeInfo(userId);
  const balance = await arcBalance(wallet.address as Address);
  const config = arcConfig();
  const fee = await cctpFeeQuote(source === "arc" ? 26 : 27, units);
  if (fee.maxFee >= units)
    throw new ChainDuelError(
      "The quoted transfer fee must be smaller than the transfer.",
      "invalid_amount",
      400,
    );
  return {
    sourceNetwork: source === "arc" ? config.networkId : stellar.networkId,
    destinationNetwork: source === "arc" ? stellar.networkId : config.networkId,
    sourceAddress: source === "arc" ? wallet.address : stellar.address,
    destinationAddress: source === "arc" ? stellar.address : wallet.address,
    amountUnits: units.toString(),
    amount: formatUsdc(units),
    maxFeeUnits: fee.maxFee.toString(),
    maxFee: formatUsdc(fee.maxFee),
    minimumReceived: formatUsdc(units - fee.maxFee),
    feeBps: fee.bps,
    quotedAt: fee.quotedAt,
    availableBalance: source === "arc" ? balance.formatted : stellar.balance,
    stellar,
    gasNotice:
      "Each Arc step needs USDC for gas. Each Stellar step needs XLM. Network fees are estimated before each approval; this quote includes Circle's fee only.",
    finality:
      "Standard finality. Confirmation time varies; completion requires a verified destination transaction.",
  };
}
export async function createBridge(userId: string, source: "arc" | "stellar", amount: string, key: string) {
  requireBridge(userId, parseUsdc(amount));
  const database = await arcDb();
  const existing = await database.one<BridgeRow>(
    "SELECT * FROM bridge_transfers WHERE user_id=? AND idempotency_key=?",
    [userId, key],
  );
  if (existing) {
    if (
      existing.source_network.startsWith(source + "-") &&
      existing.amount_units === parseUsdc(amount).toString()
    )
      return loadBridge(userId, existing.id);
    throw new ChainDuelError(
      "This transfer request was already used with different details.",
      "bridge_conflict",
      409,
    );
  }
  const quote = await quoteBridge(userId, source, amount);
  const duplicate = await database.one<BridgeRow>(
    "SELECT * FROM bridge_transfers WHERE user_id=? AND source_network=? AND destination_network=? AND amount_units=? AND status NOT IN ('completed','failed')",
    [userId, quote.sourceNetwork, quote.destinationNetwork, quote.amountUnits],
  );
  if (duplicate) return loadBridge(userId, duplicate.id);
  const id = randomUUID();
  const timestamp = now();
  await database.execute(
    `INSERT INTO bridge_transfers(id,user_id,idempotency_key,source_network,destination_network,currency,amount_units,source_address,destination_address,max_fee_units,status,created_at,updated_at)
    VALUES(?,?,?,?,?,'USDC',?,?,?,?, 'awaiting_approval',?,?) ON CONFLICT DO NOTHING`,
    [
      id,
      userId,
      key,
      quote.sourceNetwork,
      quote.destinationNetwork,
      quote.amountUnits,
      quote.sourceAddress,
      quote.destinationAddress,
      quote.maxFeeUnits,
      timestamp,
      timestamp,
    ],
  );
  const row = await database.one<BridgeRow>(
    "SELECT * FROM bridge_transfers WHERE user_id=? AND source_network=? AND destination_network=? AND amount_units=? AND status NOT IN ('completed','failed') ORDER BY created_at DESC LIMIT 1",
    [userId, quote.sourceNetwork, quote.destinationNetwork, quote.amountUnits],
  );
  if (!row)
    throw new ChainDuelError("The transfer could not be saved. Please retry.", "bridge_conflict", 409);
  return row;
}
async function stepsFor(id: string) {
  return (await arcDb()).query<BridgeStep>(
    "SELECT * FROM bridge_steps WHERE bridge_id=? ORDER BY created_at",
    [id],
  );
}
async function updateTransfer(id: string, status: BridgeRow["status"], error: string | null = null) {
  await (
    await arcDb()
  ).execute(
    "UPDATE bridge_transfers SET status=?,error=?,updated_at=? WHERE id=? AND status <> 'completed'",
    [status, error, now(), id],
  );
}
async function failStep(step: BridgeStep, message: string) {
  await (
    await arcDb()
  ).execute("UPDATE bridge_steps SET status='failed',error=?,lease_until=NULL,updated_at=? WHERE id=?", [
    message,
    now(),
    step.id,
  ]);
  if (step.phase === "source_burn") await updateTransfer(step.bridge_id, "failed", message);
}
async function refreshStep(userId: string, transfer: BridgeRow, step: BridgeStep) {
  if (step.status === "confirmed" || step.status === "failed") return;
  const database = await arcDb();
  let hash = step.tx_hash;
  if (step.network_id.startsWith("arc-")) {
    if (!hash && step.challenge_id) {
      const wallet = await arcWalletFor(userId);
      const credentials = await circleCredentials(wallet.circle_user_id);
      const response = await circleClient().getUserChallenge({
        userToken: credentials.userToken,
        challengeId: step.challenge_id,
      });
      const challenge = response.data?.challenge;
      if (challenge?.status === "FAILED" || challenge?.status === "EXPIRED") {
        await failStep(step, "Circle authorization failed or expired. No transfer completion was recorded.");
        return;
      }
      if (challenge?.status !== "COMPLETE" || !challenge.correlationIds?.[0]) return;
      const result = await circleClient().getTransaction({
        userToken: credentials.userToken,
        id: challenge.correlationIds[0],
      });
      const transaction = result.data?.transaction;
      if (!transaction || transaction.walletId !== wallet.wallet_id)
        throw new ChainDuelError(
          "The Circle transaction owner could not be verified.",
          "bridge_owner_mismatch",
          502,
        );
      // A hash always takes precedence over an upstream failure label: check the actual receipt.
      hash = transaction.txHash ?? null;
      if (!hash && ["FAILED", "DENIED", "CANCELLED"].includes(transaction.state)) {
        await failStep(step, "Circle did not submit this step.");
        return;
      }
      await database.execute(
        "UPDATE bridge_steps SET circle_transaction_id=?,tx_hash=?,status='submitted',updated_at=? WHERE id=?",
        [transaction.id, hash, now(), step.id],
      );
      if (hash && step.phase === "source_burn")
        await database.execute(
          "UPDATE bridge_transfers SET source_tx_hash=?,status='submitted',updated_at=? WHERE id=?",
          [hash, now(), transfer.id],
        );
    }
    if (!hash) return;
    const client = await verifiedArcClient();
    let receipt;
    try {
      receipt = await client.getTransactionReceipt({ hash: hash as Hex });
    } catch (error) {
      if ((error as Error).name === "TransactionReceiptNotFoundError") return;
      throw error;
    }
    const wallet = await arcWalletFor(userId);
    const transaction = await client.getTransaction({ hash: hash as Hex });
    if (
      !transaction.to ||
      !isAddressEqual(transaction.from, wallet.address as Address) ||
      !isAddressEqual(transaction.to, step.target as Address) ||
      transaction.input.toLowerCase() !== step.calldata?.toLowerCase()
    )
      throw new ChainDuelError(
        "The Arc transaction differs from the authorized bridge step.",
        "bridge_transaction_invalid",
        502,
      );
    if (receipt.status !== "success") {
      await failStep(step, "The Arc step reverted. Its transaction reference is retained.");
      return;
    }
    if (step.phase === "destination_mint" && !(await verifyArcMintReference(hash as Hex, transfer)))
      throw new ChainDuelError(
        "The destination mint could not be verified.",
        "bridge_destination_unverified",
        502,
      );
  } else {
    if (!hash) return;
    const receipt = await stellarBridgeReceipt(hash);
    if (receipt.failed) {
      await failStep(step, "The Stellar step failed. Its transaction reference is retained.");
      return;
    }
    if (!receipt.confirmed) return;
    if (step.phase === "destination_mint" && !(await verifyStellarMintReference(hash, transfer)))
      throw new ChainDuelError(
        "The Stellar mint and forwarding could not be verified.",
        "bridge_destination_unverified",
        502,
      );
  }
  await database.execute(
    "UPDATE bridge_steps SET status='confirmed',error=NULL,lease_until=NULL,updated_at=? WHERE id=?",
    [now(), step.id],
  );
  if (step.phase === "source_burn") {
    await database.execute(
      "UPDATE bridge_transfers SET source_tx_hash=?,status='source_confirmed',error=NULL,updated_at=? WHERE id=? AND status<>'completed'",
      [hash, now(), transfer.id],
    );
  }
  if (step.phase === "destination_mint") {
    await database.execute(
      "UPDATE bridge_transfers SET destination_tx_hash=?,status='completed',error=NULL,updated_at=? WHERE id=?",
      [hash, now(), transfer.id],
    );
  }
}
async function fetchAttestation(transfer: BridgeRow) {
  if (!transfer.source_tx_hash) return;
  const source = transfer.source_network.startsWith("arc-") ? 26 : 27;
  const base = transfer.source_network.endsWith("testnet")
    ? "https://iris-api-sandbox.circle.com"
    : "https://iris-api.circle.com";
  const response = await fetch(
    `${base}/v2/messages/${source}?transactionHash=${encodeURIComponent(transfer.source_tx_hash)}`,
    { cache: "no-store", signal: AbortSignal.timeout(15_000) },
  );
  if (response.status === 404) return;
  if (!response.ok)
    throw new ChainDuelError(
      "Circle attestation is temporarily unavailable. The burn will not be repeated.",
      "attestation_unavailable",
      503,
    );
  const result = (await response.json()) as {
    messages?: { message?: Hex; attestation?: Hex; status?: string }[];
  };
  const messages = result.messages?.filter((m) => m.status === "complete") ?? [];
  if (messages.length === 0) return;
  // Our source transactions contain exactly one burn. Multiple messages are never selected heuristically.
  if (messages.length !== 1)
    throw new ChainDuelError(
      "Multiple source messages require transfer review.",
      "bridge_message_invalid",
      409,
    );
  const entry = messages[0];
  if (!entry.message || !entry.attestation || !/^0x(?:[0-9a-fA-F]{130})+$/.test(entry.attestation))
    throw new ChainDuelError("Circle returned an invalid attestation.", "bridge_message_invalid", 502);
  const parsed = validateBridgeMessage(transfer, entry.message, stellarBridgeNetwork().usdc);
  await (
    await arcDb()
  ).execute(
    "UPDATE bridge_transfers SET message=?,attestation=?,message_hash=?,message_nonce=?,error=NULL,updated_at=? WHERE id=? AND status<>'completed'",
    [entry.message, entry.attestation, parsed.hash, parsed.nonce, now(), transfer.id],
  );
}
export async function refreshBridge(userId: string, id: string) {
  let transfer = await loadBridge(userId, id);
  if (transfer.status === "completed" || transfer.status === "failed") return bridgeView(transfer);
  try {
    for (const step of await stepsFor(id)) await refreshStep(userId, transfer, step);
    transfer = await loadBridge(userId, id);
    if (transfer.status === "source_confirmed") {
      await updateTransfer(id, "attestation_pending");
      transfer = { ...transfer, status: "attestation_pending" };
    }
    if (
      ["attestation_pending", "recovery_required"].includes(transfer.status) &&
      transfer.source_tx_hash &&
      !transfer.message
    )
      await fetchAttestation(transfer);
  } catch (error) {
    await updateTransfer(
      id,
      "recovery_required",
      error instanceof ChainDuelError
        ? error.message
        : "The transfer requires verification. Refresh to recover; the source burn will not be repeated.",
    );
    throw error;
  }
  return bridgeView(await loadBridge(userId, id));
}
export async function bridgeView(transfer: BridgeRow) {
  const steps = await stepsFor(transfer.id);
  return {
    transfer,
    steps: steps.map(
      ({ id, phase, network_id, status, tx_hash, gas_fee_units, gas_symbol, gas_decimals, error }) => ({
        id,
        phase,
        network_id,
        status,
        tx_hash,
        gas_fee_units,
        gas_symbol,
        gas_decimals,
        error,
      }),
    ),
    nextPhase: await nextPhase(transfer, steps),
  };
}
async function nextPhase(transfer: BridgeRow, steps: BridgeStep[]): Promise<BridgePhase | null> {
  if (transfer.status === "completed" || transfer.status === "failed") return null;
  const burn = steps.find((s) => s.phase === "source_burn");
  if (burn && (burn.tx_hash || burn.challenge_id || burn.signed_xdr)) {
    if (burn.status !== "confirmed") return burn.status === "awaiting_approval" ? "source_burn" : null;
    return transfer.message && transfer.attestation ? "destination_mint" : null;
  }
  const stellar = await stellarBridgeInfo(transfer.user_id);
  if (!stellar.accountExists) return null;
  if (!stellar.trustline) return "trustline";
  return steps.find((s) => s.phase === "source_approval")?.status === "confirmed"
    ? "source_burn"
    : "source_approval";
}
export async function prepareBridgeStep(userId: string, id: string, phase: BridgePhase) {
  requireBridge(userId);
  await refreshBridge(userId, id);
  const transfer = await loadBridge(userId, id);
  requireBridge(userId, BigInt(transfer.amount_units));
  const database = await arcDb();
  const steps = await stepsFor(id);
  const expected = await nextPhase(transfer, steps);
  if (expected !== phase)
    throw new ChainDuelError(
      "Refresh the transfer and approve its next available step.",
      "bridge_state_invalid",
      409,
    );
  let step = steps.find((s) => s.phase === phase);
  if (step?.status === "failed") {
    if (phase === "source_burn")
      throw new ChainDuelError(
        "A failed source burn needs a new transfer request.",
        "bridge_recovery_required",
        409,
      );
    // Only refreshStep assigns 'failed', after a definitive wallet failure or failed chain receipt.
    // Uncertain signatures/submissions retain their original step and never reach this reset.
    const failed = step;
    await database.transaction(async (tx) => {
      await tx.execute(
        "INSERT INTO bridge_step_attempts(id,step_id,idempotency_key,snapshot,archived_at) VALUES(?,?,?,?,?) ON CONFLICT(idempotency_key) DO NOTHING",
        [randomUUID(), failed.id, failed.idempotency_key, JSON.stringify(failed), now()],
      );
      await tx.execute(
        "UPDATE bridge_steps SET signed_xdr=NULL,unsigned_xdr=NULL,tx_hash=NULL,challenge_id=NULL,circle_transaction_id=NULL,status='preparing',error=NULL,idempotency_key=? WHERE id=? AND status='failed'",
        [randomUUID(), failed.id],
      );
    });
    step = (await stepsFor(id)).find((s) => s.phase === phase);
  }
  if (step?.signed_xdr || step?.challenge_id || step?.tx_hash) return publicPrepared(step);
  if (phase === "source_burn") {
    const quote = await quoteBridge(
      userId,
      transfer.source_network.startsWith("arc-") ? "arc" : "stellar",
      formatUsdc(BigInt(transfer.amount_units)),
    );
    if (BigInt(quote.maxFeeUnits) > BigInt(transfer.max_fee_units))
      throw new ChainDuelError(
        "Circle's fee increased. Cancel this unsubmitted transfer and request a new quote.",
        "bridge_fee_changed",
        409,
      );
    const available = quote.availableBalance;
    const [whole, fraction = ""] = (available ?? "0").split(".");
    const availableUnits = BigInt(whole) * 1_000_000n + BigInt(fraction.slice(0, 6).padEnd(6, "0"));
    if (availableUnits < BigInt(transfer.amount_units))
      throw new ChainDuelError("The source wallet has insufficient USDC.", "bridge_balance_required", 409);
    if (transfer.source_network.startsWith("arc-")) {
      const client = await verifiedArcClient();
      const addresses = CCTP_ADDRESSES[arcConfig().testnet ? "testnet" : "mainnet"];
      const allowance = await client.readContract({
        address: ARC_USDC,
        abi: erc20Abi,
        functionName: "allowance",
        args: [transfer.source_address as Address, addresses.arcMessenger],
      });
      if (allowance < BigInt(transfer.amount_units))
        throw new ChainDuelError(
          "Approve the source USDC allowance before burning.",
          "bridge_allowance_required",
          409,
        );
    }
  }
  const network =
    phase === "trustline"
      ? stellarBridgeNetwork().networkId
      : phase === "destination_mint"
        ? transfer.destination_network
        : transfer.source_network;
  const payload = network.startsWith("arc-")
    ? await prepareArcBridgeStep(userId, transfer, phase)
    : await prepareStellarBridgeStep(userId, transfer, phase);
  const timestamp = now();
  await database.transaction(async (tx) => {
    const active = await tx.run(
      "UPDATE bridge_transfers SET updated_at=? WHERE id=? AND status NOT IN ('completed','failed')",
      [timestamp, id],
    );
    if (!active) throw new ChainDuelError("This transfer is no longer active.", "bridge_state_invalid", 409);
    await tx.execute(
      `INSERT INTO bridge_steps(id,bridge_id,phase,network_id,target,calldata,unsigned_xdr,status,idempotency_key,gas_fee_units,gas_symbol,gas_decimals,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,'awaiting_approval',?,?,?,?,?,?) ON CONFLICT(bridge_id,phase) DO UPDATE SET target=excluded.target,calldata=excluded.calldata,unsigned_xdr=excluded.unsigned_xdr,gas_fee_units=excluded.gas_fee_units,updated_at=excluded.updated_at WHERE bridge_steps.signed_xdr IS NULL AND bridge_steps.challenge_id IS NULL AND bridge_steps.tx_hash IS NULL`,
      [
        randomUUID(),
        id,
        phase,
        network,
        payload.target,
        "calldata" in payload ? payload.calldata : null,
        "xdr" in payload ? payload.xdr : null,
        randomUUID(),
        payload.gasFee,
        network.startsWith("arc-") ? "USDC" : "XLM",
        network.startsWith("arc-") ? 18 : 7,
        timestamp,
        timestamp,
      ],
    );
  });
  step = (await stepsFor(id)).find((s) => s.phase === phase);
  if (!step) throw new ChainDuelError("The bridge step could not be saved.", "bridge_step_failed", 502);
  return publicPrepared(step);
}
function publicPrepared(step: BridgeStep) {
  return {
    stepId: step.id,
    phase: step.phase,
    networkId: step.network_id,
    target: step.target,
    status: step.status,
    gasFeeUnits: step.gas_fee_units,
    gasSymbol: step.gas_symbol,
    gasDecimals: step.gas_decimals,
  };
}
export async function authorizeBridgeStep(userId: string, id: string, stepId: string) {
  requireBridge(userId);
  const transfer = await loadBridge(userId, id);
  requireBridge(userId, BigInt(transfer.amount_units));
  const database = await arcDb();
  const step = await database.one<BridgeStep>("SELECT * FROM bridge_steps WHERE id=? AND bridge_id=?", [
    stepId,
    id,
  ]);
  if (!step) throw new ChainDuelError("That bridge step was not found.", "not_found", 404);
  if (step.status === "confirmed") return { credentials: null, challengeId: null, appId: null };
  if (step.status === "failed" || transfer.status === "failed" || transfer.status === "completed")
    throw new ChainDuelError("This transfer cannot submit another transaction.", "bridge_state_invalid", 409);
  if (
    step.phase !== (await nextPhase(transfer, await stepsFor(id))) &&
    !step.signed_xdr &&
    !step.challenge_id
  )
    throw new ChainDuelError("The transfer is not ready for this step.", "bridge_state_invalid", 409);
  const claimed = await database.run(
    "UPDATE bridge_steps SET lease_until=? WHERE id=? AND (lease_until IS NULL OR lease_until<?)",
    [new Date(Date.now() + 120_000).toISOString(), step.id, now()],
  );
  if (!claimed)
    throw new ChainDuelError(
      "This step is already being prepared. Refresh shortly.",
      "bridge_step_pending",
      409,
    );
  try {
    if (step.network_id.startsWith("arc-")) {
      if (step.tx_hash)
        return {
          credentials: null,
          challengeId: null,
          appId: arcConfig().appId,
        };
      const wallet = await arcWalletFor(userId);
      const credentials = await circleCredentials(wallet.circle_user_id);
      let challengeId = step.challenge_id;
      if (!challengeId) {
        const client = await verifiedArcClient();
        const debitUnits = step.phase === "source_burn" ? BigInt(transfer.amount_units) : 0n;
        const balance = await client.getBalance({ address: wallet.address as Address });
        requireArcFunds(balance, debitUnits, 0n);
        const estimate = await circleClient().estimateContractExecutionFee({
          userToken: credentials.userToken,
          source: { walletId: wallet.wallet_id },
          contractAddress: step.target,
          callData: step.calldata!,
        });
        const budget = arcFeeBudget(estimate.data?.high);
        requireArcFunds(balance, debitUnits, budget.reserve);
        const result = await circleClient().createUserTransactionContractExecutionChallenge({
          userToken: credentials.userToken,
          walletId: wallet.wallet_id,
          contractAddress: step.target,
          callData: step.calldata!,
          idempotencyKey: step.idempotency_key,
          refId: step.id,
          fee: budget.fee,
        });
        challengeId = result.data?.challengeId ?? null;
        if (!challengeId) throw new Error("Missing Circle challenge.");
        await database.execute(
          "UPDATE bridge_steps SET challenge_id=?,status='awaiting_approval',updated_at=? WHERE id=?",
          [challengeId, now(), step.id],
        );
      }
      if (step.phase === "destination_mint") await updateTransfer(id, "destination_pending");
      return { credentials, challengeId, appId: arcConfig().appId };
    }
    let signed = step.signed_xdr;
    let hash = step.tx_hash;
    if (!signed) {
      if (!step.unsigned_xdr) throw new Error("Missing prepared Stellar transaction.");
      const payload = await signStellarBridgePayload(userId, step.unsigned_xdr);
      signed = payload.xdr;
      hash = payload.hash;
      // Persist the exact signed bytes and hash BEFORE sending. Retries always retransmit these bytes.
      await database.transaction(async (tx) => {
        await tx.execute(
          "UPDATE bridge_steps SET signed_xdr=?,tx_hash=?,status='submitted',updated_at=? WHERE id=?",
          [signed, hash, now(), step.id],
        );
        if (step.phase === "source_burn")
          await tx.execute(
            "UPDATE bridge_transfers SET source_tx_hash=?,status='submitted',updated_at=? WHERE id=?",
            [hash, now(), id],
          );
      });
    }
    if (step.phase === "destination_mint") await updateTransfer(id, "destination_pending");
    await submitStellarBridgePayload(signed);
    return {
      credentials: null,
      challengeId: null,
      appId: null,
      transactionHash: hash,
    };
  } finally {
    await database.execute("UPDATE bridge_steps SET lease_until=NULL WHERE id=?", [step.id]);
  }
}
export async function recoverBridgeDestination(userId: string, id: string, hash: string) {
  const transfer = await loadBridge(userId, id);
  if (!transfer.message || !transfer.attestation || !transfer.source_tx_hash)
    throw new ChainDuelError(
      "The source burn and attestation must be verified first.",
      "attestation_pending",
      409,
    );
  const verified = transfer.destination_network.startsWith("arc-")
    ? await verifyArcMintReference(hash as Hex, transfer)
    : await verifyStellarMintReference(hash.replace(/^0x/, ""), transfer);
  if (!verified)
    throw new ChainDuelError(
      "This transaction does not prove settlement of your transfer.",
      "bridge_destination_unverified",
      409,
    );
  await (
    await arcDb()
  ).execute(
    "UPDATE bridge_transfers SET destination_tx_hash=?,status='completed',error=NULL,updated_at=? WHERE id=?",
    [hash, now(), id],
  );
  return bridgeView(await loadBridge(userId, id));
}
export async function cancelBridge(userId: string, id: string) {
  await loadBridge(userId, id);
  const database = await arcDb();
  await database.transaction(async (tx) => {
    await tx.execute("UPDATE bridge_transfers SET updated_at=? WHERE id=?", [now(), id]);
    const transfer = await tx.one<BridgeRow>("SELECT * FROM bridge_transfers WHERE id=?", [id]);
    const burn = await tx.one<BridgeStep>(
      "SELECT * FROM bridge_steps WHERE bridge_id=? AND phase='source_burn'",
      [id],
    );
    if (transfer?.source_tx_hash || burn || transfer?.status === "completed")
      throw new ChainDuelError(
        "A prepared or authorized burn cannot be cancelled. Use transfer recovery.",
        "bridge_cannot_cancel",
        409,
      );
    await tx.execute("UPDATE bridge_transfers SET status='failed',error=?,updated_at=? WHERE id=?", [
      "Cancelled before source burn. Any token approval remains on-chain.",
      now(),
      id,
    ]);
  });
  return bridgeView(await loadBridge(userId, id));
}
