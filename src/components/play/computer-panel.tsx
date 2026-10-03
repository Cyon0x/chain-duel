"use client";

import { Badge, ButtonLink, Panel } from "@/components/ui";
import { CreateDuelPanel } from "./create-duel";
import { useAsync } from "@/lib/hooks/use-async";
import { api } from "@/lib/api/client";
import { formatXlm } from "@/lib/config/game";

interface BotStatus {
  available: boolean;
  reason: string | null;
  opponent: { id: string; name: string; difficulty: string };
  entryStroops: number;
  maxEntryStroops: number;
}

export function ComputerPanel({ defaultEntryXlm, options }: { defaultEntryXlm: number; options: { xlm: number; label: string }[] }) {
  const { data, loading } = useAsync<BotStatus>(() => api("/api/bot"), [], { pollMs: 15_000 });

  if (loading && !data) {
    return (
      <Panel className="px-6 py-7">
        <p className="eyebrow">Vs computer</p>
        <p className="mt-2 text-sm text-muted">Checking computer availability…</p>
      </Panel>
    );
  }

  if (!data?.available) {
    return (
      <Panel className="flex flex-col gap-4 px-6 py-7">
        <div>
          <Badge tone="warning">Unavailable</Badge>
          <h1 className="text-display mt-3 text-3xl">Computer matches are temporarily unavailable.</h1>
          <p className="mt-2 text-sm text-muted">
            {data?.reason ?? "The protocol treasury does not have enough liquidity for a computer duel right now."}
          </p>
        </div>
        <p className="text-xs text-dim">
          Computer duels are funded by the protocol treasury and are disabled whenever liquidity or daily limits would
          be exceeded. Try again shortly or play online.
        </p>
        <ButtonLink href="/play/online" variant="secondary">
          Play online instead
        </ButtonLink>
      </Panel>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="panel-flat flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div className="flex items-center gap-3">
          <span aria-hidden className="grid h-10 w-10 place-items-center rounded-2xl border border-accent/40 bg-accent-soft text-accent">
            ⌘
          </span>
          <div>
            <p className="text-sm font-medium">{data.opponent.name}</p>
            <p className="text-xs text-dim capitalize">{data.opponent.difficulty} difficulty</p>
          </div>
        </div>
        <span className="numeric text-xs text-dim">
          Max entry {formatXlm(data.maxEntryStroops)} XLM
        </span>
      </div>
      <CreateDuelPanel
        mode="bot"
        title={`Duel ${data.opponent.name}`}
        description="The computer reacts to the same deterministic target stream you do. No waiting — the match starts as soon as your entry is locked."
        options={options}
        defaultEntry={defaultEntryXlm}
        demoAllowed
        maxEntryXlm={data.maxEntryStroops / 10_000_000}
        autoStart
      />
    </div>
  );
}
