"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import clsx from "clsx";
import { Avatar, Button, Panel } from "@/components/ui";
import { post } from "@/lib/api/client";
import { THEME_DEFINITIONS, THEMES, type ThemeId } from "@/lib/config/themes";
import { usePreferences } from "@/components/providers";

export function OnboardingForm({
  address,
  suggestions,
}: {
  address: string | null;
  suggestions: string[];
}) {
  const router = useRouter();
  const { theme, setTheme } = usePreferences();
  const [username, setUsername] = useState(suggestions[0] ?? "");
  const [avatar, setAvatar] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const valid = /^[a-zA-Z0-9_]{3,18}$/.test(username.trim());

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await post("/api/onboarding", {
        username: username.trim(),
        avatar: avatar.trim() || null,
        theme,
      });
      router.push("/dashboard");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create your profile.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel className="mx-auto flex w-full max-w-lg flex-col gap-6 px-6 py-8">
      <div>
        <p className="eyebrow">Create your duelist</p>
        <h1 className="text-display mt-2 text-3xl">Pick a name</h1>
        <p className="mt-2 text-sm text-muted">
          This is what other players see. You can change the look at any time.
        </p>
      </div>

      <div className="flex items-center gap-4">
        <Avatar name={username || "CD"} src={avatar || null} size={64} theme={theme} />
        <div className="flex-1">
          <label htmlFor="username" className="eyebrow">
            Username
          </label>
          <input
            id="username"
            value={username}
            maxLength={18}
            onChange={(event) => setUsername(event.target.value)}
            className="focus-ring mt-1.5 h-11 w-full rounded-xl border border-line bg-surface px-3 text-sm"
            placeholder="duelist_01"
            autoComplete="off"
          />
        </div>
      </div>

      {suggestions.length > 1 ? (
        <div className="flex flex-wrap gap-2">
          {suggestions.map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => setUsername(name)}
              className={clsx(
                "focus-ring rounded-xl border px-3 py-1.5 text-xs transition-colors",
                username === name ? "border-accent text-accent" : "border-line text-muted hover:border-line-strong",
              )}
            >
              {name}
            </button>
          ))}
        </div>
      ) : null}

      <div>
        <label htmlFor="avatar" className="eyebrow">
          Avatar URL <span className="normal-case tracking-normal">(optional)</span>
        </label>
        <input
          id="avatar"
          value={avatar}
          onChange={(event) => setAvatar(event.target.value)}
          className="focus-ring mt-1.5 h-11 w-full rounded-xl border border-line bg-surface px-3 text-sm"
          placeholder="https://…"
          inputMode="url"
        />
      </div>

      <div>
        <p className="eyebrow">Theme</p>
        <div className="mt-2 grid grid-cols-2 gap-2">
          {THEMES.map((id: ThemeId) => (
            <button
              key={id}
              type="button"
              onClick={() => setTheme(id)}
              aria-pressed={theme === id}
              className={clsx(
                "focus-ring flex items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors",
                theme === id ? "border-accent bg-accent-soft" : "border-line bg-surface hover:border-line-strong",
              )}
            >
              <span aria-hidden className="h-3.5 w-3.5 rounded-full" style={{ background: THEME_DEFINITIONS[id].accent }} />
              <span className="text-sm">{THEME_DEFINITIONS[id].name}</span>
            </button>
          ))}
        </div>
      </div>

      {address ? (
        <p className="numeric truncate rounded-xl border border-line bg-surface px-3 py-2 text-xs text-dim">
          Wallet · {address}
        </p>
      ) : (
        <p className="rounded-xl border border-line bg-surface px-3 py-2 text-xs text-dim">
          Signed in without an external wallet — Chain Duel will use your managed wallet for demo play.
        </p>
      )}

      {error ? (
        <p role="alert" className="rounded-xl border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      ) : null}

      <Button size="lg" loading={busy} disabled={!valid} onClick={submit}>
        Create profile
      </Button>
      <p className="text-center text-xs text-dim">3–18 characters. Letters, numbers and underscores only.</p>
    </Panel>
  );
}
