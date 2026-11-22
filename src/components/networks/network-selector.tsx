"use client";
import { useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useNetwork, networkHref } from "./network-provider";
export function NetworkSelector() {
  const network = useNetwork();
  const router = useRouter();
  const path = usePathname();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function select(next: "stellar" | "arc") {
    if (next === network.selected) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/networks/select", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ network: next }),
      });
      if (!response.ok) throw new Error("Network selection failed. Please retry.");
      const base = path.startsWith("/arc/") ? path.slice(4) : path;
      const destination = [
        "/dashboard",
        "/wallet",
        "/transactions",
        "/profile",
        "/leaderboard",
        "/play",
      ].includes(base)
        ? base
        : "/dashboard";
      router.push(networkHref(destination, next));
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="network-selector">
      <label className="sr-only" htmlFor="network-select">
        Gaming network
      </label>
      <select
        id="network-select"
        className="focus-ring"
        value={network.selected}
        disabled={busy || path.includes("/match/")}
        onChange={(event) => void select(event.target.value as "stellar" | "arc")}
      >
        <option value="stellar">
          {network.stellarLabel === "Stellar Public Network" ? "Stellar Mainnet" : network.stellarLabel}
        </option>
        <option value="arc">{network.arc.name}</option>
      </select>
      {error ? (
        <p role="alert" className="network-selector__error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
