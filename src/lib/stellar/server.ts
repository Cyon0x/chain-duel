import "server-only";
import {
  Address,
  BASE_FEE,
  Contract,
  FeeBumpTransaction,
  Keypair,
  Operation,
  Transaction,
  TransactionBuilder,
  authorizeEntry,
  rpc,
  scValToNative,
  xdr,
  nativeToScVal,
} from "@stellar/stellar-sdk";
import { contractId, stellarNetwork } from "../config/stellar";
import { rawEnv } from "../config/env";
import { playerControlledSigningEnabled, stellarVerificationEnabled } from "../config/stellar-verification";
import { STELLAR_DEPLOYMENT_ADMIN, STELLAR_MAINNET_USDC_ISSUER, STELLAR_TESTNET_USDC_ISSUER, type StellarNetworkId } from "./shared";
import { authorizationAddress, authorizeGameEntry } from "./authorization";
import { createHash } from "node:crypto";
import { executeStellarIntent } from "./intents";

export const DEFAULT_TIMEOUT_SECONDS = 60;

/** How long a submitted contract call stays valid on the ledger. */
const SUBMIT_WINDOW_SECONDS = 180;
/** How long we wait for a submission to be included before giving up. */
const CONFIRM_TIMEOUT_MS = 90_000;
/** Delay before re-broadcasting a submission that has not been seen at all. */
const RESEND_AFTER_MS = 12_000;

const cachedServers = new Map<string, rpc.Server>();
const checkedNetworks = new Map<string, Promise<void>>();

export function rpcServer(networkId?: StellarNetworkId): rpc.Server {
  const net = stellarNetwork(networkId);
  let server = cachedServers.get(net.rpcUrl);
  if (!server) {
    server = new rpc.Server(net.rpcUrl, {
      allowHttp: net.rpcUrl.startsWith("http://"),
      timeout: 20_000,
    });
    // SDK 17's fetch transport ignores the constructor's timeout option.
    // Configure the HTTP client so stalled reads cannot hold settlement open.
    server.httpClient.defaults.timeout = 20_000;
    cachedServers.set(net.rpcUrl, server);
  }
  return server;
}

async function checkRpcNetwork(networkId?: StellarNetworkId) {
  const net = stellarNetwork(networkId);
  if (net.id !== "mainnet") return;
  if (!checkedNetworks.has(net.rpcUrl)) checkedNetworks.set(net.rpcUrl, rpcServer(networkId).getNetwork().then(value => {
    if (value.passphrase !== net.networkPassphrase) throw new StellarIntegrationError("The Stellar RPC network does not match Mainnet.", "not_configured");
  }).catch(error => { checkedNetworks.delete(net.rpcUrl); throw error; }));
  await checkedNetworks.get(net.rpcUrl);
}

export class StellarIntegrationError extends Error {
  constructor(
    message: string,
    readonly code:
      | "not_configured"
      | "simulation_failed"
      | "submit_failed"
      | "timeout"
      | "failed_on_chain"
      | "invalid_input"
      | "balance_unavailable"
      | "source_not_funded"
      | "build_failed"
      | "insufficient_balance"
      | "no_friendbot"
      | "faucet_failed" = "simulation_failed",
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "StellarIntegrationError";
  }
}

/**
 * Re-stamps an assembled Soroban transaction with a fresh validity window.
 *
 * `assembleTransaction` clones the *pre*-simulation timebounds, which can be
 * nearly expired by the time simulation and auth signing finish — the network
 * then drops the submission without ever including it. Auth entries carry their
 * own ledger bound, so re-stamping the envelope keeps them valid.
 *
 * `cloneFrom` does not carry the Soroban extension across, so it is passed
 * explicitly (otherwise the result is rejected as tx_malformed). The fee is
 * left to `cloneFrom`, which strips the resource fee and re-derives the classic
 * per-operation fee.
 */
export function refreshTimebounds(
  transaction: Transaction,
  windowSeconds = SUBMIT_WINDOW_SECONDS,
): Transaction {
  return TransactionBuilder.cloneFrom(transaction, {
    networkPassphrase: transaction.networkPassphrase,
    sorobanData: sorobanDataOf(transaction),
    timebounds: { minTime: 0, maxTime: Math.floor(Date.now() / 1000) + windowSeconds },
  }).build();
}

