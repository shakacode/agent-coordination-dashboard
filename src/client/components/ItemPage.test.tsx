import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ItemTimelineResponse } from "../api";
import { ItemPage, uniquePullRequestUrls } from "./ItemPage";

interface NodeFs {
  existsSync(path: string): boolean;
  mkdtempSync(prefix: string): string;
  rmSync(path: string, options: { force: boolean; recursive: boolean }): void;
}

interface NodeChildProcess {
  execFileSync(file: string, args: string[]): void;
}

const getBuiltinModule = Function("return process.getBuiltinModule")() as (name: string) => unknown;
const nodeFs = getBuiltinModule("node:fs") as NodeFs;
const nodeChildProcess = getBuiltinModule("node:child_process") as NodeChildProcess;
const nodeOs = getBuiltinModule("node:os") as { tmpdir(): string };
const nodePath = getBuiltinModule("node:path") as { join(...paths: string[]): string };

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
    github: { repo: "shakacode/dashboard", target: "46", type: "pull_request", title: "Timeline PR", url: "https://github.com/shakacode/dashboard/pull/47", state: "OPEN", reviewDecision: "APPROVED", ciStatus: "passing", labels: [], loadState: "loaded" },
    heartbeat: { schemaVersion: 1, agentId: "worker-b", threadHandle: "takeover-chat", status: "implementing", updatedAt: "2026-07-12T10:10:00Z", expiresAt: "2026-07-12T10:20:00Z", path: "heartbeats/worker-b.json", liveness: "live" },
    warnings: [],
    selected: false
  },
  sourceStatus: [],
  warnings: []
} satisfies ItemTimelineResponse;

