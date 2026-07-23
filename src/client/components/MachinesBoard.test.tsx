import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { MachineCard } from "../coordinationView";
import { MachinesBoard } from "./MachinesBoard";

const machine: MachineCard = {
  id: "m1",
  label: "m1",
  user: "justin",
  live: 1,
  total: 3,
  dead: 2,
  hosts: [
    {
      name: "Codex",
      color: "var(--codex)",
      live: 1,
      total: 3,
      dead: 2,
      agents: [
        {
          id: "codex-live",
          state: "live",
          color: "var(--ok)",
          work: "repo/dashboard#87",
          beat: "beat 1m ago",
          repo: "repo/dashboard",
          batchId: "batch-operator-nav",
          threadHandle: "acd-machine-chat"
        }
      ]
    }
  ]
};

describe("MachinesBoard operator navigation", () => {
  it("keeps collapsed dead-agent counts visibly non-interactive", () => {
    render(<MachinesBoard machines={[machine]} />);
    const summary = screen.getByRole("note", { name: "2 dead Codex agents" });
    expect(summary).toHaveTextContent("2 dead · no heartbeat");
    expect(summary).not.toHaveTextContent("＋");
    expect(within(summary).queryByRole("button")).not.toBeInTheDocument();
  });

  it("exposes machine and host summaries as filters", () => {
    const onFilter = vi.fn();
    render(<MachinesBoard machines={[machine]} onFilter={onFilter} />);
    screen.getByRole("button", { name: "Filter jobs to machine m1" }).click();
    expect(onFilter).toHaveBeenCalledWith({ machine: "m1" });
    screen.getByRole("button", { name: "Filter jobs to Codex on m1" }).click();
    expect(onFilter).toHaveBeenCalledWith({ host: "Codex", machine: "m1" });
  });

  it("offers copy and find fallback for observed chat handles", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) }
    });
    const onFind = vi.fn();
    render(<MachinesBoard machines={[machine]} onFind={onFind} />);
    screen.getByRole("button", { name: "Find chat acd-machine-chat" }).click();
    expect(onFind).toHaveBeenCalledWith("acd-machine-chat");
    screen.getByRole("button", { name: "Copy chat acd-machine-chat" }).click();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("acd-machine-chat");
  });

  it("preserves observed repository scope when opening a partially attributed batch", () => {
    const onOpenBatch = vi.fn();
    render(<MachinesBoard machines={[machine]} onOpenBatch={onOpenBatch} />);
    screen.getByRole("button", { name: "Open batch batch-operator-nav" }).click();
    expect(onOpenBatch).toHaveBeenCalledWith("batch-operator-nav", undefined, "repo/dashboard");
  });
});
