import { StrKey } from "@stellar/stellar-sdk";
import { keccak256, type Hex } from "viem";
import { ARC_USDC } from "../networks/arc";
import {
  CCTP_ADDRESSES,
  evmRecipientBytes32,
  parseCctpMessage,
  stellarContractBytes32,
  stellarForwarderHook,
} from "./cctp";
import type { BridgeRow } from "./types";

export function validateBridgeMessage(transfer: BridgeRow, message: Hex, stellarUsdc: string) {
  const parsed = parseCctpMessage(message);
  const fromArc = transfer.source_network.startsWith("arc-");
  const addresses = CCTP_ADDRESSES[transfer.source_network.endsWith("testnet") ? "testnet" : "mainnet"];
  const sourceOwner: Hex = fromArc
    ? evmRecipientBytes32(transfer.source_address)
    : `0x${Buffer.from(StrKey.decodeEd25519PublicKey(transfer.source_address)).toString("hex")}`;
  const equal = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const expected = {
    sender: fromArc
      ? evmRecipientBytes32(addresses.arcMessenger)
      : stellarContractBytes32(addresses.stellarMessenger),
    recipient: fromArc
      ? stellarContractBytes32(addresses.stellarMessenger)
      : evmRecipientBytes32(addresses.arcMessenger),
    burnToken: fromArc ? evmRecipientBytes32(ARC_USDC) : stellarContractBytes32(stellarUsdc),
    mintRecipient: fromArc
      ? stellarContractBytes32(addresses.stellarForwarder)
      : evmRecipientBytes32(transfer.destination_address),
    destinationCaller: fromArc ? stellarContractBytes32(addresses.stellarForwarder) : `0x${"0".repeat(64)}`,
    hookData: fromArc ? stellarForwarderHook(transfer.destination_address) : "0x",
  };
  if (
    parsed.sourceDomain !== (fromArc ? 26 : 27) ||
    parsed.destinationDomain !== (fromArc ? 27 : 26) ||
    parsed.minFinalityThreshold !== 2000 ||
    parsed.finalityThresholdExecuted < 2000 ||
    parsed.amount !== BigInt(transfer.amount_units) ||
    parsed.maxFee !== BigInt(transfer.max_fee_units) ||
    parsed.feeExecuted > parsed.maxFee ||
    parsed.feeExecuted >= parsed.amount ||
    /^0x0+$/.test(parsed.nonce) ||
    !equal(parsed.messageSender, sourceOwner) ||
    Object.entries(expected).some(([key, value]) => !equal(parsed[key as keyof typeof expected], value))
  )
    throw new Error("The attested CCTP message differs from the approved transfer.");
  const hash = keccak256(message);
  if (transfer.message_hash && !equal(hash, transfer.message_hash))
    throw new Error("The saved bridge message cannot be replaced.");
  if (transfer.message_nonce && !equal(parsed.nonce, transfer.message_nonce))
    throw new Error("The saved bridge nonce cannot be replaced.");
  return { ...parsed, hash, receiveUnits: parsed.amount - parsed.feeExecuted };
}
