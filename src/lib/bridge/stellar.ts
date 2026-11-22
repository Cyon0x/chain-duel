import "server-only";
import {
  Address,
  Asset,
  Contract,
  Horizon,
  Networks,
  Operation,
  TransactionBuilder,
  rpc,
  xdr,
  nativeToScVal,
  FeeBumpTransaction,
  type Transaction,
} from "@stellar/stellar-sdk";
import { signerForUser } from "../wallet/signer";
import { ChainDuelError } from "../services/errors";
import { CCTP_ADDRESSES, cctpToStellarUnits, evmRecipientBytes32 } from "./cctp";
import { arcConfig } from "../arc/config";
import type { BridgeRow, BridgePhase } from "./types";
import { validateBridgeMessage } from "./validation";

export function stellarBridgeNetwork() {
  const testnet = arcConfig().testnet;
  const passphrase = testnet ? Networks.TESTNET : Networks.PUBLIC;
  const issuer = testnet
    ? "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"
    : "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
  const asset = new Asset("USDC", issuer);
  return {
    networkId: testnet ? ("stellar-testnet" as const) : ("stellar-mainnet" as const),
    name: testnet ? "Stellar Testnet" : "Stellar Mainnet",
    passphrase,
    issuer,
    asset,
    usdc: asset.contractId(passphrase),
    rpcUrl: testnet ? "https://soroban-testnet.stellar.org" : "https://mainnet.sorobanrpc.com",
    horizonUrl: testnet ? "https://horizon-testnet.stellar.org" : "https://horizon.stellar.org",
    cctp: CCTP_ADDRESSES[testnet ? "testnet" : "mainnet"],
  };
}
export async function bridgeStellarSigner(userId: string) {
  const signer = await signerForUser(userId);
  if (!signer?.keypair || signer.custody !== "managed" || signer.keypair.publicKey() !== signer.address)
    throw new ChainDuelError(
      "Your managed Stellar wallet could not be verified for this account.",
      "bridge_wallet_unavailable",
      409,
    );
  return signer;
}
export async function stellarBridgeInfo(userId: string) {
  const signer = await bridgeStellarSigner(userId);
  const network = stellarBridgeNetwork();
  const horizon = new Horizon.Server(network.horizonUrl);
  try {
    const account = await horizon.loadAccount(signer.address);
    const line = account.balances.find(
      (b) => "asset_code" in b && b.asset_code === "USDC" && b.asset_issuer === network.issuer,
    );
    const native = account.balances.find((b) => b.asset_type === "native");
    return {
      address: signer.address,
      networkId: network.networkId,
      networkName: network.name,
      accountExists: true,
      trustline: Boolean(line),
      balance: line?.balance ?? null,
      xlmBalance: native?.balance ?? null,
    };
  } catch (error) {
    if (
      (error as { response?: { status?: number } }).response?.status === 404 ||
      (error as { status?: number }).status === 404
    )
      return {
        address: signer.address,
        networkId: network.networkId,
        networkName: network.name,
        accountExists: false,
        trustline: false,
        balance: null,
        xlmBalance: null,
      };
    throw error;
  }
}
export async function stellarBridgeRpc() {
  const network = stellarBridgeNetwork();
  const server = new rpc.Server(network.rpcUrl);
  const info = await server.getNetwork();
  if (info.passphrase !== network.passphrase)
    throw new ChainDuelError(
      "The Stellar bridge connection has the wrong network.",
      "bridge_wrong_network",
      503,
    );
  return server;
}
export async function prepareStellarBridgeStep(userId: string, transfer: BridgeRow, phase: BridgePhase) {
  const signer = await bridgeStellarSigner(userId);
  const network = stellarBridgeNetwork();
  const server = await stellarBridgeRpc();
  const horizon = new Horizon.Server(network.horizonUrl);
  const account = await server.getAccount(signer.address);
  const fee = await horizon.fetchBaseFee();
  const builder = new TransactionBuilder(account, {
    fee: String(fee),
    networkPassphrase: network.passphrase,
  }).setTimeout(300);
  if (phase === "trustline") {
    const transaction = builder.addOperation(Operation.changeTrust({ asset: network.asset })).build();
    return {
      target: network.usdc,
      xdr: transaction.toXDR(),
      gasFee: transaction.fee,
    };
  }
  const amount = cctpToStellarUnits(BigInt(transfer.amount_units));
  const maxFee = cctpToStellarUnits(BigInt(transfer.max_fee_units));
  let target: string;
  let method: string;
  let args: xdr.ScVal[];
  if (phase === "source_approval") {
    target = network.usdc;
    method = "approve";
    const latest = await server.getLatestLedger();
    args = [
      new Address(signer.address).toScVal(),
      new Address(network.cctp.stellarMessenger).toScVal(),
      nativeToScVal(amount, { type: "i128" }),
      nativeToScVal(latest.sequence + 120, { type: "u32" }),
    ];
  } else if (phase === "source_burn") {
    target = network.cctp.stellarMessenger;
    method = "deposit_for_burn";
    args = [
      new Address(signer.address).toScVal(),
      nativeToScVal(amount, { type: "i128" }),
      nativeToScVal(26, { type: "u32" }),
      xdr.ScVal.scvBytes(Buffer.from(evmRecipientBytes32(transfer.destination_address).slice(2), "hex")),
      new Address(network.usdc).toScVal(),
      xdr.ScVal.scvBytes(Buffer.alloc(32)),
      nativeToScVal(maxFee, { type: "i128" }),
      nativeToScVal(2000, { type: "u32" }),
    ];
  } else {
    if (!transfer.message || !transfer.attestation)
      throw new ChainDuelError("The Circle attestation is not ready.", "attestation_pending", 409);
    target = network.cctp.stellarForwarder;
    method = "mint_and_forward";
    args = [
      xdr.ScVal.scvBytes(Buffer.from(transfer.message.slice(2), "hex")),
      xdr.ScVal.scvBytes(Buffer.from(transfer.attestation.slice(2), "hex")),
    ];
  }
  const transaction = builder.addOperation(new Contract(target).call(method, ...args)).build();
  const simulation = await server.simulateTransaction(transaction);
  if (rpc.Api.isSimulationError(simulation))
    throw new ChainDuelError(
      "Stellar could not prepare this bridge step. Check funding, trustline and allowance, then retry.",
      "bridge_simulation_failed",
      409,
    );
  const assembled = rpc.assembleTransaction(transaction, simulation).build();
  return { target, xdr: assembled.toXDR(), gasFee: assembled.fee };
}
export async function signStellarBridgePayload(userId: string, unsignedXdr: string) {
  const signer = await bridgeStellarSigner(userId);
  const tx = TransactionBuilder.fromXDR(unsignedXdr, stellarBridgeNetwork().passphrase) as Transaction;
  if (tx.source !== signer.address)
    throw new ChainDuelError(
      "The Stellar transaction owner differs from this account.",
      "bridge_owner_mismatch",
      403,
    );
  tx.sign(signer.keypair!);
  return { xdr: tx.toXDR(), hash: Buffer.from(tx.hash()).toString("hex") };
}
export async function submitStellarBridgePayload(signedXdr: string) {
  const server = await stellarBridgeRpc();
  const tx = TransactionBuilder.fromXDR(signedXdr, stellarBridgeNetwork().passphrase) as Transaction;
  return server.sendTransaction(tx);
}
export async function stellarBridgeReceipt(hash: string) {
  const server = await stellarBridgeRpc();
  const receipt = await server.getTransaction(hash);
  if (receipt.status === "SUCCESS") return { confirmed: true, failed: false };
  if (receipt.status === "FAILED") return { confirmed: false, failed: true };
  try {
    const history = await new Horizon.Server(stellarBridgeNetwork().horizonUrl)
      .transactions()
      .transaction(hash)
      .call();
    return { confirmed: history.successful, failed: !history.successful };
  } catch {
    return { confirmed: false, failed: false };
  }
}
export async function verifyStellarMintReference(hash: string, transfer: BridgeRow) {
  if (!transfer.message || !transfer.attestation) return false;
  validateBridgeMessage(transfer, transfer.message, stellarBridgeNetwork().usdc);
  const receipt = await (await stellarBridgeRpc()).getTransaction(hash);
  if (receipt.status !== "SUCCESS") return false;
  const decoded = TransactionBuilder.fromXDR(receipt.envelopeXdr, stellarBridgeNetwork().passphrase);
  const tx = decoded instanceof FeeBumpTransaction ? decoded.innerTransaction : decoded;
  const op = tx.operations[0];
  if (
    tx.operations.length !== 1 ||
    op.type !== "invokeHostFunction" ||
    op.func.type !== "hostFunctionTypeInvokeContract"
  )
    return false;
  const invocation = op.func.invokeContract;
  const expected = new Address(stellarBridgeNetwork().cctp.stellarForwarder).toScAddress();
  if (
    !Buffer.from(invocation.contractAddress.toXDR()).equals(Buffer.from(expected.toXDR())) ||
    invocation.functionName.toString() !== "mint_and_forward"
  )
    return false;
  return (
    invocation.args.length === 2 &&
    invocation.args.every(
      (arg, index) =>
        arg.type === "scvBytes" &&
        Buffer.from(arg.bytes.toBytes()).toString("hex") ===
          (index === 0 ? transfer.message : transfer.attestation)?.slice(2),
    )
  );
}
