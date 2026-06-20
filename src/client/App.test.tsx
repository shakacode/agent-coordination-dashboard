import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

const model = {
  generatedAt: "2026-06-17T20:00:00Z",
  stateRoot: "/state",
  targetRepos: ["shakacode/react_on_rails"],
  agents: [
    {
      agentId: "worker-a",
      claims: [],
      currentWork: [],
      liveness: "live",
      warnings: []
    }
  ],
  workItems: [
    {
      id: "shakacode/react_on_rails#4010",
      repo: "shakacode/react_on_rails",
      target: "4010",
      type: "issue",
      schedulingState: "ready_for_batch",
      warnings: [],
      selected: true,
      github: {
        repo: "shakacode/react_on_rails",
        target: "4010",
        type: "issue",
        title: "Unscheduled issue",
        url: "https://github.com/shakacode/react_on_rails/issues/4010",
        state: "OPEN",
        labels: [],
        loadState: "loaded"
      }
    },
    {
      id: "shakacode/react_on_rails#4005",
      repo: "shakacode/react_on_rails",
      target: "4005",
      type: "pull_request",
      schedulingState: "started_not_processing",
      warnings: [{ severity: "warning", message: "Work was started but the holder is not currently live or stale." }],
      selected: false,
      github: {
        repo: "shakacode/react_on_rails",
        target: "4005",
        type: "pull_request",
        title: "Stale PR",
        url: "https://github.com/shakacode/react_on_rails/pull/4005",
        state: "OPEN",
        labels: [],
        loadState: "loaded"
      }
    }
  ],
  batches: [],
  events: [],
  healthItems: [
    {
      id: "machine:warning:worker-a:Heartbeat missing machine id",
      severity: "warning",
      category: "machine",
      title: "Heartbeat missing machine id",
      detail: "worker-a does not report machine_id.",
      agentId: "worker-a"
    }
  ],
  warnings: [{ severity: "warning", message: "GitHub issue list failed for shakacode/react_on_rails: auth required" }]
};

const settings = {
  targetRepos: ["shakacode/react_on_rails"]
};

describe("App", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/settings" && init?.method === "PUT") {
          return {
            ok: true,
            json: async () => JSON.parse(String(init.body))
          };
        }
        return {
          ok: true,
          json: async () => (url === "/api/settings" ? settings : model)
        };
      })
    );
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn()
      }
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders agents, work scheduling states, and generated prompt", async () => {
    render(<App />);

    await waitFor(() => expect(screen.getByText("worker-a")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Work" }));

    expect(screen.getByText("Ready for batch")).toBeInTheDocument();
    expect(screen.getByText("Started, not processing")).toBeInTheDocument();
    expect(screen.getByText(/auth required/)).toBeInTheDocument();
    expect(screen.getByText(/Use \$pr-batch/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Issue #4010: Unscheduled issue" })).toBeInTheDocument();
  });

  it("saves target repository filters and reloads the dashboard", async () => {
    render(<App />);

    await waitFor(() => expect(screen.getByText("shakacode/react_on_rails")).toBeInTheDocument());
    await userEvent.type(screen.getByLabelText("Add target repository"), "other/repo");
    await userEvent.click(screen.getByRole("button", { name: "Add repository" }));

    expect(fetch).toHaveBeenCalledWith(
      "/api/settings",
      expect.objectContaining({
        body: JSON.stringify({ targetRepos: ["shakacode/react_on_rails", "other/repo"] }),
        method: "PUT"
      })
    );
  });
});
