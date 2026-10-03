"use client";

import { StellarWalletsKit, Networks } from "@creit.tech/stellar-wallets-kit";
import { FreighterModule } from "@creit.tech/stellar-wallets-kit/modules/freighter";
import { xBullModule } from "@creit.tech/stellar-wallets-kit/modules/xbull";
import { AlbedoModule } from "@creit.tech/stellar-wallets-kit/modules/albedo";
import { LobstrModule } from "@creit.tech/stellar-wallets-kit/modules/lobstr";
import { RabetModule } from "@creit.tech/stellar-wallets-kit/modules/rabet";
import { publicStellarConfig } from "../config/stellar";

let initialised = false;

function networkEnum(): Networks {
  const config = publicStellarConfig();
  if (config.id === "mainnet") return Networks.PUBLIC;
  if (config.id === "futurenet") return Networks.FUTURENET;
  if (config.id === "local") return Networks.STANDALONE;
  return Networks.TESTNET;
}

export function initWalletKit(): void {
  if (initialised) return;
  StellarWalletsKit.init({
    modules: [
      new FreighterModule(),
      new xBullModule(),
      new AlbedoModule(),
      new LobstrModule(),
      new RabetModule(),
    ],
    network: networkEnum(),
    authModal: { showInstallLabel: true, hideUnsupportedWallets: false },
  });
  initialised = true;
}

export interface ConnectedWallet {
  address: string;
  networkPassphrase: string | null;
}

export async function connectWallet(): Promise<ConnectedWallet> {
  initWalletKit();
  const { address } = await StellarWalletsKit.authModal();
  if (!address) throw new Error("No wallet address was returned.");
  let networkPassphrase: string | null = null;
  try {
    const network = await StellarWalletsKit.getNetwork();
    networkPassphrase = network.networkPassphrase;
  } catch {
    networkPassphrase = null;
  }
  return { address, networkPassphrase };
}

export async function disconnectWallet(): Promise<void> {
  initWalletKit();
  try {
    await StellarWalletsKit.disconnect();
  } catch {
    // Some wallets have no disconnect surface; the local session ends anyway.
  }
}

export class WalletNetworkMismatch extends Error {
  constructor(
    message: string,
    readonly expected: string,
    readonly actual: string | null,
  ) {
    super(message);
    this.name = "WalletNetworkMismatch";
  }
}

export async function assertCorrectNetwork(): Promise<void> {
  initWalletKit();
  const expected = publicStellarConfig().networkPassphrase;
  try {
    const network = await StellarWalletsKit.getNetwork();
    if (network.networkPassphrase && network.networkPassphrase !== expected) {
      throw new WalletNetworkMismatch(
        `Your wallet is on a different network. Switch it to ${publicStellarConfig().label}.`,
        expected,
        network.networkPassphrase,
      );
    }
  } catch (error) {
    if (error instanceof WalletNetworkMismatch) throw error;
    // If the wallet cannot report its network, the transaction simulation and
    // submission will still fail loudly if it is wrong.
  }
}

export async function signTransactionXdr(xdr: string, address: string): Promise<string> {
  initWalletKit();
  await assertCorrectNetwork();
  const result = await StellarWalletsKit.signTransaction(xdr, {
    networkPassphrase: publicStellarConfig().networkPassphrase,
    address,
  });
  return result.signedTxXdr;
}

export async function signAuthMessage(message: string, address: string): Promise<string> {
  initWalletKit();
  const result = await StellarWalletsKit.signMessage(message, { address });
  if (!result.signedMessage) throw new Error("The wallet did not return a signature.");
  return result.signedMessage;
}

export function walletError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/denied|reject|cancel|declin/i.test(message)) return "You rejected the request in your wallet.";
  if (/insufficient|balance/i.test(message)) return "That wallet does not have enough XLM for this entry.";
  if (/not connected|no wallet|not installed/i.test(message)) {
    return "We could not reach a Stellar wallet. Install or unlock Freighter and try again.";
  }
  return message;
}
