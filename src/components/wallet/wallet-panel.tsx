"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import Link from "next/link";
import { Badge, Button } from "@/components/ui";
import { usePreferences } from "@/components/providers";
import { signTransactionXdr, walletError } from "@/lib/wallet/client";
import { formatXlm } from "@/lib/config/game";
import type { StellarAssetSymbol, StellarNetworkId } from "@/lib/stellar/shared";
import { stellarNetworkLabel } from "@/lib/stellar/shared";

export interface WalletOverviewView {
  playerControlledSigning?: boolean;
  address: string;
  provider: string;
  custody: "external" | "managed";
  label: string | null;
  canSignServerSide: boolean;
  currency?: StellarAssetSymbol;
  depositHistoryAvailable?: boolean;
  network: { id: string; label: string; isTestnet: boolean; explorerUrl: string };
  balance: {
    address: string;
    exists: boolean;
    xlm: string;
    spendableXlm: string;
    reserveXlm: string;
    subentries: number;
    available: boolean;
    usdc?: string;
    spendableUsdc?: string;
    usdcTrustline?: boolean;
    usdcAuthorized?: boolean;
    baseReserveXlm?: string;
  };
  explorerUrl: string;
  transfers: Array<{
    id: string;
    direction: "in" | "out";
    amount_stroops: number;
    destination: string | null;
    memo: string | null;
    status: string;
    tx_hash: string | null;
    explorer_url: string | null;
    created_at: string;
    confirmed_at: string | null;
    error: string | null;
    currency?: StellarAssetSymbol;
    stellar_network?: StellarNetworkId;
  }>;
}

type Tab = "receive" | "send";
type Stage = "idle" | "preparing" | "awaiting_wallet" | "signing" | "submitting" | "confirming" | "confirmed" | "failed";

