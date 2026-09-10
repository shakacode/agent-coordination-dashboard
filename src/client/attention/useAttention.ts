/**
 * Manual refresh lifecycle for the Human Attention view.
 *
 * A visible mount performs one initial load. A hidden mount waits for its first
 * visible state before performing that load. Afterward, only an explicit visible
 * "Refresh now" action asks the backend for fresh data; timers and later
 * visibility changes never do.
 *
 * Every request is owned by an `AbortController`: starting a new one cancels the
 * request it supersedes, and the effect cleanup cancels whatever is in flight,
 * so React StrictMode's setup/cleanup/setup preflight and an unmount leave no
 * duplicate and no orphaned request behind. An abort is not a failure and never
 * raises the stale marker. A failed request keeps the last good payload so the
 * view remains useful behind a stale marker.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchAttention as fetchAttentionOverHttp, type AttentionPayload } from "../api";

export interface AttentionRequest {
  foreground: boolean;
  /** Aborted when the request is superseded, or when the view goes away. */
  signal: AbortSignal;
}

export type AttentionFetcher = (request: AttentionRequest) => Promise<AttentionPayload>;

export interface UseAttentionOptions {
  /** Injectable for tests; defaults to a real `GET /api/attention`. */
  fetchAttention?: AttentionFetcher;
  /** Injectable clock; defaults to `Date.now`. */
  now?: () => number;
}

export interface AttentionSnapshot {
  /** The last good payload; `null` until the first fetch succeeds. */
  payload: AttentionPayload | null;
  /** Local instant of the last successful fetch. */
  lastSuccessAt: number | null;
  /** Message of the most recent failure since that success, else `null`. */
  failure: string | null;
  /** Foreground refresh: sends the bypass header when the document is visible. */
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
}

function resolveOptions(options: UseAttentionOptions): ResolvedOptions {
  return {
    fetchAttention: options.fetchAttention ?? ((request) => fetchAttentionOverHttp(request)),
    now: options.now ?? (() => Date.now())
  };
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useAttention(options: UseAttentionOptions = {}): AttentionSnapshot {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const [state, setState] = useState<AttentionFetchState>(INITIAL_STATE);
  const runRef = useRef<(foreground: boolean) => void>(() => {});

  useEffect(() => {
    let disposed = false;
    let activeController: AbortController | null = null;
    let initialLoadStarted = false;
    // Only the newest request may write state, so a slow initial load cannot land
    // on top of a foreground refresh the operator asked for later.
    let sequence = 0;

    const abortActiveRequest = (): void => {
      if (activeController !== null) {
        activeController.abort();
        activeController = null;
      }
    };

    const isVisible = (): boolean => document.visibilityState === "visible";

    const run = (foreground: boolean): void => {
      if (disposed) {
        return;
      }
      // One request at a time: whatever is still in flight is superseded.
      abortActiveRequest();
      const controller = new AbortController();
      activeController = controller;
      const ticket = ++sequence;
      const { fetchAttention, now } = resolveOptions(optionsRef.current);
      const settled = (): boolean => {
        if (activeController === controller) {
          activeController = null;
        }
        // An aborted request was cancelled on purpose: it is neither a success
        // to record nor a failure to show.
        return !controller.signal.aborted && !disposed && ticket === sequence;
      };
      void fetchAttention({ foreground, signal: controller.signal }).then(
        (payload) => {
          if (!settled()) {
            return;
          }
          const at = now();
          setState({ payload, lastSuccessAt: at, failure: null });
        },
        (error: unknown) => {
          if (!settled()) {
            return;
          }
          // Keep the last good payload; the view marks it stale.
          setState((previous) => ({ ...previous, failure: failureMessage(error) }));
        }
      );
    };

    runRef.current = run;

    const runInitialLoad = (): void => {
      if (initialLoadStarted || !isVisible()) {
        return;
      }
      initialLoadStarted = true;
      run(false);
    };

    const onVisibilityChange = (): void => {
      if (disposed) {
        return;
      }
      runInitialLoad();
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    // A hidden tab issues no request at all; its first visible state starts the
    // one initial load. Later visibility changes are inert.
    runInitialLoad();

    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      abortActiveRequest();
    };
  }, []);

  const refresh = useCallback(() => {
    if (document.visibilityState !== "visible") {
      return;
    }
    runRef.current(true);
  }, []);

  return { ...state, refresh };
}
