import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("aborts a stalled Stellar RPC read through the SDK's actual fetch transport", async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, "timeout").mockImplementation(milliseconds => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("Request timed out", "TimeoutError")), milliseconds);
    return controller.signal;
  });
  vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
  })));
  const server = (await import("@/lib/stellar/server")).rpcServer("testnet");
  const rejected = expect(server.getNetwork()).rejects.toThrow(/timeout|timed out/i);
  await vi.advanceTimersByTimeAsync(20_000);
  await rejected;
  expect(AbortSignal.timeout).toHaveBeenCalledWith(20_000);
});
