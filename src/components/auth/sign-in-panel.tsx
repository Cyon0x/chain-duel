"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import clsx from "clsx";
import { Button, Spinner } from "@/components/ui";
import { listWallets, type WalletOption } from "@/lib/wallet/client";
import { post } from "@/lib/api/client";
import { useWalletSignIn, WALLET_STATUS_LABEL } from "./use-wallet-sign-in";
import type { AuthProviders } from "./types";
import brandMark from "@/assets/brand/chain-duel-mark.png";

const MONOGRAM: Record<string, string> = {
  freighter: "◈",
  xbull: "◆",
  albedo: "◇",
  lobstr: "⬡",
  rabet: "✦",
};

/**
 * The single sign-in chooser used by both the header modal and `/login`.
 * Wallet availability comes from the live Stellar Wallets Kit module list, so an
 * unreachable provider shows an install link instead of a button that pretends
 * to work.
 */
export function SignInPanel({
  providers,
  onDone,
  initialError,
  heading = "Sign in to continue",
  subheading = "Connect a Stellar wallet to stake and settle, or use a managed account.",
}: {
  providers: AuthProviders;
  onDone?: () => void;
  initialError?: string | null;
  heading?: string;
  subheading?: string;
}) {
  const router = useRouter();
  const [wallets, setWallets] = useState<WalletOption[] | null>(null);
  const [demoLoading, setDemoLoading] = useState(false);
  const [demoError, setDemoError] = useState<string | null>(null);
  const { status, error, busy, pendingWallet, signIn, reset } = useWalletSignIn(onDone);

  useEffect(() => {
    let active = true;
    listWallets()
      .then((list) => active && setWallets(list))
      .catch(() => active && setWallets([]));
    return () => {
      active = false;
    };
  }, []);

  const startDemo = useCallback(async () => {
    setDemoLoading(true);
    setDemoError(null);
    try {
      await post("/api/auth/demo", { name: "Guest Duelist" });
      onDone?.();
      router.push("/onboarding");
      router.refresh();
    } catch (caught) {
      setDemoError(caught instanceof Error ? caught.message : "Demo mode is unavailable.");
    } finally {
      setDemoLoading(false);
    }
  }, [onDone, router]);

  const activeWallet = wallets?.find((wallet) => wallet.id === pendingWallet)?.name;
  const shownError = error ?? initialError ?? null;

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-3">
        <Image src={brandMark} alt="" aria-hidden quality={92} sizes="32px" className="h-8 w-auto" />
        <p className="eyebrow">Chain Duel</p>
      </div>
      <h2 className="text-display mt-3 text-2xl">{heading}</h2>
      <p className="mt-1.5 text-sm text-muted">{subheading}</p>

      <div className="mt-6 flex flex-col gap-3">
        <p className="eyebrow text-dim">Stellar wallets</p>
        {wallets === null ? (
          <div className="flex flex-col gap-2" aria-hidden>
            {[0, 1, 2].map((row) => (
              <div key={row} className="h-[52px] animate-pulse rounded-2xl border border-line bg-surface" />
            ))}
          </div>
        ) : wallets.length === 0 ? (
          <p className="rounded-2xl border border-line bg-surface px-4 py-3 text-xs text-muted">
            Wallet detection failed in this browser. Reload the page and try again.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {wallets.map((wallet) => {
              const isPending = busy && pendingWallet === wallet.id;
              const disabled = busy && !isPending;
              return (
                <li key={wallet.id}>
                  {wallet.available ? (
                    <button
                      type="button"
                      onClick={() => signIn(wallet.id)}
                      disabled={disabled}
                      className={clsx(
                        "focus-ring flex w-full items-center gap-3 rounded-2xl border border-line bg-surface px-3.5 py-3 text-left transition-all duration-150",
                        "hover:border-accent/60 hover:bg-surface-strong",
                        disabled && "cursor-not-allowed opacity-45",
                      )}
                    >
                      <WalletMark id={wallet.id} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold">{wallet.name}</span>
                        <span className="block truncate text-[11px] text-dim">{wallet.hint}</span>
                      </span>
                      {isPending ? <Spinner /> : <span aria-hidden className="text-dim">→</span>}
                    </button>
                  ) : (
                    <div className="flex items-center gap-3 rounded-2xl border border-line/60 bg-surface/50 px-3.5 py-3">
                      <WalletMark id={wallet.id} muted />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-muted">{wallet.name}</span>
                        <span className="block truncate text-[11px] text-dim">Not detected in this browser</span>
                      </span>
                      {wallet.url ? (
                        <a
                          href={wallet.url}
                          target="_blank"
                          rel="noreferrer"
                          className="focus-ring rounded-lg px-2 py-1 text-[11px] font-semibold text-accent hover:underline"
                        >
                          Install
                        </a>
                      ) : null}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {busy ? (
        <p role="status" className="mt-3 text-center text-xs text-accent">
          {WALLET_STATUS_LABEL[status]}
          {activeWallet ? ` · ${activeWallet}` : ""}
        </p>
      ) : null}
      {shownError ? (
        <p role="alert" className="mt-3 rounded-xl border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
          {shownError}
        </p>
      ) : null}

      <div className="my-5 flex items-center gap-3">
        <span className="hairline flex-1" />
        <span className="text-[11px] uppercase tracking-[0.2em] text-dim">or</span>
        <span className="hairline flex-1" />
      </div>

      <div className="grid gap-2">
        <SocialLink href="/api/auth/oauth/google" enabled={providers.google} label="Continue with Google" mark={<GoogleMark />} />
        <SocialLink
          href="/api/auth/oauth/x"
          enabled={providers.x}
          label="Continue with X"
          mark={<span aria-hidden className="text-base font-bold">𝕏</span>}
        />
        {!providers.google || !providers.x ? (
          <p className="text-center text-[11px] leading-relaxed text-dim">
            {providers.google
              ? "X sign-in is not enabled on this deployment yet."
              : providers.x
                ? "Google sign-in is not enabled on this deployment yet."
                : "Social sign-in is not enabled on this deployment — wallets and demo mode work now."}
          </p>
        ) : null}
      </div>

      {providers.demoMode ? (
        <div className="mt-4">
          {!busy ? (
            <p className="mb-2 text-center text-[11px] text-dim">
              No stake, no wallet needed. Demo results never touch Testnet balances or rating.
            </p>
          ) : null}
          <Button variant="secondary" className="w-full" loading={demoLoading} disabled={busy} onClick={startDemo}>
            Try demo mode
          </Button>
        </div>
      ) : null}

      {demoError ? (
        <p role="alert" className="mt-2 rounded-xl border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
          {demoError}
        </p>
      ) : null}

      <p className="mt-5 text-center text-[11px] leading-relaxed text-dim">
        Your signature proves you own the wallet. Chain Duel never asks for a secret key.
      </p>
      {busy ? (
        <button
          type="button"
          onClick={reset}
          className="focus-ring mx-auto mt-2 block text-[11px] text-dim underline-offset-2 hover:underline"
        >
          Cancel
        </button>
      ) : null}
    </div>
  );
}

export function WalletMark({ id, muted }: { id: string; muted?: boolean }) {
  return (
    <span
      aria-hidden
      className={clsx(
        "grid h-9 w-9 shrink-0 place-items-center rounded-xl border text-sm",
        muted ? "border-line/60 text-dim" : "border-accent/35 bg-accent-soft text-accent",
      )}
    >
      {MONOGRAM[id] ?? "◆"}
    </span>
  );
}

function SocialLink({
  href,
  enabled,
  label,
  mark,
}: {
  href: string;
  enabled: boolean;
  label: string;
  mark: React.ReactNode;
}) {
  if (!enabled) {
    return (
      <span
        aria-disabled="true"
        title="Not enabled on this deployment"
        className="inline-flex h-12 cursor-not-allowed items-center justify-center gap-2.5 rounded-2xl border border-line/60 bg-surface/50 px-5 text-sm font-semibold text-dim"
      >
        {mark}
        {label}
      </span>
    );
  }
  return (
    // OAuth must be a full-page redirect, not client navigation.
    <a
      href={href}
      className="focus-ring inline-flex h-12 items-center justify-center gap-2.5 rounded-2xl border border-line-strong bg-surface-strong px-5 text-sm font-semibold transition-colors hover:border-accent hover:bg-surface"
    >
      {mark}
      {label}
    </a>
  );
}

function GoogleMark() {
  return (
    <svg aria-hidden width="16" height="16" viewBox="0 0 48 48">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.9 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.3 6.1 29.4 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.2-.1-2.3-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.3 6.1 29.4 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 10-2 13.6-5.2l-6.3-5.3C29.2 35 26.7 36 24 36c-5.2 0-9.6-3.1-11.3-7.6l-6.5 5C9.6 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.3 4.3-4.1 5.6l6.3 5.3C40.9 36.5 44 31 44 24c0-1.2-.1-2.3-.4-3.5z" />
    </svg>
  );
}
