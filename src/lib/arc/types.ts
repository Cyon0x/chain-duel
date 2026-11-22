import type { ArcNetworkId } from "../networks/arc";

export interface ArcWalletRow {
  user_id: string;
  network_id: ArcNetworkId;
  app_id: string;
  circle_user_id: string;
  wallet_id: string | null;
  address: string | null;
  provider: string;
  status: "pending" | "awaiting_authorization" | "ready" | "failed";
  challenge_id: string | null;
  idempotency_key: string;
  lease_until: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}
export interface ArcGameRow {
  id: string;
  code: string;
  network_id: ArcNetworkId;
  currency: "USDC";
  token_address: string;
  token_decimals: 6;
  contract_address: string;
  contract_game_id: `0x${string}`;
  mode: "pvp" | "private" | "bot";
  game_type: "pulse";
  status: string;
  creator_id: string;
  invited_user_id: string | null;
  stake_units: string;
  seed: string;
  duration_ms: number;
  created_at: string;
  expires_at: string;
  started_at: string | null;
  settlement_status: string | null;
  winner_id: string | null;
  result_hash: string | null;
  settle_tx_hash: string | null;
  settled_at: string | null;
  create_block: string | null;
}
export interface ArcPlayerRow {
  game_id: string;
  seat: number;
  user_id: string | null;
  address: string;
  score: number | null;
  max_combo: number | null;
  funded: number;
  entry_tx_hash: string | null;
  result: string | null;
}
export interface ArcOperationRow {
  id: string;
  user_id: string;
  network_id: ArcNetworkId;
  game_id: string | null;
  action: string;
  wallet_id: string;
  target: `0x${string}`;
  calldata: `0x${string}`;
  amount_units: string;
  status: string;
  challenge_id: string | null;
  circle_transaction_id: string | null;
  tx_hash: string | null;
  idempotency_key: string;
  lease_until: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}
