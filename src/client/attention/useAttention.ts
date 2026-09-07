/**
 * Polling for the Human Attention view.
 *
 * Fetches on mount when the tab is visible, then every
 * {@link ATTENTION_POLL_INTERVAL_MS} for as long as it stays visible. A hidden
 * tab asks the backend for nothing at all, including at mount: a tab restored
 * into the background, or opened behind the current one, waits for its first
 * visibilitychange, where the stale-on-return rule fires the first fetch because
 * there is no last success yet. A failed poll keeps the last good payload so the
 * view can stay useful behind a stale marker instead of blanking the desk.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchAttention as fetchAttentionOverHttp, type AttentionPayload } from "../api";

export const ATTENTION_POLL_INTERVAL_MS = 60_000;

export type AttentionTimerHandle = ReturnType<typeof setTimeout>;

export type AttentionFetcher = (options: { foreground: boolean }) => Promise<AttentionPayload>;

export interface UseAttentionOptions {
  /** Injectable for tests; defaults to a real `GET /api/attention`. */
  fetchAttention?: AttentionFetcher;
  /** Injectable clock; defaults to `Date.now`. */
  now?: () => number;
  setTimer?: (handler: () => void, delayMs: number) => AttentionTimerHandle;
  clearTimer?: (handle: AttentionTimerHandle) => void;
}

export interface AttentionSnapshot {
  /** The last good payload; `null` until the first fetch succeeds. */
  payload: AttentionPayload | null;
  /** Local instant of the last successful fetch. */
  lastSuccessAt: number | null;
  /** Message of the most recent failure since that success, else `null`. */
  failure: string | null;
  /** Foreground refresh: sends the bypass header and restarts the timer. */
  refresh: () => void;
}

interface AttentionFetchState {
  payload: AttentionPayload | null;
  lastSuccessAt: number | null;
  failure: string | null;
}

const INITIAL_STATE: AttentionFetchState = { payload: null, lastSuccessAt: null, failure: null };

interface ResolvedOptions {
  fetchAttention: AttentionFetcher;
  now: () => number;
  setTimer: (handler: () => void, delayMs: number) => AttentionTimerHandle;
  clearTimer: (handle: AttentionTimerHandle) => void;
}

// Resolved per call so fake timers installed after mount still take effect.
function resolveOptions(options: UseAttentionOptions): ResolvedOptions {
  return {
    fetchAttention: options.fetchAttention ?? fetchAttentionOverHttp,
    now: options.now ?? (() => Date.now()),
    setTimer: options.setTimer ?? ((handler, delayMs) => setTimeout(handler, delayMs)),
    clearTimer:
      options.clearTimer ??
      ((handle) => {
        clearTimeout(handle);
      })
  };
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useAttention(options: UseAttentionOptions = {}): AttentionSnapshot {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const [state, setState] = useState<AttentionFetchState>(INITIAL_STATE);
  // Refs, not state: the poll loop reads these without re-subscribing.
  const lastSuccessRef = useRef<number | null>(null);
  const lastAttemptRef = useRef<number | null>(null);
  const runRef = useRef<(foreground: boolean) => void>(() => {});

  useEffect(() => {
    let disposed = false;
    let handle: AttentionTimerHandle | null = null;
    // Only the newest request may write state, so a slow poll cannot land on top
    // of a foreground refresh the operator asked for later.
    let sequence = 0;

    const clearPendingTimer = (): void => {
      if (handle !== null) {
        resolveOptions(optionsRef.current).clearTimer(handle);
        handle = null;
      }
    };

    const isVisible = (): boolean => document.visibilityState === "visible";

    const schedule = (): void => {
      clearPendingTimer();
      if (disposed || !isVisible()) {
        return;
      }
      const { now, setTimer } = resolveOptions(optionsRef.current);
      const lastAttemptAt = lastAttemptRef.current;
      // Time already served against the interval counts, so returning to a
      // visible tab does not restart a full minute of waiting.
      const delayMs =
        lastAttemptAt === null
          ? ATTENTION_POLL_INTERVAL_MS
          : Math.max(0, ATTENTION_POLL_INTERVAL_MS - (now() - lastAttemptAt));
      handle = setTimer(() => {
        handle = null;
        run(false);
      }, delayMs);
    };

    const run = (foreground: boolean): void => {
      clearPendingTimer();
      const ticket = ++sequence;
      const { fetchAttention, now } = resolveOptions(optionsRef.current);
      void fetchAttention({ foreground }).then(
        (payload) => {
          if (disposed || ticket !== sequence) {
            return;
          }
          const at = now();
          lastSuccessRef.current = at;
          lastAttemptRef.current = at;
          setState({ payload, lastSuccessAt: at, failure: null });
          schedule();
        },
        (error: unknown) => {
          if (disposed || ticket !== sequence) {
            return;
          }
          // Keep the last good payload; the view marks it stale.
          lastAttemptRef.current = now();
          setState((previous) => ({ ...previous, failure: failureMessage(error) }));
          schedule();
        }
      );
    };

    runRef.current = run;

    const onVisibilityChange = (): void => {
      if (disposed) {
        return;
      }
      if (!isVisible()) {
        clearPendingTimer();
        return;
      }
      const { now } = resolveOptions(optionsRef.current);
      const lastSuccessAt = lastSuccessRef.current;
      if (lastSuccessAt === null || now() - lastSuccessAt >= ATTENTION_POLL_INTERVAL_MS) {
        run(false);
        return;
      }
      schedule();
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    // A hidden tab issues no request at all; onVisibilityChange runs the first
    // fetch when it is shown, because a null last success is always stale.
    if (isVisible()) {
      run(false);
    }

    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      clearPendingTimer();
    };
  }, []);

  const refresh = useCallback(() => {
    runRef.current(true);
  }, []);

  return { ...state, refresh };
}
