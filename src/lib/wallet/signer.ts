import "server-only";
import type { Keypair } from "@stellar/stellar-sdk";
import { db } from "../db";
import { loadWalletKey, primaryWallet } from "../db/repositories/identity";
import { managedKeypair } from "../stellar/wallet";
import type { WalletRow } from "../db/types";

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

  if (wallet.custody !== "managed") {
    return {
      wallet,
      address: wallet.address,
      custody: "external",
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

  return {
    wallet,
    address: wallet.address,
    custody: "managed",
    canSignServerSide: true,
    keypair: managedKeypair({
      ciphertext: sealed.ciphertext,
      iv: sealed.iv,
      authTag: sealed.auth_tag,
    }),
  };
}