/** The Soroban extension (footprint + resource fee) of an assembled transaction. */
function sorobanDataOf(transaction: Transaction): xdr.SorobanTransactionData {
  const envelope = transaction.toEnvelope();
  if (envelope.type === "envelopeTypeTx") {
    const ext = envelope.value.tx.ext;
    if (ext.type === "sorobanData") return ext.value;
  }
  throw new StellarIntegrationError(
    "Assembled transaction is missing its Soroban transaction data.",
    "simulation_failed",
  );
}

export function settlementKeypair(): Keypair {
  const env = rawEnv();
  const secret = env.SETTLEMENT_SECRET_KEY ?? env.TREASURY_SECRET_KEY;
  if (!secret) {
    throw new StellarIntegrationError(
      "No settlement signing key is configured on the server.",
      "not_configured",
    );
  }
  try {
    const key = Keypair.fromSecret(secret.trim());
    if ((stellarNetwork().id === "mainnet" || stellarVerificationEnabled()) && (key.publicKey() !== STELLAR_DEPLOYMENT_ADMIN || env.ADMIN_WALLET_ADDRESS !== STELLAR_DEPLOYMENT_ADMIN)) throw new Error("Wrong designated signer");
    return key;
  } catch {
    throw new StellarIntegrationError("The settlement signing key is not a valid Stellar secret key.", "not_configured");
  }
}

export function settlementPublicKey(): string | null {
  try {
    return settlementKeypair().publicKey();
  } catch {
    return null;
  }
}

export function requireContractId(): string {
  const id = contractId();
  if (!id) {
    throw new StellarIntegrationError(
      "Chain Duel escrow contract is not configured (CHAIN_DUEL_CONTRACT_ID).",
      "not_configured",
    );
  }
  return id;
}

// ------------------------------------------------------------- scVal helpers

export const scv = {
  address: (value: string) => new Address(value).toScVal(),
  i128: (value: number | bigint) => nativeToScVal(BigInt(value), { type: "i128" }),
  u32: (value: number) => nativeToScVal(value, { type: "u32" }),
  i64: (value: number | bigint) => nativeToScVal(BigInt(value), { type: "i64" }),
  bool: (value: boolean) => nativeToScVal(value, { type: "bool" }),
  bytes32: (hex: string) => nativeToScVal(Buffer.from(hex, "hex"), { type: "bytes" }),
  enumValue: (name: string) => xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(name)]),
};

export function decodeResult(value: unknown): unknown {
  if (!value) return null;
  try {
    return scValToNative(value as xdr.ScVal);
  } catch {
    return null;
  }
}

// -------------------------------------------------------------- tx lifecycle

export interface PreparedInvocation {
  xdr: string;
  hash: string;
  method: string;
  contractId: string;
}

function contractCall(method: string, args: xdr.ScVal[], escrowContractId?: string, networkId?: StellarNetworkId) {
  const id = escrowContractId ?? contractId(networkId);
  if (!id) throw new StellarIntegrationError("This network's escrow is not configured.", "not_configured");
  const contract = new Contract(id);
  return contract.call(method, ...args);
}

/**
 * Builds and simulates a contract invocation whose source is `publicKey`.
 * The transaction is returned unsigned (XDR) for the wallet to sign.
 */
export async function prepareInvocation(input: {
  networkId?: StellarNetworkId;
  escrowContractId?: string;
  publicKey: string;
  method: string;
  args: xdr.ScVal[];
}): Promise<PreparedInvocation> {
  await checkRpcNetwork(input.networkId);
  const server = rpcServer(input.networkId);
  const account = await server.getAccount(input.publicKey);
  const net = stellarNetwork(input.networkId);
  const transaction = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: net.networkPassphrase,
  })
    .addOperation(contractCall(input.method, input.args, input.escrowContractId, input.networkId))
    .setTimeout(SUBMIT_WINDOW_SECONDS)
    .build();

  const simulation = await server.simulateTransaction(transaction);
  if (rpc.Api.isSimulationError(simulation)) {
    throw new StellarIntegrationError(
      `Contract simulation failed for ${input.method}: ${simulation.error}`,
      "simulation_failed",
      simulation,
    );
  }
  let builder = rpc.assembleTransaction(transaction, simulation);
  if ((net.id === "mainnet" || stellarVerificationEnabled(net.id)) && ["create_game", "join_game"].includes(input.method)) {
    const target = input.escrowContractId ?? requireContractId();
    if (target !== contractId(net.id)) throw new StellarIntegrationError("Unapproved Stellar escrow.", "not_configured");
    const invoke = transaction.operations[0];
    if (invoke.type !== "invokeHostFunction") throw new StellarIntegrationError("Invalid game invocation.", "simulation_failed");
    const validUntil = await latestLedger(input.networkId) + 200;
    const auth = await Promise.all((simulation.result?.auth ?? []).map(entry => authorizeGameEntry(entry, settlementKeypair(), target, input.method, input.args, validUntil, net.networkPassphrase)));
    builder = builder.clearOperations().addOperation(Operation.invokeHostFunction({ source: invoke.source, func: invoke.func, auth }));
  }
  const prepared = builder.build();
  return {
    xdr: prepared.toXDR(),
    hash: Buffer.from(prepared.hash()).toString("hex"),
    method: input.method,
    contractId: input.escrowContractId ?? requireContractId(),
  };
}

