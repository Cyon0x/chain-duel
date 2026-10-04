"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { Avatar, Badge, Button } from "./ui";
import { usePreferences, useSession } from "./providers";
import { DisconnectButton } from "./wallet-connect";
import { SignInDialog } from "./auth/sign-in-dialog";
import type { AuthProviders } from "./auth/types";
import { THEME_DEFINITIONS, THEMES } from "@/lib/config/themes";

const NAV = [
  { href: "/play", label: "Play" },
  { href: "/players", label: "Players" },
  { href: "/leaderboard", label: "Leaderboard" },
  { href: "/profile", label: "Profile" },
  { href: "/how-to-play", label: "How to Play" },
  { href: "/transactions", label: "Transactions" },
];

export function SiteHeader({
  networkLabel,
  isTestnet,
  providers,
}: {
  networkLabel: string;
  isTestnet: boolean;
  providers: AuthProviders;
}) {
  const pathname = usePathname();
  const session = useSession();
  const { theme, setTheme, soundEnabled, toggleSound, play } = usePreferences();
  const [menuOpen, setMenuOpen] = useState(false);
  const [themeOpen, setThemeOpen] = useState(false);

  return (
    <header className="sticky top-0 z-50 border-b border-line bg-bg/80 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-7xl items-center gap-2 px-3 sm:gap-4 sm:px-6">
        <Link href="/" className="focus-ring flex min-w-0 items-center gap-2 rounded-xl pr-1 sm:gap-2.5 sm:pr-2">
          <span
            aria-hidden
            className="grid h-8 w-8 place-items-center rounded-xl border border-accent/40 bg-accent-soft text-[13px] font-bold text-accent"
          >
            CD
          </span>
          <span className="text-[15px] font-semibold tracking-tight">
            CHAIN<span className="text-accent"> DUEL</span>
          </span>
        </Link>

        <nav className="ml-2 hidden items-center gap-1 lg:flex" aria-label="Main">
          {NAV.map((item) => {
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={clsx(
                  "focus-ring rounded-xl px-3 py-2 text-[13px] font-medium transition-colors",
                  active ? "bg-surface-strong text-ink" : "text-muted hover:bg-surface hover:text-ink",
                )}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto flex shrink-0 items-center gap-1.5 sm:gap-2">
          {/* Wrapped, not class-merged: Badge/Button set their own display, so a
              `hidden` utility on them would lose to their base `inline-flex`. */}
          <div className="hidden sm:block">
            {isTestnet ? (
              <Badge tone="warning">Testnet</Badge>
            ) : (
              <Badge tone="danger">{networkLabel}</Badge>
            )}
          </div>

          <div className="relative hidden sm:block">
            <Button
              variant="ghost"
              size="sm"
              aria-label="Change theme"
              aria-expanded={themeOpen}
              onClick={() => {
                play("ui");
                setThemeOpen((open) => !open);
              }}
            >
              <span
                aria-hidden
                className="h-3 w-3 rounded-full"
                style={{ background: THEME_DEFINITIONS[theme].accent }}
              />
              <span className="hidden sm:inline">{THEME_DEFINITIONS[theme].name}</span>
            </Button>
            {themeOpen ? (
              <div className="panel absolute right-0 top-11 w-52 p-1.5" role="menu">
                {THEMES.map((id) => (
                  <button
                    key={id}
                    role="menuitemradio"
                    aria-checked={theme === id}
                    onClick={() => {
                      setTheme(id);
                      setThemeOpen(false);
                      play("ui");
                    }}
                    className="focus-ring flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-[13px] hover:bg-surface"
                  >
                    <span
                      aria-hidden
                      className="h-3.5 w-3.5 rounded-full border border-line-strong"
                      style={{ background: THEME_DEFINITIONS[id].accent }}
                    />
                    <span className="flex-1">
                      <span className="block font-medium">{THEME_DEFINITIONS[id].name}</span>
                      <span className="block text-[11px] text-dim">{THEME_DEFINITIONS[id].tagline}</span>
                    </span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          <div className="hidden sm:block">
            <Button
              variant="ghost"
              size="sm"
              onClick={toggleSound}
              aria-pressed={soundEnabled}
              aria-label={soundEnabled ? "Mute sound" : "Enable sound"}
            >
              <span aria-hidden>{soundEnabled ? "◉" : "◌"}</span>
            </Button>
          </div>

          {session.authenticated ? (
            <AccountMenu />
          ) : (
            <SignInDialog providers={providers} label="Sign in" />
          )}

          <Button
            variant="ghost"
            size="sm"
            className="lg:hidden"
            aria-label="Open menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <span aria-hidden>≡</span>
          </Button>
        </div>
      </div>

      {menuOpen ? (
        <div className="border-t border-line bg-bg-elevated px-4 py-3 lg:hidden">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2" role="radiogroup" aria-label="Theme">
              {THEMES.map((id) => (
                <button
                  key={id}
                  role="radio"
                  aria-checked={theme === id}
                  aria-label={`${THEME_DEFINITIONS[id].name} theme`}
                  onClick={() => {
                    setTheme(id);
                    play("ui");
                  }}
                  className={clsx(
                    "focus-ring h-8 w-8 rounded-full border-2 transition-transform",
                    theme === id ? "border-ink scale-105" : "border-line-strong",
                  )}
                  style={{ background: THEME_DEFINITIONS[id].accent }}
                />
              ))}
            </div>
            <Button variant="ghost" size="sm" onClick={toggleSound} aria-pressed={soundEnabled}>
              <span aria-hidden>{soundEnabled ? "◉" : "◌"}</span>
              <span className="ml-1 text-xs">{soundEnabled ? "Sound on" : "Muted"}</span>
            </Button>
          </div>
          <nav className="grid grid-cols-2 gap-2" aria-label="Mobile">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setMenuOpen(false)}
                className="focus-ring rounded-xl border border-line bg-surface px-3 py-2.5 text-sm"
              >
                {item.label}
              </Link>
            ))}
          </nav>
          {session.authenticated ? (
            <div className="mt-3 flex items-center justify-between gap-3">
              <span className="text-xs text-muted">
                {session.walletAddress ? `${session.walletAddress.slice(0, 6)}…${session.walletAddress.slice(-4)}` : "Managed wallet"}
              </span>
              <DisconnectButton />
            </div>
          ) : null}
        </div>
      ) : null}
    </header>
  );
}

/**
 * Signed-in account menu: identity, wallet custody and the routes a player
 * actually needs, without turning the header into a dashboard.
 */
function AccountMenu() {
  const session = useSession();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const items = [
    { href: "/dashboard", label: "Dashboard" },
    { href: "/wallet", label: "Wallet" },
    { href: "/profile", label: "Profile" },
    { href: "/transactions", label: "Transactions" },
    { href: "/settings", label: "Settings" },
  ];

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="focus-ring flex items-center gap-2.5 rounded-2xl border border-line-strong bg-surface px-2 py-1.5 transition-colors hover:border-accent/60"
      >
        <Avatar name={session.username ?? "Player"} size={26} />
        <span className="hidden text-[13px] font-medium sm:block">{session.username}</span>
        <span className="numeric hidden text-[11px] text-accent sm:block">{session.rating}</span>
        <span aria-hidden className={clsx("hidden text-[10px] text-dim transition-transform sm:block", open && "rotate-180")}>
          ▾
        </span>
      </button>

      {open ? (
        <div
          role="menu"
          className="animate-rise panel absolute right-0 z-50 mt-2 w-64 overflow-hidden p-1.5"
        >
          <div className="px-3 py-2.5">
            <p className="truncate text-sm font-semibold">{session.username}</p>
            <p className="mt-0.5 truncate text-[11px] text-dim">
              {session.walletAddress
                ? `${session.walletAddress.slice(0, 6)}…${session.walletAddress.slice(-4)}`
                : "Managed wallet"}
              {session.custody === "managed" ? " · Chain Duel wallet" : " · External wallet"}
            </p>
          </div>
          <div className="my-1 hairline" />
          {items.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              role="menuitem"
              onClick={() => setOpen(false)}
              className={clsx(
                "focus-ring block rounded-xl px-3 py-2 text-[13px] transition-colors",
                pathname === item.href ? "bg-surface text-ink" : "text-muted hover:bg-surface hover:text-ink",
              )}
            >
              {item.label}
            </Link>
          ))}
          <div className="my-1 hairline" />
          <div className="px-1 py-1">
            <DisconnectButton />
          </div>
        </div>
      ) : null}
    </div>
  );
}
