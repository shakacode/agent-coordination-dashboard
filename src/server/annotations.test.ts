import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyAnnotations, createAnnotationStore } from "./annotations";
import type { WorkItem } from "../shared/types";

const item: WorkItem = {
  id: "shakacode/dashboard#47",
  repo: "shakacode/dashboard",
  target: "47",
  type: "issue",
  schedulingState: "started_not_processing",
  provenance: { classification: "observed", evidence: ["claim"] },
  operatorState: "needs_attention",
  attention: { kind: "wedged", label: "Wedged", action: "Copy resume prompt" },
  warnings: [],
  selected: false
};

describe("dashboard annotation store", () => {
  it("persists a dismiss annotation across store restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "dashboard-annotations-"));
    const path = join(root, "annotations.json");
    const first = createAnnotationStore(path, () => new Date("2026-07-12T10:00:00Z"));
    await first.save({ repo: item.repo, target: item.target, kind: "dismiss", note: "handled" });

    const restarted = createAnnotationStore(path, () => new Date("2026-07-12T10:05:00Z"));
    await expect(restarted.read()).resolves.toEqual([
      expect.objectContaining({ key: "shakacode/dashboard/47", kind: "dismiss", note: "handled", createdAt: "2026-07-12T10:00:00.000Z" })
    ]);
  });

  it("moves dismissed work to History without changing its coordination fields", () => {
    const annotated = applyAnnotations([item], [{ key: "shakacode/dashboard/47", kind: "dismiss", createdAt: "2026-07-12T10:00:00Z" }], new Date("2026-07-12T11:00:00Z"));
    expect(annotated[0]).toMatchObject({
      schedulingState: "started_not_processing",
      operatorState: "archived_view",
      annotation: { kind: "dismiss", active: true }
    });
    expect(annotated[0].attention).toBeUndefined();
  });

  it("suppresses an active snooze and restores attention after expiry", () => {
    const annotation = { key: "shakacode/dashboard/47", kind: "snooze" as const, until: "2026-07-12T11:00:00Z", createdAt: "2026-07-12T10:00:00Z" };
    expect(applyAnnotations([item], [annotation], new Date("2026-07-12T10:30:00Z"))[0]).toMatchObject({ operatorState: "ready", annotation: { active: true } });
    expect(applyAnnotations([item], [annotation], new Date("2026-07-12T11:00:00Z"))[0]).toEqual(item);
  });

  it("does not turn terminal history back into ready work when snoozed", () => {
    const terminal: WorkItem = { ...item, operatorState: "terminal", terminalState: "done", attention: undefined };
    const annotation = { key: "shakacode/dashboard/47", kind: "snooze" as const, until: "2026-07-12T11:00:00Z", createdAt: "2026-07-12T10:00:00Z" };
    expect(applyAnnotations([terminal], [annotation], new Date("2026-07-12T10:30:00Z"))[0]).toMatchObject({
      operatorState: "terminal",
      terminalState: "done",
      annotation: { active: true }
    });
  });

  it("rejects a persisted snooze without an expiry instead of suppressing it ambiguously", async () => {
    const root = await mkdtemp(join(tmpdir(), "dashboard-annotations-invalid-"));
    const path = join(root, "annotations.json");
    await writeFile(path, JSON.stringify([{ key: "shakacode/dashboard/47", kind: "snooze", createdAt: "2026-07-12T10:00:00Z" }]));
    await expect(createAnnotationStore(path).read()).rejects.toThrow("snooze annotation requires until");
  });
});
