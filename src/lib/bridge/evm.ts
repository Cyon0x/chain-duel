import "server-only";
import {
  decodeEventLog,
  encodeFunctionData,
  erc20Abi,
  isAddressEqual,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { ARC_MIN_MAX_FEE, ARC_USDC } from "../networks/arc";
import { arcConfig } from "../arc/config";
import { arcWalletFor } from "../arc/access";
import { verifiedArcClient } from "../arc/chain";
import { ChainDuelError } from "../services/errors";
import { CCTP_ADDRESSES, stellarContractBytes32, stellarForwarderHook } from "./cctp";
import { validateBridgeMessage } from "./validation";
import { stellarBridgeNetwork } from "./stellar";
import type { BridgePhase, BridgeRow } from "./types";

export const cctpEvmAbi = parseAbi([
  "function depositForBurnWithHook(uint256 amount,uint32 destinationDomain,bytes32 mintRecipient,address burnToken,bytes32 destinationCaller,uint256 maxFee,uint32 minFinalityThreshold,bytes hookData)",
  "function receiveMessage(bytes message,bytes attestation) returns (bool)",
  "function usedNonces(bytes32 nonce) view returns (uint256)",
  "event MessageReceived(address indexed caller,uint32 sourceDomain,bytes32 indexed nonce,bytes32 sender,uint32 indexed finalityThresholdExecuted,bytes messageBody)",
]);
export function arcBridgePayload(transfer: BridgeRow, phase: BridgePhase) {
  const addresses = CCTP_ADDRESSES[transfer.source_network.endsWith("testnet") ? "testnet" : "mainnet"];
  if (phase === "source_approval")
    return {
      target: ARC_USDC,
      calldata: encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [addresses.arcMessenger, BigInt(transfer.amount_units)],
      }),
    };
  if (phase === "source_burn") {
    const forwarder = stellarContractBytes32(addresses.stellarForwarder);
    return {
      target: addresses.arcMessenger,
      calldata: encodeFunctionData({
        abi: cctpEvmAbi,
        functionName: "depositForBurnWithHook",
        args: [
          BigInt(transfer.amount_units),
          27,
          forwarder,
          ARC_USDC,
          forwarder,
          BigInt(transfer.max_fee_units),
          2000,
          stellarForwarderHook(transfer.destination_address),
        ],
      }),
    };
  }
  if (phase !== "destination_mint" || !transfer.message || !transfer.attestation)
    throw new ChainDuelError("The Circle attestation is not ready.", "attestation_pending", 409);
  validateBridgeMessage(transfer, transfer.message, stellarBridgeNetwork().usdc);
  return {
    target: addresses.arcTransmitter,
    calldata: encodeFunctionData({
      abi: cctpEvmAbi,
      functionName: "receiveMessage",
      args: [transfer.message, transfer.attestation],
    }),
  };
}
export async function prepareArcBridgeStep(userId: string, transfer: BridgeRow, phase: BridgePhase) {
  const wallet = await arcWalletFor(userId);
  const client = await verifiedArcClient();
  const payload = arcBridgePayload(transfer, phase);
  const gas = await client.estimateGas({
    account: wallet.address as Address,
    to: payload.target,
    data: payload.calldata,
  });
  const fees = await client.estimateFeesPerGas();
  const maxFee = fees.maxFeePerGas > ARC_MIN_MAX_FEE ? fees.maxFeePerGas : ARC_MIN_MAX_FEE;
  const gasFee = ((gas * 120n) / 100n) * maxFee;
  const balance = await client.getBalance({
    address: wallet.address as Address,
  });
  const burnUnits = phase === "source_burn" ? BigInt(transfer.amount_units) * 1_000_000_000_000n : 0n;
  if (balance < gasFee + burnUnits)
    throw new ChainDuelError(
      "Fund this Arc wallet with USDC for the transfer and network fees before approving.",
      "bridge_gas_required",
      409,
    );
  return {
    ...payload,
    networkId: arcConfig().networkId,
    gasFee: gasFee.toString(),
  };
}
export async function verifyArcMintReference(hash: Hex, transfer: BridgeRow) {
  if (!transfer.message) return false;
  const parsed = validateBridgeMessage(transfer, transfer.message, stellarBridgeNetwork().usdc);
  const client = await verifiedArcClient();
  const receipt = await client.getTransactionReceipt({ hash });
  if (receipt.status !== "success") return false;
  const transaction = await client.getTransaction({ hash });
  const payload = arcBridgePayload(transfer, "destination_mint");
  if (
    !transaction.to ||
    !isAddressEqual(transaction.to, payload.target) ||
    transaction.input.toLowerCase() !== payload.calldata.toLowerCase()
  )
    return false;
  const nonce = await client.readContract({
    address: payload.target,
    abi: cctpEvmAbi,
    functionName: "usedNonces",
    args: [parsed.nonce],
  });
  const messageEvent = receipt.logs.some((log) => {
    if (!isAddressEqual(log.address, payload.target)) return false;
    try {
      const event = decodeEventLog({
        abi: cctpEvmAbi,
        data: log.data,
        topics: log.topics,
      });
      return (
        event.eventName === "MessageReceived" &&
        event.args.nonce === parsed.nonce &&
        event.args.sourceDomain === 27 &&
        event.args.sender.toLowerCase() === parsed.sender.toLowerCase() &&
        event.args.finalityThresholdExecuted >= 2000 &&
        event.args.messageBody.toLowerCase() === `0x${transfer.message!.slice(2 + 148 * 2)}`.toLowerCase()
      );
    } catch {
      return false;
    }
  });
  const mintEvent = receipt.logs.some((log) => {
    if (!isAddressEqual(log.address, ARC_USDC)) return false;
    try {
      const event = decodeEventLog({
        abi: erc20Abi,
        data: log.data,
        topics: log.topics,
      });
      return (
        event.eventName === "Transfer" &&
        /^0x0{40}$/i.test(event.args.from) &&
        isAddressEqual(event.args.to, transfer.destination_address as Address) &&
        event.args.value === parsed.receiveUnits
      );
    } catch {
      return false;
    }
  });
  return nonce === 1n && messageEvent && mintEvent;
}
