"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Avatar, Button, Panel } from "@/components/ui";
import { StakePicker } from "./stake-picker";
import { api, post, del } from "@/lib/api/client";
import { useAsync } from "@/lib/hooks/use-async";
import { formatXlm } from "@/lib/config/game";

interface QueueSnapshot {
  status: "idle" | "searching" | "matched" | "cancelled" | "expired";
  queueId: string | null;
  gameId: string | null;
  entryStroops: number;
  demo: boolean;
  searchStartedAt: string | null;
  opponent: { username: string; avatar: string | null; rating: number } | null;
}

export function QueuePanel({
  options,
  defaultEntry,
  demoAllowed,
  maxEntryXlm,
  selfName,
}: {
  options: { xlm: number; label: string }[];
  defaultEntry: number;
  demoAllowed: boolean;
  maxEntryXlm?: number;
  selfName: string | null;
}) {
  const router = useRouter();
  const [entry, setEntry] = useState(defaultEntry);
  const [entryValid, setEntryValid] = useState(true);
  const [demo, setDemo] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tickAt, setTickAt] = useState(0);

  const { data, reload, setData } = useAsync<QueueSnapshot>(() => api("/api/matchmaking"), [], { pollMs: 2500 });
  const status = data?.status ?? "idle";
  const searching = status === "searching";

  useEffect(() => {
    if (!searching) return;
    const timer = window.setInterval(() => setTickAt(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [searching]);

  const searchStartedAt = data?.searchStartedAt ? new Date(data.searchStartedAt).getTime() : 0;
  const elapsed =
    searching && searchStartedAt && tickAt ? Math.max(0, Math.floor((tickAt - searchStartedAt) / 1000)) : 0;

  useEffect(() => {
    if (status === "matched" && data?.gameId) {
      router.push(`/match/${data.gameId}`);
    }
  }, [data?.gameId, router, status]);

  async function find() {
    if (!demo && !entryValid) {
      setError("Enter a valid stake before joining the queue.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const snapshot = await post<QueueSnapshot>("/api/matchmaking", { entryXlm: demo ? 0 : entry, demo });
      setData(snapshot);
      if (snapshot.status === "matched" && snapshot.gameId) router.push(`/match/${snapshot.gameId}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not join the queue.");
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    setBusy(true);
    try {
      await del("/api/matchmaking");
      await reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not leave the queue.");
    } finally {
      setBusy(false);
    }
  }

  if (searching) {
    return (
      <Panel className="flex flex-col items-center gap-6 px-6 py-12 text-center">
        <div className="relative grid h-32 w-32 place-items-center">
          <span
            aria-hidden
            className="absolute inset-0 animate-ping rounded-full border border-accent/40"
            style={{ animationDuration: "2.4s" }}
          />
          <span aria-hidden className="absolute inset-4 animate-pulse-soft rounded-full border border-accent/30" />
          <span className="numeric text-xs uppercase tracking-[0.2em] text-accent">Searching</span>
        </div>
        <div>
          <h2 className="text-display text-2xl">Searching for opponent</h2>
          <p className="numeric mt-2 text-sm text-muted">
            {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")} elapsed ·{" "}
            {demo ? "Demo" : `${formatXlm(data?.entryStroops ?? 0)} XLM`}
          </p>
        </div>
        <p className="max-w-sm text-sm text-dim">
          We match on game type, entry amount and availability. You are only charged once an opponent is found and you
          lock your entry.
        </p>
        <div className="flex w-full max-w-xs flex-col gap-2">
          <div className="sweep relative h-1 overflow-hidden rounded-full bg-surface-strong" />
          <Button variant="secondary" loading={busy} onClick={cancel}>
            Cancel search
          </Button>
        </div>
      </Panel>
    );
  }

  return (
    <Panel className="flex flex-col gap-6 px-6 py-7">
      <div>
        <p className="eyebrow">Play online</p>
        <h1 className="text-display mt-2 text-3xl">Find random player</h1>
        <p className="mt-2 text-sm text-muted">
          Queue up and we will pair you with another duelist at the same entry.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="panel-flat flex items-center gap-3 px-4 py-3">
          <Avatar name={selfName ?? "You"} size={36} />
          <div>
            <p className="text-sm font-medium">{selfName ?? "You"}</p>
            <p className="text-xs text-dim">You</p>
          </div>
        </div>
        <div className="panel-flat flex items-center gap-3 px-4 py-3 opacity-70">
          <span aria-hidden className="grid h-9 w-9 place-items-center rounded-2xl border border-line-strong text-dim">
            ?
          </span>
          <div>
            <p className="text-sm font-medium">Opponent</p>
            <p className="text-xs text-dim">Searching…</p>
          </div>
        </div>
      </div>

      <StakePicker
        options={options}
        value={entry}
        onChange={(next, isValid) => {
          setEntry(next);
          setEntryValid(isValid);
        }}
        demo={demo}
        onDemoChange={setDemo}
        demoAllowed={demoAllowed}
        max={maxEntryXlm}
      />

      {error ? (
        <p role="alert" className="rounded-xl border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      ) : null}

      <Button size="lg" loading={busy} onClick={find} disabled={!demo && !entryValid}>
        Find random player
      </Button>
    </Panel>
  );
}
