import "server-only";
import type { Keypair } from "@stellar/stellar-sdk";
import { db } from "../db";
import { loadWalletKey, primaryWallet } from "../db/repositories/identity";
import { managedKeypair } from "../stellar/wallet";
import type { WalletRow } from "../db/types";
import { stellarNetwork } from "../config/stellar";
import { ChainDuelError } from "../services/errors";
import { playerControlledSigningEnabled } from "../config/stellar-verification";

export interface SignerHandle {
  wallet: WalletRow;
  address: string;
  custody: "external" | "managed";
  canSignServerSide: boolean;
  /** Present only for managed (embedded) wallets. Never leaves the server. */
  keypair: Keypair | null;
}

/** Resolves how (and whether) Chain Duel can sign for a user's wallet. */
export async function signerForUser(userId: string): Promise<SignerHandle | null> {
  const database = await db();
  const wallet = await primaryWallet(database, userId);
  if (!wallet) return null;

  if (wallet.custody !== "managed" || playerControlledSigningEnabled()) {
    return {
      wallet,
      address: wallet.address,
      custody: wallet.custody,
      canSignServerSide: false,
      keypair: null,
    };
  }

  const sealed = await loadWalletKey(database, wallet.id);
  if (!sealed) {
    return {
      wallet,
      address: wallet.address,
      custody: "managed",
      canSignServerSide: false,
      keypair: null,
    };
  }

  const keypair = managedKeypair({ ciphertext: sealed.ciphertext, iv: sealed.iv, authTag: sealed.auth_tag });
  if (stellarNetwork().id === "mainnet" && keypair.publicKey() !== wallet.address) throw new ChainDuelError("The managed wallet signer does not match its recorded address.", "wallet_key_mismatch", 503);
  return {
    wallet,
    address: wallet.address,
    custody: "managed",
    canSignServerSide: true,
    keypair,
  };
}
