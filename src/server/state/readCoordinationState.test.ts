import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { finiteNonNegativeDecimalInteger, readCoordinationState } from "./readCoordinationState";

describe("readCoordinationState", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each([
    ["number zero", 0, 0],
    ["number eight", 8, 8],
    ["decimal string", "8", 8],
    ["blank string", "", undefined],
    ["whitespace string", "   ", undefined],
    ["negative number", -1, undefined],
    ["fraction", 1.5, undefined],
    ["leading zero string", "08", undefined],
    ["hex string", "0x10", undefined],
    ["exponent string", "1e2", undefined],
    ["NaN", Number.NaN, undefined],
    ["Infinity", Number.POSITIVE_INFINITY, undefined]
  ])("normalizes generation only for non-negative decimal integers: %s", (_label, value, expected) => {
    expect(finiteNonNegativeDecimalInteger(value)).toBe(expected);
  });

  it("normalizes a missing claim agent id to display-safe unattributed", async () => {
    const root = await mkdtemp(join(tmpdir(), "coord-state-missing-agent-"));
    await mkdir(join(root, "claims", "repo", "app"), { recursive: true });
    await writeFile(join(root, "claims", "repo", "app", "43.json"), JSON.stringify({ repo: "repo/app", target: "43", status: "active" }));
    const state = await readCoordinationState(root, new Date("2026-07-12T12:00:00Z"));
    expect(state.claims[0].agentId).toBe("unattributed");
  });

  it("reads claims, heartbeats, batches, and malformed file warnings", async () => {
    const root = await mkdtemp(join(tmpdir(), "coord-state-"));
    await mkdir(join(root, "claims", "shakacode", "react_on_rails"), { recursive: true });
    await mkdir(join(root, "heartbeats"), { recursive: true });
    await mkdir(join(root, "batches"), { recursive: true });
    await mkdir(join(root, "events"), { recursive: true });

    await writeFile(
      join(root, "claims", "shakacode", "react_on_rails", "4005.json"),
      JSON.stringify({
        schema_version: 1,
        repo: "shakacode/react_on_rails",
        target: "4005",
        agent_id: "worker-a",
        machine_id: "m5",
        thread_handle: "thread-a",
        host: "codex",
        operator: "justin",
        branch: "feature/operator-view",
        pr_url: "https://github.com/shakacode/react_on_rails/pull/4005",
        status: "active",
        generation: 7,
        updated_at: "2026-06-17T19:50:00Z",
        expires_at: "2026-06-17T23:50:00Z"
      })
    );
    await writeFile(join(root, "claims", "shakacode", "react_on_rails", "broken.json"), "{");
    await writeFile(
      join(root, "heartbeats", "worker-a.json"),
      JSON.stringify({
        schema_version: 1,
        agent_id: "worker-a",
        machine_id: "m5",
        thread_handle: "thread-a",
        host: "codex",
        operator: "justin",
        repo: "shakacode/react_on_rails",
        target: "4005",
        branch: "feature/operator-view",
        pr_url: "https://github.com/shakacode/react_on_rails/pull/4005",
        status: "in_progress",
        updated_at: "2026-06-17T19:50:00Z",
        expires_at: "2026-06-17T20:05:00Z"
      })
    );
    await writeFile(
      join(root, "batches", "batch-1.json"),
      JSON.stringify({
        schema_version: 1,
        batch_id: "batch-1",
        repo: "shakacode/react_on_rails",
        objective: "Stabilize the docs workflow.",
        targets: [{ type: "pull_request", target: "4005", title: "Docs workflow" }],
        lanes: [
          {
            name: "docs",
            owner: "worker-a",
            targets: ["4005"],
            depends_on: ["batch-1:backend"],
            thread_handle: "thread-a",
            host: "codex",
            operator: "justin",
            branch: "feature/operator-view",
            pr_url: "https://github.com/shakacode/react_on_rails/pull/4005"
          }
        ],
        reservations: [{ type: "issue", target: "4010", reason: "Waiting for issue owner." }],
        created_at: "2026-06-17T19:40:00Z",
        created_by_machine: "m5",
        launch_prompt: "Use $pr-batch to complete batch-1."
      })
    );
    await writeFile(join(root, "heartbeats", "broken.json"), "{");
    await writeFile(
      join(root, "events", "batch-1.jsonl"),
      `${JSON.stringify({
        event_id: "event-1",
        type: "lane.started",
        batch_id: "batch-1",
        lane_name: "docs",
        agent_id: "worker-a",
        machine_id: "m5",
        thread_handle: "thread-a",
        host: "codex",
        operator: "justin",
        repo: "shakacode/react_on_rails",
        target: "4005",
        branch: "feature/operator-view",
        pr_url: "https://github.com/shakacode/react_on_rails/pull/4005",
        generation: "8",
        timestamp: "2026-06-17T19:45:00Z"
      })}\n{\n`
    );

    const state = await readCoordinationState(root, new Date("2026-06-17T20:00:00Z"));

    expect(state.claims).toHaveLength(1);
    expect(state.claims[0].agentId).toBe("worker-a");
    expect(state.claims[0].machineId).toBe("m5");
    expect(state.claims[0]).toMatchObject({
      threadHandle: "thread-a",
      host: "codex",
      operator: "justin",
      branch: "feature/operator-view",
      prUrl: "https://github.com/shakacode/react_on_rails/pull/4005",
      generation: 7
    });
    expect(state.heartbeats[0].liveness).toBe("live");
    expect(state.heartbeats[0].machineId).toBe("m5");
    expect(state.heartbeats[0]).toMatchObject({
      threadHandle: "thread-a",
      host: "codex",
      operator: "justin",
      branch: "feature/operator-view",
      prUrl: "https://github.com/shakacode/react_on_rails/pull/4005"
    });
    expect(state.batches[0]).toMatchObject({
      batchId: "batch-1",
      repo: "shakacode/react_on_rails",
      objective: "Stabilize the docs workflow.",
      targets: [{ type: "pull_request", target: "4005", title: "Docs workflow" }],
      reservations: [{ type: "issue", target: "4010", reason: "Waiting for issue owner." }],
      createdAt: "2026-06-17T19:40:00Z",
      createdByMachine: "m5",
      launchPrompt: "Use $pr-batch to complete batch-1."
    });
    expect(state.batches[0].lanes[0]).toMatchObject({
      dependsOn: ["batch-1:backend"],
      threadHandle: "thread-a",
      host: "codex",
      operator: "justin",
      branch: "feature/operator-view",
      prUrl: "https://github.com/shakacode/react_on_rails/pull/4005"
    });
    expect(state.events[0]).toMatchObject({
      eventId: "event-1",
      type: "lane.started",
      machineId: "m5",
      threadHandle: "thread-a",
      host: "codex",
      operator: "justin",
      branch: "feature/operator-view",
      prUrl: "https://github.com/shakacode/react_on_rails/pull/4005",
      generation: 8
    });
    expect(state.warnings.map((warning) => warning.message)).toEqual(
      expect.arrayContaining([expect.stringContaining("events/batch-1.jsonl:2")])
    );
    expect(state.warnings.map((warning) => warning.message)).toEqual(expect.arrayContaining([expect.stringContaining("Malformed JSON")]));
    expect(state.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          repo: "shakacode/react_on_rails",
          target: "broken"
        })
      ])
    );
    expect(state.sourceStatus).toEqual([
      expect.objectContaining({ resource: "claims", status: "unreachable" }),
      expect.objectContaining({ resource: "heartbeats", status: "unreachable" }),
      expect.objectContaining({ resource: "batches", status: "ok" }),
      expect.objectContaining({ resource: "events", status: "unreachable" })
    ]);
  });

  it("marks a filesystem source unreachable when every discovered record is malformed", async () => {
    const root = await mkdtemp(join(tmpdir(), "coord-state-all-malformed-"));
    await mkdir(join(root, "claims"), { recursive: true });
    await mkdir(join(root, "heartbeats"), { recursive: true });
    await mkdir(join(root, "batches"), { recursive: true });
    await writeFile(join(root, "claims", "broken.json"), "{");

    const state = await readCoordinationState(root, new Date("2026-06-17T20:00:00Z"));

    expect(state.claims).toEqual([]);
    expect(state.sourceStatus.find((source) => source.resource === "claims")).toEqual(
      expect.objectContaining({ mode: "fs", status: "unreachable" })
    );
  });

  it("shows a setup notice instead of missing-directory warnings for empty roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "coord-state-missing-"));

    const state = await readCoordinationState(root, new Date("2026-06-17T20:00:00Z"));

    expect(state.claims).toEqual([]);
    expect(state.heartbeats).toEqual([]);
    expect(state.batches).toEqual([]);
    expect(state.events).toEqual([]);
    expect(state.warnings).toEqual([
      expect.objectContaining({
        severity: "info",
        message: expect.stringContaining("AGENT_COORD_STATE_ROOT")
      })
    ]);
    expect(state.warnings[0].message).toContain("Set AGENT_COORD_STATE_ROOT to an existing coordination workspace");
    expect(state.warnings.map((warning) => warning.message).join("\n")).not.toContain("Could not read coordination directory");
  });

  it("shows the state root environment variable when the configured root cannot be read", async () => {
    const parent = await mkdtemp(join(tmpdir(), "coord-state-missing-parent-"));
    const root = join(parent, "missing-root");

    const state = await readCoordinationState(root, new Date("2026-06-17T20:00:00Z"));

    expect(state.warnings).toEqual([
      expect.objectContaining({
        severity: "info",
        message: expect.stringContaining("AGENT_COORD_STATE_ROOT")
      })
    ]);
    expect(state.warnings[0].message).toContain("Set AGENT_COORD_STATE_ROOT to an existing coordination workspace");
  });

  it("treats missing sibling directories in a partially initialized root as empty", async () => {
    const root = await mkdtemp(join(tmpdir(), "coord-state-partial-"));
    await mkdir(join(root, "claims"), { recursive: true });

    const state = await readCoordinationState(root, new Date("2026-06-17T20:00:00Z"));

    expect(state.claims).toEqual([]);
    expect(state.heartbeats).toEqual([]);
    expect(state.batches).toEqual([]);
    expect(state.events).toEqual([]);
    expect(state.warnings).toEqual([]);
    expect(state.warnings.map((warning) => warning.message).join("\n")).not.toContain("No coordination state found");
    expect(state.warnings.map((warning) => warning.message).join("\n")).not.toContain("claims");
    expect(state.sourceStatus).toEqual([
      expect.objectContaining({ resource: "claims", mode: "fs", status: "empty" }),
      expect.objectContaining({ resource: "heartbeats", mode: "fs", status: "empty" }),
      expect.objectContaining({ resource: "batches", mode: "fs", status: "empty" }),
      expect.objectContaining({ resource: "events", mode: "fs", status: "empty" })
    ]);
  });

  it("marks a filesystem resource unreachable when its state path cannot be listed", async () => {
    const root = await mkdtemp(join(tmpdir(), "coord-state-unreadable-"));
    await mkdir(join(root, "claims"), { recursive: true });
    await mkdir(join(root, "batches"), { recursive: true });
    await writeFile(join(root, "heartbeats"), "not a directory");

    const state = await readCoordinationState(root, new Date("2026-06-17T20:00:00Z"));

    expect(state.sourceStatus).toEqual(
      expect.arrayContaining([expect.objectContaining({ resource: "heartbeats", mode: "fs", status: "unreachable" })])
    );
    expect(state.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ message: expect.stringContaining("coordination directory heartbeats") })])
    );
  });

  it("reads claims, heartbeats, batches, and events from the coordination API when configured", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toEqual({ authorization: "Bearer test-token" });
      const url = new URL(String(input));
      const prefix = url.searchParams.get("prefix");
      const entriesByPrefix = {
        claims: [
          {
            path: "claims/shakacode/react_on_rails/4005.json",
            data: {
              schema_version: 1,
              repo: "shakacode/react_on_rails",
              target: "4005",
              agent_id: "worker-api",
              status: "active"
            }
          }
        ],
        heartbeats: [
          {
            path: "heartbeats/worker-api.json",
            data: {
              schema_version: 1,
              agent_id: "worker-api",
              machine_id: "m1",
              repo: "shakacode/react_on_rails",
              target: "4005",
              status: "in_progress",
              updated_at: "2026-06-17T19:50:00Z",
              expires_at: "2026-06-17T20:05:00Z"
            }
          }
        ],
        batches: [
          {
            path: "batches/batch-api.json",
            data: {
              schema_version: 1,
              batch_id: "batch-api",
              repo: "shakacode/react_on_rails",
              lanes: [{ name: "api", owner: "worker-api", targets: ["4005"] }]
            }
          }
        ],
        events: [
          {
            path: "events/batch-api/20260709T001500000000Z-event.json",
            data: {
              schema_version: 1,
              event_id: "20260709T001500000000Z-event",
              type: "phase",
              batch_id: "batch-api",
              lane: "api",
              agent_id: "worker-api",
              repo: "shakacode/react_on_rails",
              target: "4005",
              phase: "validating",
              at: "2026-06-17T19:55:00Z",
              message: "running tests"
            }
          }
        ]
      } as const;

      return new Response(JSON.stringify({ entries: entriesByPrefix[prefix as keyof typeof entriesByPrefix] || [] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const state = await readCoordinationState("/unused", new Date("2026-06-17T20:00:00Z"), {
      apiUrl: "https://coord.example.test",
      token: " test-token\n"
    });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(state.claims[0]).toMatchObject({ agentId: "worker-api", repo: "shakacode/react_on_rails", target: "4005" });
    expect(state.heartbeats[0]).toMatchObject({ agentId: "worker-api", machineId: "m1", liveness: "live" });
    expect(state.batches[0]).toMatchObject({ batchId: "batch-api", lanes: [expect.objectContaining({ name: "api" })] });
    expect(state.events[0]).toMatchObject({
      eventId: "20260709T001500000000Z-event",
      type: "phase",
      batchId: "batch-api",
      laneName: "api",
      agentId: "worker-api",
      repo: "shakacode/react_on_rails",
      target: "4005",
      status: "validating",
      message: "running tests",
      timestamp: "2026-06-17T19:55:00Z"
    });
    expect(state.warnings).toEqual([]);
  });

  it("keeps API mode usable when the backend does not support events yet", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const prefix = url.searchParams.get("prefix");
      if (prefix === "events") {
        return new Response(JSON.stringify({ error: "invalid_prefix" }), {
          status: 400,
          headers: { "content-type": "application/json" }
        });
      }

      return new Response(JSON.stringify({ entries: [] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const state = await readCoordinationState("/unused", new Date("2026-06-17T20:00:00Z"), {
      apiUrl: "https://coord.example.test",
      token: "test-token"
    });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(state.events).toEqual([]);
    expect(state.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ message: "Could not read coordination API events: 400 invalid_prefix" })])
    );
  });

  it("classifies authentication failures per coordination API resource", async () => {
    const checkedAt = new Date("2026-06-17T20:00:00Z");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json" }
        })
      )
    );

    const state = await readCoordinationState("/unused", checkedAt, {
      apiUrl: "https://coord.example.test",
      token: "expired-token"
    });

    expect(state.sourceStatus).toEqual([
      { resource: "claims", mode: "api", status: "auth_error", httpStatus: 401, checkedAt: checkedAt.toISOString() },
      { resource: "heartbeats", mode: "api", status: "auth_error", httpStatus: 401, checkedAt: checkedAt.toISOString() },
      { resource: "batches", mode: "api", status: "auth_error", httpStatus: 401, checkedAt: checkedAt.toISOString() },
      { resource: "events", mode: "api", status: "auth_error", httpStatus: 401, checkedAt: checkedAt.toISOString() }
    ]);
  });

  it("keeps successful API prefixes when one prefix fails", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const prefix = url.searchParams.get("prefix");
      if (prefix === "heartbeats") {
        throw new Error("connection refused");
      }

      const entriesByPrefix = {
        claims: [
          {
            path: "claims/shakacode/react_on_rails/4005.json",
            data: {
              schema_version: 1,
              repo: "shakacode/react_on_rails",
              target: "4005",
              agent_id: "worker-api",
              status: "active"
            }
          }
        ],
        batches: [
          {
            path: "batches/batch-api.json",
            data: {
              schema_version: 1,
              batch_id: "batch-api",
              repo: "shakacode/react_on_rails",
              lanes: [{ name: "api", owner: "worker-api", targets: ["4005"] }]
            }
          }
        ]
      } as const;

      return new Response(JSON.stringify({ entries: entriesByPrefix[prefix as keyof typeof entriesByPrefix] || [] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const state = await readCoordinationState("/unused", new Date("2026-06-17T20:00:00Z"), {
      apiUrl: "https://coord.example.test",
      token: "test-token"
    });

    expect(state.claims).toHaveLength(1);
    expect(state.heartbeats).toEqual([]);
    expect(state.batches).toHaveLength(1);
    expect(state.warnings.map((warning) => warning.message)).toEqual(
      expect.arrayContaining([expect.stringContaining("Could not read coordination API heartbeats: connection refused")])
    );
    expect(state.sourceStatus).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ resource: "claims", status: "ok", httpStatus: 200 }),
        expect.objectContaining({ resource: "heartbeats", status: "unreachable" }),
        expect.objectContaining({ resource: "events", status: "empty", httpStatus: 200 })
      ])
    );
  });

  it("adds repo context to malformed coordination API record warnings", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const prefix = url.searchParams.get("prefix");
      const entries =
        prefix === "batches"
          ? [
              {
                path: "batches/broken.json",
                data: {
                  schema_version: 1,
                  batch_id: "broken",
                  repo: "shakacode/react_on_rails",
                  lanes: [null]
                }
              }
            ]
          : [];

      return new Response(JSON.stringify({ entries }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const state = await readCoordinationState("/unused", new Date("2026-06-17T20:00:00Z"), {
      apiUrl: "https://coord.example.test",
      token: "test-token"
    });

    expect(state.batches).toEqual([]);
    expect(state.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          repo: "shakacode/react_on_rails",
          message: expect.stringContaining("Malformed coordination API batches record batches/broken.json")
        })
      ])
    );
    expect(state.sourceStatus.find((source) => source.resource === "batches")).toEqual(
      expect.objectContaining({ mode: "api", status: "unreachable" })
    );
    expect(state.sourceStatus.find((source) => source.resource === "batches")).not.toHaveProperty("httpStatus");
  });

  it("omits a successful HTTP status when the coordination API response shape is malformed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ records: [] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      )
    );

    const state = await readCoordinationState("/unused", new Date("2026-06-17T20:00:00Z"), {
      apiUrl: "https://coord.example.test",
      token: "test-token"
    });

    expect(state.sourceStatus.find((source) => source.resource === "claims")).toEqual(
      expect.objectContaining({ mode: "api", status: "unreachable" })
    );
    expect(state.sourceStatus.find((source) => source.resource === "claims")).not.toHaveProperty("httpStatus");
  });

  it("marks an API source unreachable when every entry wrapper is malformed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const prefix = new URL(String(input)).searchParams.get("prefix");
        return new Response(JSON.stringify({ entries: prefix === "claims" ? [null, { path: 42, data: {} }] : [] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      })
    );

    const state = await readCoordinationState("/unused", new Date("2026-06-17T20:00:00Z"), {
      apiUrl: "https://coord.example.test",
      token: "test-token"
    });

    expect(state.claims).toEqual([]);
    expect(state.sourceStatus.find((source) => source.resource === "claims")).toEqual(
      expect.objectContaining({ mode: "api", status: "unreachable" })
    );
    expect(state.sourceStatus.find((source) => source.resource === "claims")).not.toHaveProperty("httpStatus");
  });

  it("marks an API source unreachable when a malformed entry wrapper accompanies a valid record", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const prefix = new URL(String(input)).searchParams.get("prefix");
        const entries =
          prefix === "claims"
            ? [
                {
                  path: "claims/shakacode/react_on_rails/4005.json",
                  data: { repo: "shakacode/react_on_rails", target: "4005", agent_id: "worker-a", status: "active" }
                },
                { path: "claims/broken.json" }
              ]
            : [];
        return new Response(JSON.stringify({ entries }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      })
    );

    const state = await readCoordinationState("/unused", new Date("2026-06-17T20:00:00Z"), {
      apiUrl: "https://coord.example.test",
      token: "test-token"
    });

    expect(state.claims).toHaveLength(1);
    expect(state.claims[0]).toMatchObject({ agentId: "worker-a", target: "4005" });
    expect(state.sourceStatus.find((source) => source.resource === "claims")).toEqual(
      expect.objectContaining({ mode: "api", status: "unreachable" })
    );
    expect(state.sourceStatus.find((source) => source.resource === "claims")).not.toHaveProperty("httpStatus");
  });

  it("times out stalled coordination API requests", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
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
    vi.stubGlobal("fetch", fetchMock);

    const statePromise = readCoordinationState("/unused", new Date("2026-06-17T20:00:00Z"), {
      apiUrl: "https://coord.example.test",
      token: "test-token"
    });
    await vi.runAllTimersAsync();
    const state = await statePromise;

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(state.claims).toEqual([]);
    expect(state.heartbeats).toEqual([]);
    expect(state.batches).toEqual([]);
    expect(state.warnings.map((warning) => warning.message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Could not read coordination API claims: timed out after 5000ms"),
        expect.stringContaining("Could not read coordination API heartbeats: timed out after 5000ms"),
        expect.stringContaining("Could not read coordination API batches: timed out after 5000ms")
      ])
    );
    expect(state.sourceStatus).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ resource: "claims", status: "unreachable" }),
        expect.objectContaining({ resource: "heartbeats", status: "unreachable" }),
        expect.objectContaining({ resource: "batches", status: "unreachable" }),
        expect.objectContaining({ resource: "events", status: "unreachable" })
      ])
    );
  });

  it("times out stalled coordination API response bodies", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      const signal = init?.signal;
      const response = {
        ok: true,
        status: 200,
        json: () =>
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
          })
      } as Response;
      return Promise.resolve(response);
    });
    vi.stubGlobal("fetch", fetchMock);

    const statePromise = readCoordinationState("/unused", new Date("2026-06-17T20:00:00Z"), {
      apiUrl: "https://coord.example.test",
      token: "test-token"
    });
    await vi.runAllTimersAsync();
    const state = await statePromise;

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(state.warnings.map((warning) => warning.message)).toEqual(
      expect.arrayContaining([expect.stringContaining("Could not read coordination API claims: timed out after 5000ms")])
    );
  });

  it("warns instead of reading files when API mode is missing a token", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const state = await readCoordinationState("/unused", new Date("2026-06-17T20:00:00Z"), {
      apiUrl: "https://coord.example.test"
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.claims).toEqual([]);
    expect(state.warnings[0].message).toContain("AGENT_COORD_API_TOKEN");
  });

  it("keeps host app metadata separate from machine id", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const prefix = url.searchParams.get("prefix");
      const entriesByPrefix = {
        claims: [
          {
            path: "claims/shakacode/react_on_rails/4005.json",
            data: {
              schema_version: 1,
              repo: "shakacode/react_on_rails",
              target: "4005",
              agent_id: "worker-api",
              host: "codex",
              status: "active"
            }
          }
        ],
        heartbeats: [
          {
            path: "heartbeats/worker-api.json",
            data: {
              schema_version: 1,
              agent_id: "worker-api",
              host: "claude",
              repo: "shakacode/react_on_rails",
              target: "4005",
              status: "in_progress",
              updated_at: "2026-06-17T19:50:00Z",
              expires_at: "2026-06-17T20:05:00Z"
            }
          }
        ],
        batches: [],
        events: []
      } as const;

      return new Response(JSON.stringify({ entries: entriesByPrefix[prefix as keyof typeof entriesByPrefix] || [] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const state = await readCoordinationState("/unused", new Date("2026-06-17T20:00:00Z"), {
      apiUrl: "https://coord.example.test",
      token: "test-token"
    });

    expect(state.claims[0]).toMatchObject({ host: "codex", machineId: undefined });
    expect(state.heartbeats[0]).toMatchObject({ host: "claude", machineId: undefined, liveness: "live" });
  });

  it("allows loopback HTTP coordination API URLs", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ entries: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const state = await readCoordinationState("/unused", new Date("2026-06-17T20:00:00Z"), {
      apiUrl: "http://[::1]:8787",
      token: "test-token"
    });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(state.warnings).toEqual([]);
  });
});
