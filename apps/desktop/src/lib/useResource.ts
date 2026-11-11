import { useCallback, useEffect, useRef, useState } from "react";
import type { DesktopError } from "./ipc";
import { useApp } from "../context";

export interface Resource<T> {
  data: T | undefined;
  error: DesktopError | null;
  loading: boolean;
  reload(): void;
}

/**
 * Fetches `load()` whenever `deps` change (and on reload()). Errors go
 * through the app's handler, so an `unauthenticated` anywhere re-opens
 * sign-in. Keeps the last good data while refetching.
 */
export function useResource<T>(
  connectionId: string,
  load: () => Promise<T>,
  deps: readonly unknown[],
  options: { enabled?: boolean; refreshMs?: number } = {},
): Resource<T> {
  const { handleError } = useApp();
  const [data, setData] = useState<T>();
  const [error, setError] = useState<DesktopError | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  const enabled = options.enabled ?? true;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setLoading(true);
    loadRef.current().then(
      (value) => {
        if (cancelled) return;
        setData(value);
        setError(null);
        setLoading(false);
      },
      (err: unknown) => {
        if (cancelled) return;
        setError(handleError(connectionId, err));
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, enabled, tick, ...deps]);

  useEffect(() => {
    if (!enabled || !options.refreshMs) return;
    const timer = setInterval(() => setTick((t) => t + 1), options.refreshMs);
    return () => clearInterval(timer);
  }, [enabled, options.refreshMs]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload };
}
