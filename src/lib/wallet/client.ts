"use client";

import { publicStellarConfig } from "../config/stellar";

/**
 * The Stellar wallet kit (plus five wallet modules) is ~290 kB of JavaScript.
 * It is only ever needed once a player actually connects, signs or disconnects,
 * so it is loaded with a dynamic import instead of being shipped in the shared
 * layout bundle. Every entry point below awaits `loadWalletKit()`.
 */
type WalletKitModule = typeof import("@creit.tech/stellar-wallets-kit");

let kitPromise: Promise<WalletKitModule> | null = null;

function networkEnum(kit: WalletKitModule) {
  const { Networks } = kit;
  const config = publicStellarConfig();
  if (config.id === "mainnet") return Networks.PUBLIC;
  if (config.id === "futurenet") return Networks.FUTURENET;
  if (config.id === "local") return Networks.STANDALONE;
  return Networks.TESTNET;
}

export function loadWalletKit(): Promise<WalletKitModule> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("Wallets can only be used in the browser."));
  }
  if (!kitPromise) {
    kitPromise = (async () => {
      const [kit, freighter, xbull, albedo, lobstr, rabet] = await Promise.all([
        import("@creit.tech/stellar-wallets-kit"),
        import("@creit.tech/stellar-wallets-kit/modules/freighter"),
        import("@creit.tech/stellar-wallets-kit/modules/xbull"),
        import("@creit.tech/stellar-wallets-kit/modules/albedo"),
        import("@creit.tech/stellar-wallets-kit/modules/lobstr"),
        import("@creit.tech/stellar-wallets-kit/modules/rabet"),
      ]);
      kit.StellarWalletsKit.init({
        modules: [
          new freighter.FreighterModule(),
          new xbull.xBullModule(),
          new albedo.AlbedoModule(),
          new lobstr.LobstrModule(),
          new rabet.RabetModule(),
        ],
        network: networkEnum(kit),
        authModal: { showInstallLabel: true, hideUnsupportedWallets: false },
      });
      return kit;
    })().catch((error) => {
      // A failed chunk load must not poison every later attempt.
      kitPromise = null;
      throw error;
    });
  }
  return kitPromise;
}

export interface ConnectedWallet {
  address: string;
  networkPassphrase: string | null;
}

/** Wallets Chain Duel initialises in the kit, in the order we present them. */
export const SUPPORTED_WALLETS = [
  { id: "freighter", name: "Freighter", hint: "Browser extension" },
  { id: "xbull", name: "xBull", hint: "Extension or web" },
  { id: "albedo", name: "Albedo", hint: "Web wallet" },
  { id: "lobstr", name: "LOBSTR", hint: "Web or mobile" },
  { id: "rabet", name: "Rabet", hint: "Browser extension" },
] as const;

export interface WalletOption {
  id: string;
  name: string;
  hint: string;
  available: boolean;
  url: string | null;
}

/**
 * Reports which supported wallets this browser can actually reach. A wallet
 * that is not detectable is shown with an install link rather than a button
 * that would silently fail.
 */
export async function listWallets(): Promise<WalletOption[]> {
  const { StellarWalletsKit } = await loadWalletKit();
  let detected = new Map<string, { available: boolean; url: string | null }>();
  try {
    const supported = await StellarWalletsKit.refreshSupportedWallets();
    detected = new Map(
      supported.map((wallet) => [wallet.id, { available: wallet.isAvailable, url: wallet.url ?? null }]),
    );
  } catch {
    // If detection fails we still offer the wallets; the connection attempt
    // surfaces the wallet's own error rather than us inventing one.
  }
  return SUPPORTED_WALLETS.map((wallet) => {
    const found = detected.get(wallet.id);
    return {
      id: wallet.id,
      name: wallet.name,
      hint: wallet.hint,
      available: found ? found.available : detected.size === 0,
      url: found?.url ?? null,
    };
  });
}

export async function connectWallet(walletId?: string): Promise<ConnectedWallet> {
  const { StellarWalletsKit } = await loadWalletKit();
  let address: string | undefined;
  if (walletId) {
    // The player picked a specific provider, so open that wallet directly
    // instead of making them pick again inside the kit's own modal.
    StellarWalletsKit.setWallet(walletId);
    ({ address } = await StellarWalletsKit.fetchAddress());
  } else {
    ({ address } = await StellarWalletsKit.authModal());
  }
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
  const { StellarWalletsKit } = await loadWalletKit();
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

/**
 * A failure raised by our own sign-in verification (as opposed to the wallet
 * refusing to sign). Kept distinct so `walletError` does not mislabel a server
 * message that happens to contain the word "rejected" as a user cancellation.
 */
export class WalletSignInError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "WalletSignInError";
  }
}

export async function assertCorrectNetwork(): Promise<void> {
  const { StellarWalletsKit } = await loadWalletKit();
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
  const { StellarWalletsKit } = await loadWalletKit();
  await assertCorrectNetwork();
  const result = await StellarWalletsKit.signTransaction(xdr, {
    networkPassphrase: publicStellarConfig().networkPassphrase,
    address,
  });
  return result.signedTxXdr;
}

export interface SignedAuthMessage {
  signature: string;
  signerAddress: string | null;
}

export async function signAuthMessage(message: string, address: string): Promise<SignedAuthMessage> {
  const { StellarWalletsKit } = await loadWalletKit();
  const result = await StellarWalletsKit.signMessage(message, { address });
  if (!result.signedMessage) throw new Error("The wallet did not return a signature.");
  return { signature: result.signedMessage, signerAddress: result.signerAddress ?? null };
}

export function walletError(error: unknown): string {
  if (error instanceof WalletSignInError) return error.message;
  const message = error instanceof Error ? error.message : String(error);
  if (/denied|reject|cancel|declin/i.test(message)) return "You rejected the request in your wallet.";
  if (/insufficient|balance/i.test(message)) return "That wallet does not have enough XLM for this entry.";
  if (/not connected|no wallet|not installed/i.test(message)) {
    return "We could not reach a Stellar wallet. Install or unlock Freighter and try again.";
  }
  return message;
}
