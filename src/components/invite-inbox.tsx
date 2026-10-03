"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Avatar, Button, Panel } from "@/components/ui";
import { api, post } from "@/lib/api/client";
import { useAsync } from "@/lib/hooks/use-async";
import { formatXlm } from "@/lib/config/game";

interface Invite {
  id: string;
  username: string;
  avatar: string | null;
  rating: number;
  entry_stroops: number;
  expires_at: string;
  status: string;
}

interface InviteResponse {
  accepted: boolean;
  game?: { id: string };
}

export function InviteInbox() {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { data, reload } = useAsync<{ invites: Invite[] }>(() => api("/api/invites"), [], { pollMs: 10_000 });

  const invites = data?.invites ?? [];

  async function respond(invite: Invite, accept: boolean) {
    setBusyId(invite.id);
    setError(null);
    try {
      const result = await post<InviteResponse>(`/api/invites/${invite.id}`, { accept });
      if (result.accepted && result.game?.id) {
        router.push(`/match/${result.game.id}`);
        return;
      }
      await reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not respond to that invitation.");
    } finally {
      setBusyId(null);
    }
  }

  if (invites.length === 0 && !error) return null;

  return (
    <Panel className="flex flex-col gap-3 px-5 py-4">
      <div className="flex items-center justify-between">
        <p className="eyebrow">Duel invitations</p>
        <span className="numeric text-xs text-accent">{invites.length}</span>
      </div>
      {invites.map((invite) => (
        <div key={invite.id} className="panel-flat flex flex-wrap items-center gap-3 px-3.5 py-3">
          <Avatar name={invite.username} src={invite.avatar} size={34} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm">
              <span className="font-medium">{invite.username}</span> challenged you to a Pulse Duel.
            </p>
            <p className="numeric mt-0.5 text-xs text-dim">
              {formatXlm(invite.entry_stroops)} XLM entry · {invite.rating} rating
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              loading={busyId === invite.id}
              onClick={() => respond(invite, true)}
              data-cursor="hover"
            >
              Accept
            </Button>
            <Button size="sm" variant="ghost" disabled={busyId === invite.id} onClick={() => respond(invite, false)}>
              Decline
            </Button>
          </div>
        </div>
      ))}
      {error ? <p className="text-xs text-danger">{error}</p> : null}
    </Panel>
  );
}
