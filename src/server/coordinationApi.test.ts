import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isAttentionPrefix,
  readStatePrefix,
  readStatePrefixes,
  toAttentionPrefix,
  type AttentionPrefix
} from "./coordinationApi";

const CHECKED_AT = new Date("2026-09-06T20:00:00.000Z");
const API_URL = "https://coord.example.test";

function prefixFor(owner: string, name: string, workspace = "default"): AttentionPrefix {
  const prefix = toAttentionPrefix(workspace, owner, name);
  if (!prefix) {
    throw new Error(`Test fixture built an invalid attention prefix for ${workspace}/${owner}/${name}.`);
  }
  return prefix;
}

const PREFIX = prefixFor("shakacode", "agent-coordination-dashboard");
const OTHER_PREFIX = prefixFor("shakacode", "react_on_rails");

function options(overrides: Partial<Parameters<typeof readStatePrefix>[0]> = {}) {
  return {
    coordApiUrl: API_URL,
    coordApiToken: "test-token",
    now: () => CHECKED_AT,
    ...overrides
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A fetch that never settles until its abort signal fires. */
function stalledFetch() {
  return vi.fn((_input: string | URL | Request, init?: RequestInit) => {
    const signal = init?.signal;
    return new Promise<Response>((_resolve, reject) => {
      if (!signal) {
        reject(new Error("missing abort signal"));
        return;
      }
      signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    });
  });
}

describe("attention prefix type", () => {
  it.each([
    ["a four-segment attention prefix", "attention/default/shakacode/agent-coordination-dashboard", true],
    ["a deeper path", "attention/default/shakacode/app/extra", false],
    ["a shallower path", "attention/default/shakacode", false],
    ["a different family", "claims/default/shakacode/app", false],
    ["an empty segment", "attention/default//app", false],
    ["a whitespace segment", "attention/default/shakacode/ ", false],
    ["a traversal segment", "attention/default/../app", false],
    ["a trailing slash", "attention/default/shakacode/app/", false],
    ["an empty string", "", false]
  ])("guards %s", (_label, value, expected) => {
    expect(isAttentionPrefix(value)).toBe(expected);
  });

  it("returns null instead of throwing when a prefix part is unusable", () => {
    expect(toAttentionPrefix("default", "shakacode", "")).toBeNull();
    expect(toAttentionPrefix("default", "shaka code", "app")).toBeNull();
    expect(toAttentionPrefix("default", "shakacode", "app/nested")).toBeNull();
    expect(toAttentionPrefix("default", "shakacode", "app")).toBe("attention/default/shakacode/app");
  });
});

describe("readStatePrefix", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("requests the attention prefix with the exact URL and headers", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ entries: [] }));

    await readStatePrefix(options({ coordApiToken: " test-token\n", fetchImpl }), PREFIX);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [input, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(input)).toBe(
      "https://coord.example.test/v1/state?prefix=attention%2Fdefault%2Fshakacode%2Fagent-coordination-dashboard"
    );
    expect(init.headers).toEqual({ authorization: "Bearer test-token" });
    expect(Object.keys(init).sort()).toEqual(["headers", "signal"]);
  });

  it("reads entries and reports the prefix as ok", async () => {
    const entry = {
      path: "attention/default/shakacode/agent-coordination-dashboard/123.json",
      data: {
        schema_version: 1,
        repo: "shakacode/agent-coordination-dashboard",
        target: "123",
        reason: "review_requested"
      }
    };
    const fetchImpl = vi.fn(async () => jsonResponse({ entries: [entry] }));

    const result = await readStatePrefix(options({ fetchImpl }), PREFIX);

    expect(result.entries).toEqual([entry]);
    expect(result.warnings).toEqual([]);
    expect(result.sourceStatus).toEqual({
      prefix: PREFIX,
      mode: "api",
      status: "ok",
      httpStatus: 200,
      checkedAt: CHECKED_AT.toISOString()
    });
  });

  it("reports an answered but empty prefix as empty", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ entries: [] }));

    const result = await readStatePrefix(options({ fetchImpl }), PREFIX);

    expect(result.entries).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.sourceStatus).toMatchObject({ status: "empty", httpStatus: 200 });
  });

  it.each([401, 403])("classifies HTTP %i as auth_error naming the attention read prefix", async (status) => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "unauthorized" }, status));

    const result = await readStatePrefix(options({ coordApiToken: "expired-token", fetchImpl }), PREFIX);

    expect(result.entries).toEqual([]);
    expect(result.sourceStatus).toEqual({
      prefix: PREFIX,
      mode: "api",
      status: "auth_error",
      httpStatus: status,
      checkedAt: CHECKED_AT.toISOString()
    });
    expect(result.warnings).toEqual([
      `Could not read coordination API ${PREFIX}: ${status} unauthorized. The coordination token needs read access to the ${PREFIX} prefix.`
    ]);
  });

  it("classifies an unsupported prefix and every other non-2xx status as unreachable", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "invalid_prefix" }, 400));

    const result = await readStatePrefix(options({ fetchImpl }), PREFIX);

    expect(result.entries).toEqual([]);
    expect(result.sourceStatus).toMatchObject({ status: "unreachable", httpStatus: 400 });
    expect(result.warnings).toEqual([`Could not read coordination API ${PREFIX}: 400 invalid_prefix`]);
  });

  it("classifies a network failure as unreachable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("connection refused");
    });

    const result = await readStatePrefix(options({ fetchImpl }), PREFIX);

    expect(result.sourceStatus).toMatchObject({ status: "unreachable" });
    expect(result.sourceStatus).not.toHaveProperty("httpStatus");
    expect(result.warnings).toEqual([`Could not read coordination API ${PREFIX}: connection refused`]);
  });

  it("omits a successful HTTP status when the response wrapper is malformed", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ records: [] }));

    const result = await readStatePrefix(options({ fetchImpl }), PREFIX);

    expect(result.entries).toEqual([]);
    expect(result.sourceStatus).toMatchObject({ mode: "api", status: "unreachable" });
    expect(result.sourceStatus).not.toHaveProperty("httpStatus");
    expect(result.warnings).toEqual([`Could not read coordination API ${PREFIX}: malformed response`]);
  });

  it("classifies an unparseable 2xx body as unreachable", async () => {
    // What a proxy or captive portal returns: HTTP 200 carrying HTML. The body
    // never reaches the wrapper check, so this is the JSON.parse failure path
    // rather than the malformed-wrapper path above.
    const fetchImpl = vi.fn(async () => new Response("<html>gateway</html>", { status: 200 }));

    const result = await readStatePrefix(options({ fetchImpl }), PREFIX);

    expect(result.entries).toEqual([]);
    expect(result.sourceStatus).toMatchObject({ mode: "api", status: "unreachable" });
    expect(result.sourceStatus).not.toHaveProperty("httpStatus");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].startsWith(`Could not read coordination API ${PREFIX}: `)).toBe(true);
  });

  it("falls back to the HTTP status line when a non-2xx body is not JSON", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 502, statusText: "Bad Gateway" }));

    const result = await readStatePrefix(options({ fetchImpl }), PREFIX);

    expect(result.entries).toEqual([]);
    expect(result.sourceStatus).toMatchObject({ status: "unreachable", httpStatus: 502 });
    expect(result.warnings).toEqual([`Could not read coordination API ${PREFIX}: 502 Bad Gateway`]);
  });

  it("marks the prefix unreachable when every entry wrapper is malformed", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ entries: [null, { path: 42, data: {} }] }));

    const result = await readStatePrefix(options({ fetchImpl }), PREFIX);

    expect(result.entries).toEqual([]);
    expect(result.sourceStatus).toMatchObject({ mode: "api", status: "unreachable" });
    expect(result.sourceStatus).not.toHaveProperty("httpStatus");
    expect(result.warnings).toEqual([
      `Malformed coordination API ${PREFIX} entry at index 0`,
      `Malformed coordination API ${PREFIX} entry at index 1`
    ]);
  });

  it("keeps a valid entry but marks the prefix unreachable when a wrapper beside it is malformed", async () => {
    const valid = {
      path: "attention/default/shakacode/agent-coordination-dashboard/123.json",
      data: { repo: "shakacode/agent-coordination-dashboard", target: "123" }
    };
    const fetchImpl = vi.fn(async () => jsonResponse({ entries: [valid, { path: "attention/broken.json" }] }));

    const result = await readStatePrefix(options({ fetchImpl }), PREFIX);

    expect(result.entries).toEqual([valid]);
    expect(result.sourceStatus).toMatchObject({ mode: "api", status: "unreachable" });
    expect(result.sourceStatus).not.toHaveProperty("httpStatus");
    expect(result.warnings).toEqual([`Malformed coordination API ${PREFIX} entry at index 1`]);
  });

  it("times out a stalled request after five seconds", async () => {
    vi.useFakeTimers();
    const fetchImpl = stalledFetch();

    const pending = readStatePrefix(options({ fetchImpl }), PREFIX);
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.entries).toEqual([]);
    expect(result.sourceStatus).toMatchObject({ status: "unreachable" });
    expect(result.warnings).toEqual([`Could not read coordination API ${PREFIX}: timed out after 5000ms`]);
  });

  it("times out a stalled response body on its own budget after the headers arrive", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      const signal = init?.signal;
      const stalledBody = () =>
        new Promise((_resolve, reject) => {
          if (!signal) {
            reject(new Error("missing abort signal"));
            return;
          }
          signal.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        });
      // Headers arrive three seconds in, well inside the request budget.
      return new Promise<Response>((resolve) => {
        setTimeout(() => resolve({ ok: true, status: 200, json: stalledBody } as Response), 3000);
      });
    });

    const pending = readStatePrefix(options({ fetchImpl }), PREFIX);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });

    // Three seconds of headers plus four and a half seconds of body: a single
    // shared timer would already have aborted this read at the five-second mark.
    await vi.advanceTimersByTimeAsync(7500);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    await vi.runAllTimersAsync();
    const result = await pending;

    expect(result.entries).toEqual([]);
    expect(result.sourceStatus).toMatchObject({ status: "unreachable" });
    expect(result.warnings).toEqual([`Could not read coordination API ${PREFIX}: timed out after 5000ms`]);
  });

  it("reports auth_error without a request when the token is missing", async () => {
    const fetchImpl = vi.fn();

    const result = await readStatePrefix(options({ coordApiToken: "   ", fetchImpl }), PREFIX);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.entries).toEqual([]);
    expect(result.sourceStatus).toMatchObject({ status: "auth_error" });
    expect(result.sourceStatus).not.toHaveProperty("httpStatus");
    expect(result.warnings[0]).toContain("AGENT_COORD_API_TOKEN");
    expect(result.warnings[0]).toContain(PREFIX);
  });

  it("names the configured token variable when the fallback variable supplied the token", async () => {
    const fetchImpl = vi.fn();

    const result = await readStatePrefix(
      options({ coordApiToken: "", coordApiTokenEnvVar: "AGENT_COORD_TOKEN", fetchImpl }),
      PREFIX
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.warnings[0]).toContain("AGENT_COORD_TOKEN");
  });

  it("allows plain HTTP for loopback coordination API URLs", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ entries: [] }));

    for (const apiUrl of ["http://localhost:8787", "http://127.0.0.1:8787", "http://[::1]:8787"]) {
      const result = await readStatePrefix(options({ coordApiUrl: apiUrl, fetchImpl }), PREFIX);
      expect(result.warnings).toEqual([]);
      expect(result.sourceStatus).toMatchObject({ status: "empty" });
    }

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(String((fetchImpl.mock.calls[2] as unknown as [URL])[0])).toBe(
      "http://[::1]:8787/v1/state?prefix=attention%2Fdefault%2Fshakacode%2Fagent-coordination-dashboard"
    );
  });

  it("refuses plain HTTP for a non-loopback coordination API URL", async () => {
    const fetchImpl = vi.fn();

    const result = await readStatePrefix(options({ coordApiUrl: "http://coord.example.test", fetchImpl }), PREFIX);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.sourceStatus).toMatchObject({ status: "unreachable" });
    expect(result.warnings).toEqual([
      "Invalid AGENT_COORD_API_URL: HTTP coordination API URLs must use https unless they point at localhost"
    ]);
  });

  it.each([
    ["a query string", "https://coord.example.test/?tenant=a"],
    ["a fragment", "https://coord.example.test/#tenant"]
  ])("refuses a base URL carrying %s rather than misrouting the state request", async (_label, apiUrl) => {
    const fetchImpl = vi.fn();

    const result = await readStatePrefix(options({ coordApiUrl: apiUrl, fetchImpl }), PREFIX);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.sourceStatus).toMatchObject({ status: "unreachable" });
    expect(result.warnings).toEqual([
      "Invalid AGENT_COORD_API_URL: expected an http(s) URL with no query string or fragment"
    ]);
  });

  it("reports unreachable without a request when no API URL is configured", async () => {
    const fetchImpl = vi.fn();

    const result = await readStatePrefix(options({ coordApiUrl: "  ", fetchImpl }), PREFIX);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.sourceStatus).toMatchObject({ status: "unreachable" });
    expect(result.warnings).toEqual([
      `Could not read coordination API ${PREFIX}: AGENT_COORD_API_URL is not configured.`
    ]);
  });
});

