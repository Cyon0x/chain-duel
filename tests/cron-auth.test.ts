import { beforeAll, describe, expect, it } from "vitest";

const CRON_SECRET = "cron-test-secret-000000000000000000";
const SESSION_SECRET = "chain-duel-test-session-secret-000000000000";

let handle: (request: Request) => Promise<Response>;

beforeAll(async () => {
  process.env.CRON_SECRET = CRON_SECRET;
  ({ GET: handle } = await import("@/app/api/cron/maintenance/route"));
});

function sweep(headers: Record<string, string> = {}): Promise<Response> {
  return handle(new Request("https://chain-duel.test/api/cron/maintenance", { headers }));
}

describe("maintenance cron authorization", () => {
  it("rejects an unauthenticated sweep", async () => {
    const response = await sweep();
    expect(response.status).toBe(403);
  });

  it("rejects a wrong secret", async () => {
    const response = await sweep({ authorization: "Bearer not-the-secret" });
    expect(response.status).toBe(403);
  });

  it("rejects a bearer of the wrong length without throwing", async () => {
    const response = await sweep({ authorization: `Bearer ${CRON_SECRET}x` });
    expect(response.status).toBe(403);
  });

  it("accepts the Vercel Cron bearer secret", async () => {
    const response = await sweep({ authorization: `Bearer ${CRON_SECRET}` });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { expiredDuels: number; settledMatches: number };
    expect(body.expiredDuels).toBe(0);
    expect(body.settledMatches).toBe(0);
  });

  it("accepts a manual ?token= sweep using the session secret", async () => {
    const response = await handle(
      new Request(`https://chain-duel.test/api/cron/maintenance?token=${SESSION_SECRET}`),
    );
    expect(response.status).toBe(200);
  });

  it("rejects a manual ?token= sweep with a bad token", async () => {
    const response = await handle(
      new Request("https://chain-duel.test/api/cron/maintenance?token=wrong"),
    );
    expect(response.status).toBe(403);
  });
});
