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

  it("disables stale resume and takeover commands", async () => {
    const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
    Object.assign(navigator, { clipboard });
    render(<OperatorActions commandActionsDisabled item={item} takeoverAvailable />);

    expect(screen.getByRole("button", { name: "Copy resume prompt" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Copy takeover command" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Copy resume prompt" }));
    await userEvent.click(screen.getByRole("button", { name: "Copy takeover command" }));
    expect(clipboard.writeText).not.toHaveBeenCalled();
  });

  it("shows a visible failure when the clipboard API is unavailable", async () => {
    Object.assign(navigator, { clipboard: undefined });
    render(<OperatorActions item={item} />);
    await userEvent.click(screen.getByRole("button", { name: "Copy resume prompt" }));
    expect(screen.getByRole("status")).toHaveTextContent("Could not copy resume prompt");
  });

  it("offers safe PR, branch, and batch links", () => {
    render(<OperatorActions item={item} />);
    expect(screen.getByRole("link", { name: "Open PR #56" })).toHaveAttribute("href", "https://github.com/shakacode/dashboard/pull/56");
    expect(screen.getByRole("link", { name: "Open branch" })).toHaveAttribute("href", "https://github.com/shakacode/dashboard/tree/codex%2Factions");
    expect(screen.getByRole("link", { name: "Open batch" })).toHaveAttribute("href", "/?batch=batch-a&repo=shakacode%2Fdashboard");
  });

  it("opens an issue target's distinct implementation PR by its actual number", () => {
    render(<OperatorActions item={{
      ...item,
      claim: { ...item.claim!, prUrl: undefined },
      github: {
        repo: item.repo,
        target: item.target,
        type: "issue",
        title: "Issue target",
        url: "https://github.com/shakacode/dashboard/issues/47",
        state: "OPEN",
        labels: [],
        loadState: "loaded",
        implementationPr: {
          repo: item.repo,
          target: "91",
          title: "Implementation",
          url: "https://github.com/shakacode/dashboard/pull/91",
          state: "OPEN",
          labels: [],
          loadState: "loaded"
        }
      }
    }} />);

    expect(screen.getByRole("link", { name: "Open PR #91" })).toHaveAttribute("href", "https://github.com/shakacode/dashboard/pull/91");
  });

  it("does not show a resume fallback when a safe PR action is available", () => {
    render(<OperatorActions item={item} resumeAvailable={false} resumeFallbackWhenPrUnavailable />);
    expect(screen.getByRole("link", { name: "Open PR #56" })).toHaveAttribute("href", "https://github.com/shakacode/dashboard/pull/56");
    expect(screen.queryByRole("button", { name: "Copy resume prompt" })).not.toBeInTheDocument();
  });

  it.each([
    "https://github.com/shakacode/dashboard/pull/56/files?diff=unified#file-1",
    "https://github.com/shakacode/dashboard/pull/56/checks?check_run_id=12",
    "https://github.com/shakacode/dashboard/pull/56/commits/abc123#diff"
  ])("canonicalizes a safe PR subpage action link: %s", (prUrl) => {
    render(<OperatorActions item={{ ...item, claim: { ...item.claim!, prUrl } }} />);
    expect(screen.getByRole("link", { name: "Open PR #56" })).toHaveAttribute("href", "https://github.com/shakacode/dashboard/pull/56");
  });

  it.each([
    "http://github.com/shakacode/dashboard/pull/56",
    "https://user@github.com/shakacode/dashboard/pull/56",
    "https://github.com:443/shakacode/dashboard/pull/56",
    "https://github.com:0443/shakacode/dashboard/pull/56",
    "https://github.com:444/shakacode/dashboard/pull/56",
    "https://example.test/shakacode/dashboard/pull/56",
    "https://github.com/shakacode/dashboard/issues/56"
  ])("rejects an unsafe PR action link: %s", (prUrl) => {
    render(<OperatorActions item={{ ...item, claim: { ...item.claim!, prUrl } }} />);
    expect(screen.queryByRole("link", { name: "Open PR" })).not.toBeInTheDocument();
  });

  it("does not open links from a different holder's heartbeat when an active claim exists", () => {
    render(<OperatorActions item={{
      ...item,
      claim: { ...item.claim!, batchId: undefined, branch: undefined, prUrl: undefined },
      heartbeat: { ...item.heartbeat!, agentId: "worker-other", batchId: "other-batch", branch: "other-branch", prUrl: "https://github.com/shakacode/dashboard/pull/99" }
    }} />);
    expect(screen.queryByRole("link", { name: "Open PR" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open branch" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open batch" })).not.toBeInTheDocument();
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
