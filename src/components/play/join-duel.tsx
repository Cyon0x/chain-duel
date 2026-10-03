"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Avatar, Badge, Button, ButtonLink, Panel } from "@/components/ui";
import { EscrowStatus } from "@/components/escrow-status";
import { post } from "@/lib/api/client";
import { completeEscrow, type EscrowStep } from "@/lib/wallet/escrow-client";
import { useSession } from "@/components/providers";
import { formatXlm } from "@/lib/config/game";
import type { GameViewRow } from "@/lib/api/views";

interface JoinResponse {
  game: GameViewRow;
  escrow: { mode: string; xdr?: string; transactionId?: string; txHash?: string };
}

export function JoinDuelPanel({
  code,
  creatorUsername,
  creatorAvatar,
  entryStroops,
  demo,
  isSelf,
  authenticated,
}: {
  code: string;
  creatorUsername: string;
  creatorAvatar: string | null;
  entryStroops: number;
  demo: boolean;
  isSelf: boolean;
  authenticated: boolean;
}) {
  const router = useRouter();
  const session = useSession();
  const [step, setStep] = useState<EscrowStep>("idle");
  const [error, setError] = useState<string | null>(null);

  async function join() {
    setError(null);
    setStep("preparing");
    try {
      const joined = await post<JoinResponse>("/api/duels/join", { code });
      // `join` already prepared — and for managed wallets submitted — the
      // joiner's entry, so we finish that exact handoff instead of asking the
      // server to lock the entry a second time.
      await completeEscrow({
        gameId: joined.game.id,
        address: session.walletAddress ?? "",
        escrow: joined.escrow,
        onStep: setStep,
      });
      router.push(`/match/${joined.game.id}`);
    } catch (caught) {
      setStep("failed");
      setError(caught instanceof Error ? caught.message : "Could not join that duel.");
    }
  }

  const busy = step === "preparing" || step === "awaiting_wallet" || step === "submitting" || step === "confirming";

  return (
    <Panel className="mx-auto flex w-full max-w-lg flex-col gap-6 px-6 py-8">
      <div className="text-center">
        <Badge tone="accent">Private duel</Badge>
        <h1 className="text-display mt-3 text-3xl">You have been challenged</h1>
      </div>

      <div className="flex items-center justify-center gap-4">
        <div className="text-center">
          <Avatar name={creatorUsername} src={creatorAvatar} size={56} />
          <p className="mt-2 text-sm font-medium">{creatorUsername}</p>
        </div>
        <span className="text-display text-2xl text-dim">VS</span>
        <div className="text-center">
          <Avatar name={session.username ?? "You"} size={56} />
          <p className="mt-2 text-sm font-medium">{session.username ?? "You"}</p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="panel-flat px-4 py-3 text-center">
          <p className="eyebrow">Entry</p>
          <p className="numeric mt-1.5 text-lg font-semibold">{demo ? "Demo" : `${formatXlm(entryStroops)} XLM`}</p>
        </div>
        <div className="panel-flat px-4 py-3 text-center">
          <p className="eyebrow">Prize pool</p>
          <p className="numeric mt-1.5 text-lg font-semibold text-accent">
            {demo ? "—" : `${formatXlm(entryStroops * 2)} XLM`}
          </p>
        </div>
      </div>

      <div className="panel-flat px-4 py-3 text-xs text-muted">
        <p>
          <span className="text-dim">Game ·</span> Pulse Duel — 60 seconds, blue +10, gold +25, red −15.
        </p>
        <p className="mt-1">
          <span className="text-dim">Code ·</span> <span className="numeric tracking-[0.2em]">{code}</span>
        </p>
      </div>

      <EscrowStatus step={step} error={error} />

      {isSelf ? (
        <p className="rounded-xl border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning">
          This is your own invitation. Share the link with a friend instead.
        </p>
      ) : !authenticated ? (
        <ButtonLink href={`/login?next=/duel/${code}`} size="lg">
          Sign in to join
        </ButtonLink>
      ) : (
        <Button size="lg" loading={busy} onClick={join} disabled={step === "confirmed"}>
          {demo ? "Join demo duel" : `Join duel · ${formatXlm(entryStroops)} XLM`}
        </Button>
      )}

      <p className="text-center text-xs text-dim">
        Your entry is escrowed until the duel settles. If the duel is cancelled, your entry is refunded.
      </p>
    </Panel>
  );
}
