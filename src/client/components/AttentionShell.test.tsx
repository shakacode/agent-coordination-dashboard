import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkItem } from "../../shared/types";
import { AttentionShell } from "./AttentionShell";

const ITEMS: WorkItem[] = [
  {
    id: "repo/dashboard#43",
    repo: "repo/dashboard",
    target: "43",
    type: "issue",
    schedulingState: "in_process",
    operatorState: "needs_attention",
    attention: { kind: "wedged", label: "No progress for over 15 minutes", action: "Copy resume prompt" },
    heartbeat: {
      schemaVersion: 1,
      agentId: "worker-a",
      repo: "repo/dashboard",
      target: "43",
      status: "wedged",
      updatedAt: "2026-07-12T11:00:00.000Z",
      expiresAt: "2026-07-12T11:30:00.000Z",
      path: "heartbeats/worker-a.json",
      liveness: "live"
    },
    warnings: [],
    selected: false
  },
  {
    id: "repo/dashboard#44",
    repo: "repo/dashboard",
    target: "44",
    type: "issue",
    schedulingState: "started_not_processing",
    operatorState: "terminal",
    terminalState: "done",
    warnings: [],
    selected: false
  }
];

describe("AttentionShell", () => {
  afterEach(() => vi.useRealTimers());

  it("shows the attention queue first and offers its safe resume action", async () => {
    const onCopyResume = vi.fn();
    render(<AttentionShell items={ITEMS} onCopyResume={onCopyResume} onQueryChange={vi.fn()} query="" surface="attention" />);

    expect(screen.getByRole("heading", { name: "Attention" })).toBeInTheDocument();
    expect(screen.getByText("No progress for over 15 minutes")).toBeInTheDocument();
    expect(screen.getByText("Phase: wedged")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Copy resume prompt" }));
    expect(onCopyResume).toHaveBeenCalledWith(ITEMS[0]);
  });

  it("offers eligible items for batch selection and keeps the prompt selection controlled by App", async () => {
    const onToggle = vi.fn();
    const readyItem: WorkItem = { ...ITEMS[0], id: "repo/dashboard#45", target: "45", schedulingState: "ready_for_batch", operatorState: "ready" };
    render(<AttentionShell items={[readyItem]} onQueryChange={vi.fn()} onToggle={onToggle} query="" surface="find" />);

    await userEvent.click(screen.getByRole("checkbox", { name: "Include repo/dashboard#45 in PR-batch prompt" }));
    expect(onToggle).toHaveBeenCalledWith(readyItem.id);
  });

  it("matches canonical ids so structured repo and target searches do not collide", () => {
    const collision = { ...ITEMS[0], id: "other/repo/dashboard#43", repo: "other/repo/dashboard" };
    render(<AttentionShell items={[ITEMS[0], collision]} onQueryChange={vi.fn()} query="repo/dashboard#43" surface="find" />);

    expect(screen.getByText("repo/dashboard")).toBeInTheDocument();
    expect(screen.queryByText("other/repo/dashboard")).not.toBeInTheDocument();
  });

  it("keeps terminal items out of Now even when their heartbeat TTL is still live", () => {
    const terminalWithLiveHeartbeat = { ...ITEMS[0], operatorState: "terminal" as const, terminalState: "done" as const, attention: undefined };
    render(<AttentionShell items={[terminalWithLiveHeartbeat]} onQueryChange={vi.fn()} query="" surface="now" />);

    expect(screen.getByText("No live lanes right now.")).toBeInTheDocument();
  });

  it("counts only pull requests merged on the current day in the all-clear message", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-12T12:00:00.000Z"));
    const mergedToday = {
      ...ITEMS[1],
      type: "pull_request" as const,
      lastActivityAt: "2026-07-12T20:00:00.000Z",
      github: { repo: "repo/dashboard", target: "44", type: "pull_request" as const, title: "Merged", url: "https://github.com/repo/dashboard/pull/44", state: "MERGED", labels: [], loadState: "loaded" as const }
    };
    const completedYesterday = { ...mergedToday, id: "repo/dashboard#42", target: "42", lastActivityAt: "2026-07-12T08:00:00.000Z" };
    const completedIssueToday = { ...ITEMS[1], lastActivityAt: "2026-07-12T19:00:00.000Z" };
    render(<AttentionShell items={[mergedToday, completedYesterday, completedIssueToday]} onQueryChange={vi.fn()} query="" surface="attention" />);

    expect(screen.getByText(/1 merged today/)).toBeInTheDocument();
  });
});
