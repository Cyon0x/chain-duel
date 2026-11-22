import { StrKey } from "@stellar/stellar-sdk";
import { type Hex, pad, isAddress } from "viem";

export const CCTP_DOMAINS = { arc: 26, stellar: 27 } as const;
export const CCTP_ADDRESSES = {
  mainnet: {
    arcMessenger: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d",
    arcTransmitter: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64",
    stellarMessenger: "CAE2G5Z77UP7GYPYGFOWFGW7C7J6I4YP2AFGSADRKQY62SYUFLPNFTXL",
    stellarTransmitter: "CACMENFFJPJMSDAJQLX4R7K3SFZIW2LJSE3R2UMLGSWHFHS353FVXAZV",
    stellarForwarder: "CBZL2IH7F6BIDAA3WBNXYKIXSATJGMSW7K5P5MJ6STX5RXN47TZJDF5T",
  },
  testnet: {
    arcMessenger: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA",
    arcTransmitter: "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275",
    stellarMessenger: "CDNG7HXAPBWICI2E3AUBP3YZWZELJLYSB6F5CC7WLDTLTHVM74SLRTHP",
    stellarTransmitter: "CBJ6MTCKKZG73PMDZCJMSFRD7DQEMI4FKDH7CGDSV4W6FHCRBCQAVVJY",
    stellarForwarder: "CA66Q2WFBND6V4UEB7RD4SAXSVIWMD6RA4X3U32ELVFGXV5PJK4T4VSZ",
  },
} as const;
export function stellarContractBytes32(address: string): Hex {
  if (!StrKey.isValidContract(address)) throw new Error("Invalid Stellar CCTP contract.");
  return `0x${Buffer.from(StrKey.decodeContract(address)).toString("hex")}`;
}
export function evmRecipientBytes32(address: string): Hex {
  if (!isAddress(address)) throw new Error("Invalid Arc recipient.");
  return pad(address as Hex, { size: 32 });
}
export function stellarForwarderHook(address: string): Hex {
  if (
    !StrKey.isValidEd25519PublicKey(address) &&
    !StrKey.isValidContract(address) &&
    !StrKey.isValidMed25519PublicKey(address)
  )
    throw new Error("Invalid Stellar recipient.");
  const recipient = Buffer.from(address, "utf8");
  const hook = Buffer.alloc(32 + recipient.length);
  hook.writeUInt32BE(0, 24);
  hook.writeUInt32BE(recipient.length, 28);
  recipient.copy(hook, 32);
  return `0x${hook.toString("hex")}`;
}
export function stellarToCctpUnits(stroops: bigint): bigint {
  if (stroops < 0n || stroops % 10n !== 0n) throw new Error("USDC bridges require six-decimal precision.");
  return stroops / 10n;
}
export function cctpToStellarUnits(units: bigint): bigint {
  if (units < 0n) throw new Error("Invalid USDC amount.");
  return units * 10n;
}
export function parseCctpMessage(message: Hex) {
  if (!/^0x(?:[0-9a-fA-F]{2}){376,}$/.test(message)) throw new Error("Invalid CCTP V2 message.");
  const bytes = Buffer.from(message.slice(2), "hex");
  const hex = (start: number, length: number) =>
    `0x${bytes.subarray(start, start + length).toString("hex")}` as Hex;
  if (bytes.readUInt32BE(0) !== 1) throw new Error("Unsupported CCTP message version.");
  if (bytes.readUInt32BE(148) !== 1) throw new Error("Unsupported CCTP burn message version.");
  return {
    sourceDomain: bytes.readUInt32BE(4),
    destinationDomain: bytes.readUInt32BE(8),
    nonce: hex(12, 32),
    sender: hex(44, 32),
    recipient: hex(76, 32),
    destinationCaller: hex(108, 32),
    minFinalityThreshold: bytes.readUInt32BE(140),
    finalityThresholdExecuted: bytes.readUInt32BE(144),
    burnToken: hex(152, 32),
    mintRecipient: hex(184, 32),
    amount: BigInt(hex(216, 32)),
    messageSender: hex(248, 32),
    maxFee: BigInt(hex(280, 32)),
    feeExecuted: BigInt(hex(312, 32)),
    hookData: hex(376, bytes.length - 376),
  };
}
