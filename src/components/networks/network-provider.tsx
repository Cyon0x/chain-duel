"use client";
import { createContext, useContext, useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import type { publicArcConfig } from "@/lib/arc/config";
import { useSession } from "../providers";
export type ArcPublicConfig = ReturnType<typeof publicArcConfig>;
interface NetworkContextValue {
  selected: "stellar" | "arc";
  stellarLabel: string;
  arc: ArcPublicConfig;
  socialAccount: boolean;
}
const NetworkContext = createContext<NetworkContextValue | null>(null);
export function NetworkProvider({
  value,
  children,
}: {
  value: NetworkContextValue;
  children: React.ReactNode;
}) {
  const path = usePathname();
  const session = useSession();
  const started = useRef<string | null>(null);
  useEffect(() => {
    if (
      !session.userId ||
      !value.socialAccount ||
      !value.arc.walletEnabled ||
      started.current === session.userId
    )
      return;
    started.current = session.userId;
    // Start provisioning after authentication, independently of Stellar onboarding.
    // Circle's authorization challenge is executed only when the user chooses to continue.
    void fetch("/api/arc/wallet/provision", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ networkId: value.arc.networkId, currency: "USDC" }),
    }).catch(() => {
      started.current = null;
    });
  }, [session.userId, value.arc.networkId, value.arc.walletEnabled, value.socialAccount]);
  const selected = path.startsWith("/arc/")
    ? "arc"
    : path.startsWith("/match/") || path.startsWith("/duel/")
      ? "stellar"
      : value.selected;
  return <NetworkContext.Provider value={{ ...value, selected }}>{children}</NetworkContext.Provider>;
}
export function useNetwork() {
  const context = useContext(NetworkContext);
  if (!context) throw new Error("Network context unavailable");
  return context;
}
export function networkHref(href: string, network: "stellar" | "arc") {
  if (network === "stellar") return href;
  if (href === "/play") return "/arc/play";
  if (["/dashboard", "/wallet", "/transactions", "/profile", "/leaderboard"].includes(href))
    return `/arc${href}`;
  return href;
}
