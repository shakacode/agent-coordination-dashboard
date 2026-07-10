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
