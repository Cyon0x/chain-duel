"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "../providers";
import { useNetwork } from "../networks/network-provider";
import { Button, Panel } from "../ui";
import { api, post } from "@/lib/api/client";
import { createDelegatedStellarVault, createPrimaryStellarVault, recoverStellarVault, signWithClientVault, type CreatedStellarVault } from "@/lib/wallet/vault-crypto";
import { loadClientSigner, saveClientSigner, walletSignerSlot } from "@/lib/wallet/vault-storage";
import { vaultRegistrationMessage, type StellarVaultView } from "@/lib/wallet/vault-types";
import { bytesHex } from "@/lib/stellar/pulse-codec";

export function StellarPlayerVaultSetup() {
  const session = useSession(); const network = useNetwork(); const router = useRouter();
  const [view, setView] = useState<StellarVaultView | null>(null);
  const [created, setCreated] = useState<CreatedStellarVault | null>(null);
  const [locked, setLocked] = useState(false); const [saved, setSaved] = useState(false);
  const [code, setCode] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const generating = useRef(false);
  const enabled = session.authenticated && network.selected === "stellar" && network.stellar.playerSigning === "client";
  const prepare = useCallback(async (current: StellarVaultView) => {
    if (generating.current) return;
    generating.current = true;
    setBusy(true); setError(null);
    try {
      const vault = current.walletAddress ? await createDelegatedStellarVault(current.walletAddress, current.network) : await createPrimaryStellarVault(current.network);
      await saveClientSigner(walletSignerSlot(vault.signer.walletAddress, current.network), vault.signer);
      setCreated(vault); setSaved(false);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "This browser could not create a secure wallet."); }
    finally { generating.current = false; setBusy(false); }
  }, []);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    void api<StellarVaultView>("/api/wallet/vault").then(async current => {
      if (!active) return; setView(current);
      if (!current.walletAddress) { await prepare(current); return; }
      if (current.publicVault && current.status !== "awaiting-migration-review") {
        try {
          const signer = await loadClientSigner(walletSignerSlot(current.walletAddress, current.network));
          if (active) setLocked(!signer);
        } catch { if (active) setLocked(true); }
      }
    }).catch(caught => { if (active) setError(caught instanceof Error ? caught.message : "The wallet could not be loaded."); });
    return () => { active = false; };
  }, [enabled, prepare, session.userId]);
  const download = () => {
    if (!created) return;
    const kit = JSON.stringify({ purpose: "Chain Duel player wallet recovery — keep private", recoveryCode: created.recoverySecret, publicVault: created.publicVault }, null, 2);
    const url = URL.createObjectURL(new Blob([kit], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = `chain-duel-recovery-${created.signer.walletAddress.slice(0, 8)}.json`; link.click(); URL.revokeObjectURL(url); setSaved(true);
  };
  const register = async () => {
    if (!created || !saved) return; setBusy(true); setError(null);
    try {
      const challenge = await post<{ nonce: string; message: string }>("/api/wallet/vault", { action: "challenge" });
      const message = vaultRegistrationMessage(challenge.message, created.publicVault);
      const updated = await post<StellarVaultView>("/api/wallet/vault", { action: "register", enrollment: {
        nonce: challenge.nonce, publicVault: created.publicVault,
        deviceProofHex: bytesHex(await signWithClientVault(created.signer, message)), recoveryProofHex: bytesHex(await signWithClientVault(created.recoverySigner, message)),
      } });
      await saveClientSigner(walletSignerSlot(created.signer.walletAddress, created.signer.network), created.signer);
      setView(updated); setCreated(null); setLocked(false); router.refresh();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Wallet setup could not be confirmed."); }
    finally { setBusy(false); }
  };
  const recover = async () => {
    if (!view?.walletAddress || !view.publicVault) return; setBusy(true); setError(null);
    try {
      const signer = await recoverStellarVault(view.publicVault.recoveryEnvelope, code, { walletAddress: view.walletAddress, network: view.network });
      await saveClientSigner(walletSignerSlot(view.walletAddress, view.network), signer); setCode(""); setLocked(false); router.refresh();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Recovery could not be verified."); }
    finally { setBusy(false); }
  };
  if (!enabled || (!created && !locked && view?.status !== "awaiting-migration-review" && view?.custody !== "managed" && view?.walletAddress)) return null;
  if (!view && !error) return null;
  return <div className="mx-auto w-full max-w-3xl px-4 pt-4 sm:px-6"><Panel className="space-y-3 p-5">
    <p className="eyebrow">Your Stellar wallet</p>
    {created ? <>
      <h2 className="text-lg font-semibold">Save your recovery backup</h2>
      <p className="text-sm text-muted">Your device signs for this wallet. Save the recovery kit privately before continuing; your social login alone cannot recover wallet control.</p>
      <p className="break-all font-mono text-xs text-dim">{created.publicVault.walletAddress}</p>
      <div className="flex flex-wrap gap-2"><Button variant="secondary" onClick={download}>Download recovery kit</Button><Button onClick={register} loading={busy} disabled={!saved}>I saved it · continue</Button></div>
    </> : view?.status === "awaiting-migration-review" ? <>
      <h2 className="text-lg font-semibold">Signer proposal saved for review</h2><p className="text-sm text-muted">Your existing address is preserved. Its account authority has not changed; verified stakes will be available after the signer migration is approved and confirmed.</p>
      <p className="break-all font-mono text-xs text-dim">{view.walletAddress}</p>
    </> : locked ? <>
      <h2 className="text-lg font-semibold">Restore this wallet on your device</h2><p className="text-sm text-muted">Use the recovery code saved in your private recovery kit. Recovery runs on this device and keeps your original address.</p>
      <label className="block text-sm">Recovery code<input type="password" autoComplete="off" value={code} onChange={event => setCode(event.target.value)} className="mt-2 w-full rounded-xl border border-line bg-bg px-3 py-2 font-mono" /></label>
      <Button loading={busy} onClick={recover} disabled={!code}>Restore wallet</Button>
    </> : <>
      <h2 className="text-lg font-semibold">Prepare signing on your device</h2><p className="text-sm text-muted">Keep your current wallet address and prepare player-controlled signers with a private recovery backup. Account-authority changes require a separate migration review.</p>
      <Button loading={busy} onClick={() => view && prepare(view)}>Prepare player signing</Button>
    </>}
    {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
  </Panel></div>;
}
