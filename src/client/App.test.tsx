import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, backgroundRefreshTimeoutMs, operatorDeepLinkForOverviewFilter } from "./App";
import * as operatorRows from "./operatorRows";

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
  batchOperations: [],
  qaValidations: [
    {
      id: "shakacode/react_on_rails#4005",
      repo: "shakacode/react_on_rails",
      target: "4005",
      type: "pull_request",
      title: "Stale PR",
      url: "https://github.com/shakacode/react_on_rails/pull/4005",
      status: "missing",
      detail: "No separate QA validation event found."
    },
    {
      id: "shakacode/react_on_rails#4011",
      repo: "shakacode/react_on_rails",
      target: "4011",
      type: "pull_request",
      title: "Active QA",
      url: "https://github.com/shakacode/react_on_rails/pull/4011",
      batchId: "batch-qa",
      laneName: "qa",
      status: "in_progress",
      detail: "Separate QA validation is in progress."
    }
  ],
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
    window.history.pushState({}, "", "/");
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
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders an action-oriented overview by default before drill-down tabs", async () => {
    render(<App />);

    await waitFor(() => expect(screen.getByRole("heading", { name: "Needs Attention" })).toBeInTheDocument());
    expect(screen.getByText("/state · 2 open or coordinated items")).toBeInTheDocument();
    expect(screen.getAllByText("1 ready").length).toBeGreaterThan(0);
    expect(screen.getAllByText("1 claimed").length).toBeGreaterThan(0);
    expect(screen.getByText("1 QA needs attention")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show 0 batch repairs in Operator view" })).toHaveTextContent("0 batch repairs");
    expect(screen.getByText("Missing")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Work" }));

    expect(screen.getByText("Ready for batch")).toBeInTheDocument();
    expect(screen.getByText("Started, not processing")).toBeInTheDocument();
    expect(screen.getByText(/auth required/)).toBeInTheDocument();
    expect(screen.getByText(/Use \$pr-batch/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Issue #4010: Unscheduled issue" })).toBeInTheDocument();
  });

  it("passes root search query params to the Operator View", async () => {
    window.history.pushState({}, "", "/?q=4005");

    render(<App />);

    await waitFor(() => expect(screen.getByLabelText("Search operator rows")).toHaveValue("4005"));
    expect(screen.getByText("PR #4005")).toBeInTheDocument();
    expect(screen.queryByText("Issue #4010")).not.toBeInTheDocument();
  });

  it("opens summary filters with keyboard activation and restores them through browser history", async () => {
    render(<App />);

    const readyAction = await screen.findByRole("button", { name: "Show 1 ready for batch rows in Operator view" });
    readyAction.focus();
    await userEvent.keyboard("{Enter}");

    expect(screen.getByRole("heading", { name: "Operator View" })).toBeInTheDocument();
    expect(screen.getByText("Active filter:").parentElement).toHaveTextContent("Ready for batch");
    expect(screen.getByText("Issue #4010")).toBeInTheDocument();
    expect(screen.queryByText("PR #4005")).not.toBeInTheDocument();
    expect(window.location.search).toBe("?operatorFilter=ready_for_batch");

    await userEvent.click(screen.getByRole("button", { name: "Reset filter" }));
    expect(screen.getByText("PR #4005")).toBeInTheDocument();
    expect(window.location.search).toBe("");

    window.history.back();
    await waitFor(() => expect(window.location.search).toBe("?operatorFilter=ready_for_batch"));
    expect(screen.getByText("Active filter:").parentElement).toHaveTextContent("Ready for batch");

    window.history.back();
    await waitFor(() => expect(screen.getByRole("heading", { name: "Needs Attention" })).toBeInTheDocument());
    window.history.forward();
    await waitFor(() => expect(screen.getByText("Active filter:").parentElement).toHaveTextContent("Ready for batch"));
  });

  it("uses the exact filtered Operator row count for every Overview summary", async () => {
    const { container } = render(<App />);
    const cases = [
      { name: "Show 1 ready for batch rows in Operator view", rows: 1 },
      { name: "Show 1 claimed, not processing rows in Operator view", rows: 1 },
      { name: "Show 0 processing now rows in Operator view", rows: 0 },
      { name: "Show 1 QA needs attention rows in Operator view", rows: 1 },
      { name: "Show 0 batch repairs in Operator view", rows: 0 }
    ];

    await screen.findByRole("heading", { name: "Needs Attention" });
    for (const item of cases) {
      await userEvent.click(screen.getByRole("button", { name: item.name }));
      expect(container.querySelectorAll(".operator-table tbody tr")).toHaveLength(item.rows);
      await userEvent.click(screen.getByRole("button", { name: "Overview" }));
    }
  });

  it("groups duplicate QA validation signals into the same target row used by the Operator filter", async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => ({
      ok: true,
      json: async () =>
        String(input) === "/api/settings"
          ? settings
          : {
              ...model,
              workItems: [model.workItems[1]],
              qaValidations: [
                {
                  ...model.qaValidations[0],
                  id: "qa-batch-a",
                  batchId: "batch-a",
                  laneName: "qa-a",
                  status: "missing"
                },
                {
                  ...model.qaValidations[0],
                  id: "qa-batch-b",
                  batchId: "batch-b",
                  laneName: "qa-b",
                  status: "in_progress"
                }
              ]
            }
    }) as Response);

    render(<App />);

    const qaPanel = (await screen.findByRole("heading", { name: "QA Validation" })).closest("article");
    const panel = within(qaPanel as HTMLElement);
    expect(screen.getByRole("button", { name: "Show 1 QA needs attention rows in Operator view" })).toBeInTheDocument();
    expect(panel.getAllByText("PR #4005: Stale PR")).toHaveLength(1);
    expect(panel.getByText("batch-a:qa-a (missing) · batch-b:qa-b (in_progress)")).toBeInTheDocument();
    expect(panel.getByText("Missing")).toBeInTheDocument();
    expect(panel.getByText("In progress")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Show 1 QA needs attention rows in Operator view" }));
    expect(document.querySelectorAll(".operator-table tbody tr")).toHaveLength(1);
  });

  it("keeps a rowless repair batch consistent across the summary, panel, and Operator destination", async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => ({
      ok: true,
      json: async () =>
        String(input) === "/api/settings"
          ? settings
          : {
              ...model,
              workItems: [],
              qaValidations: [],
              batches: [
                {
                  schemaVersion: 1,
                  batchId: "rowless-batch",
                  repo: "shakacode/react_on_rails",
                  objective: "Repair retained batch metadata",
                  path: "batches/rowless.json",
                  lanes: []
                }
              ],
              batchOperations: [
                {
                  batchId: "rowless-batch",
                  repo: "shakacode/react_on_rails",
                  batchPath: "batches/rowless.json",
                  controlStatus: "stopped",
                  eventCount: 1,
                  qa: { total: 0, missing: 0, requested: 0, inProgress: 0, passed: 0, failed: 0, unknown: 0 }
                }
              ]
            }
    }) as Response);

    render(<App />);

    const repairAction = await screen.findByRole("button", { name: "Show 1 batch repairs in Operator view" });
    expect(screen.getByRole("heading", { name: "Batch Repair" }).closest("article")).toHaveTextContent("rowless-batch");
    await userEvent.click(repairAction);

    const operator = within(screen.getByLabelText("Operator view"));
    expect(operator.getByText("Batch")).toBeInTheDocument();
    expect(operator.getByText("Repair retained batch metadata")).toBeInTheDocument();
    expect(operator.getByText("rowless-batch")).toBeInTheDocument();
  });

  it("clears a failed exact link without misattributing or removing the active Overview filter", async () => {
    window.history.pushState({}, "", "/?operatorFilter=ready_for_batch&repo=missing%2Frepo&target=999");

    render(<App />);

    expect(await screen.findByText("No loaded row matches this link.")).toBeInTheDocument();
    expect(screen.getByText("Active filter:").parentElement).toHaveTextContent("Ready for batch");
    await userEvent.click(screen.getByRole("button", { name: "Clear link" }));

    expect(screen.getByText("Issue #4010")).toBeInTheDocument();
    expect(screen.getByText("Active filter:").parentElement).toHaveTextContent("Ready for batch");
    expect(window.location.search).toBe("?operatorFilter=ready_for_batch");
  });

  it("restores a shareable overview filter on reload while free-text search still applies", async () => {
    window.history.pushState({}, "", "/?operatorFilter=needs_recovery&q=4005");

    render(<App />);

    await waitFor(() => expect(screen.getByLabelText("Search operator rows")).toHaveValue("4005"));
    expect(screen.getByText("Active filter:").parentElement).toHaveTextContent("Claimed, not processing");
    expect(screen.getByText("PR #4005")).toBeInTheDocument();
    expect(screen.queryByText("Issue #4010")).not.toBeInTheDocument();
  });

  it("preserves operator search when switching away from the Operator tab", async () => {
    render(<App />);

    await waitFor(() => expect(screen.getByRole("heading", { name: "Needs Attention" })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Operator" }));
    await userEvent.type(screen.getByLabelText("Search operator rows"), "4005");

    expect(screen.getByText("PR #4005")).toBeInTheDocument();
    expect(screen.queryByText("Issue #4010")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Work" }));
    await userEvent.click(screen.getByRole("button", { name: "Operator" }));

    expect(screen.getByLabelText("Search operator rows")).toHaveValue("4005");
    expect(screen.getByText("PR #4005")).toBeInTheDocument();
    expect(screen.queryByText("Issue #4010")).not.toBeInTheDocument();
  });

  it("preserves the live query in structured filter state when opening an Overview action", async () => {
    expect(operatorDeepLinkForOverviewFilter("ready_for_batch", "4005")).toEqual({
      overviewFilter: "ready_for_batch",
      query: "4005"
    });

    render(<App />);
    await screen.findByRole("heading", { name: "Needs Attention" });
    await userEvent.click(screen.getByRole("button", { name: "Operator" }));
    await userEvent.type(screen.getByLabelText("Search operator rows"), "4005");
    await userEvent.click(screen.getByRole("button", { name: "Overview" }));
    await userEvent.click(screen.getByRole("button", { name: "Show 1 ready for batch rows in Operator view" }));

    expect(screen.getByLabelText("Search operator rows")).toHaveValue("4005");
    expect(window.location.search).toBe("?operatorFilter=ready_for_batch&q=4005");
  });

  it("memoizes Overview operator row derivation across unrelated App rerenders", async () => {
    const buildRows = vi.spyOn(operatorRows, "buildOperatorRows");
    render(<App />);

    await screen.findByRole("heading", { name: "Needs Attention" });
    const initialCalls = buildRows.mock.calls.length;
    expect(initialCalls).toBeGreaterThan(0);

    await userEvent.type(screen.getByLabelText("Add target repository"), "other/repo");

    expect(buildRows).toHaveBeenCalledTimes(initialCalls);
  });

  it("labels info-only coordination messages as notices", async () => {
    vi.mocked(fetch).mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/settings" && init?.method === "PUT") {
          return {
            ok: true,
            json: async () => JSON.parse(String(init.body))
          } as Response;
        }
        return {
          ok: true,
          json: async () =>
            url === "/api/settings"
              ? settings
              : {
                  ...model,
                  agents: [],
                  workItems: [],
                  healthItems: [],
                  warnings: [{ severity: "info", message: "No coordination state found at /state." }]
                }
        } as Response;
      }
    );

    render(<App />);

    await waitFor(() => expect(screen.getByText("Notices")).toBeInTheDocument());
    expect(screen.getAllByText("1 notices").length).toBeGreaterThan(0);
    expect(screen.queryByText("Warnings")).not.toBeInTheDocument();
    expect(screen.getAllByText(/No coordination state found/).length).toBeGreaterThan(0);
  });

  it("groups repeated warning types and keeps overflow details inspectable", async () => {
    vi.mocked(fetch).mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/settings" && init?.method === "PUT") {
          return {
            ok: true,
            json: async () => JSON.parse(String(init.body))
          } as Response;
        }
        return {
          ok: true,
          json: async () =>
            url === "/api/settings"
              ? settings
              : {
                  ...model,
                  warnings: [
                    {
                      severity: "warning",
                      repo: "shakacode/react_on_rails",
                      target: "4005",
                      message: "Work has a heartbeat from worker-a but the claim is held by owner-a."
                    },
                    {
                      severity: "warning",
                      repo: "shakacode/react_on_rails",
                      target: "4010",
                      message: "Work has a heartbeat from worker-b but the claim is held by owner-b."
                    },
                    { severity: "warning", message: "Active claim has no matching heartbeat." },
                    { severity: "warning", message: "A distinct warning." },
                    { severity: "warning", message: "Another distinct warning." }
                  ]
                }
        } as Response;
      }
    );

    render(<App />);

    const warningsPanel = await screen.findByLabelText("Coordination warnings");
    const panel = within(warningsPanel);
    const groupedLabel = panel.getByText(
      "Work has a heartbeat from an agent other than the claim holder.",
      { selector: "summary .signal-group-label" }
    );
    expect(panel.getByLabelText("2 occurrences")).toBeInTheDocument();
    expect(panel.getByText("1 more type")).toBeInTheDocument();

    await userEvent.click(groupedLabel);
    expect(
      panel.getByText(
        "shakacode/react_on_rails#4005: Work has a heartbeat from worker-a but the claim is held by owner-a."
      )
    ).toBeInTheDocument();
    expect(
      panel.getByText(
        "shakacode/react_on_rails#4010: Work has a heartbeat from worker-b but the claim is held by owner-b."
      )
    ).toBeInTheDocument();

    await userEvent.click(panel.getByText("1 more type"));
    expect(panel.getByText("Another distinct warning.")).toBeInTheDocument();
  });

  it("groups repeated Overview attention types while retaining exact records", async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => ({
      ok: true,
      json: async () =>
        String(input) === "/api/settings"
          ? settings
          : {
              ...model,
              warnings: [],
              healthItems: [
                { ...model.healthItems[0], id: "health-a", detail: "worker-a does not report machine_id." },
                { ...model.healthItems[0], id: "health-b", detail: "worker-b does not report machine_id.", agentId: "worker-b" },
                ...Array.from({ length: 6 }, (_, index) => ({
                  ...model.healthItems[0],
                  id: `health-unique-${index}`,
                  category: "batch",
                  title: `Unique health type ${index}`,
                  detail: `Exact health detail ${index}`
                }))
              ]
            }
    }) as Response);

    render(<App />);

    const attentionPanel = (await screen.findByRole("heading", { name: "Needs Attention" })).closest("article");
    const panel = within(attentionPanel as HTMLElement);
    expect(panel.getByLabelText("2 occurrences")).toBeInTheDocument();
    await userEvent.click(panel.getByText("Heartbeat missing machine id", { selector: "summary .signal-group-label" }));
    expect(panel.getByText("worker-a does not report machine_id.")).toBeInTheDocument();
    expect(panel.getByText("worker-b does not report machine_id.")).toBeInTheDocument();
    expect(panel.getByText("1 more type")).toBeInTheDocument();
    await userEvent.click(panel.getByText("1 more type"));
    expect(panel.getByText("Exact health detail 5")).toBeInTheDocument();
  });

  it("saves target repository filters and reloads the dashboard", async () => {
    render(<App />);

    await waitFor(() => expect(screen.getByLabelText("Add target repository")).toBeInTheDocument());
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

  it("auto-refreshes the dashboard when a refresh interval is configured", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/settings" && init?.method === "PUT") {
        return {
          ok: true,
          json: async () => JSON.parse(String(init.body))
        } as Response;
      }
      return {
        ok: true,
        json: async () => (url === "/api/settings" ? { ...settings, refreshIntervalMs: 100 } : model)
      } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    const dashboardCallCount = () => fetchMock.mock.calls.filter(([input]) => String(input) === "/api/dashboard").length;
    await waitFor(() => expect(dashboardCallCount()).toBeGreaterThan(0));
    const initialCount = dashboardCallCount();
    await waitFor(() => expect(dashboardCallCount()).toBeGreaterThan(initialCount));
  });

  it("sizes background refresh timeouts from the configured polling interval", () => {
    expect(backgroundRefreshTimeoutMs(100)).toBe(4000);
    expect(backgroundRefreshTimeoutMs(10000)).toBe(11000);
    expect(backgroundRefreshTimeoutMs(Number.NaN)).toBe(4000);
  });

  it("preserves selected work items across background refreshes", async () => {
    let dashboardCalls = 0;
    const unselectedModel = {
      ...model,
      workItems: model.workItems.map((item) => ({ ...item, selected: false }))
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/settings" && init?.method === "PUT") {
        return {
          ok: true,
          json: async () => JSON.parse(String(init.body))
        } as Response;
      }
      if (url === "/api/settings") {
        return {
          ok: true,
          json: async () => ({ ...settings, refreshIntervalMs: 100 })
        } as Response;
      }
      dashboardCalls += 1;
      return {
        ok: true,
        json: async () => unselectedModel
      } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    await waitFor(() => expect(screen.getByRole("heading", { name: "Needs Attention" })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Work" }));
    const firstCheckbox = screen.getAllByRole("checkbox")[0];
    expect(firstCheckbox).not.toBeChecked();
    await userEvent.click(firstCheckbox);
    expect(firstCheckbox).toBeChecked();

    await waitFor(() => expect(dashboardCalls).toBeGreaterThan(1));
    expect(screen.getAllByRole("checkbox")[0]).toBeChecked();
  });

  it("keeps the current dashboard visible when a background refresh fails", async () => {
    let dashboardCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/settings" && init?.method === "PUT") {
        return {
          ok: true,
          json: async () => JSON.parse(String(init.body))
        } as Response;
      }
      if (url === "/api/settings") {
        return {
          ok: true,
          json: async () => ({ ...settings, refreshIntervalMs: 100 })
        } as Response;
      }
      dashboardCalls += 1;
      if (dashboardCalls > 1) {
        throw new Error("temporary API failure");
      }
      return {
        ok: true,
        json: async () => model
      } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    await waitFor(() => expect(screen.getByRole("heading", { name: "Needs Attention" })).toBeInTheDocument());
    await waitFor(() => expect(dashboardCalls).toBeGreaterThan(1));
    expect(screen.getByRole("heading", { name: "Needs Attention" })).toBeInTheDocument();
    expect(screen.queryByText("temporary API failure")).not.toBeInTheDocument();
  });

  it("keeps foreground refresh disabled until overlapping user actions settle", async () => {
    const batchModel = {
      ...model,
      targetRepos: ["repo-a/app", "repo-b/app"],
      batches: [
        {
          schemaVersion: 1,
          batchId: "batch-overlap",
          targets: [
            { type: "pull_request", target: "1", repo: "repo-a/app" },
            { type: "pull_request", target: "2", repo: "repo-b/app" }
          ],
          lanes: [],
          path: "/state/batches/batch-overlap.json"
        }
      ],
      batchOperations: [
        {
          batchId: "batch-overlap",
          batchPath: "/state/batches/batch-overlap.json",
          controlStatus: "running",
          eventCount: 0,
          qa: {
            total: 0,
            missing: 0,
            requested: 0,
            inProgress: 0,
            passed: 0,
            failed: 0,
            unknown: 0
          }
        }
      ]
    };
    const releaseStopResponses: Array<() => void> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/settings") {
        return {
          ok: true,
          json: async () => ({ targetRepos: ["repo-a/app", "repo-b/app"], refreshIntervalMs: 100 })
        } as Response;
      }
      if (url === "/api/batches/stop" && init?.method === "POST") {
        return new Promise<Response>((resolve) => {
          releaseStopResponses.push(() =>
            resolve({
              ok: true,
              json: async () => ({ path: "/state/events/batches/batch-overlap.jsonl" })
            } as Response)
          );
        });
      }
      return {
        ok: true,
        json: async () => batchModel
      } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    await waitFor(() => expect(screen.getByRole("heading", { name: "Needs Attention" })).toBeInTheDocument());
    const refreshButton = screen.getByRole("button", { name: "Refresh dashboard" });
    await userEvent.click(screen.getByRole("button", { name: "Batches" }));
    await userEvent.click(screen.getByRole("button", { name: "Request stop for batch-overlap in repo-a/app" }));
    await userEvent.click(screen.getByRole("button", { name: "Request stop for batch-overlap in repo-b/app" }));

    await waitFor(() => expect(releaseStopResponses).toHaveLength(1));
    expect(refreshButton).toBeDisabled();
    releaseStopResponses[0]();
    await screen.findByText("Batch stop requested for repo-a/app.");
    expect(refreshButton).toBeDisabled();
    await waitFor(() => expect(releaseStopResponses).toHaveLength(2));
    releaseStopResponses[1]();
    await screen.findByText("Batch stop requested for repo-b/app.");
    await waitFor(() => expect(refreshButton).not.toBeDisabled());
  });

  it("keeps batch import validation failures local to the Batches view", async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/batches/import" && init?.method === "POST") {
        return {
          ok: false,
          status: 400,
          json: async () => ({ error: "Invalid batch plan" })
        } as Response;
      }
      return {
        ok: true,
        json: async () => (url === "/api/settings" ? settings : model)
      } as Response;
    });
    render(<App />);

    await waitFor(() => expect(screen.getByRole("heading", { name: "Needs Attention" })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Batches" }));
    await userEvent.type(
      screen.getByLabelText("Paste coordination prompt"),
      [
        "Use $pr-batch to complete this batch with subagents.",
        "Repository: shakacode/react_on_rails",
        "Batch id: batch-import-1",
        "Batch objective: Import retained metadata.",
        "Items:",
        "- PR #4005: https://github.com/shakacode/react_on_rails/pull/4005"
      ].join("\n")
    );
    await userEvent.click(screen.getByRole("button", { name: "Review batch plan" }));
    await userEvent.click(screen.getByRole("button", { name: "Save batch plan" }));

    expect(await screen.findByText("Batch plan import failed with 400")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Agent Coordination" })).toBeInTheDocument();
  });
});
