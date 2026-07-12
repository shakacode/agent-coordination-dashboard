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
});
