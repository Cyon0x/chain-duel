import { ok } from "@/lib/api/respond";
import { arcFail as fail } from "@/lib/arc/respond";
import { bridgeAvailability } from "@/lib/bridge/config";
import { getSessionUser } from "@/lib/auth/session";
import { arcDb } from "@/lib/arc/db";
import { arcSession, sameOrigin } from "@/lib/arc/access";
import { readArcJson } from "@/lib/arc/request";
import { validateArcRequest } from "@/lib/arc/api";
import { publicArcConfig } from "@/lib/arc/config";
import {
  quoteBridge,
  createBridge,
  prepareBridgeStep,
  authorizeBridgeStep,
  refreshBridge,
  recoverBridgeDestination,
  cancelBridge,
} from "@/lib/bridge/service";
import { z } from "zod";
export async function GET() {
  try {
    const session = await getSessionUser();
    const transfers = session
      ? await (
          await arcDb()
        ).query("SELECT * FROM bridge_transfers WHERE user_id=? ORDER BY created_at DESC LIMIT 50", [
          session.user.id,
        ])
      : [];
    return ok({
      availability: bridgeAvailability(session?.user.id),
      arc: publicArcConfig(),
      signedIn: Boolean(session),
      transfers,
    });
  } catch (error) {
    return fail(error);
  }
}
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const body = await readArcJson(request);
    validateArcRequest(body);
    const session = await arcSession();
    const input = z
      .discriminatedUnion("action", [
        z.object({
          action: z.literal("quote"),
          source: z.enum(["stellar", "arc"]),
          amount: z.string().max(24),
        }),
        z.object({
          action: z.literal("create"),
          source: z.enum(["stellar", "arc"]),
          amount: z.string().max(24),
          idempotencyKey: z.uuid(),
        }),
        z.object({
          action: z.literal("prepare"),
          id: z.uuid(),
          phase: z.enum(["trustline", "source_approval", "source_burn", "destination_mint"]),
        }),
        z.object({
          action: z.literal("approve"),
          id: z.uuid(),
          stepId: z.uuid(),
        }),
        z.object({ action: z.literal("refresh"), id: z.uuid() }),
        z.object({
          action: z.literal("recover"),
          id: z.uuid(),
          transactionHash: z.string().regex(/^(0x)?[0-9a-fA-F]{64}$/),
        }),
        z.object({ action: z.literal("cancel"), id: z.uuid() }),
      ])
      .parse(body);
    const userId = session.user.id;
    switch (input.action) {
      case "quote":
        return ok({
          quote: await quoteBridge(userId, input.source, input.amount),
        });
      case "create":
        return ok({
          transfer: await createBridge(userId, input.source, input.amount, input.idempotencyKey),
        });
      case "prepare":
        return ok({
          prepared: await prepareBridgeStep(userId, input.id, input.phase),
        });
      case "approve":
        return ok(await authorizeBridgeStep(userId, input.id, input.stepId));
      case "refresh":
        return ok(await refreshBridge(userId, input.id));
      case "recover":
        return ok(await recoverBridgeDestination(userId, input.id, input.transactionHash));
      case "cancel":
        return ok(await cancelBridge(userId, input.id));
    }
  } catch (error) {
    return fail(error);
  }
}
