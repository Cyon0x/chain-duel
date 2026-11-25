"use client";

import { StrKey } from "@stellar/stellar-sdk";
import type { StellarNetworkId } from "../stellar/shared";
import { STELLAR_DEPLOYMENT_ADMIN } from "../stellar/shared";
import type { PublicStellarVault, StellarRecoveryEnvelope, VaultKind } from "./vault-types";

type Bytes = Uint8Array<ArrayBuffer>;

/** This object stays on the player's device. Never serialize it to an API. */
export interface ClientStellarSigner {
  walletAddress: string;
  signerAddress: string;
  publicKeyHex: string;
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  network: StellarNetworkId;
}
export interface CreatedStellarVault {
  signer: ClientStellarSigner;
  recoverySigner: ClientStellarSigner;
  publicVault: PublicStellarVault;
  /** Display/save only on the player's device; never send to a backend. */
  recoverySecret: string;
}

const encoder = new TextEncoder();
const hex = (bytes: Uint8Array) => Array.from(bytes,value => value.toString(16).padStart(2,"0")).join("");
const copy = (bytes: Uint8Array): Bytes => new Uint8Array(bytes);
function unhex(value: string, length?: number): Bytes {
  if (!/^(?:[0-9a-f]{2})+$/.test(value) || (length !== undefined && value.length !== length*2)) throw new Error("Invalid vault metadata.");
  return Uint8Array.from(value.match(/.{2}/g)!,pair => Number.parseInt(pair,16));
}
const random = (length: number): Bytes => crypto.getRandomValues(new Uint8Array(length));
function base64(bytes: Uint8Array): string {
  let binary=""; for (const value of bytes) binary+=String.fromCharCode(value); return btoa(binary);
}
function unbase64(value: string): Bytes {
  if (value.length > 4096 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error("Invalid encrypted vault backup.");
  return Uint8Array.from(atob(value),letter => letter.charCodeAt(0));
}

export function createRecoverySecret(): string {
  const value=hex(random(24));
  return `CDR1-${value.match(/.{6}/g)!.join("-")}`;
}
function recoveryBytes(secret: string): Bytes {
  const normalized=secret.trim().replace(/^CDR1-/i,"").replaceAll("-","").toLowerCase();
  if (!/^[0-9a-f]{48}$/.test(normalized)) throw new Error("Use the complete recovery code saved for this wallet.");
  return unhex(normalized,24);
}

function context(envelope: Pick<StellarRecoveryEnvelope,"walletAddress"|"signerAddress"|"publicKeyHex"|"network"|"kind">): Bytes {
  return encoder.encode(JSON.stringify({purpose:"ChainDuel Stellar vault recovery",version:1,walletAddress:envelope.walletAddress,signerAddress:envelope.signerAddress,publicKeyHex:envelope.publicKeyHex,network:envelope.network,kind:envelope.kind}));
}
async function wrappingKey(secret: string, salt: Bytes, info: Bytes): Promise<CryptoKey> {
  const material=recoveryBytes(secret);
  try {
    const input=await crypto.subtle.importKey("raw",material,"HKDF",false,["deriveKey"]);
    return await crypto.subtle.deriveKey({name:"HKDF",hash:"SHA-256",salt,info},input,{name:"AES-GCM",length:256},false,["encrypt","decrypt"]);
  } finally { material.fill(0); }
}

async function publicMaterial(key: CryptoKey) {
  const raw=new Uint8Array(await crypto.subtle.exportKey("raw",key));
  return {publicKeyHex:hex(raw),signerAddress:StrKey.encodeEd25519PublicKey(raw)};
}
async function signerFor(pair: CryptoKeyPair, walletAddress: string | null, network: StellarNetworkId): Promise<ClientStellarSigner> {
  const publicPart=await publicMaterial(pair.publicKey);
  return {...publicPart,walletAddress:walletAddress ?? publicPart.signerAddress,privateKey:pair.privateKey,publicKey:pair.publicKey,network};
}
async function encryptRecovery(pair: CryptoKeyPair, walletAddress: string, network: StellarNetworkId, kind: VaultKind, recoverySecret: string): Promise<{envelope: StellarRecoveryEnvelope; signer: ClientStellarSigner}> {
  const publicPart=await publicMaterial(pair.publicKey);
  const salt=random(16);const nonce=random(12);
  const publicContext={...publicPart,walletAddress,network,kind};
  const info=context(publicContext);
  const raw=new Uint8Array(await crypto.subtle.exportKey("pkcs8",pair.privateKey));
  try {
    const key=await wrappingKey(recoverySecret,salt,info);
    const encrypted=await crypto.subtle.encrypt({name:"AES-GCM",iv:nonce,additionalData:info,tagLength:128},key,raw);
    const privateKey=await crypto.subtle.importKey("pkcs8",raw,"Ed25519",false,["sign"]);
    return {envelope:{version:1,algorithm:"HKDF-SHA256/AES-256-GCM",...publicContext,saltHex:hex(salt),nonceHex:hex(nonce),ciphertextBase64:base64(new Uint8Array(encrypted))},signer:{...publicContext,privateKey,publicKey:pair.publicKey}};
  } finally { raw.fill(0); }
}

/** New social-login player wallets are created here, never by a game server. */
export async function createPrimaryStellarVault(network: StellarNetworkId): Promise<CreatedStellarVault> {
  const pair=await crypto.subtle.generateKey("Ed25519",true,["sign","verify"]) as CryptoKeyPair;
  const publicPart=await publicMaterial(pair.publicKey);
  const recoverySecret=createRecoverySecret();
  const {envelope,signer}=await encryptRecovery(pair,publicPart.signerAddress,network,"client-primary",recoverySecret);
  await recoverStellarVault(envelope,recoverySecret,{walletAddress:signer.walletAddress,network});
  return {signer,recoverySigner:signer,publicVault:{version:1,walletAddress:signer.walletAddress,deviceSignerAddress:signer.signerAddress,recoverySignerAddress:signer.signerAddress,network,kind:"client-primary",recoveryEnvelope:envelope},recoverySecret};
}

/** Preserve an existing G address. No account authority is changed by this call.
 * Irreversible migration is separately reviewed and requires confirmed keys. */
export async function createDelegatedStellarVault(walletAddress: string, network: StellarNetworkId): Promise<CreatedStellarVault> {
  if (!StrKey.isValidEd25519PublicKey(walletAddress)) throw new Error("Invalid existing Stellar wallet address.");
  if (walletAddress === STELLAR_DEPLOYMENT_ADMIN) throw new Error("The designated administrative wallet's signers must remain unchanged.");
  const device=await crypto.subtle.generateKey("Ed25519",false,["sign","verify"]) as CryptoKeyPair;
  const recovery=await crypto.subtle.generateKey("Ed25519",true,["sign","verify"]) as CryptoKeyPair;
  const recoverySecret=createRecoverySecret();
  const signer=await signerFor(device,walletAddress,network);
  const {envelope,signer:recoverySigner}=await encryptRecovery(recovery,walletAddress,network,"delegated-recovery",recoverySecret);
  await recoverStellarVault(envelope,recoverySecret,{walletAddress,network});
  return {signer,recoverySigner,publicVault:{version:1,walletAddress,deviceSignerAddress:signer.signerAddress,recoverySignerAddress:recoverySigner.signerAddress,network,kind:"delegated-recovery",recoveryEnvelope:envelope},recoverySecret};
}

export async function recoverStellarVault(envelope: StellarRecoveryEnvelope, secret: string, expected: {walletAddress: string; network: StellarNetworkId}): Promise<ClientStellarSigner> {
  if (envelope.version!==1 || envelope.algorithm!=="HKDF-SHA256/AES-256-GCM" || envelope.walletAddress!==expected.walletAddress || envelope.network!==expected.network || !["client-primary","delegated-recovery"].includes(envelope.kind)) throw new Error("This encrypted backup belongs to a different wallet or network.");
  if (!StrKey.isValidEd25519PublicKey(envelope.walletAddress) || !StrKey.isValidEd25519PublicKey(envelope.signerAddress) || StrKey.encodeEd25519PublicKey(unhex(envelope.publicKeyHex,32))!==envelope.signerAddress || (envelope.kind==="client-primary" && envelope.walletAddress!==envelope.signerAddress)) throw new Error("Invalid vault identity.");
  let raw: Bytes | null=null;
  try {
    const info=context(envelope);const key=await wrappingKey(secret,unhex(envelope.saltHex,16),info);
    raw=new Uint8Array(await crypto.subtle.decrypt({name:"AES-GCM",iv:unhex(envelope.nonceHex,12),additionalData:info,tagLength:128},key,unbase64(envelope.ciphertextBase64)));
    const privateKey=await crypto.subtle.importKey("pkcs8",raw,"Ed25519",false,["sign"]);
    const publicKey=await crypto.subtle.importKey("raw",unhex(envelope.publicKeyHex,32),"Ed25519",true,["verify"]);
    const proof=await crypto.subtle.sign("Ed25519",privateKey,info);
    if (!await crypto.subtle.verify("Ed25519",publicKey,proof,info)) throw new Error("Signer mismatch");
    return {walletAddress:envelope.walletAddress,signerAddress:envelope.signerAddress,publicKeyHex:envelope.publicKeyHex,network:envelope.network,privateKey,publicKey};
  } catch { throw new Error("The recovery code or encrypted backup could not be verified."); }
  finally { raw?.fill(0); }
}

export async function signWithClientVault(signer: ClientStellarSigner, bytes: Uint8Array): Promise<Bytes> {
  if (signer.privateKey.extractable || signer.privateKey.type!=="private" || signer.privateKey.algorithm.name!=="Ed25519") throw new Error("The local wallet signing key is not secured.");
  return new Uint8Array(await crypto.subtle.sign("Ed25519",signer.privateKey,copy(bytes)));
}

/** Gameplay credentials stay with the player and create no funded account. */
export async function createStellarInputKey(walletAddress: string, network: StellarNetworkId): Promise<ClientStellarSigner> {
  const pair=await crypto.subtle.generateKey("Ed25519",false,["sign","verify"]) as CryptoKeyPair;
  return signerFor(pair,walletAddress,network);
}
