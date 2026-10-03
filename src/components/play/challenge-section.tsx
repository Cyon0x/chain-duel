"use client";

import { useState } from "react";
import { Button, Panel } from "@/components/ui";
import { CreateDuelPanel } from "./create-duel";
import { formatXlm } from "@/lib/config/game";

export function ChallengeSection({
  username,
  options,
  defaultEntry,
  demoAllowed,
  maxEntryXlm,
}: {
  username: string;
  options: { xlm: number; label: string }[];
  defaultEntry: number;
  demoAllowed: boolean;
  maxEntryXlm?: number;
}) {
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <Panel className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
        <div>
          <p className="eyebrow">Challenge</p>
          <p className="mt-1.5 text-sm text-muted">
            Send {username} a Pulse Duel invitation for {formatXlm(defaultEntry * 10_000_000)} XLM.
          </p>
        </div>
        <Button size="lg" onClick={() => setOpen(true)}>
          Challenge
        </Button>
      </Panel>
    );
  }

  return (
    <CreateDuelPanel
      mode="pvp"
      invitedUsername={username}
      title={`Challenge ${username}`}
      description="Pick your entry and send the challenge. They can accept or decline from their dashboard."
      options={options}
      defaultEntry={defaultEntry}
      demoAllowed={demoAllowed}
      maxEntryXlm={maxEntryXlm}
    />
  );
}
