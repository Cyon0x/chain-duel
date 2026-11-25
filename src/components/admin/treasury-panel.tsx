"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Input, Panel, SectionHeader } from "@/components/ui";
import { post } from "@/lib/api/client";
import { useNetwork } from "@/components/networks/network-provider";

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
    protocolFeesStroops?: number;
    ecosystemFeesStroops?: number;
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
  const router = useRouter();
  const { stellar } = useNetwork();
  const symbol = stellar.asset.symbol;
  const mainnet = stellar.id === "mainnet" || stellar.verification?.version === 1;
  const [allocation, setAllocation] = useState<"protocol" | "ecosystem">("protocol");
  const request = useRef<{ key: string; id: string } | null>(null);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const snapshot = dashboard.snapshot;
  const maxWithdraw = xlm(mainnet ? allocation === "ecosystem" ? snapshot.ecosystemFeesStroops ?? 0 : snapshot.protocolFeesStroops ?? 0 : snapshot.accruedFeesStroops);

  async function withdraw() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const key = `${allocation}:${amount}:${stellar.networkId}`;
      if (request.current?.key !== key) request.current = { key, id: crypto.randomUUID() };
      const response = await post<{ txHash: string; explorerUrl: string; remaining: string }>(
        "/api/treasury/withdraw",
        { amount, kind: allocation, networkId: stellar.networkId, currency: symbol, requestId: request.current.id },
      );
      setResult(`Withdrawn to ${dashboard.adminWallet}. Remaining ${allocation} fees: ${response.remaining} ${symbol}.`);
      setAmount("");
      request.current = null;
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Withdrawal failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
        <Metric label="Contract balance" value={`${xlm(snapshot.contractBalanceStroops)} ${symbol}`} />
        <Metric label="Bot liquidity" value={`${xlm(snapshot.botLiquidityStroops)} ${symbol}`} tone="accent" />
        <Metric label="Accrued fees" value={`${xlm(snapshot.accruedFeesStroops)} ${symbol}`} tone="success" />
        <Metric label="Locked escrow" value={`${xlm(snapshot.lockedEscrowStroops)} ${symbol}`} />
      </div>
      {mainnet ? <div className="grid grid-cols-2 gap-3"><Metric label="Protocol allocation" value={`${xlm(snapshot.protocolFeesStroops ?? 0)} ${symbol}`} /><Metric label="Ecosystem allocation" value={`${xlm(snapshot.ecosystemFeesStroops ?? 0)} ${symbol}`} /></div> : null}

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
          <Detail label="Min treasury balance" value={`${xlm(dashboard.limits.minTreasuryBalanceStroops)} ${symbol}`} />
          <Detail label="Max bot entry" value={`${xlm(dashboard.limits.maxBotEntryStroops)} ${symbol}`} />
          <Detail label="Max payout" value={`${xlm(dashboard.limits.maxPayoutStroops)} ${symbol}`} />
          <Detail label="Daily bot liability" value={`${xlm(dashboard.limits.dailyBotLiabilityStroops)} ${symbol}`} />
        </div>
      </Panel>

      <Panel className="flex flex-col gap-4 px-5 py-5">
        <SectionHeader
          title={mainnet ? "Collect fee allocation" : "Withdraw protocol revenue"}
          subtitle={`Only the designated wallet can collect these fees. Available ${allocation} allocation: ${maxWithdraw} ${symbol}`}
        />
        {mainnet ? <label className="flex flex-col gap-1.5 text-sm"><span className="eyebrow">Allocation</span><select className="focus-ring h-11 rounded-xl border border-line bg-surface px-3" value={allocation} disabled={busy} onChange={event => setAllocation(event.target.value as "protocol" | "ecosystem")}><option value="protocol">Protocol · 5%</option><option value="ecosystem">Ecosystem · 5%</option></select></label> : null}
        <div className="flex flex-wrap items-end gap-3">
          <label className="min-w-[200px] flex-1">
            <span className="eyebrow">Amount ({symbol})</span>
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
            <Row label="Player rewards" value={`${xlm(dashboard.totals.player_rewards)} ${symbol}`} />
            <Row label="Treasury delta" value={`${xlm(dashboard.totals.treasury_delta)} ${symbol}`} />
            <Row label={mainnet ? "Game fees" : "Protocol fees"} value={`${xlm(dashboard.totals.fees)} ${symbol}`} />
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
                    {xlm(Number(field(row, "amount_stroops")))} {symbol}
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
      <p className="text-xs uppercase tracking-[0.14em] text-dim">{label}</p>
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