describe("ItemPage", () => {
  it("does not offer resume when no current item was resolved for the timeline", () => {
    render(<ItemPage onBack={vi.fn()} timeline={{ ...timeline, item: undefined }} />);
    expect(screen.queryByRole("button", { name: "Copy resume prompt" })).not.toBeInTheDocument();
  });

  it("filters malformed and unsafe values while deduplicating pull request URLs", () => {
    expect(uniquePullRequestUrls([
      "not a URL",
      "https://example.test/shakacode/dashboard/pull/47",
      "https://github.com/shakacode/dashboard/issues/47",
      "https://operator@github.com/shakacode/dashboard/pull/47",
      "https://operator:secret@github.com/shakacode/dashboard/pull/47",
      "https://github.com:444/shakacode/dashboard/pull/47",
      "https://github.com/shakacode/dashboard/pull/47",
      "https://github.com/shakacode/dashboard/pull/47/files"
    ])).toEqual(["https://github.com/shakacode/dashboard/pull/47"]);
  });

  it("sorts epoch-zero evidence first and invalid timestamps last", () => {
    render(<ItemPage onBack={vi.fn()} timeline={{
      ...timeline,
      claims: [],
      liveness: [],
      phases: [],
      events: [
        { eventId: "invalid", type: "status.update", repo: "shakacode/dashboard", target: "46", timestamp: "not-a-date", message: "Invalid date", path: "events/order.jsonl:3" },
        { eventId: "later", type: "status.update", repo: "shakacode/dashboard", target: "46", timestamp: "1970-01-01T00:00:01.000Z", message: "Later date", path: "events/order.jsonl:2" },
        { eventId: "epoch", type: "status.update", repo: "shakacode/dashboard", target: "46", timestamp: "1970-01-01T00:00:00.000Z", message: "Epoch date", path: "events/order.jsonl:1" }
      ]
    }} />);

    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      expect.stringContaining("Epoch date"),
      expect.stringContaining("Later date"),
      expect.stringContaining("Invalid date")
    ]);
  });

  afterEach(() => vi.restoreAllMocks());

  it("shows the complete custody chain and copies ownership handles locally", async () => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn() } });
    render(<ItemPage onBack={vi.fn()} timeline={timeline} />);

    expect(screen.getByRole("heading", { name: "Work item #46" })).toBeInTheDocument();
    expect(screen.getByText("Current state: running")).toBeInTheDocument();
    expect(screen.getByText("GitHub: OPEN · APPROVED · CI: PASSING")).toBeInTheDocument();
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
      item: {
        ...timeline.item,
        claim: { schemaVersion: 1, repo: "shakacode/dashboard", target: "46", agentId: "worker-b", status: "active", path: "claims/46.json" },
        heartbeat: { ...timeline.item.heartbeat!, liveness: "dead" }
      }
    }} />);

    await userEvent.click(screen.getByRole("button", { name: "Copy takeover command" }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      "agent-coord claim --agent-id \"${AGENT_COORD_AGENT_ID:?Set AGENT_COORD_AGENT_ID}\" --repo 'shakacode/dashboard' --target '46'"
    );
  });

  it("copies the shared resume contract using the active claim branch first", async () => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn() } });
    render(<ItemPage onBack={vi.fn()} timeline={{
      ...timeline,
      item: {
        ...timeline.item,
        claim: { schemaVersion: 1, repo: "shakacode/dashboard", target: "46", agentId: "worker-b", status: "active", branch: "codex/claim", path: "claims/46.json" },
        heartbeat: { ...timeline.item.heartbeat!, branch: "codex/heartbeat" },
        github: { ...timeline.item.github!, branch: "codex/github" }
      }
    }} />);

    await userEvent.click(screen.getByRole("button", { name: "Copy resume prompt" }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      "$pr-batch\nResume the existing lane for shakacode/dashboard#46.\nThread handle: takeover-chat\nBatch: UNKNOWN\nBranch: codex/claim\nLast phase: implementing\nVerify current coordination state and custody before edits. Continue in the owning task when available."
    );
  });

  it("shell-quotes hostile repository and target text in copied takeover commands", async () => {
    const directory = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "custody-command-"));
    const marker = nodePath.join(directory, "must-not-exist");
    Object.assign(navigator, { clipboard: { writeText: vi.fn() } });
    const repo = "owner/o'brien; : #";
    const target = `46; touch ${marker}; : #`;
    try {
      render(<ItemPage onBack={vi.fn()} timeline={{
        ...timeline,
        repo,
        target,
        item: {
          ...timeline.item,
          repo,
          target,
          claim: { schemaVersion: 1, repo, target, agentId: "worker-b", status: "active", path: "claims/46.json" },
          heartbeat: { ...timeline.item.heartbeat!, liveness: "dead" }
        }
      }} />);

      await userEvent.click(screen.getByRole("button", { name: "Copy takeover command" }));
      const command = vi.mocked(navigator.clipboard.writeText).mock.calls[0][0];
      expect(command).toContain("--repo REPLACE_WITH_OWNER_REPO");
      expect(command).not.toContain("touch");
      expect(command).not.toContain("REPLACE_WITH_YOUR_AGENT_ID");
      expect(() => nodeChildProcess.execFileSync("sh", ["-c", `unset AGENT_COORD_AGENT_ID; set -- ${command.replace("agent-coord claim ", "")}`])).toThrow();
      expect(nodeFs.existsSync(marker)).toBe(false);
    } finally {
      nodeFs.rmSync(directory, { force: true, recursive: true });
    }
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
    expect(screen.getByRole("button", { name: "Copy resume prompt" })).toBeInTheDocument();
  });

  it("does not present terminal work as held or eligible for takeover", () => {
    render(<ItemPage onBack={vi.fn()} timeline={{
      ...timeline,
      item: {
        ...timeline.item,
        operatorState: "terminal",
        terminalState: "done",
        claim: { schemaVersion: 1, repo: "shakacode/dashboard", target: "46", agentId: "worker-b", status: "active", path: "claims/46.json" },
        heartbeat: { ...timeline.item.heartbeat!, liveness: "live" }
      }
    }} />);

    expect(screen.getByText("Holder: UNKNOWN")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy resume prompt" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy takeover command" })).not.toBeInTheDocument();
  });

  it("does not advertise resume for a dashboard-archived dismissed item", () => {
    render(<ItemPage onBack={vi.fn()} timeline={{
      ...timeline,
      item: {
        ...timeline.item,
        operatorState: "archived_view",
        annotation: { key: "shakacode/dashboard/46", kind: "dismiss", createdAt: "2026-07-12T10:00:00Z", active: true }
      }
    }} />);
    expect(screen.queryByRole("button", { name: "Copy resume prompt" })).not.toBeInTheDocument();
  });

  it("does not present released custody with a live heartbeat as held or eligible for takeover", () => {
    render(<ItemPage onBack={vi.fn()} timeline={{
      ...timeline,
      item: {
        ...timeline.item,
        operatorState: "ready",
        claim: { schemaVersion: 1, repo: "shakacode/dashboard", target: "46", agentId: "worker-b", status: "released", path: "claims/46.json" },
        heartbeat: { ...timeline.item.heartbeat!, liveness: "live" }
      }
    }} />);

    expect(screen.getByText("Holder: UNKNOWN")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy resume prompt" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy takeover command" })).not.toBeInTheDocument();
  });

  it("shows the live heartbeat agent as holder when nonterminal work has no claim", () => {
    render(<ItemPage onBack={vi.fn()} timeline={timeline} />);

    expect(screen.getByText("Holder: worker-b")).toBeInTheDocument();
  });

  it("shows the stale heartbeat agent as holder when nonterminal work has no claim", () => {
    render(<ItemPage onBack={vi.fn()} timeline={{
      ...timeline,
      item: { ...timeline.item, heartbeat: { ...timeline.item.heartbeat!, liveness: "stale" } }
    }} />);

    expect(screen.getByText("Holder: worker-b")).toBeInTheDocument();
  });

  it("keeps a heartbeat-only dead holder UNKNOWN", () => {
    render(<ItemPage onBack={vi.fn()} timeline={{
      ...timeline,
      item: { ...timeline.item, heartbeat: { ...timeline.item.heartbeat!, liveness: "dead" } }
    }} />);

    expect(screen.getByText("Holder: UNKNOWN")).toBeInTheDocument();
  });

  it("keeps a heartbeat-only terminal holder UNKNOWN", () => {
    render(<ItemPage onBack={vi.fn()} timeline={{
      ...timeline,
      item: { ...timeline.item, operatorState: "terminal", terminalState: "done" }
    }} />);

    expect(screen.getByText("Holder: UNKNOWN")).toBeInTheDocument();
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

  it("offers takeover when timeline liveness marks the claimed holder dead despite another live heartbeat", () => {
    render(<ItemPage onBack={vi.fn()} timeline={{
      ...timeline,
      liveness: [
        { agentId: "worker-a", machineId: "m1", liveness: "dead", status: "implementing", startedAt: "2026-07-12T10:00:00Z", endedAt: "2026-07-12T10:10:00Z" },
        { agentId: "worker-b", machineId: "m2", liveness: "live", status: "reviewing", startedAt: "2026-07-12T10:05:00Z", endedAt: "2026-07-12T10:10:00Z" }
      ],
      item: {
        ...timeline.item,
        claim: { schemaVersion: 1, repo: "shakacode/dashboard", target: "46", agentId: "worker-a", status: "active", path: "claims/46.json" },
        heartbeat: { ...timeline.item.heartbeat!, agentId: "worker-b", liveness: "live" }
      }
    }} />);

    expect(screen.getByText("Holder: worker-a")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy takeover command" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy resume prompt" })).toBeInTheDocument();
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

  it("shows ownership telemetry once while retaining unrelated telemetry evidence", () => {
    render(<ItemPage onBack={vi.fn()} timeline={{
      ...timeline,
      claims: [
        { action: "acquired", agentId: "worker-a", timestamp: "2026-07-12T10:00:00Z", sourceEventId: "started", sourceEventPath: "events/custody.jsonl:1" },
        { action: "renewed", agentId: "worker-a", timestamp: "2026-07-12T10:02:00Z", sourceEventId: "heartbeat", sourceEventPath: "events/custody.jsonl:2" },
        { action: "taken_over", agentId: "worker-b", previousAgentId: "worker-a", timestamp: "2026-07-12T10:04:00Z", sourceEventId: "continued", sourceEventPath: "events/custody.jsonl:3" }
      ],
      liveness: [],
      phases: [],
      events: [
        { eventId: "started", type: "lane.started", repo: "shakacode/dashboard", target: "46", agentId: "worker-a", timestamp: "2026-07-12T10:00:00Z", path: "events/custody.jsonl:1" },
        { eventId: "heartbeat", type: "heartbeat", repo: "shakacode/dashboard", target: "46", agentId: "worker-a", timestamp: "2026-07-12T10:02:00Z", path: "events/custody.jsonl:2" },
        { eventId: "continued", type: "continued", repo: "shakacode/dashboard", target: "46", agentId: "worker-b", timestamp: "2026-07-12T10:04:00Z", path: "events/custody.jsonl:3" },
        { eventId: "progress", type: "phase.progress", repo: "shakacode/dashboard", target: "46", timestamp: "2026-07-12T10:05:00Z", message: "Still working", path: "events/custody.jsonl:4" }
      ]
    }} />);

    expect(screen.getAllByRole("listitem").map((entry) => entry.textContent)).toEqual([
      expect.stringContaining("acquired by worker-a"),
      expect.stringContaining("renewed by worker-a"),
      expect.stringContaining("worker-a → worker-b"),
      expect.stringContaining("phase.progressStill working")
    ]);
  });

  it("retains unrelated telemetry when it shares an event ID with ownership telemetry from another path", () => {
    render(<ItemPage onBack={vi.fn()} timeline={{
      ...timeline,
      claims: [{
        action: "acquired",
        agentId: "worker-a",
        timestamp: "2026-07-12T10:00:00Z",
        sourceEventId: "caller-supplied-id",
        sourceEventPath: "events/custody.jsonl:1"
      }],
      liveness: [],
      phases: [],
      events: [
        { eventId: "caller-supplied-id", type: "lane.started", repo: "shakacode/dashboard", target: "46", agentId: "worker-a", timestamp: "2026-07-12T10:00:00Z", path: "events/custody.jsonl:1" },
        { eventId: "caller-supplied-id", type: "status.update", repo: "shakacode/dashboard", target: "46", timestamp: "2026-07-12T10:01:00Z", message: "Unrelated telemetry", path: "history/other.jsonl:1" }
      ]
    }} />);

    expect(screen.getAllByRole("listitem").map((entry) => entry.textContent)).toEqual([
      expect.stringContaining("acquired by worker-a"),
      expect.stringContaining("status.updateUnrelated telemetry")
    ]);
  });

  it("renders same-ID telemetry from separate paths without duplicate React keys", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(<ItemPage onBack={vi.fn()} timeline={{
      ...timeline,
      claims: [],
      liveness: [],
      phases: [],
      events: [
        { eventId: "caller-supplied-id", type: "status.update", repo: "shakacode/dashboard", target: "46", timestamp: "2026-07-12T10:00:00Z", message: "First event", path: "events/one.jsonl:1" },
        { eventId: "caller-supplied-id", type: "status.update", repo: "shakacode/dashboard", target: "46", timestamp: "2026-07-12T10:01:00Z", message: "Second event", path: "history/two.jsonl:1" }
      ]
    }} />);

    expect(screen.getAllByText("status.update")).toHaveLength(2);
    expect(consoleError).not.toHaveBeenCalledWith(expect.stringContaining("same key"), expect.anything());
  });

  it("renders same-ID phase spans from separate source paths without duplicate React keys", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(<ItemPage onBack={vi.fn()} timeline={{
      ...timeline,
      claims: [],
      liveness: [],
      phases: [
        { eventId: "caller-supplied-id", eventPath: "events/one.jsonl:1", phase: "planning", startedAt: "2026-07-12T10:00:00Z", endedAt: "2026-07-12T10:01:00Z", durationMs: 60_000 },
        { eventId: "caller-supplied-id", eventPath: "history/two.jsonl:1", phase: "implementing", startedAt: "2026-07-12T10:01:00Z", endedAt: "2026-07-12T10:02:00Z", durationMs: 60_000 }
      ],
      events: []
    }} />);

    expect(screen.getByText("planning · 1m")).toBeInTheDocument();
    expect(screen.getByText("implementing · 1m")).toBeInTheDocument();
    expect(consoleError).not.toHaveBeenCalledWith(expect.stringContaining("same key"), expect.anything());
  });

  it("retains unrelated telemetry that shares a phase ID from another path", () => {
    render(<ItemPage onBack={vi.fn()} timeline={{
      ...timeline,
      claims: [],
      liveness: [],
      phases: [{ eventId: "caller-supplied-id", eventPath: "events/phase.jsonl:1", phase: "planning", startedAt: "2026-07-12T10:00:00Z", endedAt: "2026-07-12T10:01:00Z", durationMs: 60_000 }],
      events: [
        { eventId: "caller-supplied-id", type: "phase", repo: "shakacode/dashboard", target: "46", timestamp: "2026-07-12T10:00:00Z", path: "events/phase.jsonl:1" },
        { eventId: "caller-supplied-id", type: "status.update", repo: "shakacode/dashboard", target: "46", timestamp: "2026-07-12T10:01:00Z", message: "Unrelated telemetry", path: "history/other.jsonl:1" }
      ]
    }} />);

    expect(screen.getByText("planning · 1m")).toBeInTheDocument();
    expect(screen.getByText("status.update")).toBeInTheDocument();
    expect(screen.getByText("Unrelated telemetry")).toBeInTheDocument();
  });

  it("retains all same-ID telemetry when a phase has no source provenance", () => {
    render(<ItemPage onBack={vi.fn()} timeline={{
      ...timeline,
      claims: [],
      liveness: [],
      phases: [{ eventId: "ambiguous-id", phase: "planning", startedAt: "2026-07-12T10:00:00Z", endedAt: "2026-07-12T10:01:00Z", durationMs: 60_000 }],
      events: [
        { eventId: "ambiguous-id", type: "status.update", repo: "shakacode/dashboard", target: "46", timestamp: "2026-07-12T10:00:00Z", message: "First source", path: "events/one.jsonl:1" },
        { eventId: "ambiguous-id", type: "status.update", repo: "shakacode/dashboard", target: "46", timestamp: "2026-07-12T10:01:00Z", message: "Second source", path: "history/two.jsonl:1" }
      ]
    }} />);

    expect(screen.getByText("First source")).toBeInTheDocument();
    expect(screen.getByText("Second source")).toBeInTheDocument();
  });

  it("renders both durable and newer current-snapshot custody evidence", () => {
    render(<ItemPage onBack={vi.fn()} timeline={{
      ...timeline,
      liveness: [],
      phases: [],
      claims: [
        { action: "acquired", agentId: "worker-a", generation: 1, machineId: "m1", threadHandle: "old-thread", timestamp: "2026-07-12T10:00:00Z" },
        { action: "renewed", agentId: "worker-a", generation: 2, machineId: "m2", threadHandle: "current-thread", timestamp: "2026-07-12T10:05:00Z" }
      ]
    }} />);

    expect(screen.getByText("CAS generation 1")).toBeInTheDocument();
    expect(screen.getByText("CAS generation 2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy thread handle old-thread" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy thread handle current-thread" })).toBeInTheDocument();
  });

  it("renders safe branch and PR anchors on every custody row and keeps unknown anchors inert", () => {
    render(<ItemPage onBack={vi.fn()} timeline={{
      ...timeline,
      claims: [{ action: "acquired", agentId: "worker-a", timestamp: "2026-07-12T10:00:00Z", branch: "codex/claim", prUrl: "https://github.com/shakacode/dashboard/pull/41" }],
      liveness: [{ agentId: "worker-a", status: "implementing", liveness: "live", startedAt: "2026-07-12T10:01:00Z", endedAt: "2026-07-12T10:02:00Z", branch: "codex/live", prUrl: "https://github.com/shakacode/dashboard/pull/42" }],
      phases: [{ eventId: "unsafe-phase", phase: "verifying", startedAt: "2026-07-12T10:02:00Z", endedAt: "2026-07-12T10:03:00Z", durationMs: 60_000, branch: "codex/phase", prUrl: "javascript:alert(1)" }],
      events: [{ eventId: "telemetry", type: "heartbeat", repo: "shakacode/dashboard", target: "46", timestamp: "2026-07-12T10:03:00Z", path: "history/events.jsonl:1", branch: "codex/telemetry" }]
    }} />);

    expect(screen.getByText("Branch: codex/claim")).toBeInTheDocument();
    expect(screen.getByText("Branch: codex/live")).toBeInTheDocument();
    expect(screen.getByText("Branch: codex/phase")).toBeInTheDocument();
    expect(screen.getByText("Branch: codex/telemetry")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "PR 41" })).toHaveAttribute("href", "https://github.com/shakacode/dashboard/pull/41");
    expect(screen.getByRole("link", { name: "PR 42" })).toHaveAttribute("href", "https://github.com/shakacode/dashboard/pull/42");
    expect(screen.getAllByText("PR: UNKNOWN")).toHaveLength(2);
    expect(screen.queryByRole("link", { name: "PR 1" })).not.toBeInTheDocument();
  });

  it("accepts safe GitHub PR subpages while rejecting non-PR and foreign anchors", () => {
    const safeUrl = "https://github.com/shakacode/dashboard/pull/47/files?diff=unified#file-1";
    render(<ItemPage onBack={vi.fn()} timeline={{
      ...timeline,
      prUrls: [safeUrl, "https://github.com/shakacode/dashboard/issues/47", "https://example.test/shakacode/dashboard/pull/47"]
    }} />);

    expect(screen.getByRole("link", { name: "PR 47" })).toHaveAttribute("href", "https://github.com/shakacode/dashboard/pull/47");
    expect(screen.queryByText("PR UNKNOWN")).not.toBeInTheDocument();
  });

  it("falls back to loaded GitHub anchors and renders each safe global anchor once", () => {
    render(<ItemPage onBack={vi.fn()} timeline={{
      ...timeline,
      branches: [],
      prUrls: ["https://github.com/shakacode/dashboard/pull/47", "https://github.com/shakacode/dashboard/pull/47"],
      item: {
        ...timeline.item,
        github: {
          ...timeline.item.github!,
          branch: "codex/github-only",
          url: "https://github.com/shakacode/dashboard/pull/47"
        }
      }
    }} />);

    expect(screen.getAllByText("Branch: codex/github-only")).toHaveLength(1);
    expect(screen.getAllByRole("link", { name: "PR 47" })).toHaveLength(1);
  });

  it("merges distinct current GitHub anchors with historical custody anchors", () => {
    render(<ItemPage onBack={vi.fn()} timeline={{
      ...timeline,
      branches: ["codex/historical"],
      prUrls: ["https://github.com/shakacode/dashboard/pull/47"],
      item: {
        ...timeline.item,
        github: {
          ...timeline.item.github!,
          branch: "codex/current",
          url: "https://github.com/shakacode/dashboard/pull/48"
        }
      }
    }} />);

    expect(screen.getByText("Branch: codex/historical, codex/current")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "PR 47" })).toHaveAttribute("href", "https://github.com/shakacode/dashboard/pull/47");
    expect(screen.getByRole("link", { name: "PR 48" })).toHaveAttribute("href", "https://github.com/shakacode/dashboard/pull/48");
  });

  it("keeps target-scoped warnings visible beside one broad UNKNOWN notice", () => {
    render(<ItemPage onBack={vi.fn()} timeline={{
      ...timeline,
      sourceStatus: [{ resource: "events", mode: "fs", status: "unreachable", checkedAt: "2026-07-12T10:10:00Z" }],
      warnings: [
        { severity: "warning", message: "Target coordination history is partial." },
        { severity: "warning", message: "Target coordination history is partial." },
        { severity: "info", message: "Target source remained reachable." }
      ]
    }} />);

    expect(screen.getAllByText("Coordination data: UNKNOWN")).toHaveLength(1);
    expect(screen.getAllByText("WARNING: Target coordination history is partial.")).toHaveLength(1);
    expect(screen.getByText("INFO: Target source remained reachable.")).toBeInTheDocument();
  });
});