describe("readStatePrefixes", () => {
  it("isolates a failing prefix from the prefixes that answered", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const prefix = new URL(String(input)).searchParams.get("prefix");
      if (prefix === OTHER_PREFIX) {
        throw new Error("connection refused");
      }
      return jsonResponse({
        entries: [
          {
            path: "attention/default/shakacode/agent-coordination-dashboard/123.json",
            data: { repo: "shakacode/agent-coordination-dashboard", target: "123" }
          }
        ]
      });
    });

    const [read, failed] = await readStatePrefixes(options({ fetchImpl }), [PREFIX, OTHER_PREFIX]);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(read.entries).toHaveLength(1);
    expect(read.warnings).toEqual([]);
    expect(read.sourceStatus).toMatchObject({ prefix: PREFIX, status: "ok", httpStatus: 200 });
    expect(failed.entries).toEqual([]);
    expect(failed.sourceStatus).toMatchObject({ prefix: OTHER_PREFIX, status: "unreachable" });
    expect(failed.warnings).toEqual([`Could not read coordination API ${OTHER_PREFIX}: connection refused`]);
  });

  it("stamps every prefix with one checkedAt", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ entries: [] }));

    const results = await readStatePrefixes(options({ fetchImpl }), [PREFIX, OTHER_PREFIX]);

    expect(results.map((result) => result.sourceStatus.checkedAt)).toEqual([
      CHECKED_AT.toISOString(),
      CHECKED_AT.toISOString()
    ]);
  });
});
