"use client";
import { useCallback, useEffect, useState } from "react";
import { Button, ButtonLink, Panel, Spinner } from "../ui";
import { PulseArena } from "../game/arena";
import { useSession } from "../providers";
import { useNetwork } from "../networks/network-provider";
import { formatUsdc, arcPoolSplit } from "@/lib/networks/arc";
import type { ArcGameRow, ArcPlayerRow, ArcOperationRow } from "@/lib/arc/types";
import type { ArenaView } from "../game/arena";
import { arcFetch, arcBody, executeCircle } from "./client";
type View = Omit<ArenaView, "game" | "players"> & {
  game: ArcGameRow;
  players: (ArcPlayerRow & { username: string })[];
};
export function ArcMatchStage({ id }: { id: string }) {
  const session = useSession();
  const { arc } = useNetwork();
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState<ArcOperationRow | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      setView(await arcFetch<View>(`/api/arc/games/${encodeURIComponent(id)}`));
    } catch (err) {
      setError((err as Error).message);
    }
  }, [id]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, [refresh]);
  async function action(action: "approve" | "entry" | "cancel" | "refund") {
    setBusy(true);
    setError(null);
    try {
      const response = await arcFetch<{ operation: ArcOperationRow }>(`/api/arc/games/${id}/entry`, {
        method: "POST",
        body: arcBody(arc.networkId, { action }),
      });
      setReview(response.operation);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function authorize() {
    if (!review) return;
    setBusy(true);
    setError(null);
    setStatus("Awaiting wallet approval");
    try {
      await executeCircle(
        await arcFetch<Parameters<typeof executeCircle>[0]>(`/api/arc/operations/${review.id}`, {
          method: "POST",
          body: arcBody(arc.networkId),
        }),
      );
      setStatus("Submitted · checking Arc confirmation");
      for (let attempt = 0; attempt < 20; attempt++) {
        const { operation } = await arcFetch<{ operation: ArcOperationRow }>(
          `/api/arc/operations/${review.id}`,
        );
        if (operation.status === "failed") throw new Error(operation.error ?? "Arc transaction failed.");
        if (operation.status === "confirmed") {
          setReview(null);
          setStatus("Confirmed on Arc");
          await refresh();
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      setStatus("Confirmation is pending. Your transaction is saved; retry to check it.");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function join() {
    setBusy(true);
    setError(null);
    try {
      await arcFetch(`/api/arc/games/${id}/join`, { method: "POST", body: arcBody(arc.networkId) });
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function start() {
    setBusy(true);
    setError(null);
    try {
      await arcFetch(`/api/arc/games/${id}/start`, { method: "POST", body: arcBody(arc.networkId) });
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!view)
    return (
      <Panel className="arc-card">
        <Spinner />
        <p>Loading Arc duel…</p>
        {error ? (
          <p role="alert" className="text-danger">
            {error}
          </p>
        ) : null}
      </Panel>
    );
  const self = view.players.find((p) => p.user_id === session.userId);
  const split = arcPoolSplit(BigInt(view.game.stake_units));
  if (view.game.status === "active" && self && self.score === null)
    return (
      <PulseArena
        view={view}
        selfUserId={session.userId!}
        apiBase="/api/arc/games"
        entryLabel={`${formatUsdc(view.game.stake_units)} USDC entry · ${formatUsdc(split.pool)} USDC pool · ${arc.name}`}
        onFinished={() => void refresh()}
      />
    );
  return (
    <Panel className="arc-card">
      <p className="eyebrow">{arc.name} · Pulse Duel</p>
      <h1>
        {view.game.status === "settled"
          ? self
            ? view.game.winner_id === session.userId
              ? "You won"
              : "You lost"
            : "Duel complete"
          : "Arc duel lobby"}
      </h1>
      <p className="numeric">
        {formatUsdc(view.game.stake_units)} USDC per player · {formatUsdc(split.winner)} USDC winner reward
      </p>
      <div className="arc-player-list">
        {view.players.map((p) => (
          <div key={p.seat}>
            <strong>{p.username}</strong>
            <span>
              {view.game.status === "settled" ? `${p.user_id === view.game.winner_id ? "Won" : "Lost"} · ` : ""}
              {p.score !== null ? `${p.score} points` : p.funded ? "Stake confirmed" : "Stake not deposited"}
            </span>
          </div>
        ))}
      </div>
      {view.game.status === "settled" ? (
        <>
          <p>
            Settlement is confirmed. Protocol and ecosystem each receive {formatUsdc(split.protocol)} USDC.
          </p>
          {view.game.settle_tx_hash ? (
            <a
              className="focus-ring text-accent"
              href={`${arc.explorer}/tx/${view.game.settle_tx_hash}`}
              target="_blank"
              rel="noreferrer"
            >
              Verify settlement
            </a>
          ) : null}
          <ButtonLink href="/arc/play">Play again</ButtonLink>
        </>
      ) : view.game.status === "refunded" ? (
        <>
          <p>The escrow has refunded this duel.</p>
          <ButtonLink href="/arc/play">Find another duel</ButtonLink>
        </>
      ) : (
        <>
          {self && !self.funded ? (
            <div className="arc-actions">
              <Button disabled={busy} onClick={() => void action("approve")}>
                1. Approve USDC stake
              </Button>
              <Button disabled={busy} variant="secondary" onClick={() => void action("entry")}>
                2. Deposit stake
              </Button>
            </div>
          ) : null}
          {!self ? (
            <Button disabled={busy} onClick={() => void join()}>
              Join this Arc duel
            </Button>
          ) : null}
          {view.game.status === "joined" ? (
            <Button disabled={busy} onClick={() => void start()}>
              Start Pulse Duel
            </Button>
          ) : null}
          {view.game.status === "waiting" ? (
            <>
              <p>
                Waiting for an Arc opponent. Share this link or code{" "}
                <strong className="numeric">{view.game.code}</strong>.
              </p>
              <input
                className="arc-share"
                readOnly
                aria-label="Arc duel invitation link"
                value={
                  typeof window === "undefined" ? "" : `${window.location.origin}/arc/match/${view.game.id}`
                }
              />
            </>
          ) : null}
          {(view.game.status === "active" || view.game.status === "finished") && self?.score !== null ? (
            <p role="status">
              Your verified score is saved.{" "}
              {view.game.status === "finished"
                ? "Checking settlement confirmation…"
                : "Waiting for your opponent’s result…"}
            </p>
          ) : null}
          {self?.funded ? (
            <div className="arc-actions">
              {view.game.creator_id === session.userId &&
              (view.game.status === "waiting" ||
                (view.game.mode === "bot" && view.game.status === "joined")) ? (
                <Button variant="secondary" disabled={busy} onClick={() => void action("cancel")}>
                  Cancel & refund
                </Button>
              ) : null}
              <Button variant="ghost" disabled={busy} onClick={() => void action("refund")}>
                Check timed refund eligibility
              </Button>
            </div>
          ) : null}
        </>
      )}
      {review ? (
        <section className="arc-review" aria-label="Review Arc transaction">
          <h2>Review {review.action === "approve" ? "USDC approval" : review.action}</h2>
          <p>
            {review.action === "approve"
              ? `Allow the game escrow to spend exactly ${formatUsdc(view.game.stake_units)} USDC.`
              : `${formatUsdc(review.amount_units)} USDC · ${arc.name}`}
          </p>
          <p className="arc-contract">Contract: {review.target}</p>
          <p>Circle will ask you to authorize this transaction. Network fees are paid in USDC.</p>
          <div className="arc-actions">
            <Button disabled={busy} onClick={() => void authorize()}>
              {busy ? <Spinner /> : null}Approve in Circle
            </Button>
            <Button disabled={busy} variant="ghost" onClick={() => setReview(null)}>
              Back
            </Button>
          </div>
        </section>
      ) : null}
      {status ? (
        <p role="status" className="text-sm text-accent">
          {status}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </Panel>
  );
}