export interface SubmittedTransaction {
  hash: string;
  ledger: number | null;
  returnValue: unknown;
  status: "SUCCESS";
}

async function pollForResult(
  hash: string,
  options: { timeoutMs?: number; resend?: () => Promise<void>; networkId?: StellarNetworkId } = {},
): Promise<SubmittedTransaction> {
  const server = rpcServer(options.networkId);
  const deadline = Date.now() + (options.timeoutMs ?? CONFIRM_TIMEOUT_MS);
  let last: rpc.Api.GetTransactionResponse | null = null;
  let lastResend = Date.now();
  while (Date.now() < deadline) {
    const result = await server.getTransaction(hash);
    last = result;
    if (result.status === "SUCCESS") {
      return {
        hash: result.txHash,
        ledger: result.ledger,
        returnValue: decodeResult((result as { returnValue?: unknown }).returnValue),
        status: "SUCCESS",
      };
    }
    if (result.status === "FAILED") {
      throw new StellarIntegrationError(
        `Transaction ${hash} failed on chain.`,
        "failed_on_chain",
        result,
      );
    }
    // NOT_FOUND means the transaction never reached a ledger. Testnet RPC
    // occasionally drops a queued submission, so re-broadcast the identical
    // signed envelope: the hash is unchanged, so this can never execute twice.
    if (options.resend && Date.now() - lastResend > RESEND_AFTER_MS) {
      lastResend = Date.now();
      await options.resend().catch(() => undefined);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_200));
  }
  throw new StellarIntegrationError(
    `Timed out waiting for transaction ${hash} to confirm.`,
    "timeout",
    last,
  );
}

export async function submitSignedXdr(xdrBase64: string, networkId?: StellarNetworkId): Promise<SubmittedTransaction> {
  await checkRpcNetwork(networkId);
  const server = rpcServer(networkId);
  const net = stellarNetwork(networkId);
  const transaction = TransactionBuilder.fromXDR(xdrBase64, net.networkPassphrase) as
    | Transaction
    | FeeBumpTransaction;
  const resend = async () => {
    const retry = TransactionBuilder.fromXDR(xdrBase64, net.networkPassphrase) as
      | Transaction
      | FeeBumpTransaction;
    await server.sendTransaction(retry);
  };
  const sent = await server.sendTransaction(transaction);
  if (sent.status === "ERROR") {
    throw new StellarIntegrationError(
      `Stellar RPC rejected the transaction: ${JSON.stringify(sent.errorResult ?? sent.status)}`,
      "submit_failed",
      sent,
    );
  }
  return pollForResult(sent.hash, { resend, networkId });
}

/**
 * Builds, simulates, authorises and submits a contract call with a local
 * keypair. This follows the SDK's documented multi-party-authorisation flow:
 * simulation supplies the authorisation entries, `authorizeEntry` signs them,
 * and the operation is rebuilt before a signed submission.
 */
interface KeypairInvocation {
  networkId?: StellarNetworkId;
  intentId?: string;
  escrowContractId?: string;
  keypair: Keypair;
  method: string;
  args: xdr.ScVal[];
}

