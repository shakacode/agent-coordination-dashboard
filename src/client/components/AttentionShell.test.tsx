import { fireEvent, render, screen } from "@testing-library/react";
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

  it("treats only strict owner/repo#numeric values as canonical ids and keeps hash metadata searchable", () => {
    const metadataItem = {
      ...ITEMS[0],
      claim: { schemaVersion: 1, agentId: "worker", repo: "repo/dashboard", target: "43", status: "active" as const, branch: "feature/foo#bar", threadHandle: "thread#lantern", path: "claims/43.json" }
    };
    const { rerender } = render(<AttentionShell items={[metadataItem]} onQueryChange={vi.fn()} query="feature/foo#bar" surface="find" />);
    expect(screen.getByRole("heading", { name: /Issue #43/ })).toBeInTheDocument();
    rerender(<AttentionShell items={[metadataItem]} onQueryChange={vi.fn()} query="thread#lantern" surface="find" />);
    expect(screen.getByRole("heading", { name: /Issue #43/ })).toBeInTheDocument();
    rerender(<AttentionShell items={[metadataItem]} onQueryChange={vi.fn()} query="repo/dashboard#43" surface="find" />);
    expect(screen.getByRole("heading", { name: /Issue #43/ })).toBeInTheDocument();
  });

  it("matches hash targets while preserving exact structured repo, batch, lane, and operator filters", async () => {
    const repoA = { ...ITEMS[0], id: "repo/a#43", repo: "repo/a", batchSignals: [{ batchId: "batch-a", laneName: "lane-a", status: "running", blockedOn: [] }] };
    const repoB = { ...ITEMS[0], id: "repo/b#43", repo: "repo/b", batchSignals: [{ batchId: "batch-b", laneName: "lane-b", status: "running", blockedOn: [] }] };
    const onClearDeepLink = vi.fn();
    const { rerender } = render(<AttentionShell deepLink={{ repo: "repo/a", target: "43", batchId: "batch-a", laneName: "lane-a", query: "worker" }} items={[repoA, repoB]} onClearDeepLink={onClearDeepLink} onQueryChange={vi.fn()} query="#43" surface="find" />);
    expect(screen.getByText("repo/a")).toBeInTheDocument();
    expect(screen.queryByText("repo/b")).not.toBeInTheDocument();
    expect(screen.getByText(/Constrained by repo repo\/a/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Clear constraints" }));
    expect(onClearDeepLink).toHaveBeenCalled();

    rerender(<AttentionShell deepLink={{ repo: "repo/a", target: "43", batchId: "wrong", laneName: "wrong" }} items={[repoA, repoB]} onQueryChange={vi.fn()} query="" surface="find" />);
    expect(screen.getByText("No work items match this search.")).toBeInTheDocument();

    const splitSignals = { ...repoB, id: "repo/c#43", repo: "repo/c", batchSignals: [{ batchId: "batch-b", laneName: "other-lane", status: "running", blockedOn: [] }, { batchId: "other-batch", laneName: "lane-b", status: "running", blockedOn: [] }] };
    rerender(<AttentionShell deepLink={{ batchId: "batch-b", laneName: "lane-b" }} items={[repoA, repoB, splitSignals]} onQueryChange={vi.fn()} query="" surface="find" />);
    expect(screen.getByText("repo/b")).toBeInTheDocument();
    expect(screen.queryByText("repo/a")).not.toBeInTheDocument();
    expect(screen.queryByText("repo/c")).not.toBeInTheDocument();

    rerender(<AttentionShell deepLink={{ overviewFilter: "processing_now" }} items={[repoA, { ...repoB, operatorState: "ready", heartbeat: undefined }]} onQueryChange={vi.fn()} query="" surface="find" />);
    expect(screen.getByText("repo/a")).toBeInTheDocument();
    expect(screen.queryByText("repo/b")).not.toBeInTheDocument();
  });

  it("matches independently preserved batch-only and lane-only signals while keeping combined constraints same-signal", () => {
    const batchOnly = { ...ITEMS[0], id: "repo/batch#43", repo: "repo/batch", batchSignals: [{ batchId: "batch-x", status: "implementation", blockedOn: [] }] };
    const laneOnly = { ...ITEMS[0], id: "repo/lane#43", repo: "repo/lane", batchSignals: [{ laneName: "lane-x", status: "review", blockedOn: [] }] };
    const paired = { ...ITEMS[0], id: "repo/paired#43", repo: "repo/paired", batchSignals: [{ batchId: "batch-x", laneName: "lane-x", status: "qa", blockedOn: [] }] };
    const { rerender } = render(<AttentionShell deepLink={{ batchId: "batch-x" }} items={[batchOnly, laneOnly, paired]} onQueryChange={vi.fn()} query="" surface="find" />);
    expect(screen.getByText("repo/batch")).toBeInTheDocument();
    expect(screen.getByText("repo/paired")).toBeInTheDocument();
    expect(screen.queryByText("repo/lane")).not.toBeInTheDocument();
    rerender(<AttentionShell deepLink={{ laneName: "lane-x" }} items={[batchOnly, laneOnly, paired]} onQueryChange={vi.fn()} query="" surface="find" />);
    expect(screen.getByText("repo/lane")).toBeInTheDocument();
    expect(screen.getByText("repo/paired")).toBeInTheDocument();
    expect(screen.queryByText("repo/batch")).not.toBeInTheDocument();
    rerender(<AttentionShell deepLink={{ batchId: "batch-x", laneName: "lane-x" }} items={[batchOnly, laneOnly, paired]} onQueryChange={vi.fn()} query="" surface="find" />);
    expect(screen.getByText("repo/paired")).toBeInTheDocument();
    expect(screen.queryByText("repo/batch")).not.toBeInTheDocument();
    expect(screen.queryByText("repo/lane")).not.toBeInTheDocument();
  });

  it("keeps terminal items out of Now even when their heartbeat TTL is still live", () => {
    const terminalWithLiveHeartbeat = { ...ITEMS[0], operatorState: "terminal" as const, terminalState: "done" as const, attention: undefined };
    render(<AttentionShell items={[terminalWithLiveHeartbeat]} onQueryChange={vi.fn()} query="" surface="now" />);

    expect(screen.getByText("No live lanes right now.")).toBeInTheDocument();
  });

  it("counts only pull requests merged on the current day in the all-clear message", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-12T12:00:00.000Z"));
    const mergedToday = {
      ...ITEMS[1],
      type: "pull_request" as const,
      lastActivityAt: "2026-07-11T20:00:00.000Z",
      github: { repo: "repo/dashboard", target: "44", type: "pull_request" as const, title: "Merged", url: "https://github.com/repo/dashboard/pull/44", state: "MERGED", mergedAt: "2026-07-12T20:00:00.000Z", labels: [], loadState: "loaded" as const }
    };
    const completedYesterday = { ...mergedToday, id: "repo/dashboard#42", target: "42", github: { ...mergedToday.github, mergedAt: "2026-07-12T08:00:00.000Z" } };
    const unprovenMergeToday = { ...mergedToday, id: "repo/dashboard#46", target: "46", lastActivityAt: "2026-07-12T21:00:00.000Z", github: { ...mergedToday.github, target: "46", mergedAt: undefined } };
    const completedIssueToday = { ...ITEMS[1], lastActivityAt: "2026-07-12T19:00:00.000Z" };
    const onShowMergedToday = vi.fn();
    const { rerender } = render(<AttentionShell items={[mergedToday, completedYesterday, unprovenMergeToday, completedIssueToday]} mergeTimeStatus="available" onQueryChange={vi.fn()} onShowMergedToday={onShowMergedToday} query="" surface="attention" />);

    fireEvent.click(screen.getByRole("button", { name: "1 merged today" }));
    expect(onShowMergedToday).toHaveBeenCalled();
    rerender(<AttentionShell historyMergedTodayOnly items={[mergedToday, completedYesterday, unprovenMergeToday, completedIssueToday]} mergeTimeStatus="available" onQueryChange={vi.fn()} query="" surface="history" />);
    expect(screen.getByText("Merged", { exact: false })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /Issue #42/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /Issue #46/ })).not.toBeInTheDocument();
  });

  it("renders merge-day truth as unavailable instead of a false zero without a trusted producer", () => {
    render(<AttentionShell items={[]} mergeTimeStatus="unavailable" onQueryChange={vi.fn()} query="" surface="attention" />);
    expect(screen.getByText("merged today unavailable")).toHaveAttribute("title", "GitHub merge timestamps are not available");
    expect(screen.queryByRole("button", { name: /merged today/ })).not.toBeInTheDocument();
  });

  it("keeps legacy batch repair categories mapped to repair membership and established statuses", () => {
    const inferred = { ...ITEMS[0], id: "repo/dashboard#50", target: "50", attention: undefined, batchSignals: [{ batchId: "missing-plan", laneName: "lane", status: "running", blockedOn: [] }] };
    const mismatch = { ...ITEMS[0], id: "repo/dashboard#51", target: "51", attention: undefined, batchSignals: [{ batchId: "healthy", laneName: "lane", status: "prompt_mismatch", blockedOn: [] }] };
    render(<AttentionShell deepLink={{ overviewFilter: "batch_repair" }} items={[inferred, mismatch]} onQueryChange={vi.fn()} query="" repairBatchCount={2} repairWorkItemIds={new Set([inferred.id])} surface="find" />);
    expect(screen.getByRole("heading", { name: /#50/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /#51/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open 2 batch repair records" })).toBeInTheDocument();
  });

  it("qualifies batch repair membership by canonical work identity instead of shared batch id", () => {
    const repoA = { ...ITEMS[0], id: "repo/a#43", repo: "repo/a", attention: undefined, batchSignals: [{ batchId: "shared", laneName: "a", status: "running", blockedOn: [] }] };
    const repoB = { ...ITEMS[0], id: "repo/b#43", repo: "repo/b", attention: undefined, batchSignals: [{ batchId: "shared", laneName: "b", status: "running", blockedOn: [] }] };
    render(<AttentionShell deepLink={{ overviewFilter: "batch_repair" }} items={[repoA, repoB]} onQueryChange={vi.fn()} query="" repairBatchCount={1} repairWorkItemIds={new Set([repoA.id])} surface="find" />);
    expect(screen.getByText("repo/a")).toBeInTheDocument();
    expect(screen.queryByText("repo/b")).not.toBeInTheDocument();
  });

  it("uses the Now population for the running count, sorts History newest-first, and filters it", async () => {
    const wedgedLive = ITEMS[0];
    const older = { ...ITEMS[1], id: "repo/dashboard#40", target: "40", lastActivityAt: "2026-07-10T12:00:00Z", github: { repo: "repo/dashboard", target: "40", type: "issue" as const, title: "Older terminal", url: "https://github.com/repo/dashboard/issues/40", state: "CLOSED", labels: [], loadState: "loaded" as const } };
    const newer = { ...ITEMS[1], id: "repo/dashboard#41", target: "41", lastActivityAt: "2026-07-11T12:00:00Z", github: { ...older.github, target: "41", title: "Newer terminal", url: "https://github.com/repo/dashboard/issues/41" } };
    const onSurfaceChange = vi.fn();
    const onQueryChange = vi.fn();
    const { rerender } = render(<AttentionShell items={[wedgedLive]} onQueryChange={onQueryChange} onSurfaceChange={onSurfaceChange} query="" surface="attention" />);
    expect(screen.getByRole("button", { name: "Show 1 running lanes" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Show 1 running lanes" }));
    expect(onSurfaceChange).toHaveBeenCalledWith("now");

    rerender(<AttentionShell items={[older, newer]} onQueryChange={onQueryChange} onSurfaceChange={onSurfaceChange} query="" surface="history" />);
    const headings = screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent);
    expect(headings).toEqual(expect.arrayContaining([expect.stringContaining("Newer terminal"), expect.stringContaining("Older terminal")]));
    expect(headings.indexOf(headings.find((value) => value?.includes("Newer terminal"))!)).toBeLessThan(headings.indexOf(headings.find((value) => value?.includes("Older terminal"))!));
    fireEvent.change(screen.getByRole("textbox", { name: "Filter history" }), { target: { value: "Older" } });
    expect(onQueryChange).toHaveBeenLastCalledWith("Older");
    rerender(<AttentionShell items={[older, newer]} onQueryChange={onQueryChange} onSurfaceChange={onSurfaceChange} query="Older" surface="history" />);
    expect(screen.getByText("Older terminal", { exact: false })).toBeInTheDocument();
    expect(screen.queryByText("Newer terminal", { exact: false })).not.toBeInTheDocument();
  });

  it("renders every declared attention action, including resolvable PR and batch-operation actions", async () => {
    const onOpenBatchOperations = vi.fn();
    const qa = { ...ITEMS[0], attention: { kind: "qa_missing" as const, label: "QA missing", action: "Open PR" as const }, claim: { schemaVersion: 1, agentId: "worker", repo: "repo/dashboard", target: "43", status: "active" as const, prUrl: "https://github.com/repo/dashboard/pull/43", path: "claims/43.json" } };
    const stop = { ...ITEMS[0], id: "repo/dashboard#45", target: "45", attention: { kind: "batch_stop_requested" as const, label: "Batch stop is pending", action: "Open batch operations" as const } };
    render(<AttentionShell items={[qa, stop]} onOpenBatchOperations={onOpenBatchOperations} onQueryChange={vi.fn()} query="" surface="attention" />);

    expect(screen.getByRole("link", { name: "Open PR" })).toHaveAttribute("href", "https://github.com/repo/dashboard/pull/43");
    await userEvent.click(screen.getByRole("button", { name: "Open batch operations" }));
    expect(onOpenBatchOperations).toHaveBeenCalled();
  });
});
