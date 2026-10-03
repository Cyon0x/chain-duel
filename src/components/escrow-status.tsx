"use client";

import clsx from "clsx";
import { Badge } from "@/components/ui";
import type { EscrowStep } from "@/lib/wallet/escrow-client";

const LABELS: Record<EscrowStep, string> = {
  idle: "Ready",
  preparing: "Preparing escrow",
  awaiting_wallet: "Waiting for wallet",
  signing: "Signing",
  submitting: "Submitting",
  confirming: "Confirming on Stellar",
  confirmed: "Confirmed",
  failed: "Failed",
};

export function EscrowStatus({ step, error }: { step: EscrowStep; error?: string | null }) {
  if (step === "idle" && !error) return null;
  const tone = step === "failed" ? "danger" : step === "confirmed" ? "success" : "accent";
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <Badge tone={tone}>{LABELS[step]}</Badge>
        {step !== "confirmed" && step !== "failed" ? (
          <span className="animate-breathe text-xs text-dim">
            Do not close this window while the transaction settles.
          </span>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className={clsx("rounded-xl border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger")}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
