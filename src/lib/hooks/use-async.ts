"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface AsyncState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => Promise<void>;
  setData: (value: T | null) => void;
}

/** Small polling-friendly async hook. Never throws into render. */
export function useAsync<T>(
  loader: () => Promise<T>,
  deps: unknown[] = [],
  options: {
    pollMs?: number;
    enabled?: boolean;
    /** Return false to skip a poll tick (e.g. once the data is final). */
    shouldPoll?: (data: T | null) => boolean;
  } = {},
): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [internalLoading, setInternalLoading] = useState(true);
  const loaderRef = useRef(loader);
  const mounted = useRef(true);
  const disabled = options.enabled === false;
  const dataRef = useRef<T | null>(null);
  const shouldPollRef = useRef(options.shouldPoll);

  useEffect(() => {
    shouldPollRef.current = options.shouldPoll;
  });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    loaderRef.current = loader;
  });

  const reload = useCallback(async () => {
    try {
      const value = await loaderRef.current();
      if (mounted.current) {
        dataRef.current = value;
        setData(value);
        setError(null);
      }
    } catch (caught) {
      if (mounted.current) {
        setError(caught instanceof Error ? caught.message : "Something went wrong.");
      }
    } finally {
      if (mounted.current) setInternalLoading(false);
    }
  }, []);

  useEffect(() => {
    if (disabled) return;
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, disabled]);

  useEffect(() => {
    if (!options.pollMs || disabled) return;
    const timer = window.setInterval(() => {
      if (shouldPollRef.current && !shouldPollRef.current(dataRef.current)) return;
      void reload();
    }, options.pollMs);
    return () => window.clearInterval(timer);
  }, [options.pollMs, disabled, reload]);

  const updateData = useCallback((value: T | null) => {
    dataRef.current = value;
    setData(value);
  }, []);

  return { data, error, loading: disabled ? false : internalLoading, reload, setData: updateData };
}

/** Counts up to a target value — used by the result screens. */
export function useCountUp(target: number, durationMs = 900): number {
  const [value, setValue] = useState(0);

  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced || durationMs <= 0) {
      const frame = requestAnimationFrame(() => setValue(target));
      return () => cancelAnimationFrame(frame);
    }
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      const eased = 1 - (1 - t) ** 3;
      setValue(Math.round(target * eased));
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, durationMs]);

  return value;
}
