"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Panel } from "@/components/ui";
import { WalletConnect } from "@/components/wallet-connect";
import { post } from "@/lib/api/client";

export function AuthPanel({
  providers,
  error,
}: {
  providers: { google: boolean; x: boolean; demoMode: boolean };
  error?: string;
}) {
  const router = useRouter();
  const [demoLoading, setDemoLoading] = useState(false);
  const [demoError, setDemoError] = useState<string | null>(null);

  async function startDemo() {
    setDemoLoading(true);
    setDemoError(null);
    try {
      await post("/api/auth/demo", { name: "Guest Duelist" });
      router.push("/onboarding");
      router.refresh();
    } catch (caught) {
      setDemoError(caught instanceof Error ? caught.message : "Demo mode is unavailable.");
    } finally {
      setDemoLoading(false);
    }
  }

  return (
    <Panel className="flex flex-col gap-5 px-6 py-7">
      <div>
        <p className="eyebrow">Sign in</p>
        <h1 className="text-display mt-2 text-3xl">Enter Chain Duel</h1>
        <p className="mt-2 text-sm text-muted">
          Connect a Stellar wallet to stake and settle, or start with a managed account.
        </p>
      </div>

      <WalletConnect size="lg" label="Connect Stellar wallet" />

      <div className="flex items-center gap-3">
        <span className="hairline flex-1" />
        <span className="text-[11px] uppercase tracking-[0.2em] text-dim">or</span>
        <span className="hairline flex-1" />
      </div>

      <div className="grid gap-2">
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- OAuth must be a full-page redirect, not client navigation */}
        <a
          href="/api/auth/oauth/google"
          aria-disabled={!providers.google}
          className={`focus-ring inline-flex h-12 items-center justify-center gap-2.5 rounded-2xl border border-line-strong bg-surface-strong px-5 text-sm font-semibold transition-colors ${
            providers.google ? "hover:border-accent" : "pointer-events-none opacity-45"
          }`}
        >
          <GoogleMark />
          Continue with Google
        </a>
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- OAuth must be a full-page redirect, not client navigation */}
        <a
          href="/api/auth/oauth/x"
          aria-disabled={!providers.x}
          className={`focus-ring inline-flex h-12 items-center justify-center gap-2.5 rounded-2xl border border-line-strong bg-surface-strong px-5 text-sm font-semibold transition-colors ${
            providers.x ? "hover:border-accent" : "pointer-events-none opacity-45"
          }`}
        >
          <span aria-hidden className="text-base font-bold">𝕏</span>
          Continue with X
        </a>
        {!providers.google || !providers.x ? (
          <p className="text-center text-xs text-dim">
            Social sign-in is enabled when the deployment has OAuth credentials configured.
          </p>
        ) : null}
      </div>

      {providers.demoMode ? (
        <div className="rounded-2xl border border-line bg-surface px-4 py-3.5">
          <p className="text-sm font-medium">Try demo mode</p>
          <p className="mt-1 text-xs text-muted">
            Play every mode with no stake. Demo results never touch Testnet balances or your rating.
          </p>
          <Button variant="secondary" className="mt-3 w-full" loading={demoLoading} onClick={startDemo}>
            Enter demo mode
          </Button>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="rounded-xl border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      ) : null}
      {demoError ? (
        <p role="alert" className="rounded-xl border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
          {demoError}
        </p>
      ) : null}

      <p className="text-center text-xs text-dim">
        Your wallet signature proves ownership. Chain Duel never asks for your secret key.
      </p>
    </Panel>
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
