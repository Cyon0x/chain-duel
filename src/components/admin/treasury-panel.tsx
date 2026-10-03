"use client";

import { useState } from "react";
import { Badge, Button, Input, Panel, SectionHeader } from "@/components/ui";
import { post } from "@/lib/api/client";

interface TreasuryDashboard {
  contractConfigured: boolean;
  contractId: string | null;
  escrowAvailable: boolean;
  adminWallet: string | null;
  settlementKeyMatchesAdmin: boolean;
  snapshot: {
    available: boolean;
    botLiquidityStroops: number;
    accruedFeesStroops: number;
    lockedEscrowStroops: number;
    contractBalanceStroops: number;
    paused: boolean;
    botEnabled: boolean;
    adminAddress: string | null;
    treasuryAddress: string | null;
    maxEntryStroops: number;
    maxPayoutStroops: number;
    minTreasuryBalanceStroops: number;
    stats: {
      gamesCreated: number;
      gamesSettled: number;
      gamesCancelled: number;
      botGames: number;
      botWins: number;
      playerWins: number;
    } | null;
  };
  totals: {
    games: number;
    bot_wins: number;
    player_wins: number;
    player_rewards: number;
    treasury_delta: number;
    fees: number;
  };
  botMatches: unknown[];
  treasuryTransactions: unknown[];
  adminActions: unknown[];
  limits: {
    minTreasuryBalanceStroops: number;
    maxBotEntryStroops: number;
    maxPayoutStroops: number;
    dailyBotLiabilityStroops: number;
  };
}

