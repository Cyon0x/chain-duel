"use client";
import { useCallback, useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Button, ButtonLink, Panel, Spinner } from "../ui";
import { Icon } from "../icons";
import { useNetwork } from "../networks/network-provider";
import { arcFetch, arcBody, executeCircle } from "./client";
interface Overview {
  wallet: { address: string | null; status: string; provider: string; error: string | null } | null;
  balance: { units: string; formatted: string } | null;
  balanceError: string | null;
}
export function ArcWalletPanel() {
  const { arc, socialAccount } = useNetwork();
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    if (!socialAccount) return;
    try {
      setData(await arcFetch<Overview>("/api/arc/wallet"));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [socialAccount]);
  useEffect(() => {
    if (!socialAccount) return;
    let cancelled = false;
    void arcFetch<Overview>("/api/arc/wallet")
      .then((value) => {
        if (!cancelled) setData(value);
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [socialAccount]);
  async function provision() {
    setBusy(true);
    setError(null);
    setMessage("Preparing your Circle wallet…");
    try {
      const response = await arcFetch<Parameters<typeof executeCircle>[0]>("/api/arc/wallet/provision", {
        method: "POST",
        body: arcBody(arc.networkId),
      });
      setMessage("Authorize wallet setup in Circle.");
      await executeCircle(response);
      const result = await arcFetch<{ wallet: { status: string } | null }>("/api/arc/wallet/reconcile", {
        method: "POST",
        body: arcBody(arc.networkId),
      });
      if (result.wallet?.status !== "ready")
        throw new Error("Circle is still provisioning your wallet. Please retry shortly.");
      setMessage("Your Arc wallet is ready.");
      await refresh();
    } catch (err) {
      setMessage(null);
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function recover() {
    setBusy(true);
    setError(null);
    try {
      await executeCircle(
        await arcFetch<Parameters<typeof executeCircle>[0]>("/api/arc/wallet/recover", {
          method: "POST",
          body: arcBody(arc.networkId),
        }),
      );
      setMessage("Circle completed your recovery request.");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(data?.wallet?.address ?? "");
      setMessage("Wallet address copied.");
    } catch {
      setError("Could not copy. Select the wallet address to copy it manually.");
    }
  }
  if (!socialAccount)
    return (
      <Panel className="arc-card">
        <h2>One account, two ecosystems</h2>
        <p>Sign in with Google or X to set up your Circle-powered Arc wallet.</p>
        <ButtonLink href="/arc/login">Sign in</ButtonLink>
      </Panel>
    );
  return (
    <div className="arc-wallet-grid">
      <Panel className="arc-card">
        <div className="arc-card__heading">
          <Icon name="wallet" size={24} />
          <span>{arc.name}</span>
        </div>
        <p className="eyebrow mt-5">Available USDC</p>
        <p className="arc-balance numeric">
          {data?.balance?.formatted ?? "—"} <span>USDC</span>
        </p>
        <p className="text-sm text-muted">USDC covers your stake and network fees.</p>
        {data?.balanceError ? (
          <p role="status" className="text-warning text-sm">
            {data.balanceError}
          </p>
        ) : null}
        {data?.wallet?.address ? (
          <>
            <label className="arc-label" htmlFor="arc-address">
              Receive USDC on {arc.name}
            </label>
            <div className="arc-address">
              <input id="arc-address" readOnly value={data.wallet.address} />
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void copy()}
                aria-label="Copy Arc wallet address"
              >
                Copy
              </Button>
            </div>
            <div className="arc-receive">
              <QRCodeSVG
                value={data.wallet.address}
                size={128}
                bgColor="#ffffff"
                fgColor="#07121e"
                marginSize={3}
              />
              <p>
                Send only USDC on {arc.name} to this address. Use the Bridge section for supported cross-chain
                transfers.
              </p>
            </div>
            <div className="arc-actions">
              <Button variant="secondary" size="sm" onClick={() => void refresh()}>
                Refresh balance
              </Button>
              <a
                className="focus-ring text-sm text-accent"
                target="_blank"
                rel="noreferrer"
                href={`${arc.explorer}/address/${data.wallet.address}`}
              >
                Open explorer
              </a>
            </div>
          </>
        ) : (
          <div className="arc-setup">
            <h2>Your wallet, powered by Circle</h2>
            <p>
              Your account is connected. Circle will ask you to set a six-digit authorization PIN and recovery
              answers once. No extension is needed.
            </p>
            <Button disabled={busy || !arc.walletEnabled} onClick={() => void provision()}>
              {busy ? <Spinner /> : null}
              {data?.wallet?.status === "failed" ? "Retry wallet setup" : "Finish wallet setup"}
            </Button>
            {!arc.walletEnabled ? (
              <p className="arc-notice">
                Arc wallet onboarding is awaiting activation. You can continue playing on Stellar.
              </p>
            ) : null}
          </div>
        )}
        {message ? (
          <p className="text-sm text-accent" role="status">
            {message}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
      </Panel>
      <Panel className="arc-card">
        <h2>Wallet security & recovery</h2>
        <p>
          Chain Duel uses Circle User-Controlled Wallets. You approve every signing request in Circle’s secure
          interface.
        </p>
        <p>
          Keep your PIN and recovery answers safe. Your Google or X login identifies your Chain Duel account;
          your Circle PIN authorizes the wallet.
        </p>
        <p>
          If you forget your PIN, Circle uses your recovery answers to restore access. Losing both can
          permanently prevent access to the wallet.
        </p>
        <Button
          variant="secondary"
          disabled={busy || !data?.wallet?.address || !arc.walletEnabled}
          onClick={() => void recover()}
        >
          Recover Circle PIN
        </Button>
        <a
          className="focus-ring text-sm text-accent"
          href="https://developers.circle.com/wallets/user-controlled/recover-account"
          target="_blank"
          rel="noreferrer"
        >
          Read Circle recovery guidance
        </a>
      </Panel>
    </div>
  );
}
