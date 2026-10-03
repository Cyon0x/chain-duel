export class ChainDuelError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "ChainDuelError";
  }
}

export function escrowUnavailableError(): ChainDuelError {
  return new ChainDuelError(
    "Staked duels need the Chain Duel escrow contract. Play a demo duel while escrow is unavailable.",
    "escrow_unavailable",
    503,
  );
}

export function toErrorResponse(error: unknown): { status: number; body: { error: string; code: string } } {
  if (error instanceof ChainDuelError) {
    return { status: error.status, body: { error: error.message, code: error.code } };
  }
  const message = error instanceof Error ? error.message : "Something went wrong.";
  const code = (error as { code?: string })?.code ?? "internal_error";
  if (message === "UNAUTHENTICATED") {
    return { status: 401, body: { error: "Sign in to continue.", code: "unauthenticated" } };
  }
  return { status: 400, body: { error: message, code } };
}
