import { it, expect } from "vitest";
import { arcFail } from "@/lib/arc/respond";
it("never returns private provider details from unexpected errors", async () => {
  const response = arcFail(new Error("upstream CIRCLE_API_KEY=unit-test-secret request failed"));
  const body = await response.json();
  expect(response.status).toBe(502);
  expect(JSON.stringify(body)).not.toContain("unit-test-secret");
});
