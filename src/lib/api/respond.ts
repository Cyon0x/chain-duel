import { NextResponse } from "next/server";
import { toErrorResponse } from "../services/errors";

/**
 * `JSON.stringify` throws on BigInt, and contract reads naturally produce
 * bigint stroop amounts. Normalising here means a single stray bigint can never
 * turn an otherwise valid response into a 500.
 */
export function jsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = jsonSafe(item);
    }
    return out;
  }
  return value;
}

export function ok<T>(data: T, init?: ResponseInit) {
  return NextResponse.json(jsonSafe(data), {
    ...init,
    headers: { "cache-control": "no-store", ...(init?.headers ?? {}) },
  });
}

export function fail(error: unknown) {
  const { status, body } = toErrorResponse(error);
  return NextResponse.json(jsonSafe(body), { status, headers: { "cache-control": "no-store" } });
}

export async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    return {} as T;
  }
}

export function numeric(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
