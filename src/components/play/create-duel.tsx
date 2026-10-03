"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Badge, Button, ButtonLink, Panel } from "@/components/ui";
import { StakePicker } from "./stake-picker";
import { EscrowStatus } from "@/components/escrow-status";
import { post } from "@/lib/api/client";
import { runEscrow, type EscrowStep } from "@/lib/wallet/escrow-client";
import { ApiError } from "@/lib/api/client";
import { useSession } from "@/components/providers";
import { formatXlm } from "@/lib/config/game";
import type { DuelCreationResponse } from "@/lib/api/views";

type Mode = "pvp" | "private" | "bot";

export function CreateDuelPanel({
  mode,
  invitedUsername,
  title,
  description,
  options,
  defaultEntry,
  demoAllowed,
  maxEntryXlm,
  autoStart = false,
}: {
  mode: Mode;
  invitedUsername?: string;
  title: string;
  description: string;
  options: { xlm: number; label: string }[];
  defaultEntry: number;
  demoAllowed: boolean;
  maxEntryXlm?: number;
  autoStart?: boolean;
}) {
  const router = useRouter();
  const session = useSession();
  const [entry, setEntry] = useState(defaultEntry);
  const [demo, setDemo] = useState(false);
  const [step, setStep] = useState<EscrowStep>("idle");
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<DuelCreationResponse | null>(null);
  const [copied, setCopied] = useState(false);

  const inviteUrl = created && typeof window !== "undefined" ? `${window.location.origin}/duel/${created.game.code}` : "";

  async function create() {
    setError(null);
    setStep("preparing");
    try {
      const creation = await post<DuelCreationResponse>("/api/duels", {
        mode,
        entryXlm: demo ? 0 : entry,
        demo,
        ...(invitedUsername ? { invitedUsername } : {}),
      });
      setCreated(creation);

      const result = await runEscrow({
        gameId: creation.game.id,
        address: session.walletAddress ?? "",
        role: "creator",
        onStep: setStep,
      });

      if (autoStart || mode === "bot") {
        router.push(`/match/${result.game.id}`);
        return;
      }
      setStep("confirmed");
    } catch (caught) {
      setStep("failed");
      setError(
        caught instanceof ApiError
          ? caught.message
          : caught instanceof Error
            ? caught.message
            : "Could not create that duel.",
      );
    }
  }

  async function copyLink() {
    if (!inviteUrl) return;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setError("Copy failed — select the link and copy it manually.");
    }
  }

  async function share() {
    if (!inviteUrl) return;
    const data = {
      title: "Chain Duel",
      text: `${session.username ?? "A duelist"} challenged you to a Pulse Duel.`,
      url: inviteUrl,
    };
    try {
      if (navigator.share) {
        await navigator.share(data);
      } else {
        await copyLink();
      }
    } catch {
      // sharing cancelled
    }
  }

  if (created && mode !== "bot" && step === "confirmed") {
    return (
      <Panel className="flex flex-col gap-5 px-6 py-7">
        <div>
          <Badge tone="success">Duel created</Badge>
          <h2 className="text-display mt-3 text-3xl">Invite ready</h2>
          <p className="mt-2 text-sm text-muted">
            {invitedUsername
              ? `${invitedUsername} will see your challenge in their dashboard. You can also share the link directly.`
              : "Share this link with your friend. The duel expires in 30 minutes if nobody joins."}
          </p>
        </div>

        <div className="panel-flat flex items-center justify-between gap-3 px-4 py-3.5">
          <div className="min-w-0">
            <p className="eyebrow">Invite link</p>
            <p className="numeric mt-1 truncate text-sm text-accent">{inviteUrl}</p>
          </div>
          <span className="numeric text-2xl font-semibold tracking-[0.2em] text-ink">{created.game.code}</span>
        </div>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <div className="panel-flat px-3.5 py-2.5">
            <p className="eyebrow">Entry</p>
            <p className="numeric mt-1 text-sm">{created.game.demo ? "Demo" : `${formatXlm(created.game.entry_stroops)} XLM`}</p>
          </div>
          <div className="panel-flat px-3.5 py-2.5">
            <p className="eyebrow">Prize pool</p>
            <p className="numeric mt-1 text-sm">
              {created.game.demo ? "—" : `${formatXlm(created.game.entry_stroops * 2)} XLM`}
            </p>
          </div>
          <div className="panel-flat px-3.5 py-2.5">
            <p className="eyebrow">Status</p>
            <p className="mt-1 text-sm capitalize">{created.game.status}</p>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button onClick={copyLink}>{copied ? "Copied" : "Copy link"}</Button>
          <Button variant="secondary" onClick={share}>
            Share
          </Button>
          <ButtonLink href={`/match/${created.game.id}`} variant="ghost">
            Open duel lobby
          </ButtonLink>
        </div>
        <p className="text-xs text-dim">
          Your entry is escrowed. If nobody joins before the window closes you can cancel and reclaim it.
        </p>
      </Panel>
    );
  }

  return (
    <Panel className="flex flex-col gap-5 px-6 py-7">
      <div>
        <p className="eyebrow">{mode === "bot" ? "Vs computer" : invitedUsername ? "Challenge" : "Private duel"}</p>
        <h1 className="text-display mt-2 text-3xl">{title}</h1>
        <p className="mt-2 text-sm text-muted">{description}</p>
        {invitedUsername ? (
          <p className="mt-3 inline-flex items-center gap-2 rounded-full border border-accent/40 bg-accent-soft px-3 py-1 text-xs text-accent">
            Opponent · {invitedUsername}
          </p>
        ) : null}
      </div>

      <StakePicker
        options={options}
        value={entry}
        onChange={setEntry}
        demo={demo}
        onDemoChange={setDemo}
        demoAllowed={demoAllowed}
        max={maxEntryXlm}
      />

      <EscrowStatus step={step} error={error} />

      <Button
        size="lg"
        loading={step === "preparing" || step === "awaiting_wallet" || step === "submitting" || step === "confirming"}
        onClick={create}
        disabled={step === "confirmed"}
      >
        {mode === "bot"
          ? "Start computer duel"
          : invitedUsername
            ? `Challenge ${invitedUsername}`
            : "Create private duel"}
      </Button>

      <p className="text-center text-xs text-dim">
        {demo
          ? "Demo duel — nothing is staked and results stay out of your rating."
          : "Your entry is locked in the Chain Duel escrow contract until the duel settles."}
      </p>
    </Panel>
  );
}