async function prepareKeypairInvocation(input: KeypairInvocation): Promise<string> {
  await checkRpcNetwork(input.networkId);
  const server = rpcServer(input.networkId);
  const net = stellarNetwork(input.networkId);
  const account = await server.getAccount(input.keypair.publicKey());
  const transaction = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: net.networkPassphrase,
  })
    .addOperation(contractCall(input.method, input.args, input.escrowContractId, input.networkId))
    .setTimeout(SUBMIT_WINDOW_SECONDS)
    .build();

  const simulation = await server.simulateTransaction(transaction);
  if (rpc.Api.isSimulationError(simulation)) {
    throw new StellarIntegrationError(
      `Contract simulation failed for ${input.method}: ${simulation.error}`,
      "simulation_failed",
      simulation,
    );
  }

  const invoke = transaction.operations[0];
  if (invoke.type !== "invokeHostFunction") {
    throw new StellarIntegrationError(
      `Contract call for ${input.method} did not produce an invokeHostFunction operation`,
      "simulation_failed",
    );
  }

  const validUntil = (await latestLedger(input.networkId)) + 200;
  const auth = await Promise.all(
    (simulation.result?.auth ?? []).map(async entry => {
      const address = authorizationAddress(entry);
      if (net.id === "mainnet" && address === STELLAR_DEPLOYMENT_ADMIN && address !== input.keypair.publicKey()) {
        const target = input.escrowContractId ?? requireContractId();
        if (target !== contractId("mainnet")) throw new StellarIntegrationError("Unapproved Mainnet escrow.", "not_configured");
        return authorizeGameEntry(entry, settlementKeypair(), target, input.method, input.args, validUntil, net.networkPassphrase);
      }
      if (address && address !== input.keypair.publicKey()) throw new StellarIntegrationError("Unexpected transaction authority.", "simulation_failed");
      return authorizeEntry(entry, input.keypair, validUntil, net.networkPassphrase, address ?? undefined);
    }),
  );

  const assembled = rpc
    .assembleTransaction(transaction, simulation)
    .clearOperations()
    .addOperation(
      Operation.invokeHostFunction({
        source: invoke.source,
        func: invoke.func,
        auth,
      }),
    )
    .build();

  const built = refreshTimebounds(assembled);
  built.sign(input.keypair);
  return built.toXDR();
}

export async function transactionReceipt(hash: string, networkId?: StellarNetworkId): Promise<SubmittedTransaction | "FAILED" | null> {
  const result = await rpcServer(networkId).getTransaction(hash);
  if (result.status === "FAILED") return "FAILED";
  if (result.status !== "SUCCESS") {
    const history = await fetch(`${stellarNetwork(networkId).horizonUrl}/transactions/${hash}`, { cache: "no-store", signal: AbortSignal.timeout(15000) });
    if (history.status === 404) return null;
    if (!history.ok) throw new StellarIntegrationError("The saved transaction receipt is temporarily unavailable.", "submit_failed");
    const receipt = await history.json() as { hash: string; successful: boolean; ledger: number };
    if (receipt.hash !== hash) throw new StellarIntegrationError("The saved transaction receipt does not match its hash.", "failed_on_chain");
    return receipt.successful ? { hash, ledger: receipt.ledger, returnValue: null, status: "SUCCESS" } : "FAILED";
  }
  return { hash: result.txHash, ledger: result.ledger, returnValue: decodeResult(result.returnValue), status: "SUCCESS" };
}

export async function invokeWithKeypair(input: KeypairInvocation): Promise<SubmittedTransaction> {
  if (playerControlledSigningEnabled() && input.keypair.publicKey() !== STELLAR_DEPLOYMENT_ADMIN) throw new StellarIntegrationError("The backend cannot sign with player wallet keys.", "invalid_input");
  const net = stellarNetwork(input.networkId);
  if (net.id !== "mainnet" && !stellarVerificationEnabled(net.id)) return submitSignedXdr(await prepareKeypairInvocation(input), input.networkId);
  const target = input.escrowContractId ?? requireContractId();
  const argsHash = createHash("sha256").update(input.args.map(arg => Buffer.from(arg.toXdr()).toString("hex")).join(":" )).digest("hex");
  const id = input.intentId ?? createHash("sha256").update(`${net.id}:${input.keypair.publicKey()}:${target}:${input.method}:${argsHash}`).digest("hex");
  return executeStellarIntent({
    id, networkId: net.id, address: input.keypair.publicKey(), contractId: target, method: input.method, argsHash,
    prepare: () => prepareKeypairInvocation(input), submit: signed => submitSignedXdr(signed, net.id),
    receipt: hash => transactionReceipt(hash, net.id),
  });
}

