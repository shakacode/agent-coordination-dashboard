import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { OperatorActions } from "./OperatorActions";
import type { WorkItem } from "../../shared/types";

const item: WorkItem = {
  id: "shakacode/dashboard#47",
  repo: "shakacode/dashboard",
  target: "47",
  type: "issue",
  schedulingState: "started_not_processing",
  provenance: { classification: "observed", evidence: ["claim"] },
  claim: { schemaVersion: 1, repo: "shakacode/dashboard", target: "47", agentId: "worker", batchId: "batch-a", branch: "codex/actions", prUrl: "https://github.com/shakacode/dashboard/pull/56", status: "active", path: "claims/47.json" },
  heartbeat: { schemaVersion: 1, agentId: "worker", status: "blocked", updatedAt: "2026-07-12T10:00:00Z", expiresAt: "2026-07-12T10:10:00Z", liveness: "dead", path: "heartbeats/worker.json" },
  operatorState: "needs_attention",
  attention: { kind: "dead_holder", label: "Dead", action: "Copy resume prompt" },
  warnings: [],
  selected: false
};

describe("OperatorActions", () => {
  it("copies resume and takeover commands with visible confirmation", async () => {
    const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
    Object.assign(navigator, { clipboard });
    render(<OperatorActions item={item} takeoverAvailable />);

    await userEvent.click(screen.getByRole("button", { name: "Copy resume prompt" }));
    expect(clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining("Thread handle: UNKNOWN"));
    expect(screen.getByRole("status")).toHaveTextContent("Resume prompt copied");
    await userEvent.click(screen.getByRole("button", { name: "Copy takeover command" }));
    expect(clipboard.writeText).toHaveBeenLastCalledWith(expect.stringContaining("agent-coord claim"));
    expect(clipboard.writeText).toHaveBeenLastCalledWith(expect.not.stringContaining("REPLACE_WITH_YOUR_AGENT_ID"));
    expect(screen.getByRole("status")).toHaveTextContent("Takeover command copied");
  });

  it("offers safe PR, branch, and batch links", () => {
    render(<OperatorActions item={item} />);
    expect(screen.getByRole("link", { name: "Open PR" })).toHaveAttribute("href", "https://github.com/shakacode/dashboard/pull/56");
    expect(screen.getByRole("link", { name: "Open branch" })).toHaveAttribute("href", "https://github.com/shakacode/dashboard/tree/codex%2Factions");
    expect(screen.getByRole("link", { name: "Open batch" })).toHaveAttribute("href", "/?batch=batch-a");
  });

  it("sends dismiss and fixed snooze annotations", async () => {
    const onAnnotate = vi.fn().mockResolvedValue(undefined);
    let clickedAt = new Date("2026-07-12T10:00:00Z");
    render(<OperatorActions item={item} now={() => clickedAt} onAnnotate={onAnnotate} />);
    clickedAt = new Date("2026-07-12T12:00:00Z");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Dismiss or snooze" }), "snooze-1h");
    expect(onAnnotate).toHaveBeenCalledWith({ kind: "snooze", until: "2026-07-12T13:00:00.000Z" });
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Dismiss or snooze" }), "dismiss");
    expect(onAnnotate).toHaveBeenLastCalledWith({ kind: "dismiss" });
  });

  it.each([
    ["dismiss", "Clear dismissal"],
    ["snooze", "Clear snooze"]
  ] as const)("labels the %s clear action precisely", (kind, label) => {
    render(<OperatorActions item={{ ...item, annotation: { key: "shakacode/dashboard/47", kind, createdAt: "2026-07-12T10:00:00Z", ...(kind === "snooze" ? { until: "2099-07-12T11:00:00Z" } : {}), active: true } }} onClearAnnotation={vi.fn()} />);
    expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
  });
});