export function TreasuryPanel({ dashboard }: { dashboard: TreasuryDashboard }) {
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const snapshot = dashboard.snapshot;
  const maxWithdraw = xlm(snapshot.accruedFeesStroops);

  async function withdraw() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const response = await post<{ txHash: string; explorerUrl: string; remaining: string }>(
        "/api/treasury/withdraw",
        { amountXlm: Number(amount) },
      );
      setResult(`Withdrawn. Remaining accrued fees: ${response.remaining} XLM.`);
      setAmount("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Withdrawal failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="Contract balance" value={`${xlm(snapshot.contractBalanceStroops)} XLM`} />
        <Metric label="Bot liquidity" value={`${xlm(snapshot.botLiquidityStroops)} XLM`} tone="accent" />
        <Metric label="Accrued fees" value={`${xlm(snapshot.accruedFeesStroops)} XLM`} tone="success" />
        <Metric label="Locked escrow" value={`${xlm(snapshot.lockedEscrowStroops)} XLM`} />
      </div>

      <Panel className="flex flex-col gap-4 px-5 py-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="eyebrow">Authorization</p>
            <p className="mt-1.5 max-w-xl text-sm text-muted">
              Withdrawals are gated by the contract&apos;s <span className="numeric">require_admin</span> and can only ever
              be sent to the bound treasury wallet.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge tone={snapshot.paused ? "danger" : "success"}>{snapshot.paused ? "Paused" : "Live"}</Badge>
            <Badge tone={snapshot.botEnabled ? "success" : "neutral"}>
              {snapshot.botEnabled ? "Bot enabled" : "Bot disabled"}
            </Badge>
            <Badge tone={dashboard.settlementKeyMatchesAdmin ? "success" : "danger"}>
              {dashboard.settlementKeyMatchesAdmin ? "Key matches admin" : "Key mismatch"}
            </Badge>
          </div>
        </div>
        <div className="grid gap-2 text-xs sm:grid-cols-2">
          <Detail label="Admin wallet" value={dashboard.adminWallet ?? "—"} />
          <Detail label="Treasury wallet" value={snapshot.treasuryAddress ?? "—"} />
          <Detail label="Contract" value={dashboard.contractId ?? "Not configured"} />
          <Detail label="Contract admin" value={snapshot.adminAddress ?? "—"} />
        </div>
        <div className="grid gap-2 text-xs sm:grid-cols-4">
          <Detail label="Min treasury balance" value={`${xlm(dashboard.limits.minTreasuryBalanceStroops)} XLM`} />
          <Detail label="Max bot entry" value={`${xlm(dashboard.limits.maxBotEntryStroops)} XLM`} />
          <Detail label="Max payout" value={`${xlm(dashboard.limits.maxPayoutStroops)} XLM`} />
          <Detail label="Daily bot liability" value={`${xlm(dashboard.limits.dailyBotLiabilityStroops)} XLM`} />
        </div>
      </Panel>

      <Panel className="flex flex-col gap-4 px-5 py-5">
        <SectionHeader
          title="Withdraw protocol revenue"
          subtitle={`Only the admin wallet can withdraw, and funds are sent to the bound treasury address. Available: ${maxWithdraw} XLM`}
        />
        <div className="flex flex-wrap items-end gap-3">
          <label className="min-w-[200px] flex-1">
            <span className="eyebrow">Amount (XLM)</span>
            <Input
              className="mt-1.5"
              value={amount}
              inputMode="decimal"
              onChange={(event) => setAmount(event.target.value)}
              placeholder={maxWithdraw}
            />
          </label>
          <Button loading={busy} onClick={withdraw} disabled={!dashboard.escrowAvailable || Number(amount) <= 0}>
            Withdraw to treasury wallet
          </Button>
        </div>
        {!dashboard.escrowAvailable ? (
          <p className="text-xs text-warning">Contract is not configured — withdrawals are disabled.</p>
        ) : null}
        {error ? (
          <p role="alert" className="rounded-xl border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
            {error}
          </p>
        ) : null}
        {result ? (
          <p role="status" className="rounded-xl border border-success/40 bg-success/10 px-3 py-2 text-sm text-success">
            {result}
          </p>
        ) : null}
      </Panel>

      <div className="grid gap-6 lg:grid-cols-2">
        <section>
          <SectionHeader title="Bot match accounting" subtitle={`${dashboard.totals.games} computer duels`} />
          <Panel className="flex flex-col gap-2 px-5 py-4 text-sm">
            <Row label="Bot wins" value={String(dashboard.totals.bot_wins)} />
            <Row label="Player wins" value={String(dashboard.totals.player_wins)} />
            <Row label="Player rewards" value={`${xlm(dashboard.totals.player_rewards)} XLM`} />
            <Row label="Treasury delta" value={`${xlm(dashboard.totals.treasury_delta)} XLM`} />
            <Row label="Protocol fees" value={`${xlm(dashboard.totals.fees)} XLM`} />
          </Panel>
          <div className="mt-3 flex flex-col gap-2">
            {dashboard.botMatches.slice(0, 8).map((row, index) => (
              <div key={index} className="panel-flat flex items-center justify-between px-4 py-2.5 text-xs">
                <span className="text-muted">{field(row, "bot_id")}</span>
                <span className="numeric">
                  {field(row, "player_score")} – {field(row, "bot_score")}
                </span>
                <Badge tone={field(row, "winner") === "player" ? "success" : "warning"}>{field(row, "winner")}</Badge>
              </div>
            ))}
          </div>
        </section>

        <section>
          <SectionHeader title="Treasury ledger" />
          <Panel className="flex max-h-[420px] flex-col gap-2 overflow-y-auto px-4 py-4">
            {dashboard.treasuryTransactions.length ? (
              dashboard.treasuryTransactions.map((row, index) => (
                <div key={index} className="flex items-center justify-between border-b border-line pb-2 text-xs last:border-0">
                  <span className="text-muted">{field(row, "kind")}</span>
                  <span className={`numeric ${field(row, "direction") === "in" ? "text-success" : "text-ink"}`}>
                    {field(row, "direction") === "in" ? "+" : "−"}
                    {xlm(Number(field(row, "amount_stroops")))} XLM
                  </span>
                </div>
              ))
            ) : (
              <p className="text-xs text-dim">No treasury movements recorded yet.</p>
            )}
          </Panel>
        </section>
      </div>

      <section>
        <SectionHeader title="Admin audit log" subtitle="Every privileged action is recorded." />
        <Panel className="flex flex-col gap-2 px-5 py-4">
          {dashboard.adminActions.length ? (
            dashboard.adminActions.map((row, index) => (
              <div
                key={index}
                className="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-2 text-xs last:border-0"
              >
                <span className="font-medium">{field(row, "action")}</span>
                <span className="numeric text-dim">{field(row, "admin_wallet").slice(0, 10)}…</span>
                <span className="text-dim">{field(row, "created_at")}</span>
              </div>
            ))
          ) : (
            <p className="text-xs text-dim">No admin actions yet.</p>
          )}
        </Panel>
      </section>
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: "accent" | "success" }) {
  return (
    <Panel className="px-4 py-3.5">
      <p className="eyebrow">{label}</p>
      <p
        className={`numeric mt-2 text-xl font-semibold ${
          tone === "accent" ? "text-accent" : tone === "success" ? "text-success" : ""
        }`}
      >
        {value}
      </p>
    </Panel>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface px-3 py-2">
      <p className="text-[10px] uppercase tracking-[0.14em] text-dim">{label}</p>
      <p className="numeric mt-1 truncate text-xs text-muted">{value}</p>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between border-b border-line pb-2 last:border-0">
      <span className="text-muted">{label}</span>
      <span className="numeric">{value}</span>
    </div>
  );
}

function field(row: unknown, key: string): string {
  const record = row as Record<string, unknown> | null;
  const value = record?.[key];
  return value === null || value === undefined ? "—" : String(value);
}

function xlm(stroops: number): string {
  return (Number(stroops) / 10_000_000).toLocaleString("en-US", { maximumFractionDigits: 2 });
}
