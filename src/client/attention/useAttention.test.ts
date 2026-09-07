import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DASHBOARD_REFRESH_HEADER, fetchAttention } from "../api";
import { deskPayload, emptyPayload, FIXTURE_NOW_MS } from "./fixtures";
import { ATTENTION_POLL_INTERVAL_MS, useAttention } from "./useAttention";

/** Minimal `Response` stand-in: jsdom does not implement fetch. */
function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  } as unknown as Response;
}

function headersOf(init: RequestInit | undefined): Record<string, string> {
  return (init?.headers ?? {}) as Record<string, string>;
}

describe("fetchAttention", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("gets the attention endpoint through the global fetch without the bypass header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(emptyPayload));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchAttention()).resolves.toEqual(emptyPayload);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [input, init] = fetchMock.mock.calls[0] as [string, RequestInit | undefined];
    expect(input).toEqual("/api/attention");
    expect(init?.method).toEqual("GET");
    expect(headersOf(init)).not.toHaveProperty(DASHBOARD_REFRESH_HEADER);
  });

  it("sends the loopback bypass header only for a foreground refresh", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(emptyPayload));

    await fetchAttention({ foreground: true, fetch: fetchMock });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit | undefined];
    expect(headersOf(init)[DASHBOARD_REFRESH_HEADER]).toEqual("foreground");
  });

  it("names the http status when the server answers with a non-2xx", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, 503));

    await expect(fetchAttention({ fetch: fetchMock })).rejects.toThrow(/http 503/);
  });

  it("names a network failure when the request never completes", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));

    await expect(fetchAttention({ fetch: fetchMock })).rejects.toThrow(/network/);
  });

  it("names a malformed body when the response is not JSON", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token");
      }
    });

    await expect(fetchAttention({ fetch: fetchMock })).rejects.toThrow(/malformed/);
  });

  it("names a malformed body when the JSON is not payload-shaped", async () => {
    const bodies: unknown[] = [
      null,
      [],
      "ok",
      { cards: [] },
      { ...emptyPayload, cards: [{ id: "missing-fields" }] },
      { ...emptyPayload, sources: [{ repository: "a/b", mode: "smtp", status: "ok" }] }
    ];

    for (const body of bodies) {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(body));
      await expect(fetchAttention({ fetch: fetchMock })).rejects.toThrow(/malformed/);
    }
  });
});

