"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import clsx from "clsx";
import { Badge, Button, Panel } from "@/components/ui";
import { usePreferences, useSession } from "@/components/providers";
import { THEME_DEFINITIONS, THEMES, type ThemeId } from "@/lib/config/themes";
import { disconnectWallet } from "@/lib/wallet/client";
import { accountExplorerUrl, truncateAddress } from "@/lib/explorer";
import { patch } from "@/lib/api/client";

export function SettingsPanel({
  username,
  wallet,
}: {
  username: string;
  wallet: { address: string; custody: string; network: string; provider: string } | null;
}) {
  const router = useRouter();
  const { theme, setTheme, soundEnabled, toggleSound, musicEnabled, toggleMusic, notifyEnabled, toggleNotify } =
    usePreferences();
  const session = useSession();
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function pickTheme(next: ThemeId) {
    setTheme(next);
    setSaving(true);
    try {
      await patch("/api/profile", { theme: next });
      setMessage("Theme saved to your profile.");
    } catch {
      setMessage("Theme applied locally; we could not save it to your profile.");
    } finally {
      setSaving(false);
      window.setTimeout(() => setMessage(null), 2400);
    }
  }

  async function signOut() {
    await disconnectWallet();
    await fetch("/api/auth/session", { method: "DELETE" });
    router.push("/");
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-5">
      <Panel className="flex flex-col gap-4 px-5 py-5">
        <div className="flex items-center justify-between">
          <div>
            <p className="eyebrow">Appearance</p>
            <p className="mt-1 text-sm text-muted">Theme changes accents, arena environment and profile presentation.</p>
          </div>
          {saving ? <Badge tone="neutral">Saving</Badge> : null}
        </div>
        <div className="grid gap-2 sm:grid-cols-4">
          {THEMES.map((id) => (
            <button
              key={id}
              type="button"
              aria-pressed={theme === id}
              onClick={() => pickTheme(id)}
              className={clsx(
                "focus-ring flex flex-col gap-2 rounded-2xl border px-4 py-3 text-left transition-colors",
                theme === id ? "border-accent bg-accent-soft" : "border-line bg-surface hover:border-line-strong",
              )}
            >
              <span aria-hidden className="h-6 w-6 rounded-full" style={{ background: THEME_DEFINITIONS[id].accent }} />
              <span className="text-sm font-medium">{THEME_DEFINITIONS[id].name}</span>
              <span className="text-[11px] text-dim">{THEME_DEFINITIONS[id].tagline}</span>
            </button>
          ))}
        </div>
      </Panel>

      <Panel className="flex flex-col gap-3 px-5 py-5">
        <p className="eyebrow">Audio &amp; alerts</p>
        <Toggle label="Sound effects" hint="Targets, combos, countdown and results." value={soundEnabled} onChange={toggleSound} />
        <Toggle
          label="Ambient music"
          hint="A quiet synthesised pad while you browse."
          value={musicEnabled}
          onChange={toggleMusic}
          disabled={!soundEnabled}
        />
        <Toggle
          label="Match notifications"
          hint="Request desktop notification permission for duel invites."
          value={notifyEnabled}
          onChange={toggleNotify}
        />
      </Panel>

      <Panel className="flex flex-col gap-4 px-5 py-5">
        <p className="eyebrow">Account</p>
        <Row label="Username" value={username} />
        <Row label="Signed in with" value={session.custody === "managed" ? "Managed wallet" : "Stellar wallet"} />
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-3">
          <span className="text-sm text-muted">Wallet</span>
          {wallet ? (
            <a
              href={accountExplorerUrl(wallet.address)}
              target="_blank"
              rel="noreferrer"
              className="focus-ring numeric text-sm text-accent hover:underline"
            >
              {truncateAddress(wallet.address, 6)}
            </a>
          ) : (
            <span className="text-sm text-dim">None</span>
          )}
        </div>
        {wallet ? (
          <>
            <Row label="Custody" value={wallet.custody} />
            <Row label="Network" value={wallet.network} />
            <Row label="Provider" value={wallet.provider} />
          </>
        ) : null}
        <p className="text-xs text-dim">
          Chain Duel never stores your external wallet secret key and never asks you to paste one.
        </p>
      </Panel>

      <Panel className="flex flex-col gap-3 px-5 py-5">
        <p className="eyebrow">Privacy &amp; session</p>
        <p className="text-sm text-muted">
          Your theme, sound and notification choices stay in this browser. Duel history and transactions are stored so
          your profile and leaderboard position stay consistent.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="danger" onClick={signOut}>
            Disconnect &amp; sign out
          </Button>
          <a href="/privacy" className="focus-ring self-center text-sm text-accent hover:underline">
            Read the privacy notice →
          </a>
        </div>
      </Panel>

      {message ? (
        <p role="status" className="rounded-xl border border-line bg-surface px-3 py-2 text-sm text-muted">
          {message}
        </p>
      ) : null}
    </div>
  );
}

function Toggle({
  label,
  hint,
  value,
  onChange,
  disabled,
}: {
  label: string;
  hint: string;
  value: boolean;
  onChange: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-line pb-3 last:border-0 last:pb-0">
      <div>
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-dim">{hint}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={value}
        disabled={disabled}
        onClick={onChange}
        className={clsx(
          "focus-ring relative h-6 w-11 shrink-0 rounded-full border transition-colors",
          value && !disabled ? "border-accent bg-accent-soft" : "border-line-strong bg-surface",
          disabled && "cursor-not-allowed opacity-40",
        )}
      >
        <span
          aria-hidden
          className={clsx(
            "absolute top-0.5 h-4 w-4 rounded-full transition-all",
            value ? "left-[22px] bg-accent" : "left-0.5 bg-muted",
          )}
        />
      </button>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-line pb-3 last:border-0 last:pb-0">
      <span className="text-sm text-muted">{label}</span>
      <span className="text-sm capitalize">{value}</span>
    </div>
  );
}
