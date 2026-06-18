import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readCoordinationState } from "./readCoordinationState";

describe("readCoordinationState", () => {
  it("reads claims, heartbeats, batches, and malformed file warnings", async () => {
    const root = await mkdtemp(join(tmpdir(), "coord-state-"));
    await mkdir(join(root, "claims", "shakacode", "react_on_rails"), { recursive: true });
    await mkdir(join(root, "heartbeats"), { recursive: true });
    await mkdir(join(root, "batches"), { recursive: true });

    await writeFile(
      join(root, "claims", "shakacode", "react_on_rails", "4005.json"),
      JSON.stringify({
        schema_version: 1,
        repo: "shakacode/react_on_rails",
        target: "4005",
        agent_id: "worker-a",
        status: "active",
        updated_at: "2026-06-17T19:50:00Z",
        expires_at: "2026-06-17T23:50:00Z"
      })
    );
    await writeFile(
      join(root, "heartbeats", "worker-a.json"),
      JSON.stringify({
        schema_version: 1,
        agent_id: "worker-a",
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
        lanes: [{ name: "docs", owner: "worker-a", targets: ["4005"], depends_on: ["batch-1:backend"] }]
      })
    );
    await writeFile(join(root, "heartbeats", "broken.json"), "{");

    const state = await readCoordinationState(root, new Date("2026-06-17T20:00:00Z"));

    expect(state.claims).toHaveLength(1);
    expect(state.claims[0].agentId).toBe("worker-a");
    expect(state.heartbeats[0].liveness).toBe("live");
    expect(state.batches[0].lanes[0].dependsOn).toEqual(["batch-1:backend"]);
    expect(state.warnings[0].message).toContain("Malformed JSON");
  });

  it("warns when expected coordination directories cannot be read", async () => {
    const root = await mkdtemp(join(tmpdir(), "coord-state-missing-"));

    const state = await readCoordinationState(root, new Date("2026-06-17T20:00:00Z"));

    expect(state.claims).toEqual([]);
    expect(state.heartbeats).toEqual([]);
    expect(state.batches).toEqual([]);
    expect(state.warnings.map((warning) => warning.message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("claims"),
        expect.stringContaining("heartbeats"),
        expect.stringContaining("batches")
      ])
    );
  });
});