describe("useAttention", () => {
  let clock = FIXTURE_NOW_MS;
  const now = () => clock;

  function setVisibility(state: DocumentVisibilityState): void {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
    document.dispatchEvent(new Event("visibilitychange"));
  }

  async function flush(): Promise<void> {
    await act(async () => {});
  }

  beforeEach(() => {
    clock = FIXTURE_NOW_MS;
    vi.useFakeTimers();
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  });

  afterEach(() => {
    vi.useRealTimers();
    Reflect.deleteProperty(document, "visibilityState");
  });

  it("fetches once on mount of a visible tab and keeps the payload with the success instant", async () => {
    const fetchAttentionMock = vi.fn().mockResolvedValue(deskPayload);

    expect(document.visibilityState).toEqual("visible");
    const { result } = renderHook(() => useAttention({ fetchAttention: fetchAttentionMock, now }));
    await flush();

    expect(fetchAttentionMock).toHaveBeenCalledTimes(1);
    expect(fetchAttentionMock).toHaveBeenCalledWith({ foreground: false });
    expect(result.current.payload).toEqual(deskPayload);
    expect(result.current.lastSuccessAt).toEqual(FIXTURE_NOW_MS);
    expect(result.current.failure).toBeNull();
  });

  it("asks the backend for nothing while a tab that started hidden stays hidden", async () => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    const fetchAttentionMock = vi.fn().mockResolvedValue(deskPayload);

    const { result } = renderHook(() => useAttention({ fetchAttention: fetchAttentionMock, now }));
    await flush();

    expect(fetchAttentionMock).not.toHaveBeenCalled();
    expect(result.current.payload).toBeNull();

    clock += ATTENTION_POLL_INTERVAL_MS * 2;
    await act(async () => {
      vi.advanceTimersByTime(ATTENTION_POLL_INTERVAL_MS * 2);
    });
    expect(fetchAttentionMock).not.toHaveBeenCalled();

    // No last success means the payload is stale on arrival, so showing the tab
    // is what issues the first request.
    await act(async () => {
      setVisibility("visible");
    });

    expect(fetchAttentionMock).toHaveBeenCalledTimes(1);
    expect(fetchAttentionMock).toHaveBeenCalledWith({ foreground: false });
    expect(result.current.payload).toEqual(deskPayload);
  });

  it("polls again one interval later while the tab stays visible", async () => {
    const fetchAttentionMock = vi.fn().mockResolvedValue(deskPayload);

    renderHook(() => useAttention({ fetchAttention: fetchAttentionMock, now }));
    await flush();

    clock += ATTENTION_POLL_INTERVAL_MS - 1;
    await act(async () => {
      vi.advanceTimersByTime(ATTENTION_POLL_INTERVAL_MS - 1);
    });
    expect(fetchAttentionMock).toHaveBeenCalledTimes(1);

    clock += 1;
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(fetchAttentionMock).toHaveBeenCalledTimes(2);
  });

  it("runs no fetch while the tab is hidden and clears the pending timer", async () => {
    const clearTimer = vi.fn();
    const fetchAttentionMock = vi.fn().mockResolvedValue(deskPayload);

    renderHook(() =>
      useAttention({
        fetchAttention: fetchAttentionMock,
        now,
        setTimer: (handler, delayMs) => setTimeout(handler, delayMs),
        clearTimer: (handle) => {
          clearTimer(handle);
          clearTimeout(handle);
        }
      })
    );
    await flush();

    await act(async () => {
      setVisibility("hidden");
    });
    expect(clearTimer).toHaveBeenCalled();

    clock += ATTENTION_POLL_INTERVAL_MS * 3;
    await act(async () => {
      vi.advanceTimersByTime(ATTENTION_POLL_INTERVAL_MS * 3);
    });

    expect(fetchAttentionMock).toHaveBeenCalledTimes(1);
  });

  it("fetches immediately when a hidden tab returns and the payload is stale", async () => {
    const fetchAttentionMock = vi.fn().mockResolvedValue(deskPayload);

    renderHook(() => useAttention({ fetchAttention: fetchAttentionMock, now }));
    await flush();

    await act(async () => {
      setVisibility("hidden");
    });

    clock += ATTENTION_POLL_INTERVAL_MS;
    await act(async () => {
      setVisibility("visible");
    });

    expect(fetchAttentionMock).toHaveBeenCalledTimes(2);
  });

  it("waits out the remaining interval when a returning tab is not stale", async () => {
    const fetchAttentionMock = vi.fn().mockResolvedValue(deskPayload);

    renderHook(() => useAttention({ fetchAttention: fetchAttentionMock, now }));
    await flush();

    clock += 20_000;
    await act(async () => {
      setVisibility("hidden");
    });
    await act(async () => {
      setVisibility("visible");
    });
    expect(fetchAttentionMock).toHaveBeenCalledTimes(1);

    clock += ATTENTION_POLL_INTERVAL_MS - 20_000;
    await act(async () => {
      vi.advanceTimersByTime(ATTENTION_POLL_INTERVAL_MS - 20_000);
    });

    expect(fetchAttentionMock).toHaveBeenCalledTimes(2);
  });

  it("keeps the last good payload and records the failure when a poll fails", async () => {
    const fetchAttentionMock = vi
      .fn()
      .mockResolvedValueOnce(deskPayload)
      .mockRejectedValueOnce(new Error("attention request failed: network"));

    const { result } = renderHook(() => useAttention({ fetchAttention: fetchAttentionMock, now }));
    await flush();

    clock += ATTENTION_POLL_INTERVAL_MS;
    await act(async () => {
      vi.advanceTimersByTime(ATTENTION_POLL_INTERVAL_MS);
    });

    expect(fetchAttentionMock).toHaveBeenCalledTimes(2);
    expect(result.current.payload).toEqual(deskPayload);
    expect(result.current.lastSuccessAt).toEqual(FIXTURE_NOW_MS);
    expect(result.current.failure).toMatch(/network/);
  });

  it("clears the failure once a later poll succeeds", async () => {
    const fetchAttentionMock = vi
      .fn()
      .mockResolvedValueOnce(deskPayload)
      .mockRejectedValueOnce(new Error("attention request failed: network"))
      .mockResolvedValue(emptyPayload);

    const { result } = renderHook(() => useAttention({ fetchAttention: fetchAttentionMock, now }));
    await flush();

    clock += ATTENTION_POLL_INTERVAL_MS;
    await act(async () => {
      vi.advanceTimersByTime(ATTENTION_POLL_INTERVAL_MS);
    });
    expect(result.current.failure).toMatch(/network/);

    clock += ATTENTION_POLL_INTERVAL_MS;
    await act(async () => {
      vi.advanceTimersByTime(ATTENTION_POLL_INTERVAL_MS);
    });

    expect(result.current.failure).toBeNull();
    expect(result.current.payload).toEqual(emptyPayload);
    expect(result.current.lastSuccessAt).toEqual(FIXTURE_NOW_MS + 2 * ATTENTION_POLL_INTERVAL_MS);
  });

  it("refreshes in the foreground and restarts the interval", async () => {
    const fetchAttentionMock = vi.fn().mockResolvedValue(deskPayload);

    const { result } = renderHook(() => useAttention({ fetchAttention: fetchAttentionMock, now }));
    await flush();

    clock += 30_000;
    await act(async () => {
      vi.advanceTimersByTime(30_000);
      result.current.refresh();
    });

    expect(fetchAttentionMock).toHaveBeenCalledTimes(2);
    expect(fetchAttentionMock).toHaveBeenLastCalledWith({ foreground: true });

    // The interval restarts from the refresh, not from the original mount.
    clock += 30_000;
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(fetchAttentionMock).toHaveBeenCalledTimes(2);

    clock += 30_000;
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(fetchAttentionMock).toHaveBeenCalledTimes(3);
  });

  it("stops polling once the view unmounts", async () => {
    const fetchAttentionMock = vi.fn().mockResolvedValue(deskPayload);

    const { unmount } = renderHook(() => useAttention({ fetchAttention: fetchAttentionMock, now }));
    await flush();
    unmount();

    clock += ATTENTION_POLL_INTERVAL_MS * 2;
    await act(async () => {
      vi.advanceTimersByTime(ATTENTION_POLL_INTERVAL_MS * 2);
    });

    expect(fetchAttentionMock).toHaveBeenCalledTimes(1);
  });
});
