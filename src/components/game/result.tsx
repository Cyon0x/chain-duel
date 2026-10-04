"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";
import clsx from "clsx";
import { Badge, Button, ButtonLink, Panel } from "@/components/ui";
import { useCountUp } from "@/lib/hooks/use-async";
import { api } from "@/lib/api/client";
import { txExplorerUrl } from "@/lib/explorer";
import { usePreferences } from "@/components/providers";
import type { MatchRowView, MatchView, TransactionView } from "@/lib/api/views";
import brandMark from "@/assets/brand/chain-duel-mark.png";

interface ResultProps {
  view: MatchView;
  selfUserId: string;
  onPlayAgain?: () => void;
}

interface HistoryResponse {
  dashboard: { profile: { rating: number; reputation: number } };
  history: { matches: MatchRowView[] };
  transactions: TransactionView[];
}

export function MatchResult({ view, selfUserId, onPlayAgain }: ResultProps) {
  const { play } = usePreferences();
  const self = view.players.find((player) => player.user_id === selfUserId) ?? view.players[0];
  const opponent = view.players.find((player) => player.user_id !== selfUserId) ?? view.players[1];
  const game = view.game;

  const selfScore = self?.score ?? 0;
  const opponentScore = opponent?.score ?? 0;
  const won = game.winner_id === selfUserId;
  // A computer win is recorded with a null winner_id (there is no human
  // winner), so it must be distinguished from a genuine tie before the draw
  // check — otherwise losing to the computer renders as "DRAW".
  const selfIsBot = Boolean(self && self.is_bot === 1);
  const botWon = !won && !selfIsBot && game.winner_id === null && game.mode === "bot";
  const isDraw = !won && !botWon && game.winner_id === null;
  const [payload, setPayload] = useState<HistoryResponse | null>(null);

  const displayScore = useCountUp(selfScore, 900);
  const displayOpponent = useCountUp(opponentScore, 900);

  useEffect(() => {
    if (won) play("victory");
    else play("defeat");
  }, [play, won]);

  useEffect(() => {
    let cancelled = false;
    api<HistoryResponse>("/api/profile?include=history")
      .then((value) => {
        if (!cancelled) setPayload(value);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const matchRow = payload?.history?.matches.find((row) => row.game_id === game.id) ?? null;
  const settlementTx = payload?.transactions?.find(
    (tx) => tx.game_id === game.id && (tx.kind === "payout" || tx.kind === "bot_settlement" || tx.kind === "entry") && tx.tx_hash,
  );
  const txHash = game.settle_tx_hash ?? matchRow?.settlement_tx_hash ?? settlementTx?.tx_hash ?? null;
  const explorer = txExplorerUrl(txHash);

  const pool = game.entry_stroops * 2;
  const title = won ? "WINNER" : botWon ? "COMPUTER WINS" : isDraw ? "DRAW" : "DEFEAT";

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      <Panel
        className={clsx(
          "relative overflow-hidden px-6 py-10 text-center",
          won ? "accent-glow" : undefined,
        )}
      >
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 -top-24 h-56 opacity-70"
          style={{
            background: won
              ? "radial-gradient(60% 100% at 50% 100%, var(--accent-soft), transparent 70%)"
              : "radial-gradient(60% 100% at 50% 100%, rgba(255,95,122,0.18), transparent 70%)",
          }}
        />
        <Image
          src={brandMark}
          alt=""
          aria-hidden
          quality={92}
          sizes="44px"
          className="relative mx-auto mb-3 block h-11 w-auto"
        />
        <p className="eyebrow">{game.demo ? "Demo duel" : "Pulse Duel"}</p>
        <h1
          className={clsx(
            "text-display mt-3 text-5xl sm:text-6xl",
            won ? "text-accent" : isDraw ? "text-ink" : "text-danger",
          )}
        >
          {title}
        </h1>
        <p className="mt-3 text-sm text-muted">
          vs {opponent?.username ?? "Opponent"}
          {game.mode === "bot" ? " · VS COMPUTER" : ""}
        </p>

        <div className="mx-auto mt-8 grid max-w-md grid-cols-[1fr_auto_1fr] items-center gap-4">
          <div>
            <p className="eyebrow">You</p>
            <p className="numeric mt-1 text-4xl font-semibold text-accent">{displayScore.toLocaleString("en-US")}</p>
          </div>
          <span className="text-dim">—</span>
          <div>
            <p className="eyebrow">Opponent</p>
            <p className="numeric mt-1 text-4xl font-semibold">{displayOpponent.toLocaleString("en-US")}</p>
          </div>
        </div>
      </Panel>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Panel className="px-4 py-3.5">
          <p className="eyebrow">Prize pool</p>
          <p className="numeric mt-2 text-xl font-semibold">{xlm(pool)} XLM</p>
        </Panel>
        <Panel className="px-4 py-3.5">
          <p className="eyebrow">Your reward</p>
          <p className={clsx("numeric mt-2 text-xl font-semibold", won ? "text-success" : "text-muted")}>
            {game.demo ? "Demo" : `${xlm(won ? game.payout_stroops : 0)} XLM`}
          </p>
        </Panel>
        <Panel className="px-4 py-3.5">
          <p className="eyebrow">Protocol fee</p>
          <p className="numeric mt-2 text-xl font-semibold text-muted">
            {game.demo ? "—" : `${xlm(game.fee_stroops)} XLM`}
          </p>
        </Panel>
        <Panel className="px-4 py-3.5">
          <p className="eyebrow">Rating</p>
          <p
            className={clsx(
              "numeric mt-2 text-xl font-semibold",
              (matchRow?.rating_delta ?? 0) > 0 ? "text-success" : (matchRow?.rating_delta ?? 0) < 0 ? "text-danger" : "text-muted",
            )}
          >
            {game.mode === "bot"
              ? "Unrated"
              : `${(matchRow?.rating_delta ?? 0) >= 0 ? "+" : ""}${matchRow?.rating_delta ?? 0}`}
          </p>
        </Panel>
      </div>

      <Panel className="flex flex-col gap-3 px-5 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="eyebrow">Settlement</p>
            <p className="mt-1.5 text-sm text-muted">
              {game.demo
                ? "Demo duel — no Testnet funds moved."
                : txHash
                  ? "Settled on Stellar Testnet."
                  : "Settlement is still confirming."}
            </p>
          </div>
          {game.demo ? (
            <Badge tone="neutral">Demo</Badge>
          ) : txHash ? (
            <Badge tone="success">Confirmed</Badge>
          ) : (
            <Badge tone="warning">Pending</Badge>
          )}
        </div>
        {explorer ? (
          <a
            href={explorer}
            target="_blank"
            rel="noreferrer"
            className="focus-ring numeric truncate rounded-xl border border-line bg-surface px-3 py-2 text-xs text-accent hover:border-accent"
          >
            {txHash}
          </a>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {onPlayAgain ? (
            <Button onClick={onPlayAgain} variant="secondary">
              Play again
            </Button>
          ) : (
            <ButtonLink href="/play" variant="secondary">
              Play again
            </ButtonLink>
          )}
          <ButtonLink href="/dashboard" variant="secondary">
            Back to dashboard
          </ButtonLink>
          <Link href="/transactions" className="focus-ring self-center text-sm text-accent hover:underline">
            View transactions →
          </Link>
        </div>
      </Panel>
    </div>
  );
}

function xlm(stroops: number): string {
  return (stroops / 10_000_000).toLocaleString("en-US", { maximumFractionDigits: 2 });
}
