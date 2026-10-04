import Link from "next/link";
import clsx from "clsx";
import { Avatar, Badge } from "@/components/ui";
import { formatXlm } from "@/lib/config/game";
import type {
  DirectoryPlayer,
  GameViewRow,
  MatchRowView,
  TransactionView,
} from "@/lib/api/views";

export function verdictTone(result: string): "success" | "danger" | "neutral" {
  if (result === "win") return "success";
  if (result === "loss") return "danger";
  return "neutral";
}

export function MatchRowItem({ match }: { match: MatchRowView }) {
  const isWin = match.result === "win";
  return (
    <Link
      href={match.game_id ? `/match/${match.game_id}` : "/profile"}
      className="focus-ring flex items-center gap-4 rounded-2xl border border-line bg-surface px-4 py-3 transition-colors hover:border-line-strong"
    >
      <span
        className={clsx(
          "grid h-9 w-9 shrink-0 place-items-center rounded-xl border text-xs font-bold",
          isWin ? "border-success/40 text-success" : match.result === "loss" ? "border-danger/40 text-danger" : "border-line-strong text-muted",
        )}
        aria-hidden
      >
        {isWin ? "W" : match.result === "loss" ? "L" : "D"}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">
          {match.opponent_label}
          {match.mode === "bot" ? <span className="ml-2 text-xs text-dim">VS COMPUTER</span> : null}
        </p>
        <p className="numeric mt-0.5 text-xs text-dim">
          {match.score_for.toLocaleString("en-US")} – {match.score_against.toLocaleString("en-US")} ·{" "}
          {relativeTime(match.created_at)}
        </p>
      </div>
      <div className="text-right">
        <p className={clsx("numeric text-sm font-semibold", match.reward_stroops > 0 ? "text-success" : "text-muted")}>
          {match.demo ? "Demo" : match.reward_stroops > 0 ? `+${formatXlm(match.reward_stroops)}` : `−${formatXlm(match.entry_stroops)}`}
        </p>
        {match.mode !== "bot" && match.rating_delta !== 0 ? (
          <p className={clsx("numeric text-[11px]", match.rating_delta > 0 ? "text-success" : "text-danger")}>
            {match.rating_delta > 0 ? "+" : ""}
            {match.rating_delta} rating
          </p>
        ) : (
          <p className="text-[11px] text-dim">Unrated</p>
        )}
      </div>
    </Link>
  );
}

const TX_LABELS: Record<string, string> = {
  deposit: "Deposit",
  transfer: "Wallet transfer",
  entry: "Duel entry",
  payout: "Winner payout",
  refund: "Refund",
  fee: "Protocol fee",
  bot_settlement: "Computer duel settlement",
  treasury_funding: "Treasury funding",
  treasury_withdrawal: "Treasury withdrawal",
};

export function TransactionItem({ tx }: { tx: TransactionView }) {
  const incoming = tx.direction === "in";
  return (
    <div className="flex items-center gap-4 rounded-2xl border border-line bg-surface px-4 py-3">
      <span
        aria-hidden
        className={clsx(
          "grid h-9 w-9 shrink-0 place-items-center rounded-xl border text-sm",
          incoming ? "border-success/40 text-success" : "border-line-strong text-muted",
        )}
      >
        {incoming ? "↓" : "↑"}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{TX_LABELS[tx.kind] ?? tx.kind}</p>
        <p className="numeric mt-0.5 text-xs text-dim">
          {relativeTime(tx.created_at)}
          {tx.game_id ? ` · ${tx.game_id.slice(0, 10)}` : ""}
        </p>
      </div>
      <div className="text-right">
        <p className={clsx("numeric text-sm font-semibold", incoming ? "text-success" : "text-ink")}>
          {tx.amount_stroops > 0 ? `${incoming ? "+" : "−"}${formatXlm(tx.amount_stroops)}` : "—"}
        </p>
        <TxStatus status={tx.status} demo={tx.demo === 1} hash={tx.tx_hash} />
      </div>
    </div>
  );
}

export function TxStatus({
  status,
  demo,
  hash,
}: {
  status: string;
  demo?: boolean;
  hash?: string | null;
}) {
  if (demo) return <Badge tone="neutral">Demo</Badge>;
  const tone =
    status === "confirmed" ? "success" : status === "failed" ? "danger" : "warning";
  const label =
    status === "confirmed"
      ? "Confirmed"
      : status === "failed"
        ? "Failed"
        : status.replace(/_/g, " ");
  const content = <Badge tone={tone}>{label}</Badge>;
  if (hash && status === "confirmed") {
    return (
      <a
        href={`https://stellar.expert/explorer/testnet/tx/${hash}`}
        target="_blank"
        rel="noreferrer"
        className="focus-ring inline-flex rounded-full"
      >
        {content}
      </a>
    );
  }
  return content;
}

export function PlayerCard({ player }: { player: DirectoryPlayer }) {
  const winRate = player.games_played ? Math.round((player.wins / player.games_played) * 100) : 0;
  return (
    <Link
      href={`/players/${player.username}`}
      className="focus-ring group flex flex-col gap-3 rounded-[18px] border border-line bg-surface px-4 py-4 transition-colors hover:border-accent/45"
    >
      <div className="flex items-center gap-3">
        <Avatar name={player.username} src={player.avatar} size={40} theme={player.theme} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{player.username}</p>
          <p className="numeric text-xs text-accent">{player.rating} rating</p>
        </div>
      </div>
      <dl className="grid grid-cols-4 gap-1 text-center">
        {[
          { label: "W", value: player.wins },
          { label: "L", value: player.losses },
          { label: "Win%", value: `${winRate}` },
          { label: "Streak", value: player.current_streak },
        ].map((stat) => (
          <div key={stat.label}>
            <dt className="text-[10px] uppercase tracking-[0.12em] text-dim">{stat.label}</dt>
            <dd className="numeric mt-0.5 text-sm">{stat.value}</dd>
          </div>
        ))}
      </dl>
      <div className="flex items-center justify-between text-xs text-dim">
        <span>Reputation {player.reputation}</span>
        <span className="text-accent opacity-0 transition-opacity group-hover:opacity-100">View →</span>
      </div>
    </Link>
  );
}

export function ActiveDuelCard({ game }: { game: GameViewRow }) {
  return (
    <Link
      href={`/match/${game.id}`}
      className="focus-ring flex items-center gap-4 rounded-2xl border border-accent/40 bg-accent-soft px-4 py-3"
    >
      <span aria-hidden className="grid h-9 w-9 place-items-center rounded-xl border border-accent/40 text-accent">
        ⚡
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">
          {game.mode === "bot" ? "Computer duel" : "Duel"} in progress
        </p>
        <p className="numeric mt-0.5 text-xs text-dim">
          {game.demo ? "Demo" : `${formatXlm(game.entry_stroops)} XLM entry`} · {game.status}
        </p>
      </div>
      <span className="text-sm font-medium text-accent">Resume →</span>
    </Link>
  );
}

export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const seconds = Math.max(1, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}
