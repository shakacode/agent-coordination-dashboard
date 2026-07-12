import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
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
  it("shows the attention queue first and offers its safe resume action", async () => {
    const onCopyResume = vi.fn();
    render(<AttentionShell items={ITEMS} onCopyResume={onCopyResume} onQueryChange={vi.fn()} query="" surface="attention" />);

    expect(screen.getByRole("heading", { name: "Attention" })).toBeInTheDocument();
    expect(screen.getByText("No progress for over 15 minutes")).toBeInTheDocument();
    expect(screen.getByText("Phase: wedged")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Copy resume prompt" }));
    expect(onCopyResume).toHaveBeenCalledWith(ITEMS[0]);
  });
});
