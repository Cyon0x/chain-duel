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

export const DEFAULT_TIMEOUT_SECONDS = 60;

/** How long a submitted contract call stays valid on the ledger. */
const SUBMIT_WINDOW_SECONDS = 180;
/** How long we wait for a submission to be included before giving up. */
const CONFIRM_TIMEOUT_MS = 90_000;
/** Delay before re-broadcasting a submission that has not been seen at all. */
const RESEND_AFTER_MS = 12_000;

let cachedServer: rpc.Server | null = null;

export function rpcServer(): rpc.Server {
  if (!cachedServer) {
    const net = stellarNetwork();
    cachedServer = new rpc.Server(net.rpcUrl, {
      allowHttp: net.rpcUrl.startsWith("http://"),
    });
  }
  return cachedServer;
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
    return Keypair.fromSecret(secret.trim());
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

function contractCall(method: string, args: xdr.ScVal[]) {
  const contract = new Contract(requireContractId());
  return contract.call(method, ...args);
}

/**
 * Builds and simulates a contract invocation whose source is `publicKey`.
 * The transaction is returned unsigned (XDR) for the wallet to sign.
 */
export async function prepareInvocation(input: {
  publicKey: string;
  method: string;
  args: xdr.ScVal[];
}): Promise<PreparedInvocation> {
  const server = rpcServer();
  const account = await server.getAccount(input.publicKey);
  const net = stellarNetwork();
  const transaction = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: net.networkPassphrase,
  })
    .addOperation(contractCall(input.method, input.args))
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
  const prepared = rpc.assembleTransaction(transaction, simulation).build();
  return {
    xdr: prepared.toXDR(),
    hash: Buffer.from(prepared.hash()).toString("hex"),
    method: input.method,
    contractId: requireContractId(),
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
  options: { timeoutMs?: number; resend?: () => Promise<void> } = {},
): Promise<SubmittedTransaction> {
  const server = rpcServer();
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

export async function submitSignedXdr(xdrBase64: string): Promise<SubmittedTransaction> {
  const server = rpcServer();
  const net = stellarNetwork();
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
  return pollForResult(sent.hash, { resend });
}

/**
 * Builds, simulates, authorises and submits a contract call with a local
 * keypair. This follows the SDK's documented multi-party-authorisation flow:
 * simulation supplies the authorisation entries, `authorizeEntry` signs them,
 * and the operation is rebuilt before a signed submission.
 */
export async function invokeWithKeypair(input: {
  keypair: Keypair;
  method: string;
  args: xdr.ScVal[];
}): Promise<SubmittedTransaction> {
  const server = rpcServer();
  const net = stellarNetwork();
  const account = await server.getAccount(input.keypair.publicKey());
  const transaction = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: net.networkPassphrase,
  })
    .addOperation(contractCall(input.method, input.args))
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

  const validUntil = (await server.getLatestLedger()).sequence + 200;
  const auth = await Promise.all(
    (simulation.result?.auth ?? []).map((entry) =>
      authorizeEntry(entry, input.keypair, validUntil, net.networkPassphrase),
    ),
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
  return submitSignedXdr(built.toXDR());
}

export async function invokeWithServerKey(input: {
  method: string;
  args: xdr.ScVal[];
  signer?: Keypair;
}): Promise<SubmittedTransaction> {
  return invokeWithKeypair({
    keypair: input.signer ?? settlementKeypair(),
    method: input.method,
    args: input.args,
  });
}

// ------------------------------------------------------------------- reads

export async function readContractState(method: string, args: xdr.ScVal[] = []): Promise<unknown> {
  const contract = new Contract(requireContractId());
  const server = rpcServer();
  const net = stellarNetwork();
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
    balances?: Array<{ asset_type: string; balance: string }>;
  };
  const native = payload.balances?.find((entry) => entry.asset_type === "native");
  return { address, xlm: native?.balance ?? "0", exists: true };
}

export async function fundWithFriendbot(address: string): Promise<boolean> {
  const net = stellarNetwork();
  if (!net.friendbotUrl) return false;
  const response = await fetch(`${net.friendbotUrl}/?addr=${encodeURIComponent(address)}`, {
    method: "GET",
  });
  return response.ok;
}

export async function latestLedger(): Promise<number> {
  const result = await rpcServer().getLatestLedger();
  return result.sequence;
}
