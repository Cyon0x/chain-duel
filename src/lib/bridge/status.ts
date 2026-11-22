export const BRIDGE_STATES = [
  "awaiting_approval",
  "submitted",
  "source_confirmed",
  "attestation_pending",
  "destination_pending",
  "completed",
  "failed",
  "recovery_required",
] as const;
export type BridgeStatus = (typeof BRIDGE_STATES)[number];
export const BRIDGE_LABELS: Record<BridgeStatus, string> = {
  awaiting_approval: "Awaiting approval",
  submitted: "Submitted",
  source_confirmed: "Source transaction confirmed",
  attestation_pending: "Attestation pending",
  destination_pending: "Destination transaction pending",
  completed: "Completed",
  failed: "Failed",
  recovery_required: "Recovery required",
};
const NEXT: Record<BridgeStatus, BridgeStatus[]> = {
  awaiting_approval: ["submitted", "failed"],
  submitted: ["source_confirmed", "failed", "recovery_required"],
  source_confirmed: ["attestation_pending", "recovery_required"],
  attestation_pending: ["destination_pending", "recovery_required"],
  destination_pending: ["completed", "recovery_required"],
  completed: [],
  failed: [],
  recovery_required: ["attestation_pending", "destination_pending", "completed"],
};
export function bridgeTransition(
  current: BridgeStatus,
  next: BridgeStatus,
  proof: {
    sourceHash?: string;
    destinationHash?: string;
    destinationSettled?: boolean;
  } = {},
) {
  if (!NEXT[current].includes(next)) throw new Error("Invalid bridge state transition.");
  if (next === "source_confirmed" && !proof.sourceHash)
    throw new Error("Source confirmation proof required.");
  if (next === "completed" && (!proof.destinationHash || proof.destinationSettled !== true))
    throw new Error("Destination settlement proof required.");
  return next;
}
