import type { Hex } from "viem";
import type { BridgeStatus } from "./status";
export type BridgeNetwork = "stellar-mainnet" | "stellar-testnet" | "arc-mainnet" | "arc-testnet";
export type BridgePhase = "trustline" | "source_approval" | "source_burn" | "destination_mint";
export interface BridgeRow {
  id: string;
  user_id: string;
  idempotency_key: string;
  source_network: BridgeNetwork;
  destination_network: BridgeNetwork;
  currency: "USDC";
  amount_units: string;
  source_address: string;
  destination_address: string;
  max_fee_units: string;
  status: BridgeStatus;
  source_tx_hash: string | null;
  message_hash: string | null;
  message_nonce: string | null;
  destination_tx_hash: string | null;
  message: Hex | null;
  attestation: Hex | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}
export interface BridgeStep {
  id: string;
  bridge_id: string;
  phase: BridgePhase;
  network_id: BridgeNetwork;
  target: string;
  calldata: Hex | null;
  unsigned_xdr: string | null;
  signed_xdr: string | null;
  status: string;
  challenge_id: string | null;
  circle_transaction_id: string | null;
  tx_hash: string | null;
  idempotency_key: string;
  lease_until: string | null;
  gas_fee_units: string | null;
  gas_symbol: string | null;
  gas_decimals: number | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}
