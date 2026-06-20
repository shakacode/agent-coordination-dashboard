import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { BatchEvent, BatchRecord } from "../../shared/types";
import { BatchesTab } from "./BatchesTab";

const event: BatchEvent = {
  eventId: "event-1",
  type: "continued",
  batchId: "batch-1",
  batchPath: "batches/batch-1.json",
  laneName: "lane-a",
  repo: "shakacode/react_on_rails",
  target: "4010",
  status: "in_progress",
  message: "Resumed after token-limit pause.",
  timestamp: "2026-06-17T20:00:00Z",
  path: "events/batch-1.jsonl:1"
};

const batch: BatchRecord = {
  schemaVersion: 1,
  batchId: "batch-1",
  repo: "shakacode/react_on_rails",
  path: "batches/batch-1.json",
  lanes: [
    {
      name: "lane-a",
      owner: "worker-a",
      targets: ["4010"],
      dependsOn: [],
      status: "queued",
      liveness: "no-heartbeat",
      blockedOn: []
    }
  ]
};

describe("BatchesTab", () => {
  it("renders event status and message separately", () => {
    render(<BatchesTab batches={[batch]} events={[event]} />);

    expect(screen.getByText("continued")).toBeInTheDocument();
    expect(screen.getByText("in_progress")).toBeInTheDocument();
    expect(screen.getByText("Resumed after token-limit pause.")).toBeInTheDocument();
  });

  it("renders scoped event history even when no batch file is retained", () => {
    render(<BatchesTab batches={[]} events={[{ ...event, batchPath: undefined }]} />);

    expect(screen.getByRole("heading", { name: "Recent history" })).toBeInTheDocument();
    expect(screen.getByText("Resumed after token-limit pause.")).toBeInTheDocument();
  });

  it("labels inferred batches", () => {
    render(<BatchesTab batches={[{ ...batch, source: "inferred" }]} events={[]} />);

    expect(screen.getByText("Inferred")).toBeInTheDocument();
  });
});
