import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MachinesTab } from "./MachinesTab";

describe("MachinesTab", () => {
  afterEach(() => vi.restoreAllMocks());
  it("shows the normal empty state when agent sources are healthy", () => {
    render(<MachinesTab agents={[]} />);
    expect(screen.getByText("No agents or heartbeats found.")).toBeInTheDocument();
  });

  it("does not report a healthy empty state when agent sources are unavailable", () => {
    render(<MachinesTab agents={[]} unavailableSources={["heartbeats", "events"]} />);

    expect(screen.getByText("Coordination agent data unavailable: heartbeats, events could not be read.")).toBeInTheDocument();
    expect(screen.queryByText("No agents or heartbeats found.")).not.toBeInTheDocument();
  });

  it("labels retained agent records as incomplete when a backing source is unavailable", () => {
    render(
      <MachinesTab
        agents={[{ agentId: "worker-a", claims: [], currentWork: [], liveness: "live", warnings: [] }]}
        unavailableSources={["events"]}
      />
    );

    expect(screen.getByText("Coordination agent data may be incomplete: events could not be read.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "worker-a" })).toBeInTheDocument();
  });

  it("renders legacy unknown agent and machine attribution as unattributed", () => {
    render(<MachinesTab agents={[{ agentId: "UNKNOWN", machineId: "UNKNOWN machine", claims: [], currentWork: [], liveness: "unknown", warnings: [] }]} />);
    expect(screen.queryByText("UNKNOWN")).not.toBeInTheDocument();
    expect(screen.queryByText("UNKNOWN machine")).not.toBeInTheDocument();
    expect(screen.getAllByText("unattributed").length).toBeGreaterThan(0);
  });

  it("renders duplicate same-message warning records without duplicate React keys", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const message = "Work was started but the holder is not currently live or stale.";
    const warning = { severity: "warning" as const, message, repo: "repo/dashboard", target: "43", agentId: "worker-a" };
    const agent = { agentId: "worker-a", claims: [], currentWork: [], liveness: "dead" as const, warnings: [warning, { ...warning }] };

    const { rerender } = render(<MachinesTab agents={[agent]} />);
    expect(screen.getAllByText(message)).toHaveLength(2);
    rerender(<MachinesTab agents={[{ ...agent, warnings: [{ ...warning }, warning] }]} />);
    expect(screen.getAllByText(message)).toHaveLength(2);
    expect(consoleError.mock.calls.flat().join(" ")).not.toContain("same key");
  });
});
