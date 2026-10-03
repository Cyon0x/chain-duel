import { NextResponse } from "next/server";
import { toErrorResponse } from "../services/errors";

export function ok<T>(data: T, init?: ResponseInit) {
  return NextResponse.json(data, {
    ...init,
    headers: { "cache-control": "no-store", ...(init?.headers ?? {}) },
  });
}

export function fail(error: unknown) {
  const { status, body } = toErrorResponse(error);
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
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
