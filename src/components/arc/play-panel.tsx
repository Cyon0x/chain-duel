"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, ButtonLink, Panel, Spinner } from "../ui";
import { useNetwork } from "../networks/network-provider";
import { parseArcStake, formatUsdc, arcPoolSplit } from "@/lib/networks/arc";
import { arcFetch, arcBody } from "./client";
export function ArcPlayPanel() {
  const { arc, socialAccount } = useNetwork();
  const router = useRouter();
  const [amount, setAmount] = useState("5");
  const [mode, setMode] = useState<"pvp" | "private" | "bot">("pvp");
  const [code, setCode] = useState("");
  const [invited, setInvited] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ticket, setTicket] = useState<{ status: string; gameId: string | null } | null>(null);
  let reward: string | null = null;
  try {
    reward = formatUsdc(arcPoolSplit(parseArcStake(amount)).winner);
  } catch {}
  async function create() {
    setBusy(true);
    setError(null);
    try {
      parseArcStake(amount);
      if (mode === "pvp") {
        const result = await arcFetch<{ status: string; gameId: string | null }>("/api/arc/matchmaking", {
          method: "POST",
          body: arcBody(arc.networkId, { amount, gameType: "pulse", mode: "pvp" }),
        });
        setTicket(result);
        if (result.gameId) router.push(`/arc/match/${result.gameId}`);
      } else {
        const result = await arcFetch<{ game: { id: string } }>("/api/arc/games", {
          method: "POST",
          body: arcBody(arc.networkId, {
            amount,
            mode,
            gameType: "pulse",
            idempotencyKey: crypto.randomUUID(),
            ...(invited ? { invitedUserId: invited } : {}),
          }),
        });
        router.push(`/arc/match/${result.game.id}`);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function checkQueue() {
    try {
      const result = await arcFetch<{ status: string; gameId: string | null }>("/api/arc/matchmaking");
      setTicket(result);
      if (result.gameId) router.push(`/arc/match/${result.gameId}`);
    } catch (err) {
      setError((err as Error).message);
    }
  }
  async function cancelQueue() {
    try {
      setTicket(await arcFetch("/api/arc/matchmaking", { method: "DELETE" }));
    } catch (err) {
      setError((err as Error).message);
    }
  }
  return (
    <div className="arc-play-grid">
      <Panel className="arc-card">
        <p className="eyebrow">Pulse Duel · 60 seconds</p>
        <h2>Choose your Arc opponent</h2>
        {!arc.gamingEnabled ? (
          <p className="arc-notice" role="status">
            Arc gaming is awaiting wallet and escrow activation. No USDC stakes are being accepted.
          </p>
        ) : null}
        <div className="arc-mode-picker" role="group" aria-label="Arc game mode">
          {(["pvp", "private", "bot"] as const).map((value) => (
            <button
              type="button"
              key={value}
              className="focus-ring"
              aria-pressed={mode === value}
              onClick={() => setMode(value)}
            >
              {value === "pvp" ? "Online" : value === "private" ? "Friend / challenge" : "Computer"}
            </button>
          ))}
        </div>
        <label className="arc-label" htmlFor="arc-stake">
          Entry per player · USDC
        </label>
        <input
          id="arc-stake"
          className="arc-input numeric"
          inputMode="decimal"
          aria-describedby="arc-stake-limits"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
        />
        <p id="arc-stake-limits" className="text-sm text-muted">
          {reward
            ? `${reward} USDC to the winner. 5% protocol fee and 5% ecosystem fee.`
            : "Choose a stake from 0.50 to 1,000 USDC, with up to six decimal places."}
        </p>
        {mode === "private" ? (
          <>
            <label className="arc-label" htmlFor="arc-challenge">
              Challenge a player (optional account ID)
            </label>
            <input
              id="arc-challenge"
              className="arc-input"
              value={invited}
              onChange={(event) => setInvited(event.target.value)}
              placeholder="Leave empty to share a private invitation"
            />
          </>
        ) : null}
        <Button
          disabled={busy || !arc.gamingEnabled || !socialAccount || !reward}
          onClick={() => void create()}
        >
          {busy ? <Spinner /> : null}
          {mode === "pvp"
            ? "Find an Arc opponent"
            : mode === "bot"
              ? "Create computer duel"
              : "Create private duel"}
        </Button>
        <p className="text-xs text-dim">
          Creating a lobby takes no stake. You review and authorize your USDC approval and deposit in Circle.
        </p>
        {ticket && ticket.status !== "idle" ? (
          <div className="arc-review">
            <p role="status">
              {ticket.status === "searching"
                ? "Searching for an Arc opponent at your exact USDC stake."
                : ticket.status}
            </p>
            <div className="arc-actions">
              <Button variant="secondary" onClick={() => void checkQueue()}>
                Check matchmaking
              </Button>
              <Button variant="ghost" onClick={() => void cancelQueue()}>
                Leave queue
              </Button>
            </div>
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
      </Panel>
      <Panel className="arc-card">
        <h2>Join a friend’s duel</h2>
        <p>Your friend’s Arc invitation stays on Arc. Stellar games use their own lobbies and escrow.</p>
        <label className="arc-label" htmlFor="arc-code">
          Arc invitation code
        </label>
        <input
          id="arc-code"
          className="arc-input numeric"
          value={code}
          maxLength={8}
          onChange={(event) => setCode(event.target.value.toUpperCase())}
        />
        <Button
          variant="secondary"
          disabled={!arc.gamingEnabled || code.length !== 8}
          onClick={() => router.push(`/arc/match/${code}`)}
        >
          Open invitation
        </Button>
        <ButtonLink href="/arc/wallet" variant="ghost">
          Manage Arc wallet
        </ButtonLink>
      </Panel>
    </div>
  );
}
