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

export function databaseUnavailableError(): ChainDuelError {
  return new ChainDuelError(
    "Chain Duel is temporarily unavailable. Please try again.",
    "database_unavailable",
    503,
  );
}

/** Postgres/libpq failure codes and messages that mean "the database is down". */
const CONNECTION_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "08000",
  "08001",
  "08003",
  "08004",
  "08006",
  "08007",
  "08P01",
  "57P01",
  "57P02",
  "57P03",
  "53300",
]);

function isConnectionFailure(error: unknown): boolean {
  const code = (error as { code?: string })?.code;
  if (code && CONNECTION_CODES.has(code)) return true;
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /Connection terminated|terminating connection|connection refused|timeout exceeded when trying to connect|ECONNREFUSED|ENOTFOUND|getaddrinfo|server closed the connection/i.test(
    message,
  );
}

export function toErrorResponse(error: unknown): { status: number; body: { error: string; code: string } } {
  if (error instanceof ChainDuelError) {
    return { status: error.status, body: { error: error.message, code: error.code } };
  }
  if (isConnectionFailure(error)) {
    const fallback = databaseUnavailableError();
    return { status: fallback.status, body: { error: fallback.message, code: fallback.code } };
  }
  const message = error instanceof Error ? error.message : "Something went wrong.";
  const code = (error as { code?: string })?.code ?? "internal_error";
  if (message === "UNAUTHENTICATED") {
    return { status: 401, body: { error: "Sign in to continue.", code: "unauthenticated" } };
  }
  return { status: 400, body: { error: message, code } };
}
