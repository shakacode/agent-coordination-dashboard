import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { HealthItem } from "../../shared/types";
import { HealthTab } from "./HealthTab";

function healthItem(partial: Partial<HealthItem> = {}): HealthItem {
  return {
    id: "h-1",
    severity: "warning",
    category: "heartbeat",
    title: "Heartbeat missing machine id",
    detail: "agent-a heartbeat has no machine id",
    ...partial
  };
}

describe("HealthTab", () => {
  it("collapses repeated signals into one counted, expandable group", async () => {
    const items = [
      healthItem({ id: "h-1", agentId: "agent-a", detail: "agent-a heartbeat has no machine id" }),
      healthItem({ id: "h-2", agentId: "agent-b", detail: "agent-b heartbeat has no machine id" }),
      healthItem({ id: "h-3", agentId: "agent-c", detail: "agent-c heartbeat has no machine id" })
    ];

    render(<HealthTab items={items} />);

    // One counted summary rather than three near-identical cards.
    const summary = screen.getByText("Heartbeat missing machine id", { selector: "summary .signal-group-label" });
    expect(summary).toBeInTheDocument();
    expect(screen.getByText("3×")).toBeInTheDocument();

    // Underlying records remain inspectable on expand.
    await userEvent.click(summary);
    expect(screen.getByText("agent-a heartbeat has no machine id")).toBeInTheDocument();
    expect(screen.getByText("agent-c heartbeat has no machine id")).toBeInTheDocument();
  });

  it("renders a lone signal flat, without a count", () => {
    render(<HealthTab items={[healthItem({ category: "batch", title: "Batch plan missing" })]} />);

    expect(screen.getByRole("heading", { name: "Batch plan missing" })).toBeInTheDocument();
    expect(screen.queryByText("1×")).not.toBeInTheDocument();
  });

  it("shows an empty state when there are no health issues", () => {
    render(<HealthTab items={[]} />);
    expect(screen.getByText("No coordination health issues found.")).toBeInTheDocument();
  });

  it("does not report a healthy empty state when health sources are unavailable", () => {
    render(<HealthTab items={[]} unavailableSources={["claims", "events"]} />);

    expect(screen.getByText("Coordination health data unavailable: claims, events could not be read.")).toBeInTheDocument();
    expect(screen.queryByText("No coordination health issues found.")).not.toBeInTheDocument();
  });
});
