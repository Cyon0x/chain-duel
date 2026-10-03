"use client";

/**
 * Browser-side API client. Every call goes to a server route that re-validates
 * the session and the request; nothing here is trusted by the backend.
 */

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      accept: "application/json",
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const body = (payload ?? {}) as { error?: string; code?: string };
    throw new ApiError(body.error ?? "Something went wrong. Please try again.", body.code ?? "error", response.status);
  }
  return payload as T;
}

export function post<T>(path: string, body?: unknown): Promise<T> {
  return api<T>(path, { method: "POST", body: JSON.stringify(body ?? {}) });
}

export function patch<T>(path: string, body?: unknown): Promise<T> {
  return api<T>(path, { method: "PATCH", body: JSON.stringify(body ?? {}) });
}

export function del<T>(path: string): Promise<T> {
  return api<T>(path, { method: "DELETE" });
}
