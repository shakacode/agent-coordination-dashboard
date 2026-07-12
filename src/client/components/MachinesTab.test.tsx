import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MachinesTab } from "./MachinesTab";

describe("MachinesTab", () => {
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
});
