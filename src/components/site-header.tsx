"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import dynamic from "next/dynamic";
import { Avatar, Button } from "./ui";
import { Icon, type IconName } from "./icons";
import { usePreferences, useSession } from "./providers";
import { SoundToggle } from "./sound-toggle";
import { THEME_DEFINITIONS, THEMES } from "@/lib/config/themes";
import type { AuthProviders } from "./auth/types";
import brandMark from "@/assets/brand/chain-duel-mark.png";

// Keep the existing wallet kit off the shared layout's initial bundle.
const SignInDialog = dynamic(() => import("./auth/sign-in-dialog").then((mod) => mod.SignInDialog), {
  ssr: false,
  loading: () => <Button size="sm" className="opacity-70">Sign in</Button>,
});
const DisconnectButton = dynamic(() => import("./wallet-connect").then((mod) => mod.DisconnectButton), {
  ssr: false,
  loading: () => <Button variant="secondary" size="sm" className="opacity-70">Sign out</Button>,
});

const NAV: { href: string; label: string; icon: IconName }[] = [
  { href: "/play", label: "Play", icon: "gamepad" },
  { href: "/players", label: "Players", icon: "users" },
  { href: "/leaderboard", label: "Leaderboard", icon: "trophy" },
  { href: "/profile", label: "Profile", icon: "user" },
  { href: "/how-to-play", label: "How to Play", icon: "book" },
  { href: "/transactions", label: "Transactions", icon: "transactions" },
];

function isActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`) || (href === "/play" && pathname === "/");
}

function menuKeys(event: KeyboardEvent<HTMLElement>) {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemradio"]'));
  if (!items.length) return;
  event.preventDefault();
  const current = items.indexOf(document.activeElement as HTMLElement);
  const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
    : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
  items[next]?.focus();
}

/** Dismiss overlays on touch, pointer or Escape and restore keyboard focus. */
function useDismiss(open: boolean, close: () => void) {
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef(close);
  useEffect(() => { closeRef.current = close; }, [close]);
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => containerRef.current?.querySelector<HTMLElement>('[role="menuitem"], [role="menuitemradio"]')?.focus());
    const pointer = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) closeRef.current();
    };
    const key = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        closeRef.current();
        triggerRef.current?.focus({ preventScroll: true });
      }
    };
    document.addEventListener("pointerdown", pointer);
    document.addEventListener("keydown", key);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", pointer);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  return { containerRef, triggerRef };
}

export function SiteHeader({ networkLabel, isTestnet, providers }: {
  networkLabel: string;
  isTestnet: boolean;
  providers: AuthProviders;
}) {
  const pathname = usePathname();
  const session = useSession();
  const { theme, setTheme, play } = usePreferences();
  const [menuOpen, setMenuOpen] = useState(false);
  const [themeOpen, setThemeOpen] = useState(false);
  const { containerRef: navigationRef, triggerRef: navigationTriggerRef } = useDismiss(menuOpen, () => setMenuOpen(false));
  const { containerRef: themeRef, triggerRef: themeTriggerRef } = useDismiss(themeOpen, () => setThemeOpen(false));
  const onMatch = pathname.startsWith("/match/");

  return (
    <>
      <header className="site-header">
        <div className="site-header__bar" ref={navigationRef}>
          <Link href="/" className="site-brand focus-ring" aria-label="Chain Duel home">
            <Image src={brandMark} alt="" aria-hidden preload quality={92} sizes="38px" />
            <span className="site-brand__name">CHAIN <span className="text-accent">DUEL</span></span>
          </Link>

          <nav className="desktop-navigation" aria-label="Main navigation">
            {NAV.map(({ href, label, icon }) => (
              <Link key={href} href={href} className="nav-link focus-ring" data-active={isActive(pathname, href)} aria-current={isActive(pathname, href) ? "page" : undefined}>
                <Icon name={icon} size={16} />{label}
              </Link>
            ))}
          </nav>

          <div className="header-controls">
            <span className="network-chip" title={networkLabel} aria-label={`Network: ${networkLabel}`}>
              {isTestnet ? networkLabel.replace(/^Stellar\s+/i, "") : networkLabel}
            </span>
            <div className="theme-control desktop-control" ref={themeRef}>
              <button ref={themeTriggerRef} type="button" className="theme-trigger focus-ring" aria-label="Change arena theme" aria-expanded={themeOpen} aria-haspopup="menu" aria-controls="theme-menu" onClick={() => { play("ui"); setThemeOpen((value) => !value); }}>
                <span className="theme-dot" style={{ background: THEME_DEFINITIONS[theme].accent }} aria-hidden />
                {THEME_DEFINITIONS[theme].name}<Icon name="chevron" size={12} />
              </button>
              {themeOpen ? (
                <div id="theme-menu" className="header-popover" role="menu" aria-label="Arena theme" onKeyDown={menuKeys}>
                  {THEMES.map((id) => (
                    <button key={id} type="button" role="menuitemradio" aria-checked={theme === id} onClick={() => { setTheme(id); setThemeOpen(false); play("ui"); themeTriggerRef.current?.focus(); }}>
                      <span className="theme-dot" style={{ background: THEME_DEFINITIONS[id].accent }} aria-hidden />
                      <span className="flex-1"><span className="block font-semibold">{THEME_DEFINITIONS[id].name}</span><span className="block text-xs text-dim">{THEME_DEFINITIONS[id].tagline}</span></span>
                      {theme === id ? <Icon name="check" size={16} /> : null}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            <div className="desktop-control"><SoundToggle /></div>
            {session.authenticated ? <AccountMenu /> : <SignInDialog providers={providers} label="Sign in" />}
            <button ref={navigationTriggerRef} type="button" className="menu-trigger focus-ring" aria-label={menuOpen ? "Close navigation menu" : "Open navigation menu"} aria-expanded={menuOpen} aria-controls="mobile-navigation" onClick={() => { setMenuOpen((value) => !value); setThemeOpen(false); }}>
              <Icon name={menuOpen ? "close" : "menu"} size={19} />
            </button>
          </div>

          {menuOpen ? (
            <div id="mobile-navigation" className="mobile-drawer">
              <nav aria-label="More navigation">
                {NAV.map(({ href, label, icon }) => (
                  <Link key={href} href={href} className="nav-link focus-ring" data-active={isActive(pathname, href)} aria-current={isActive(pathname, href) ? "page" : undefined} onClick={() => setMenuOpen(false)}>
                    <Icon name={icon} size={18} />{label}
                  </Link>
                ))}
              </nav>
              <div className="mobile-drawer__preferences">
                <div className="mobile-drawer__themes" role="radiogroup" aria-label="Arena theme" onKeyDown={(event) => {
                  if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
                  event.preventDefault();
                  const next = (THEMES.indexOf(theme) + (event.key === "ArrowRight" ? 1 : -1) + THEMES.length) % THEMES.length;
                  setTheme(THEMES[next]);
                  event.currentTarget.querySelectorAll<HTMLButtonElement>("button")[next]?.focus();
                }}>
                  {THEMES.map((id) => (
                    <button key={id} type="button" role="radio" tabIndex={theme === id ? 0 : -1} aria-checked={theme === id} aria-label={`${THEME_DEFINITIONS[id].name} theme`} onClick={() => { setTheme(id); play("ui"); }}>
                      <span className="theme-dot" style={{ background: THEME_DEFINITIONS[id].accent }} aria-hidden />
                    </button>
                  ))}
                </div>
                <SoundToggle />
              </div>
              {session.authenticated ? (
                <div className="mobile-drawer__wallet">
                  <Link href="/wallet" className="focus-ring inline-flex items-center gap-2 py-2" onClick={() => setMenuOpen(false)}><Icon name="wallet" size={16} />{session.walletAddress ? `${session.walletAddress.slice(0, 6)}…${session.walletAddress.slice(-4)}` : "Your wallet"}</Link>
                  <DisconnectButton />
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </header>

      {!onMatch ? (
        <nav className="mobile-tabbar" aria-label="Quick navigation">
          {NAV.slice(0, 4).map(({ href, label, icon }) => (
            <Link key={href} href={href} className="focus-ring" data-active={isActive(pathname, href)} aria-current={isActive(pathname, href) ? "page" : undefined} onClick={() => setMenuOpen(false)}>
              <Icon name={icon} size={20} /><span>{label}</span>
            </Link>
          ))}
        </nav>
      ) : null}
    </>
  );
}

function AccountMenu() {
  const session = useSession();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const { containerRef, triggerRef } = useDismiss(open, () => setOpen(false));
  const items: { href: string; label: string; icon: IconName }[] = [
    { href: "/dashboard", label: "Dashboard", icon: "gamepad" },
    { href: "/wallet", label: "Wallet", icon: "wallet" },
    { href: "/profile", label: "Profile", icon: "user" },
    { href: "/transactions", label: "Transactions", icon: "transactions" },
    { href: "/settings", label: "Settings", icon: "settings" },
    ...(session.isAdmin ? [{ href: "/admin/treasury", label: "Treasury", icon: "layers" as IconName }] : []),
  ];
  return (
    <div className="account-control" ref={containerRef}>
      <button ref={triggerRef} type="button" className="account-trigger focus-ring" aria-label={`Account menu for ${session.username ?? "Player"}`} aria-expanded={open} aria-haspopup="menu" aria-controls="account-menu" onClick={() => setOpen((value) => !value)}>
        <Avatar name={session.username ?? "Player"} size={26} />
        <span className="account-trigger__name">{session.username}</span>
      </button>
      {open ? (
        <div id="account-menu" className="header-popover" role="menu" aria-label="Account" onKeyDown={menuKeys}>
          <div className="account-identity"><strong>{session.username}</strong><p>{session.walletAddress ? `${session.walletAddress.slice(0, 8)}…${session.walletAddress.slice(-6)}` : "Managed wallet"}{session.custody === "managed" ? " · Chain Duel wallet" : " · External wallet"}</p><p>Duel Rating <span className="numeric text-accent">{session.rating}</span></p></div>
          <div className="hairline my-1" />
          {items.map(({ href, label, icon }) => <Link key={href} href={href} role="menuitem" aria-current={pathname === href ? "page" : undefined} onClick={() => setOpen(false)}><Icon name={icon} size={17} />{label}</Link>)}
          <div className="hairline my-1" /><div className="p-1"><DisconnectButton /></div>
        </div>
      ) : null}
    </div>
  );
}
