import { describe, expect, it } from "vitest";
import { StrKey } from "@stellar/stellar-sdk";
import { createDelegatedStellarVault, createPrimaryStellarVault, createRecoverySecret, createStellarInputKey, recoverStellarVault, signWithClientVault } from "@/lib/wallet/vault-crypto";
import { STELLAR_DEPLOYMENT_ADMIN } from "@/lib/stellar/shared";

const player="GBGDTBOXVZ4GIDDRISY5FGXYY7XCWCCK3FRHJHSVFEZMWA3ZZ2HUALTK";
const proof=new TextEncoder().encode("player-controlled signing verification; no network transaction");

describe("player-controlled Stellar vaults",()=>{
  it("creates new player keys locally with a nonextractable signer and an encrypted public backup",async()=>{
    const vault=await createPrimaryStellarVault("testnet");
    expect(StrKey.isValidEd25519PublicKey(vault.signer.walletAddress)).toBe(true);
    expect(vault.signer.walletAddress).toBe(vault.signer.signerAddress);
    expect(vault.signer.privateKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("pkcs8",vault.signer.privateKey)).rejects.toThrow();
    const json=JSON.stringify(vault.publicVault);
    expect(json).not.toContain(vault.recoverySecret);
    expect(json).not.toContain("privateKey");
    expect(vault.publicVault.recoveryEnvelope.ciphertextBase64.length).toBeGreaterThan(64);
  });
  it("recovers the same address without handing a plaintext signing key to a backend",async()=>{
    const vault=await createPrimaryStellarVault("testnet");
    const recovered=await recoverStellarVault(vault.publicVault.recoveryEnvelope,vault.recoverySecret,{walletAddress:vault.signer.walletAddress,network:"testnet"});
    expect(recovered.walletAddress).toBe(vault.signer.walletAddress);
    const signed=await signWithClientVault(recovered,proof);
    expect(await crypto.subtle.verify("Ed25519",vault.signer.publicKey,signed,proof)).toBe(true);
    await expect(crypto.subtle.exportKey("pkcs8",recovered.privateKey)).rejects.toThrow();
  });
  it("rejects wrong recovery secrets, wallets, networks and modified metadata",async()=>{
    const vault=await createPrimaryStellarVault("testnet");const envelope=vault.publicVault.recoveryEnvelope;
    await expect(recoverStellarVault(envelope,createRecoverySecret(),{walletAddress:envelope.walletAddress,network:"testnet"})).rejects.toThrow("could not be verified");
    await expect(recoverStellarVault(envelope,vault.recoverySecret,{walletAddress:player,network:"testnet"})).rejects.toThrow("different wallet or network");
    await expect(recoverStellarVault(envelope,vault.recoverySecret,{walletAddress:envelope.walletAddress,network:"mainnet"})).rejects.toThrow("different wallet or network");
    await expect(recoverStellarVault({...envelope,network:"mainnet"},vault.recoverySecret,{walletAddress:envelope.walletAddress,network:"mainnet"})).rejects.toThrow("could not be verified");
    const modified=(envelope.ciphertextBase64.startsWith("A")?"B":"A")+envelope.ciphertextBase64.slice(1);
    await expect(recoverStellarVault({...envelope,ciphertextBase64:modified},vault.recoverySecret,{walletAddress:envelope.walletAddress,network:"testnet"})).rejects.toThrow("could not be verified");
  });
  it("prepares device/recovery authority without changing an existing wallet address or any on-chain signer",async()=>{
    const vault=await createDelegatedStellarVault(player,"testnet");
    expect(vault.signer.walletAddress).toBe(player);expect(vault.recoverySigner.walletAddress).toBe(player);
    expect(vault.signer.signerAddress).not.toBe(player);
    expect(vault.signer.signerAddress).not.toBe(vault.recoverySigner.signerAddress);
    const recovered=await recoverStellarVault(vault.publicVault.recoveryEnvelope,vault.recoverySecret,{walletAddress:player,network:"testnet"});
    expect(recovered.signerAddress).toBe(vault.recoverySigner.signerAddress);
    expect(recovered.walletAddress).toBe(player);
    const signature=await signWithClientVault(recovered,proof);
    expect(await crypto.subtle.verify("Ed25519",vault.recoverySigner.publicKey,signature,proof)).toBe(true);
  });
  it("refuses to replace or add signer authority to the designated administrative wallet",async()=>{
    await expect(createDelegatedStellarVault(STELLAR_DEPLOYMENT_ADMIN,"testnet")).rejects.toThrow("must remain unchanged");
  });
  it("a separately generated backend credential cannot forge the player's input signature",async()=>{
    const one=await createStellarInputKey(player,"testnet");const attacker=await createStellarInputKey(player,"testnet");
    const forged=await signWithClientVault(attacker,proof);
    expect(await crypto.subtle.verify("Ed25519",one.publicKey,forged,proof)).toBe(false);
    expect(await crypto.subtle.verify("Ed25519",one.publicKey,await signWithClientVault(one,proof),proof)).toBe(true);
    expect(one.privateKey.extractable).toBe(false);
  });
});
