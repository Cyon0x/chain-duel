"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Panel, ButtonLink } from "../ui";
import { Icon } from "../icons";
import { useNetwork } from "../networks/network-provider";
import { useSession } from "../providers";
import { ArcWalletPanel } from "./wallet-panel";
import { ArcPlayPanel } from "./play-panel";
import { ArcMatchStage } from "./match-stage";
import { arcFetch } from "./client";
import { formatUsdc } from "@/lib/networks/arc";
import type { ArcGameRow } from "@/lib/arc/types";
interface Transaction {
  id: string;
  kind: string;
  amount_units: string;
  status: string;
  tx_hash: string | null;
  direction: string;
  created_at: string;
}
export function ArcSection({ section, id }: { section: string; id?: string }) {
  const { arc, socialAccount } = useNetwork();
  const session = useSession();
  const [games, setGames] = useState<ArcGameRow[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  useEffect(() => {
    if (!socialAccount) return;
    void Promise.all([
      arcFetch<{ games: ArcGameRow[] }>("/api/arc/games"),
      arcFetch<{ transactions: Transaction[] }>("/api/arc/wallet"),
    ])
      .then(([a, b]) => {
        setGames(a.games);
        setTransactions(b.transactions);
        setHistoryLoaded(true);
      })
      .catch((err) => setError((err as Error).message));
  }, [socialAccount, section]);
  if (section === "match" && id) return <ArcMatchStage id={id} />;
  const title =
    section === "wallet"
      ? "Your Arc wallet"
      : section === "play"
        ? "Choose your Arc duel"
        : section === "transactions"
          ? "Arc transactions"
          : section === "profile"
            ? "One profile, two ecosystems"
            : section === "leaderboard"
              ? "Arc leaderboard"
              : "Enter the Arc arena";
  return (
    <div className="arc-section">
      <header className="arc-section__header">
        <div>
          <p className="eyebrow">Chain Duel · {arc.name}</p>
          <h1 className="text-display">{title}</h1>
          <p>
            {section === "wallet"
              ? "Receive USDC and authorize transactions with your Circle wallet."
              : section === "play"
                ? "Same Pulse Duel. Independent USDC escrow and Arc opponents."
                : "Competitive gaming across ecosystems. Your account connects Stellar and Arc."}
          </p>
        </div>
        <span className="arc-network-label">
          <Icon name="layers" size={16} />
          {arc.name} · USDC
        </span>
      </header>
      {section === "dashboard" && !arc.gamingEnabled ? (
        <p className="arc-notice" role="status">
          {arc.walletEnabled
            ? "Arc wallets are available. Gaming is awaiting final wallet transaction verification."
            : "Arc wallets and USDC gaming are awaiting activation."}{" "}
          Your existing Stellar games remain available.
        </p>
      ) : null}
      {section === "wallet" && !arc.walletEnabled ? (
        <p className="arc-notice" role="status">
          Arc wallet setup is awaiting activation. You can sign in to your shared Chain Duel account and
          continue playing on Stellar.
        </p>
      ) : null}
      {section === "wallet" ? (
        <ArcWalletPanel />
      ) : section === "play" ? (
        <ArcPlayPanel />
      ) : section === "transactions" ? (
        <Panel className="arc-card">
          <h2>Your USDC ledger</h2>
          <p>Entries, payouts and refunds are confirmed only after Arc settlement.</p>
          {transactions.length ? (
            transactions.map((tx) => (
              <div key={tx.id} className="arc-transaction">
                <div>
                  <strong>{tx.kind.replaceAll("_", " ")}</strong>
                  <span>{tx.status}</span>
                </div>
                <p className="numeric">{formatUsdc(tx.amount_units)} USDC</p>
                {tx.tx_hash ? (
                  <a
                    href={`${arc.explorer}/tx/${tx.tx_hash}`}
                    target="_blank"
                    rel="noreferrer"
                    className="focus-ring text-accent"
                  >
                    View transaction
                  </a>
                ) : null}
              </div>
            ))
          ) : (
            <p className="arc-empty">
              {!socialAccount
                ? "Sign in with Google or X to view your Arc transactions."
                : historyLoaded
                  ? "No Arc transactions recorded."
                  : "Loading Arc transaction history…"}
            </p>
          )}
        </Panel>
      ) : section === "leaderboard" ? (
        <ArcLeaderboard />
      ) : section === "profile" ? (
        <>
          <Panel className="arc-card">
            <h2>{session.username ?? "Your Chain Duel profile"}</h2>
            {session.userId ? (
              <p>
                Account ID: <span className="arc-contract">{session.userId}</span>
              </p>
            ) : (
              <>
                <p>Sign in to view your account and both game histories.</p>
                <ButtonLink href="/arc/login">Sign in</ButtonLink>
              </>
            )}
            <p>
              Your Stellar wallet and history remain associated with this account. Arc uses its own wallet and
              USDC game records.
            </p>
            <div className="arc-actions">
              <ButtonLink href="/arc/wallet" variant="secondary">
                Arc wallet
              </ButtonLink>
              <ButtonLink href="/arc/transactions" variant="ghost">
                Arc transactions
              </ButtonLink>
            </div>
          </Panel>
          <ArcGameList games={games} loaded={historyLoaded} authenticated={socialAccount} />
        </>
      ) : (
        <>
          <Panel className="arc-card arc-dashboard-core">
            <div>
              <Icon name="gamepad" size={34} />
              <h2>Pulse Duel on Arc</h2>
              <p>
                Race through sixty seconds of targets and combos. Your opponent, stake and settlement all stay
                on your selected network.
              </p>
              <div className="arc-actions">
                <ButtonLink href="/arc/play">Explore Arc games</ButtonLink>
                <ButtonLink href="/arc/wallet" variant="secondary">
                  Open Arc wallet
                </ButtonLink>
                <ButtonLink href="/bridge" variant="ghost">
                  Cross-chain USDC
                </ButtonLink>
              </div>
            </div>
            <div className="arc-economy">
              <p className="eyebrow">Arc prize pool</p>
              <strong className="numeric">
                90<span>%</span>
              </strong>
              <p>To the winner</p>
              <div>
                <span>Protocol</span>
                <span>5%</span>
              </div>
              <div>
                <span>Ecosystem</span>
                <span>5%</span>
              </div>
            </div>
          </Panel>
          {!socialAccount ? (
            <Panel className="arc-card">
              <h2>Connect your Chain Duel account</h2>
              <p>
                Google and X sign-in connect your profile to both ecosystems. Circle handles Arc wallet
                authorization and recovery.
              </p>
              <ButtonLink href="/arc/login">Sign in with Google or X</ButtonLink>
            </Panel>
          ) : null}
          <ArcGameList games={games} loaded={historyLoaded} authenticated={socialAccount} />
        </>
      )}
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
function ArcGameList({
  games,
  loaded,
  authenticated,
}: {
  games: ArcGameRow[];
  loaded: boolean;
  authenticated: boolean;
}) {
  return (
    <section className="arc-history">
      <h2>Arc game history</h2>
      {games.length ? (
        games.map((game) => (
          <Link href={`/arc/match/${game.id}`} key={game.id} className="arc-game-row focus-ring">
            <div>
              <strong>
                Pulse Duel ·{" "}
                {game.mode === "bot" ? "Computer" : game.mode === "private" ? "Private" : "Online"}
              </strong>
              <span>{game.status.replaceAll("_", " ")}</span>
            </div>
            <span className="numeric">{formatUsdc(game.stake_units)} USDC</span>
          </Link>
        ))
      ) : (
        <Panel className="arc-card">
          <p>
            {!authenticated
              ? "Sign in with Google or X to view your Arc game history."
              : loaded
                ? "No Arc duels recorded yet. Your first confirmed game will appear here."
                : "Loading Arc game history…"}
          </p>
        </Panel>
      )}
    </section>
  );
}
function ArcLeaderboard() {
  const [players, setPlayers] = useState<{ username: string; wins: number; games: number }[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void arcFetch<{ players: typeof players }>("/api/arc/leaderboard")
      .then((data) => setPlayers(data.players))
      .catch((err) => setError((err as Error).message));
  }, []);
  return (
    <Panel className="arc-card">
      <h2>Arc competitors</h2>
      <p>Ranked by confirmed human duel wins. Computer games are excluded.</p>
      {players.length ? (
        players.map((player, index) => (
          <div className="arc-game-row" key={player.username}>
            <strong>
              {index + 1}. {player.username}
            </strong>
            <span>
              {player.wins} wins · {player.games} duels
            </span>
          </div>
        ))
      ) : (
        <p className="arc-empty">No settled Arc competitors yet.</p>
      )}
      {error ? (
        <p role="alert" className="text-danger">
          {error}
        </p>
      ) : null}
    </Panel>
  );
}
