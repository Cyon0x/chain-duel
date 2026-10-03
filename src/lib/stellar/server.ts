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
      | "invalid_input" = "simulation_failed",
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "StellarIntegrationError";
  }
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
    .setTimeout(DEFAULT_TIMEOUT_SECONDS)
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

async function pollForResult(hash: string, timeoutMs = 60_000): Promise<SubmittedTransaction> {
  const server = rpcServer();
  const deadline = Date.now() + timeoutMs;
  let last: rpc.Api.GetTransactionResponse | null = null;
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
  const sent = await server.sendTransaction(transaction);
  if (sent.status === "ERROR") {
    throw new StellarIntegrationError(
      `Stellar RPC rejected the transaction: ${JSON.stringify(sent.errorResult ?? sent.status)}`,
      "submit_failed",
      sent,
    );
  }
  if (sent.status === "DUPLICATE") {
    return pollForResult(sent.hash);
  }
  return pollForResult(sent.hash);
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
    .setTimeout(DEFAULT_TIMEOUT_SECONDS)
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

  const built = rpc
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
