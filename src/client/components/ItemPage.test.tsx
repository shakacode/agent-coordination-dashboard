import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ItemTimelineResponse } from "../api";
import { ItemPage } from "./ItemPage";

const timeline = {
  repo: "shakacode/dashboard",
  target: "46",
  claims: [
    { action: "acquired", agentId: "worker-a", machineId: "m1", host: "codex", operator: "justin", threadHandle: "first-chat", timestamp: "2026-07-12T10:00:00Z", generation: 3 },
    { action: "taken_over", agentId: "worker-b", previousAgentId: "worker-a", machineId: "m2", host: "claude", operator: "riley", threadHandle: "takeover-chat", timestamp: "2026-07-12T10:05:00Z", generation: 4 }
  ],
  liveness: [{ agentId: "worker-b", machineId: "m2", host: "claude", operator: "riley", liveness: "live", status: "implementing", startedAt: "2026-07-12T10:05:00Z", endedAt: "2026-07-12T10:10:00Z" }],
  phases: [{ eventId: "phase-1", phase: "implementing", machineId: "m3", host: "codex", operator: "devon", startedAt: "2026-07-12T10:02:00Z", endedAt: "2026-07-12T10:10:00Z", durationMs: 480_000, threadHandle: "takeover-chat" }],
  events: [],
  branches: ["codex/takeover"],
  prUrls: ["https://github.com/shakacode/dashboard/pull/47"],
  item: {
    id: "shakacode/dashboard#46",
    repo: "shakacode/dashboard",
    target: "46",
    type: "issue",
    schedulingState: "in_process",
    operatorState: "running",
    github: { repo: "shakacode/dashboard", target: "46", type: "pull_request", title: "Timeline PR", url: "https://github.com/shakacode/dashboard/pull/47", state: "OPEN", reviewDecision: "APPROVED", labels: [], loadState: "loaded" },
    heartbeat: { schemaVersion: 1, agentId: "worker-b", threadHandle: "takeover-chat", status: "implementing", updatedAt: "2026-07-12T10:10:00Z", expiresAt: "2026-07-12T10:20:00Z", path: "heartbeats/worker-b.json", liveness: "live" },
    warnings: [],
    selected: false
  },
  sourceStatus: [],
  warnings: []
} satisfies ItemTimelineResponse;

describe("ItemPage", () => {
  afterEach(() => vi.restoreAllMocks());

  it("shows the complete custody chain and copies ownership handles locally", async () => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn() } });
    render(<ItemPage onBack={vi.fn()} timeline={timeline} />);

    expect(screen.getByRole("heading", { name: "Work item #46" })).toBeInTheDocument();
    expect(screen.getByText("Current state: running")).toBeInTheDocument();
    expect(screen.getByText("GitHub: OPEN · APPROVED · CI: UNKNOWN")).toBeInTheDocument();
    expect(screen.getByText("Machine: m1 · Host: codex · Operator: justin")).toBeInTheDocument();
    expect(screen.getAllByText("Machine: m2 · Host: claude · Operator: riley")).toHaveLength(2);
    expect(screen.getByText("Machine: m3 · Host: codex · Operator: devon")).toBeInTheDocument();
    expect(screen.getByText(/worker-a → worker-b/)).toBeInTheDocument();
    expect(screen.getByText("implementing · 8m")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "PR 47" })).toHaveAttribute("href", "https://github.com/shakacode/dashboard/pull/47");
    expect(screen.getAllByRole("listitem").map((entry) => entry.textContent)).toEqual([
      expect.stringContaining("acquired by worker-a"),
      expect.stringContaining("implementing · 8m"),
      expect.stringContaining("worker-a → worker-b"),
      expect.stringContaining("live · 5m")
    ]);

    await userEvent.click(screen.getAllByRole("button", { name: "Copy thread handle takeover-chat" })[0]);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("takeover-chat");
  });

  it("copies an executable takeover command with an explicit replacement agent identity", async () => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn() } });
    render(<ItemPage onBack={vi.fn()} timeline={{
      ...timeline,
      item: { ...timeline.item, heartbeat: { ...timeline.item.heartbeat!, liveness: "dead" } }
    }} />);

    await userEvent.click(screen.getByRole("button", { name: "Copy takeover command" }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      "agent-coord claim --repo shakacode/dashboard --target 46 --agent-id REPLACE_WITH_YOUR_AGENT_ID"
    );
  });

  it("offers takeover when the active claim belongs to the dead holder", () => {
    render(<ItemPage onBack={vi.fn()} timeline={{
      ...timeline,
      item: {
        ...timeline.item,
        claim: { schemaVersion: 1, repo: "shakacode/dashboard", target: "46", agentId: "worker-b", status: "active", path: "claims/46.json" },
        heartbeat: { ...timeline.item.heartbeat!, liveness: "dead" }
      }
    }} />);

    expect(screen.getByRole("button", { name: "Copy takeover command" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy resume prompt" })).not.toBeInTheDocument();
  });

  it("keeps an active claim as holder when an older heartbeat is dead", () => {
    render(<ItemPage onBack={vi.fn()} timeline={{
      ...timeline,
      item: {
        ...timeline.item,
        claim: { schemaVersion: 1, repo: "shakacode/dashboard", target: "46", agentId: "worker-b", status: "active", path: "claims/46.json" },
        heartbeat: { ...timeline.item.heartbeat!, agentId: "worker-a", liveness: "dead" }
      }
    }} />);

    expect(screen.getByText("Holder: worker-b")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy resume prompt" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy takeover command" })).not.toBeInTheDocument();
  });

  it("keeps historical heartbeat telemetry visible without turning it into liveness", () => {
    render(<ItemPage onBack={vi.fn()} timeline={{
      ...timeline,
      events: [{
        eventId: "old-heartbeat",
        type: "heartbeat",
        repo: "shakacode/dashboard",
        target: "46",
        agentId: "worker-a",
        machineId: "m1",
        threadHandle: "first-chat",
        host: "codex",
        operator: "justin",
        timestamp: "2026-07-12T10:01:00Z",
        path: "history/demo-custody.jsonl:2"
      }]
    }} />);

    expect(screen.getByText("heartbeat")).toBeInTheDocument();
    expect(screen.getAllByText("Machine: m1 · Host: codex · Operator: justin")).toHaveLength(2);
  });
});