const STAGE_LABEL: Record<Exclude<Stage, "idle" | "failed">, string> = {
  preparing: "Preparing",
  awaiting_wallet: "Waiting for wallet",
  signing: "Signing",
  submitting: "Submitting",
  confirming: "Confirming",
  confirmed: "Confirmed",
};

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-6)}`;
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function WalletPanel({ initial }: { initial: WalletOverviewView }) {
  const { play } = usePreferences();
  const [wallet, setWallet] = useState(initial);
  const [tab, setTab] = useState<Tab>("receive");
  const [copied, setCopied] = useState(false);
  const [stage, setStage] = useState<Stage>("idle");
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [funding, setFunding] = useState(false);
  const [form, setForm] = useState({ destination: "", amountXlm: "", memo: "" });
  const [currency, setCurrency] = useState<StellarAssetSymbol>(initial.currency ?? (initial.network.id === "mainnet" ? "USDC" : "XLM"));
  const transferRequest = useRef<{ key: string; id: string } | null>(null);
  const trustlineRequest = useRef<string | null>(null);
  const [trustlineBusy, setTrustlineBusy] = useState(false);
  const [recovering, setRecovering] = useState<string | null>(null);
  const mainnet = wallet.network.id === "mainnet" || wallet.currency === "USDC";
  const balanceSymbol = mainnet ? "USDC" : "XLM";
  const spendableText = currency === "USDC" ? wallet.balance.spendableUsdc ?? "0" : wallet.balance.spendableXlm;

  const busy = stage !== "idle" && stage !== "confirmed" && stage !== "failed";
  const spendable = Number(spendableText);

  async function recover(transactionId: string) {
    setRecovering(transactionId);
    setError(null);
    try {
      const response = await fetch("/api/wallet/recover", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ transactionId }) });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "The saved transfer could not be confirmed.");
      await refresh();
    } catch (caught) { setError(walletError(caught)); }
    finally { setRecovering(null); }
  }

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/wallet", { cache: "no-store" });
      if (response.ok) setWallet((await response.json()) as WalletOverviewView);
    } catch {
      // A failed refresh must not wipe the data already on screen.
    }
  }, []);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(wallet.address);
      setCopied(true);
      play("ui");
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setError("Could not access the clipboard. Copy the address manually.");
    }
  }, [play, wallet.address]);

  const share = useCallback(async () => {
    const text = `Send ${balanceSymbol} on ${wallet.network.label} to my Chain Duel wallet: ${wallet.address}`;
    try {
      if (navigator.share) await navigator.share({ title: "Chain Duel wallet", text });
      else await copy();
    } catch {
      // The player dismissed the share sheet: not an error.
    }
  }, [balanceSymbol, copy, wallet.address, wallet.network.label]);

  const enableUsdc = useCallback(async () => {
    setTrustlineBusy(true);
    setError(null);
    try {
      trustlineRequest.current ??= crypto.randomUUID();
      const response = await fetch("/api/wallet/trustline", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ networkId: `stellar-${wallet.network.id}`, requestId: trustlineRequest.current }) });
      const body = await response.json() as { mode?: string; transactionId?: string; xdr?: string; networkPassphrase?: string; error?: string };
      if (!response.ok) throw new Error(body.error ?? "USDC setup could not be prepared.");
      if (body.mode === "wallet-signature" && body.xdr && body.transactionId) {
        const signedXdr = await signTransactionXdr(body.xdr, wallet.address, body.networkPassphrase);
        const confirmed = await fetch("/api/wallet/trustline", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "confirm", transactionId: body.transactionId, signedXdr }) });
        const result = await confirmed.json() as { error?: string };
        if (!confirmed.ok) throw new Error(result.error ?? "USDC setup could not be confirmed.");
      }
      trustlineRequest.current = null;
      play("transaction");
      await refresh();
    } catch (caught) { setError(walletError(caught)); }
    finally { setTrustlineBusy(false); }
  }, [play, refresh, wallet.address, wallet.network.id]);

  const fund = useCallback(async () => {
    setFunding(true);
    setError(null);
    try {
      const response = await fetch("/api/wallet/fund", { method: "POST" });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "The faucet could not fund this wallet.");
      play("transaction");
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The faucet could not fund this wallet.");
    } finally {
      setFunding(false);
    }
  }, [play, refresh]);

  const send = useCallback(async () => {
    setError(null);
    setReceipt(null);
    setStage("preparing");
    try {
      const key = JSON.stringify({ ...form, currency, networkId: wallet.network.id });
      if (transferRequest.current?.key !== key) transferRequest.current = { key, id: crypto.randomUUID() };
      const response = await fetch("/api/wallet/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...form, currency, networkId: `stellar-${wallet.network.id}`, requestId: transferRequest.current.id }),
      });
      const body = (await response.json()) as
        | { mode: "confirmed"; txHash: string; explorerUrl: string }
        | { mode: "wallet-signature"; transactionId: string; xdr: string; networkPassphrase: string }
        | { error?: string };
      if (!response.ok) throw new Error((body as { error?: string }).error ?? "The transfer could not be started.");

      if ((body as { mode: string }).mode === "confirmed") {
        setStage("confirmed");
        setReceipt((body as { txHash: string }).txHash);
        play("transaction");
        setForm({ destination: "", amountXlm: "", memo: "" });
        transferRequest.current = null;
        await refresh();
        return;
      }

      const handoff = body as { transactionId: string; xdr: string; networkPassphrase: string };
      setStage("awaiting_wallet");
      const signedXdr = await signTransactionXdr(handoff.xdr, wallet.address, handoff.networkPassphrase);
      setStage("submitting");
      const complete = await fetch("/api/wallet/send/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ transactionId: handoff.transactionId, signedXdr }),
      });
      const done = (await complete.json()) as { txHash?: string; error?: string };
      if (!complete.ok) throw new Error(done.error ?? "The transfer was rejected.");
      setStage("confirmed");
      setReceipt(done.txHash ?? null);
      play("transaction");
      setForm({ destination: "", amountXlm: "", memo: "" });
      transferRequest.current = null;
      await refresh();
    } catch (caught) {
      setStage("failed");
      setError(walletError(caught));
      play("wrong");
    }
  }, [currency, form, play, refresh, wallet.address, wallet.network.id]);

  const stageSteps = useMemo(
    () => ["preparing", "awaiting_wallet", "signing", "submitting", "confirming", "confirmed"] as const,
    [],
  );

  return (
    <div className="flex flex-col gap-5">
      <section className="panel relative overflow-hidden p-5 sm:p-7">
        <div
          aria-hidden
          className="pointer-events-none absolute -right-24 -top-24 h-56 w-56 rounded-full opacity-40 blur-3xl"
          style={{ background: "radial-gradient(circle, var(--accent) 0%, transparent 70%)" }}
        />
        <div className="relative flex flex-col gap-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="eyebrow">Wallet balance</p>
              <p className="numeric mt-2 text-4xl font-semibold sm:text-5xl">
                {wallet.balance.available ? (
                  <>
                    {Number(mainnet ? wallet.balance.usdc ?? "0" : wallet.balance.xlm).toLocaleString("en-US", { maximumFractionDigits: 7 })}
                    <span className="ml-2 text-lg text-muted">{balanceSymbol}</span>
                  </>
                ) : (
                  <span className="text-2xl text-muted">Balance unavailable</span>
                )}
              </p>
              <p className="mt-2 text-xs text-dim">
                {wallet.balance.available
                  ? mainnet ? `${wallet.balance.spendableUsdc ?? "0"} USDC sendable · ${wallet.balance.xlm} XLM for network fees · ${wallet.balance.reserveXlm} XLM account reserve` : `${wallet.balance.spendableXlm} XLM sendable · ${wallet.balance.reserveXlm} XLM account reserve`
                  : "Stellar is unreachable right now. Your address is still valid for deposits."}
              </p>
            </div>
            <div className="flex flex-col items-end gap-2">
              <Badge tone="accent">{wallet.custody === "managed" ? "Embedded wallet" : "Your wallet"}</Badge>
              <Badge tone="neutral">{wallet.network.label}</Badge>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <code className="numeric min-w-0 flex-1 truncate rounded-2xl border border-line bg-surface px-4 py-3 text-xs sm:text-sm">
              {wallet.address}
            </code>
            <Button variant="secondary" size="sm" onClick={copy}>
              {copied ? "Copied ✓" : "Copy address"}
            </Button>
            <Button variant="ghost" size="sm" onClick={share}>
              Share
            </Button>
            <a
              href={wallet.explorerUrl}
              target="_blank"
              rel="noreferrer"
              className="focus-ring rounded-xl px-3 py-2 text-xs text-accent hover:underline"
            >
              Explorer ↗
            </a>
          </div>

          {wallet.playerControlledSigning ? (
            <p className="text-xs leading-relaxed text-dim">Your device or external wallet authorizes transfers. Keep your encrypted recovery backup and recovery code safe.</p>
          ) : wallet.custody === "managed" ? (
            <p className="text-xs leading-relaxed text-dim">
              Chain Duel created this wallet for you. Transfers require authorization from your account.
            </p>
          ) : (
            <p className="text-xs leading-relaxed text-dim">
              This is your connected Stellar wallet. Chain Duel never sees your key — every transfer is signed inside
              your wallet.
            </p>
          )}

          {wallet.network.isTestnet && wallet.balance.available && !wallet.balance.exists ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-accent/30 bg-accent-soft px-4 py-3">
              <p className="text-xs text-muted">
                This wallet is not on-chain yet. Add Testnet XLM to start playing staked duels.
              </p>
              <Button size="sm" loading={funding} onClick={fund}>
                Fund with Testnet XLM
              </Button>
            </div>
          ) : null}
          {mainnet && wallet.balance.available && !wallet.balance.usdcTrustline ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-accent/30 bg-accent-soft px-4 py-3">
              <p className="text-xs text-muted">Enable official USDC before receiving stakes or rewards. This reserves another {wallet.balance.baseReserveXlm ?? "0.5"} XLM and pays a Stellar network fee.</p>
              <Button size="sm" loading={trustlineBusy} disabled={!wallet.balance.exists || busy} onClick={enableUsdc}>Enable USDC</Button>
            </div>
          ) : null}
          {mainnet && wallet.balance.usdcTrustline && !wallet.balance.usdcAuthorized ? <p role="status" className="text-xs text-warning">The USDC issuer has not authorized this wallet&apos;s trustline.</p> : null}
          {tab === "receive" && error ? <p role="alert" className="text-xs text-danger">{error}</p> : null}
        </div>
      </section>

      <section className="panel p-5 sm:p-6">
        <div className="flex gap-2" role="tablist" aria-label="Wallet actions">
          {(["receive", "send"] as Tab[]).map((id) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              onClick={() => {
                setTab(id);
                setError(null);
                play("ui");
              }}
              className={clsx(
                "focus-ring h-10 rounded-xl px-4 text-sm font-semibold capitalize transition-colors",
                tab === id ? "bg-accent text-accent-ink" : "border border-line-strong text-muted hover:text-ink",
              )}
            >
              {id}
            </button>
          ))}
        </div>

        {tab === "receive" ? (
          <div className="mt-5 flex flex-col gap-3">
            <p className="text-sm text-muted">
              Deposit {mainnet ? "official Stellar USDC or XLM" : "XLM"} from a Stellar wallet or exchange by sending to your address. XLM pays network fees and activates the account.
            </p>
            <div className="rounded-2xl border border-line bg-surface px-4 py-3">
              <p className="eyebrow">Your deposit address</p>
              <p className="numeric mt-2 break-all text-sm">{wallet.address}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" onClick={copy}>
                {copied ? "Copied ✓" : "Copy address"}
              </Button>
              <Button variant="ghost" size="sm" onClick={share}>
                Share
              </Button>
            </div>
            <p className="text-xs text-dim">
              Use {wallet.network.label}. {mainnet ? "USDC requires its authorized trustline; keep XLM for network fees and reserves." : "Only send Testnet XLM to this Testnet wallet."}
            </p>
          </div>
        ) : (
          <form
            className="mt-5 flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (!busy) void send();
            }}
          >
            {mainnet ? <label className="flex flex-col gap-1.5"><span className="eyebrow">Asset</span><select className="focus-ring h-11 rounded-xl border border-line bg-surface px-3 text-sm" value={currency} disabled={busy} onChange={event => setCurrency(event.target.value as StellarAssetSymbol)}><option value="USDC">USDC</option><option value="XLM">XLM</option></select></label> : null}
            <label className="flex flex-col gap-1.5">
              <span className="eyebrow">Destination address</span>
              <input
                required
                value={form.destination}
                onChange={(event) => setForm((f) => ({ ...f, destination: event.target.value }))}
                placeholder="G…"
                spellCheck={false}
                autoComplete="off"
                className="focus-ring numeric h-11 rounded-xl border border-line bg-surface px-3 text-sm"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="eyebrow">Amount ({currency})</span>
              <div className="flex gap-2">
                <input
                  required
                  inputMode="decimal"
                  value={form.amountXlm}
                  onChange={(event) => setForm((f) => ({ ...f, amountXlm: event.target.value }))}
                  placeholder="0.00"
                  className="focus-ring numeric h-11 min-w-0 flex-1 rounded-xl border border-line bg-surface px-3 text-sm"
                />
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => setForm((f) => ({ ...f, amountXlm: spendableText }))}
                  disabled={!wallet.balance.available || spendable <= 0}
                >
                  Max
                </Button>
              </div>
              <span className="text-xs text-dim">Up to {spendableText} {currency} sendable · network fee paid in XLM</span>
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="eyebrow">Memo (optional)</span>
              <input
                value={form.memo}
                onChange={(event) => setForm((f) => ({ ...f, memo: event.target.value }))}
                maxLength={28}
                placeholder="What is this for?"
                className="focus-ring h-11 rounded-xl border border-line bg-surface px-3 text-sm"
              />
            </label>

            <Button type="submit" loading={busy} disabled={busy || !wallet.balance.available}>
              {wallet.custody === "managed" ? `Send ${currency}` : `Sign & send ${currency}`}
            </Button>

            {busy ? (
              <ol className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-dim">
                {stageSteps.map((step) => (
                  <li
                    key={step}
                    className={clsx(
                      stageSteps.indexOf(step) <= stageSteps.indexOf(stage as (typeof stageSteps)[number])
                        ? "text-accent"
                        : undefined,
                    )}
                  >
                    {STAGE_LABEL[step]}
                  </li>
                ))}
              </ol>
            ) : null}

            {stage === "confirmed" ? (
              <p role="status" className="rounded-xl border border-success/40 bg-success/10 px-3 py-2 text-xs text-success">
                Transfer confirmed{receipt ? ` · ${receipt.slice(0, 12)}…` : ""}.{" "}
                {receipt ? (
                  <a
                    className="underline"
                    href={`${wallet.network.explorerUrl}/tx/${receipt}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View on explorer ↗
                  </a>
                ) : null}
              </p>
            ) : null}
            {error ? (
              <p role="alert" className="rounded-xl border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
                {error}
              </p>
            ) : null}
          </form>
        )}
      </section>

      <section className="panel p-5 sm:p-6">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-display text-lg">Wallet activity</h2>
          <Link href="/transactions" className="focus-ring text-xs text-accent hover:underline">
            All transactions →
          </Link>
        </div>
        {wallet.depositHistoryAvailable === false ? <p role="status" className="mt-3 text-xs text-warning">Recent wallet deposits could not be refreshed. Try again shortly or view the wallet on the explorer.</p> : null}
        {wallet.transfers.length === 0 ? (
          <div className="mt-4 rounded-2xl border border-dashed border-line-strong px-4 py-8 text-center">
            <p className="text-sm text-muted">No transfers yet</p>
            <p className="mt-1 text-xs text-dim">Deposits and sends from this wallet will appear here.</p>
          </div>
        ) : (
          <ul className="mt-4 flex flex-col gap-2">
            {wallet.transfers.map((transfer) => (
              <li
                key={transfer.id}
                className="flex items-center gap-4 rounded-2xl border border-line bg-surface px-4 py-3"
              >
                <span
                  aria-hidden
                  className={clsx(
                    "grid h-9 w-9 shrink-0 place-items-center rounded-xl border text-xs font-bold",
                    transfer.direction === "in" ? "border-success/40 text-success" : "border-line-strong text-muted",
                  )}
                >
                  {transfer.direction === "in" ? "↓" : "↑"}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {transfer.direction === "in" ? "Deposit" : "Sent"}
                    {transfer.memo ? <span className="ml-2 text-xs text-dim">{transfer.memo}</span> : null}
                  </p>
                  <p className="numeric mt-0.5 truncate text-xs text-dim">
                    {transfer.destination ? shortAddress(transfer.destination) : wallet.address} ·{" "}
                    <time dateTime={transfer.created_at} suppressHydrationWarning>{relativeTime(transfer.created_at)}</time> · {stellarNetworkLabel(transfer.stellar_network ?? "testnet")}
                  </p>
                  {transfer.stellar_network === "mainnet" && transfer.tx_hash && transfer.status !== "confirmed" ? <Button size="sm" variant="ghost" loading={recovering === transfer.id} disabled={Boolean(recovering)} onClick={() => recover(transfer.id)}>Retry confirmation</Button> : null}
                </div>
                <div className="text-right">
                  <p
                    className={clsx(
                      "numeric text-sm font-semibold",
                      transfer.direction === "in" ? "text-success" : "text-ink",
                    )}
                  >
                    {transfer.direction === "in" ? "+" : "−"}
                    {formatXlm(transfer.amount_stroops, 7)} {transfer.currency ?? "XLM"}
                  </p>
                  <p
                    className={clsx(
                      "text-xs",
                      transfer.status === "confirmed"
                        ? "text-success"
                        : transfer.status === "failed"
                          ? "text-danger"
                          : "text-warning",
                    )}
                  >
                    {transfer.status === "confirmed"
                      ? "Confirmed"
                      : transfer.status === "failed"
                        ? "Failed"
                        : "Pending"}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