export async function invokeWithServerKey(input: {
  networkId?: StellarNetworkId;
  intentId?: string;
  escrowContractId?: string;
  method: string;
  args: xdr.ScVal[];
  signer?: Keypair;
}): Promise<SubmittedTransaction> {
  const keypair = input.signer ?? settlementKeypair();
  if (stellarNetwork(input.networkId).id === "mainnet" && keypair.publicKey() !== STELLAR_DEPLOYMENT_ADMIN) throw new StellarIntegrationError("Wrong Mainnet administrator.", "not_configured");
  return invokeWithKeypair({
    networkId: input.networkId,
    intentId: input.intentId,
    keypair,
    method: input.method,
    args: input.args,
    escrowContractId: input.escrowContractId,
  });
}

// ------------------------------------------------------------------- reads

export async function readContractState(method: string, args: xdr.ScVal[] = [], escrowContractId?: string, networkId?: StellarNetworkId): Promise<unknown> {
  const contract = new Contract(escrowContractId ?? requireContractId());
  await checkRpcNetwork(networkId);
  const server = rpcServer(networkId);
  const net = stellarNetwork(networkId);
  const source = settlementPublicKey() ?? rawEnv().ADMIN_WALLET_ADDRESS ?? null;
  if (!source) {
    throw new StellarIntegrationError(
      "Reading contract state requires a settlement key or ADMIN_WALLET_ADDRESS to simulate with.",
      "not_configured",
    );
  }
  const operation = contract.call(method, ...args);
  const account = await server.getAccount(source);
  const transaction = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: net.networkPassphrase,
  })
    .addOperation(operation)
    .setTimeout(DEFAULT_TIMEOUT_SECONDS)
    .build();
  const simulation = await server.simulateTransaction(transaction);
  if (rpc.Api.isSimulationError(simulation)) {
    throw new StellarIntegrationError(
      `Simulation failed for ${method}: ${simulation.error}`,
      "simulation_failed",
      simulation,
    );
  }
  return decodeResult((simulation as { result?: { retval?: unknown } }).result?.retval);
}

export interface AccountBalance {
  address: string;
  xlm: string;
  exists: boolean;
  usdc?: string;
  usdcTrustline?: boolean;
}

export async function getAccountBalance(address: string): Promise<AccountBalance> {
  const net = stellarNetwork();
  const response = await fetch(`${net.horizonUrl}/accounts/${address}`, {
    headers: { accept: "application/json" },
    cache: "no-store",
  });
  if (response.status === 404) {
    return { address, xlm: "0", exists: false };
  }
  if (!response.ok) {
    throw new StellarIntegrationError(
      `Horizon balance lookup failed with status ${response.status}`,
      "submit_failed",
    );
  }
  const payload = (await response.json()) as {
    balances?: Array<{ asset_type: string; balance: string; asset_code?: string; asset_issuer?: string }>;
  };
  const native = payload.balances?.find((entry) => entry.asset_type === "native");
  const usdc = payload.balances?.find(entry => entry.asset_code === "USDC" && entry.asset_issuer === (net.id === "mainnet" ? STELLAR_MAINNET_USDC_ISSUER : STELLAR_TESTNET_USDC_ISSUER));
  return { address, xlm: native?.balance ?? "0", exists: true, usdc: usdc?.balance ?? "0", usdcTrustline: Boolean(usdc) };
}

export async function fundWithFriendbot(address: string): Promise<boolean> {
  const net = stellarNetwork();
  if (!net.friendbotUrl) return false;
  const response = await fetch(`${net.friendbotUrl}/?addr=${encodeURIComponent(address)}`, {
    method: "GET",
  });
  return response.ok;
}

export async function latestLedger(networkId?: StellarNetworkId): Promise<number> {
  // We need only the sequence for expiry/auth. SDK 17.2 eagerly decodes the
  // entire ledger header, whose new Testnet SCP extension is not supported by
  // its XDR schema. The RPC's numeric sequence is independent of that header.
  const response = await fetch(stellarNetwork(networkId).rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "chain-duel-ledger", method: "getLatestLedger" }),
    signal: AbortSignal.timeout(15_000),
    cache: "no-store",
  });
  if (!response.ok) throw new StellarIntegrationError("Could not read the current Stellar ledger.", "simulation_failed");
  const payload = await response.json() as { result?: { sequence?: number }; error?: unknown };
  const sequence = payload.result?.sequence;
  if (payload.error || !Number.isSafeInteger(sequence) || !sequence || sequence < 1) {
    throw new StellarIntegrationError("Stellar RPC returned an invalid ledger sequence.", "simulation_failed");
  }
  return sequence;
}
