import { fail } from "../api/respond";
import { ChainDuelError } from "../services/errors";
import { ZodError } from "zod";
export function arcFail(error: unknown) {
  if (error instanceof ChainDuelError || (error instanceof Error && error.message === "UNAUTHENTICATED"))
    return fail(error);
  if (error instanceof ZodError)
    return fail(
      new ChainDuelError(
        "Check the network, currency and required fields, then retry.",
        "invalid_request",
        400,
      ),
    );
  return fail(
    new ChainDuelError(
      "The Arc service could not complete this request. Please retry.",
      "arc_service_error",
      502,
    ),
  );
}
