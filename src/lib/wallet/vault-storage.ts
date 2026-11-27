"use client";
import type { StellarNetworkId } from "../stellar/shared";
import type { ClientStellarSigner } from "./vault-crypto";

const DATABASE = "chain-duel-player-signers-v1";
const STORE = "signers";
let opening: Promise<IDBDatabase> | null = null;
function database(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("This browser cannot store a secure player wallet. Use a supported external wallet."));
  if (!opening) opening = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => { request.result.onversionchange = () => { request.result.close(); opening = null; }; resolve(request.result); };
    request.onerror = () => reject(new Error("Your browser could not open the secure wallet store."));
    request.onblocked = () => reject(new Error("Close other Chain Duel tabs and retry wallet setup."));
  }).catch(error => { opening = null; throw error; });
  return opening;
}
export const walletSignerSlot = (address: string, network: StellarNetworkId) => `${network}:wallet:${address}`;
export const pulseSignerSlot = (contractId: string, gameIdHex: string, address: string, network: StellarNetworkId) => `${network}:pulse:${contractId}:${gameIdHex}:${address}`;
export async function saveClientSigner(slot: string, signer: ClientStellarSigner): Promise<void> {
  if (signer.privateKey.extractable || signer.privateKey.type !== "private") throw new Error("The player signing key must be nonextractable.");
  const store = await database();
  await new Promise<void>((resolve, reject) => {
    const transaction = store.transaction(STORE, "readwrite"); transaction.objectStore(STORE).put(signer, slot);
    transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(new Error("Your browser could not save the secured wallet. Keep your recovery backup.")); transaction.onabort = transaction.onerror;
  });
}
export async function loadClientSigner(slot: string): Promise<ClientStellarSigner | null> {
  const store = await database();
  return new Promise((resolve, reject) => {
    const request = store.transaction(STORE, "readonly").objectStore(STORE).get(slot);
    request.onsuccess = () => {
      const value = request.result as ClientStellarSigner | undefined;
      if (!value) return resolve(null);
      if (!value.privateKey || value.privateKey.extractable || value.privateKey.type !== "private" || value.privateKey.algorithm.name !== "Ed25519") return reject(new Error("The stored player signer is invalid. Restore your recovery backup."));
      resolve(value);
    };
    request.onerror = () => reject(new Error("The local player wallet could not be read."));
  });
}
