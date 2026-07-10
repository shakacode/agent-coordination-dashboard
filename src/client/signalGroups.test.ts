import { describe, expect, it } from "vitest";
import type { CoordinationWarning, HealthItem } from "../shared/types";
import { groupHealthItems, groupWarnings } from "./signalGroups";

function warning(partial: Partial<CoordinationWarning> = {}): CoordinationWarning {
  return { severity: "warning", message: "Heartbeat missing machine id", ...partial };
}

function healthItem(partial: Partial<HealthItem> = {}): HealthItem {
  return {
    id: "h-1",
    severity: "warning",
    category: "heartbeat",
    title: "Heartbeat missing machine id",
    detail: "agent-a heartbeat has no machine id",
    ...partial
  };
}

describe("groupWarnings", () => {
  it("collapses identical messages into one counted group that retains every record", () => {
    const warnings = [
      warning({ agentId: "agent-a" }),
      warning({ agentId: "agent-b" }),
      warning({ agentId: "agent-c" })
    ];

    const groups = groupWarnings(warnings);

    expect(groups).toHaveLength(1);
    expect(groups[0].count).toBe(3);
    expect(groups[0].label).toBe("Heartbeat missing machine id");
    expect(groups[0].items).toHaveLength(3);
    expect(groups[0].items.map((item) => item.agentId)).toEqual(["agent-a", "agent-b", "agent-c"]);
  });

  it("groups messages that differ only by numeric identifiers", () => {
    const groups = groupWarnings([
      warning({ message: "Target #1783647786 has no manifest", severity: "info" }),
      warning({ message: "Target #4497 has no manifest", severity: "info" })
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].count).toBe(2);
    expect(groups[0].label).toBe("Target #… has no manifest");
  });

  it("groups known warning templates with nonnumeric ids under an honest type label", () => {
    const groups = groupWarnings([
      warning({ message: "Work has a heartbeat from worker-a but the claim is held by owner-a." }),
      warning({ message: "Work has a heartbeat from 7eaf31b2 but the claim is held by owner-b." })
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe("Work has a heartbeat from an agent other than the claim holder.");
    expect(groups[0].items.map((item) => item.message)).toEqual([
      "Work has a heartbeat from worker-a but the claim is held by owner-a.",
      "Work has a heartbeat from 7eaf31b2 but the claim is held by owner-b."
    ]);
  });

  it("uses a type label when grouped records contain different meaningful counts", () => {
    const groups = groupWarnings([
      warning({ message: "Work has 2 heartbeat records for the same target." }),
      warning({ message: "Work has 7 heartbeat records for the same target." })
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe("Work has multiple heartbeat records for the same target.");
    expect(groups[0].items.map((item) => item.message)).toEqual([
      "Work has 2 heartbeat records for the same target.",
      "Work has 7 heartbeat records for the same target."
    ]);
  });

  it("keeps scheduled-work warnings with different statuses separate", () => {
    const groups = groupWarnings([
      warning({ message: "Work is already scheduled in batch batch-a:lane-1 (running)." }),
      warning({ message: "Work is already scheduled in batch batch-b:lane-2 (blocked)." })
    ]);

    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.label)).toEqual([
      "Work is already scheduled in a batch (blocked).",
      "Work is already scheduled in a batch (running)."
    ]);
  });

  it("keeps distinct messages and severities separate", () => {
    const groups = groupWarnings([
      warning(),
      warning(),
      warning({ message: "Could not read coordination API events: 400 invalid_prefix", severity: "critical" })
    ]);

    expect(groups).toHaveLength(2);
    // Most severe first, then by descending count.
    expect(groups[0].severity).toBe("critical");
    expect(groups[1].count).toBe(2);
  });

  it("returns an empty array for no warnings", () => {
    expect(groupWarnings([])).toEqual([]);
  });
});

describe("groupHealthItems", () => {
  it("groups health items by severity, category, and title", () => {
    const groups = groupHealthItems([
      healthItem({ id: "h-1", agentId: "agent-a" }),
      healthItem({ id: "h-2", agentId: "agent-b" }),
      healthItem({ id: "h-3", category: "batch", title: "Batch plan missing", detail: "batch-1 has no manifest" })
    ]);

    expect(groups).toHaveLength(2);
    const heartbeat = groups.find((group) => group.label === "Heartbeat missing machine id");
    expect(heartbeat?.count).toBe(2);
    expect(heartbeat?.items.map((item) => item.id)).toEqual(["h-1", "h-2"]);
  });
});
