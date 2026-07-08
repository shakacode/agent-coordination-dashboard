import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readCoordinationState } from "./readCoordinationState";

describe("readCoordinationState", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
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
        status: "active",
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
        repo: "shakacode/react_on_rails",
        target: "4005",
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
        lanes: [{ name: "docs", owner: "worker-a", targets: ["4005"], depends_on: ["batch-1:backend"] }],
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
        repo: "shakacode/react_on_rails",
        target: "4005",
        timestamp: "2026-06-17T19:45:00Z"
      })}\n{\n`
    );

    const state = await readCoordinationState(root, new Date("2026-06-17T20:00:00Z"));

    expect(state.claims).toHaveLength(1);
    expect(state.claims[0].agentId).toBe("worker-a");
    expect(state.claims[0].machineId).toBe("m5");
    expect(state.heartbeats[0].liveness).toBe("live");
    expect(state.heartbeats[0].machineId).toBe("m5");
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
    expect(state.batches[0].lanes[0].dependsOn).toEqual(["batch-1:backend"]);
    expect(state.events[0]).toMatchObject({ eventId: "event-1", type: "lane.started", machineId: "m5" });
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

  it("warns when partially initialized expected coordination directories cannot be read", async () => {
    const root = await mkdtemp(join(tmpdir(), "coord-state-partial-"));
    await mkdir(join(root, "claims"), { recursive: true });

    const state = await readCoordinationState(root, new Date("2026-06-17T20:00:00Z"));

    expect(state.claims).toEqual([]);
    expect(state.heartbeats).toEqual([]);
    expect(state.batches).toEqual([]);
    expect(state.events).toEqual([]);
    expect(state.warnings.map((warning) => warning.message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("heartbeats"),
        expect.stringContaining("batches")
      ])
    );
    expect(state.warnings.map((warning) => warning.message).join("\n")).not.toContain("No coordination state found");
    expect(state.warnings.map((warning) => warning.message).join("\n")).not.toContain("claims");
  });

  it("reads claims, heartbeats, and batches from the coordination API when configured", async () => {
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

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(state.claims[0]).toMatchObject({ agentId: "worker-api", repo: "shakacode/react_on_rails", target: "4005" });
    expect(state.heartbeats[0]).toMatchObject({ agentId: "worker-api", machineId: "m1", liveness: "live" });
    expect(state.batches[0]).toMatchObject({ batchId: "batch-api", lanes: [expect.objectContaining({ name: "api" })] });
    expect(state.events).toEqual([]);
    expect(state.warnings).toEqual([]);
  });

  it("warns instead of reading files when API mode is missing a token", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const state = await readCoordinationState("/unused", new Date("2026-06-17T20:00:00Z"), {
      apiUrl: "https://coord.example.test"
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.claims).toEqual([]);
    expect(state.warnings[0].message).toContain("AGENT_COORD_TOKEN");
  });

  it("allows loopback HTTP coordination API URLs", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ entries: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const state = await readCoordinationState("/unused", new Date("2026-06-17T20:00:00Z"), {
      apiUrl: "http://[::1]:8787",
      token: "test-token"
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(state.warnings).toEqual([]);
  });
});
