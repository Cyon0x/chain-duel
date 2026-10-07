"use client";

import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { Button, ButtonLink, EmptyState, LoadingBlock, Panel, Spinner } from "@/components/ui";
import { api } from "@/lib/api/client";
import { useAsync } from "@/lib/hooks/use-async";
import { EscrowStatus } from "@/components/escrow-status";
import { runEscrow, type EscrowStep } from "@/lib/wallet/escrow-client";
import { useSession } from "@/components/providers";
import { isResultFinal } from "@/lib/game/outcome";
import { PulseArena } from "./arena";
import { MatchResult } from "./result";
import type { MatchView, SubmitResponse } from "@/lib/api/views";

const LOCK_RETRIES = 5;

/**
 * Owns the duel lifecycle: lock entry → lobby → countdown/arena → settlement.
 *
 * The server view is the only source of truth here. The result screen is
 * rendered exclusively from a *settled* game (see `isResultFinal`); while a
 * settlement is still confirming we show a progress panel and keep polling
 * instead of guessing an outcome from a half-written game row.
 */
export function MatchStage({ gameId, selfUserId }: { gameId: string; selfUserId: string | null }) {
  const router = useRouter();
  const session = useSession();
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<EscrowStep>("idle");
  const [actionError, setActionError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [waitingForOpponent, setWaitingForOpponent] = useState(false);

  const { data: view, error, loading, reload } = useAsync<MatchView>(
    () => api<MatchView>(`/api/matches/${gameId}`),
    [gameId],
    {
      pollMs: 4000,
      // Once the result is authoritative there is nothing left to poll for.
      shouldPoll: (current) => !current || !isResultFinal(current.game),
    },
  );

  const self = useMemo(
    () => view?.players.find((player) => player.user_id === selfUserId) ?? null,
    [selfUserId, view],
  );

  const selfLocked = useMemo(() => {
    if (!view || !self) return false;
    return self.seat === 1 ? view.escrow.creator : view.escrow.joiner;
  }, [self, view]);

  const enter = useCallback(async () => {
    if (!view || !self) return;
    setBusy(true);
    setActionError(null);
    try {
      if (!selfLocked) {
        let lastError: unknown = null;
        for (let attempt = 0; attempt < LOCK_RETRIES; attempt += 1) {
          try {
            await runEscrow({
              gameId,
              address: session.walletAddress ?? "",
              role: self.seat === 1 ? "creator" : "joiner",
              onStep: setStep,
            });
            lastError = null;
            break;
          } catch (caught) {
            lastError = caught;
            const message = caught instanceof Error ? caught.message : "";
            // A joiner can arrive before the creator's on-chain game exists.
            if (!/does not exist|not found|already/i.test(message)) throw caught;
            setStep("preparing");
            await new Promise((resolve) => window.setTimeout(resolve, 2_000));
            await reload();
          }
        }
        if (lastError) throw lastError;
      }
      await api<MatchView>(`/api/matches/${gameId}/start`, { method: "POST" });
      await reload();
      setStep("idle");
    } catch (caught) {
      setStep("failed");
      setActionError(caught instanceof Error ? caught.message : "Could not start the duel.");
    } finally {
      setBusy(false);
    }
  }, [gameId, reload, self, selfLocked, session.walletAddress, view]);

  const onFinished = useCallback(
    async (response: SubmitResponse) => {
      // Until the next view arrives we must never fall back to the arena, which
      // would restart the duel from a fresh client session.
      setSubmitted(true);
      setWaitingForOpponent(!response.settled);
      await reload();
      setSubmitted(false);
    },
    [reload],
  );

  if (loading && !view) return <LoadingBlock label="Loading duel" />;
  if (error && !view) {
    return (
      <EmptyState
        icon="⚠"
        title="Duel unavailable"
        description={error}
        action={
          <ButtonLink href="/play" variant="secondary">
            Back to play
          </ButtonLink>
        }
      />
    );
  }
  if (!view) return null;

  const game = view.game;

  if (game.status === "cancelled" || game.status === "expired" || game.status === "refunded") {
    return (
      <EmptyState
        icon="◇"
        title="This duel ended early"
        description="The duel was cancelled or expired and any escrowed entry was returned to its owner."
        action={
          <ButtonLink href="/play" variant="secondary">
            Find another duel
          </ButtonLink>
        }
      />
    );
  }

  // Authoritative result only — WIN / LOSE / DRAW can never be guessed here.
  if (isResultFinal(game)) {
    if (!selfUserId) return <LoadingBlock />;
    return <MatchResult view={view} selfUserId={selfUserId} onPlayAgain={() => router.push("/play")} />;
  }

  if (submitted || game.status === "finished") {
    return (
      <SettlementPendingPanel
        title={game.status === "finished" ? "Settling the duel" : "Verifying result"}
        body="Replaying both event logs and confirming settlement on Stellar. This updates automatically."
        onRetry={() => reload()}
      />
    );
  }

  if (game.status === "active" && selfUserId) {
    if (waitingForOpponent) {
      return (
        <SettlementPendingPanel
          title="Result submitted"
          body="Waiting for your opponent to finish. Settlement runs automatically the moment both event logs are verified."
          onRetry={() => reload()}
        />
      );
    }
    return <PulseArena view={view} selfUserId={selfUserId} onFinished={onFinished} />;
  }

  const bots = view.players.filter((player) => player.is_bot === 1);
  const humans = view.players.filter((player) => player.is_bot !== 1);
  const opponentReady = game.mode === "bot" || humans.length >= 2;

  return (
    <Panel className="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-8">
      <div className="text-center">
        <p className="eyebrow">{game.demo ? "Demo duel" : "Pulse Duel"}</p>
        <h1 className="text-display mt-2 text-3xl">
          {humans[0]?.username ?? "Player"} <span className="text-dim">vs</span>{" "}
          {bots.length ? `${bots[0].username} · CPU` : humans[1]?.username ?? "Waiting"}
        </h1>
        <p className="mt-2 text-sm text-muted">
          {game.mode === "bot"
            ? "The computer plays the same deterministic target stream as you."
            : "Both players receive the same target sequence. Highest verified score wins."}
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {view.players.map((player) => {
          const locked = player.seat === 1 ? view.escrow.creator : view.escrow.joiner;
          return (
            <div key={player.id} className="panel-flat flex items-center justify-between px-4 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{player.username}</p>
                <p className="text-xs text-dim">
                  {player.is_bot === 1 ? "Chain Duel computer" : `${player.rating || 1000} rating`}
                </p>
              </div>
              <span
                className={`rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] ${
                  locked ? "border-success/40 text-success" : "border-line-strong text-dim"
                }`}
              >
                {player.is_bot === 1 ? "Funded" : locked ? "Locked" : "Not locked"}
              </span>
            </div>
          );
        })}
      </div>

      <div className="panel-flat px-4 py-3 text-sm">
        <div className="flex items-center justify-between">
          <span className="text-muted">Entry</span>
          <span className="numeric">
            {game.demo ? "Demo (no stake)" : `${xlm(game.entry_stroops)} XLM each`}
          </span>
        </div>
        <div className="mt-2 flex items-center justify-between">
          <span className="text-muted">Prize pool</span>
          <span className="numeric">{game.demo ? "—" : `${xlm(game.entry_stroops * 2)} XLM`}</span>
        </div>
      </div>

      <EscrowStatus step={step} error={actionError} />

      <div className="flex flex-col items-center gap-2">
        <Button size="lg" loading={busy} onClick={enter} disabled={!opponentReady || step === "confirmed"}>
          {!selfLocked && !game.demo
            ? `Lock entry · ${xlm(game.entry_stroops)} XLM`
            : game.mode === "bot"
              ? "Start duel vs computer"
              : "Start duel"}
        </Button>
        {!opponentReady ? (
          <p className="text-xs text-dim">Waiting for an opponent to accept the invitation…</p>
        ) : (
          <p className="text-xs text-dim">
            {selfLocked
              ? "Your entry is locked in escrow."
              : "Your wallet will ask you to sign the escrow transaction."}
          </p>
        )}
      </div>
    </Panel>
  );
}

function SettlementPendingPanel({
  title,
  body,
  onRetry,
}: {
  title: string;
  body: string;
  onRetry: () => void;
}) {
  return (
    <Panel className="mx-auto flex max-w-md flex-col items-center gap-3 px-6 py-10 text-center">
      <Spinner className="text-accent" />
      <h1 className="text-lg font-semibold">{title}</h1>
      <p className="text-sm text-muted">{body}</p>
      <Button variant="secondary" onClick={onRetry}>
        Check again
      </Button>
    </Panel>
  );
}

function xlm(stroops: number): string {
  return (stroops / 10_000_000).toLocaleString("en-US", { maximumFractionDigits: 2 });
}
