import Image from "next/image";
import type { Metadata, Viewport } from "next";
import "./globals.css";
import { GameCursor } from "@/components/game-cursor";
import { PreferencesProvider, SessionProvider } from "@/components/providers";
import { SiteHeader } from "@/components/site-header";
import { getSessionUser } from "@/lib/auth/session";
import { persistenceStatus } from "@/lib/db";
import { appUrl, demoModeEnabled, integrationStatus, isProduction } from "@/lib/config/env";
import { publicStellarConfig } from "@/lib/config/stellar";
import { isThemeId } from "@/lib/config/themes";
import brandMark from "@/assets/brand/chain-duel-mark.png";

const TITLE = "Chain Duel — Compete. React. Duel.";
const DESCRIPTION =
  "Chain Duel is a skill-based 1v1 competitive arcade game with real Stellar Testnet escrow, settlement and rewards.";

export const metadata: Metadata = {
  metadataBase: new URL(appUrl()),
  title: TITLE,
  description: DESCRIPTION,
  applicationName: "Chain Duel",
  openGraph: {
    type: "website",
    siteName: "Chain Duel",
    title: TITLE,
    description: DESCRIPTION,
    url: appUrl(),
  },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION },
};

export const viewport: Viewport = {
  themeColor: "#05070c",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Reading the session touches the database. If persistence is down we still
  // render the chrome and let pages surface their own error state.
  const session = await getSessionUser().catch(() => null);
  const network = publicStellarConfig();
  const integrations = integrationStatus();
  const theme = isThemeId(session?.profile?.theme) ? session.profile.theme : "neon";
  const persistence = await persistenceStatus();
  // Only warn when durable persistence is genuinely unavailable — never to
  // advertise deployment instructions to players.
  const storageWarning = isProduction() && !persistence.available;

  return (
    <html lang="en" data-theme={theme} suppressHydrationWarning>
      <body>
        <PreferencesProvider initialTheme={theme}>
          <SessionProvider
            value={{
              authenticated: Boolean(session),
              userId: session?.user.id ?? null,
              username: session?.profile?.username ?? null,
              walletAddress: session?.primaryWallet?.address ?? null,
              custody: (session?.primaryWallet?.custody as "external" | "managed" | undefined) ?? null,
              isAdmin: session?.user.is_admin === 1,
              rating: session?.profile?.rating ?? 1000,
              onboardingComplete: session?.profile?.onboarding_complete === 1,
            }}
          >
            <GameCursor />
            <SiteHeader
              networkLabel={network.label}
              isTestnet={network.isTestnet}
              providers={{
                google: integrations.google,
                x: integrations.x,
                demoMode: demoModeEnabled(),
              }}
            />
            {storageWarning ? (
              <div className="mx-auto w-full max-w-7xl px-4 pt-4 sm:px-6">
                <p
                  role="status"
                  className="rounded-2xl border border-danger/40 bg-danger/10 px-4 py-3 text-xs text-danger"
                >
                  <span className="font-semibold">Chain Duel is temporarily unavailable.</span> We cannot reach the
                  game database right now, so signing in and staked duels are paused. Please try again in a moment.
                </p>
              </div>
            ) : null}
            <main className="mx-auto w-full max-w-7xl px-4 pb-24 pt-6 sm:px-6">{children}</main>
            <footer className="border-t border-line px-4 py-8 sm:px-6">
              <div className="mx-auto flex max-w-7xl flex-col gap-3 text-xs text-dim sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-2.5">
                  <Image
                    src={brandMark}
                    alt=""
                    aria-hidden
                    quality={92}
                    sizes="20px"
                    className="h-5 w-auto opacity-80"
                  />
                  <p>
                    Chain Duel runs on {network.label}. Testnet assets carry no real-world value.
                  </p>
                </div>
                <nav className="flex flex-wrap gap-4" aria-label="Legal">
                  <a className="hover:text-muted" href="/how-to-play">How to Play</a>
                  <a className="hover:text-muted" href="/rules">Game Rules</a>
                  <a className="hover:text-muted" href="/terms">Terms</a>
                  <a className="hover:text-muted" href="/privacy">Privacy</a>
                </nav>
              </div>
            </footer>
          </SessionProvider>
        </PreferencesProvider>
      </body>
    </html>
  );
}
