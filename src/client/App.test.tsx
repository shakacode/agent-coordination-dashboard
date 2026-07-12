import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
// @ts-expect-error App tests inspect the checked-in CSS, while the browser tsconfig intentionally excludes Node types.
import { readFileSync } from "node:fs";
// @ts-expect-error See the node:fs import above.
import { cwd } from "node:process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardModel } from "../shared/types";
import { App } from "./App";

const model = {
  generatedAt: "2026-07-12T11:20:00.000Z",
  stateRoot: "/state",
  targetRepos: ["repo/dashboard"],
  agents: [],
  batches: [],
  events: [],
  batchOperations: [],
  qaValidations: [],
  healthItems: [],
  warnings: [],
  workItems: [
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
      type: "pull_request",
      schedulingState: "started_not_processing",
      operatorState: "terminal",
      terminalState: "done",
      github: {
        repo: "repo/dashboard",
        target: "44",
        type: "pull_request",
        title: "Finished dashboard work",
        url: "https://github.com/repo/dashboard/pull/44",
        state: "MERGED",
        labels: [],
        loadState: "loaded"
      },
      warnings: [],
      selected: false
    },
    {
      id: "repo/dashboard#45",
      repo: "repo/dashboard",
      target: "45",
      type: "issue",
      schedulingState: "ready_for_batch",
      operatorState: "ready",
      github: {
        repo: "repo/dashboard",
        target: "45",
        type: "issue",
        title: "Ready dashboard work",
        url: "https://github.com/repo/dashboard/issues/45",
        state: "OPEN",
        labels: [],
        loadState: "loaded"
      },
      warnings: [],
      selected: false
    }
  ]
} satisfies DashboardModel;

const settings = { targetRepos: ["repo/dashboard"] };

describe("App", () => {
  beforeEach(() => {
    window.history.pushState({}, "", "/");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => ({
        ok: true,
        json: async () => (String(input) === "/api/settings" ? settings : model)
      }))
    );
    Object.assign(navigator, { clipboard: { writeText: vi.fn() } });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("opens on the attention queue and keeps its safe copy action local", async () => {
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Attention" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Dashboard surfaces" })).toHaveTextContent("AttentionNowFindHistory");
    await userEvent.click(screen.getByRole("button", { name: "Copy resume prompt" }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining("repo/dashboard#43"));
    expect(screen.getByRole("button", { name: "3 open or coordinated items" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "0 agents" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "0 events" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "0 health" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "0 notices" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "0 agents" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "0 events" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "0 health" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "0 notices" })).toBeDisabled();
  });

  it("maps legacy query links into Find and retains their query", async () => {
    window.history.pushState({}, "", "/?q=43&batch=batch-a&item=repo/dashboard%2343");
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Find" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Find work" })).toHaveValue("43");
    expect(window.location.search).not.toContain("item=");
    expect(window.location.search).toContain("repo=repo%2Fdashboard");
    expect(window.location.search).toContain("target=43");
  });

  it("migrates target-only legacy item links without dropping their exact filter", async () => {
    window.history.pushState({}, "", "/?item=%2345");
    render(<App />);

    expect(await screen.findByRole("heading", { name: /Ready dashboard work/ })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /Finished dashboard work/ })).not.toBeInTheDocument();
    expect(window.location.search).toBe("?target=45");
  });

  it("migrates arbitrary legacy item values into universal Find text before removing item", async () => {
    window.history.pushState({}, "", "/?item=worker-a");
    render(<App />);
    expect(await screen.findByRole("textbox", { name: "Find work" })).toHaveValue("worker-a");
    expect(window.location.search).toBe("?q=worker-a");
  });

  it.each(["feature/foo#bar", "https://github.com/repo/dashboard/pull/44#discussion_r1", "thread#lantern"])(
    "keeps noncanonical hash-bearing legacy item %s intact as universal text",
    async (legacyItem) => {
      window.history.pushState({}, "", `/?item=${encodeURIComponent(legacyItem)}`);
      render(<App />);
      expect(await screen.findByRole("textbox", { name: "Find work" })).toHaveValue(legacyItem);
      expect(new URLSearchParams(window.location.search).get("q")).toBe(legacyItem);
      expect(new URLSearchParams(window.location.search).has("item")).toBe(false);
      if (legacyItem.includes("github.com")) expect(screen.getByRole("heading", { name: /Finished dashboard work/ })).toBeInTheDocument();
    }
  );

  it("makes structured constraints visible and clears them when a new universal search begins", async () => {
    window.history.pushState({}, "", "/?repo=repo/dashboard&target=45");
    render(<App />);
    expect(await screen.findByText(/Constrained by repo repo\/dashboard/)).toBeInTheDocument();
    await userEvent.type(screen.getByRole("textbox", { name: "Find work" }), "worker-a");
    expect(screen.queryByText(/Constrained by/)).not.toBeInTheDocument();
    expect(window.location.search).toBe("?q=worker-a");
  });

  it("clears query and every structured constraint when the total WorkItem count is opened", async () => {
    window.history.pushState({}, "", "/?repo=repo/dashboard&target=45&q=Ready");
    render(<App />);
    await screen.findByText(/Constrained by repo repo\/dashboard/);
    await userEvent.click(screen.getByRole("button", { name: "3 open or coordinated items" }));
    expect(screen.getByRole("textbox", { name: "Find work" })).toHaveValue("");
    expect(screen.queryByText(/Constrained by/)).not.toBeInTheDocument();
    expect(window.location.search).toBe("");
    expect(screen.getByRole("heading", { name: /Issue #43/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /PR #44/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Issue #45/ })).toBeInTheDocument();
  });

  it("scopes each positive header count to exactly agents, health, or event records", async () => {
    const scopedModel = {
      ...model,
      agents: [{ agentId: "worker-only", claims: [], currentWork: [], liveness: "live", warnings: [] }],
      healthItems: [{ id: "health-only", severity: "warning", category: "state", title: "Health only", detail: "Exact health record" }],
      events: [{ eventId: "event-only", type: "lane_started", repo: "repo/dashboard", target: "45", batchId: "batch-one", laneName: "lane", timestamp: model.generatedAt, path: "events/event-only.json" }]
    };
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => ({ ok: true, json: async () => String(input) === "/api/settings" ? settings : scopedModel }) as Response);
    render(<App />);

    await userEvent.click(await screen.findByRole("button", { name: "1 agents" }));
    expect(screen.getByText("Agents").closest("details")).toHaveAttribute("open");
    expect(screen.getByRole("heading", { name: "worker-only" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Health only" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "1 health" }));
    expect(screen.getByRole("heading", { name: "Health only" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "worker-only" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "1 events" }));
    expect(screen.getByText("Event records").closest("details")).toHaveAttribute("open");
    expect(screen.getByLabelText("Event records")).toHaveTextContent("lane_started");
    expect(screen.queryByRole("heading", { name: "Import Batch Plan" })).not.toBeInTheDocument();
  });

  it("keeps duplicate event IDs from different source files stable across refreshes", async () => {
    const duplicateEvents = [
      { eventId: "duplicate-event", type: "lane_started", repo: "repo/dashboard", target: "43", batchId: "batch-one", laneName: "lane-a", timestamp: model.generatedAt, path: "events/batch-one.jsonl:1" },
      { eventId: "duplicate-event", type: "lane_finished", repo: "repo/dashboard", target: "45", batchId: "batch-two", laneName: "lane-b", timestamp: model.generatedAt, path: "history/batch-two.jsonl:1" }
    ];
    let dashboardCalls = 0;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/settings") return { ok: true, json: async () => settings } as Response;
      dashboardCalls += 1;
      const events = dashboardCalls === 1 ? duplicateEvents : [...duplicateEvents].reverse();
      return { ok: true, json: async () => ({ ...model, events }) } as Response;
    });
    render(<App />);

    await userEvent.click(await screen.findByRole("button", { name: "2 events" }));
    expect(screen.getByLabelText("Event records")).toHaveTextContent("lane_started");
    expect(screen.getByLabelText("Event records")).toHaveTextContent("lane_finished");

    await userEvent.click(screen.getByRole("button", { name: "Refresh dashboard" }));
    await waitFor(() => expect(dashboardCalls).toBe(2));
    expect(screen.getByLabelText("Event records")).toHaveTextContent("lane_started");
    expect(screen.getByLabelText("Event records")).toHaveTextContent("lane_finished");
    expect(consoleError).not.toHaveBeenCalledWith(expect.stringContaining("same key"), expect.anything());
    expect(consoleError.mock.calls.flat().join(" ")).not.toContain("same key");
  });

  it("opens only fully-qualified repair batches from the legacy batch_repair count", async () => {
    const repair = { schemaVersion: 1, batchId: "shared", repo: "repo/dashboard", source: "manifest" as const, launchPrompt: "saved", lanes: [], path: "batches/repair.json" };
    const healthy = { schemaVersion: 1, batchId: "shared", repo: "other/dashboard", source: "manifest" as const, launchPrompt: "saved", lanes: [], path: "batches/healthy.json" };
    const operation = { batchId: "shared", batchPath: repair.path, controlStatus: "stopped" as const, eventCount: 1, qa: { total: 0, missing: 0, requested: 0, inProgress: 0, passed: 0, failed: 0, unknown: 0 } };
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => ({ ok: true, json: async () => String(input) === "/api/settings" ? settings : { ...model, batches: [repair, healthy], batchOperations: [operation] } }) as Response);
    window.history.pushState({}, "", "/?operatorFilter=batch_repair");
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Open 1 batch repair records" }));
    expect(screen.getByText("Batch repairs").closest("details")).toHaveAttribute("open");
    expect(screen.getByText("repo/dashboard", { selector: ".batch-scope" })).toBeInTheDocument();
    expect(screen.queryByText("other/dashboard")).not.toBeInTheDocument();
  });

  it("does not assign an ambiguous repo-less lane repair across repositories", async () => {
    const laneOnlyBatch = {
      schemaVersion: 1,
      batchId: "lane-only",
      source: "inferred" as const,
      lanes: [{ name: "lane", owner: "worker", targets: ["43"], dependsOn: [], status: "running", liveness: "dead" as const, blockedOn: [] }],
      path: "batches/lane-only.json"
    };
    const collisionItems = ["repo/a", "repo/b"].map((repo) => ({
      ...model.workItems[2],
      id: `${repo}#43`,
      repo,
      target: "43",
      github: undefined,
      batchSignals: [{ batchId: "lane-only", laneName: "lane", status: "running", blockedOn: [] }]
    }));
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => ({
      ok: true,
      json: async () => String(input) === "/api/settings" ? settings : { ...model, workItems: collisionItems, batches: [laneOnlyBatch] }
    }) as Response);
    window.history.pushState({}, "", "/?operatorFilter=batch_repair");
    render(<App />);

    expect(await screen.findByText("No work items match this search.")).toBeInTheDocument();
    expect(screen.queryByText("repo/a")).not.toBeInTheDocument();
    expect(screen.queryByText("repo/b")).not.toBeInTheDocument();
  });

  it("keeps repo plus target structured links exact when target numbers collide", async () => {
    const collision = { ...model.workItems[2], id: "other/repo/dashboard#45", repo: "other/repo/dashboard", github: { ...model.workItems[2].github!, repo: "other/repo/dashboard" } };
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => ({
      ok: true,
      json: async () => String(input) === "/api/settings" ? settings : { ...model, workItems: [...model.workItems, collision] }
    }) as Response);
    window.history.pushState({}, "", "/?repo=repo/dashboard&target=45");
    render(<App />);

    expect(await screen.findByRole("textbox", { name: "Find work" })).toHaveValue("");
    expect(screen.getByText("repo/dashboard", { selector: ".attention-card-kicker" })).toBeInTheDocument();
    expect(screen.queryByText("other/repo/dashboard", { selector: ".attention-card-kicker" })).not.toBeInTheDocument();
  });

  it("selects ready work from the four-surface shell and produces a usable batch prompt", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "Attention" });
    await userEvent.click(screen.getByRole("button", { name: "Find" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Find work" }), "45");
    await userEvent.click(screen.getByRole("checkbox", { name: "Include repo/dashboard#45 in PR-batch prompt" }));
    await userEvent.click(screen.getByText("PR-batch prompt"));

    expect(screen.getByText(/Issue #45: https:\/\/github.com\/repo\/dashboard\/issues\/45/)).toBeInTheDocument();
    expect(screen.getByTitle("Copy prompt")).toBeEnabled();
  });

  it("keeps Now restricted to live or stale holders and separates History", async () => {
    render(<App />);

    await screen.findByRole("heading", { name: "Attention" });
    await userEvent.click(screen.getByRole("button", { name: "Now" }));
    expect(screen.getByRole("heading", { name: "Now" })).toBeInTheDocument();
    expect(screen.getByText("Issue #43: Unattributed work item")).toBeInTheDocument();
    expect(screen.queryByText("Finished dashboard work")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "History" }));
    expect(screen.getByRole("heading", { name: "History" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Finished dashboard work/ })).toBeInTheDocument();
  });

  it("keeps the full-width degraded banner when coordination reads fail", async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => ({
      ok: true,
      json: async () =>
        String(input) === "/api/settings"
          ? settings
          : {
              ...model,
              sourceStatus: ["claims", "heartbeats", "batches", "events"].map((resource) => ({
                resource,
                mode: "api",
                status: "auth_error",
                httpStatus: 401,
                checkedAt: "2026-07-12T11:20:00.000Z"
              }))
            }
    }) as unknown as Response);
    render(<App />);

    expect(await screen.findByRole("alert", { name: "Coordination backend degraded" })).toHaveTextContent("agent-coord doctor --deep");
    await userEvent.click(screen.getByRole("button", { name: "Find" }));
    expect(screen.getByRole("checkbox", { name: "Include repo/dashboard#45 in PR-batch prompt" })).toBeDisabled();
    await userEvent.click(screen.getByText("PR-batch prompt"));
    expect(screen.getByTitle("Copy prompt")).toBeDisabled();
  });

  it("clears degraded state and re-enables selection after every required source recovers", async () => {
    let dashboardCalls = 0;
    const degraded = ["claims", "heartbeats", "batches", "events"].map((resource) => ({
      resource,
      mode: "api" as const,
      status: "unreachable" as const,
      httpStatus: 503,
      checkedAt: model.generatedAt
    }));
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/settings") return { ok: true, json: async () => settings } as Response;
      dashboardCalls += 1;
      return { ok: true, json: async () => dashboardCalls === 1 ? { ...model, sourceStatus: degraded } : { ...model, sourceStatus: degraded.map((source) => ({ ...source, status: "ok" as const, httpStatus: 200 })) } } as Response;
    });
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Find" }));
    const checkbox = screen.getByRole("checkbox", { name: "Include repo/dashboard#45 in PR-batch prompt" });
    expect(checkbox).toBeDisabled();
    expect(screen.getByRole("alert", { name: "Coordination backend degraded" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Refresh dashboard" }));
    await waitFor(() => expect(screen.queryByRole("alert", { name: "Coordination backend degraded" })).not.toBeInTheDocument());
    expect(checkbox).toBeEnabled();
  });

  it("saves target repository settings and reloads dashboard data", async () => {
    render(<App />);
    await userEvent.type(await screen.findByLabelText("Add target repository"), "other/repo");
    await userEvent.click(screen.getByRole("button", { name: "Add repository" }));

    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      "/api/settings",
      expect.objectContaining({ method: "PUT", body: JSON.stringify({ targetRepos: ["repo/dashboard", "other/repo"] }) })
    ));
    expect(fetch).toHaveBeenCalledWith("/api/dashboard", expect.objectContaining({ headers: { "X-Dashboard-Refresh": "foreground" } }));
  });

  it("preserves shell selection across background refreshes and hides transient refresh failures", async () => {
    let dashboardCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/settings") return { ok: true, json: async () => ({ ...settings, refreshIntervalMs: 20 }) } as Response;
      dashboardCalls += 1;
      if (dashboardCalls > 2) throw new Error("transient refresh failure");
      return {
        ok: true,
        json: async () => ({ ...model, workItems: model.workItems.map((item) => ({ ...item, selected: false })) })
      } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Find" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Find work" }), "45");
    const checkbox = screen.getByRole("checkbox", { name: "Include repo/dashboard#45 in PR-batch prompt" });
    await userEvent.click(checkbox);

    await waitFor(() => expect(dashboardCalls).toBeGreaterThan(2));
    expect(checkbox).toBeChecked();
    expect(screen.queryByText("transient refresh failure")).not.toBeInTheDocument();
  });

  it("keeps batch recovery controls and loopback-only import and stop routes reachable as drill-downs", async () => {
    const batch = {
      schemaVersion: 1,
      batchId: "batch-recovery",
      repo: "repo/dashboard",
      source: "manifest" as const,
      lanes: [],
      path: "batches/batch-recovery.json"
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/batches/import" || url === "/api/batches/stop") return { ok: true, json: async () => ({ path: "local-state.json" }) } as Response;
      return { ok: true, json: async () => url === "/api/settings" ? settings : { ...model, batches: [batch], events: [{ eventId: "event-1", type: "lane_started", batchId: "batch-recovery", batchPath: batch.path, repo: "repo/dashboard", timestamp: model.generatedAt, path: "events/event-1.json" }] } } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "1 events" }));
    expect(screen.getByText("Event records").closest("details")).toHaveAttribute("open");
    await userEvent.click(screen.getByRole("button", { name: "Show all batch operations" }));
    expect(screen.getByText("Batch operations").closest("details")).toHaveAttribute("open");
    await userEvent.click(screen.getByRole("button", { name: "Request stop for batch-recovery in repo/dashboard" }));
    expect(await screen.findByText("Batch stop requested for repo/dashboard.")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/batches/stop", expect.objectContaining({ method: "POST" }));

    await userEvent.type(screen.getByLabelText("Paste coordination prompt"), [
      "Use $pr-batch to complete this batch with subagents.",
      "Repository: repo/dashboard",
      "Batch id: batch-import-1",
      "Batch objective: Import retained metadata.",
      "Items:",
      "- Issue #45: https://github.com/repo/dashboard/issues/45"
    ].join("\n"));
    await userEvent.click(screen.getByRole("button", { name: "Review batch plan" }));
    await userEvent.click(screen.getByRole("button", { name: "Save batch plan" }));
    expect(await screen.findByText("Batch plan saved.")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/batches/import", expect.objectContaining({ method: "POST" }));
  });

  it("serializes overlapping loopback writes instead of racing coordination mutations", async () => {
    const batches = ["batch-one", "batch-two"].map((batchId) => ({
      schemaVersion: 1,
      batchId,
      repo: "repo/dashboard",
      source: "manifest" as const,
      lanes: [],
      path: `batches/${batchId}.json`
    }));
    const stopResolvers: Array<() => void> = [];
    const stopBodies: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/batches/stop") {
        stopBodies.push(String(init?.body));
        await new Promise<void>((resolve) => stopResolvers.push(resolve));
        return { ok: true, json: async () => ({ path: "local-event.json" }) } as Response;
      }
      return { ok: true, json: async () => url === "/api/settings" ? settings : { ...model, batches } } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);
    await userEvent.click(await screen.findByText("Batch operations"));
    await userEvent.click(screen.getByRole("button", { name: "Request stop for batch-one in repo/dashboard" }));
    await userEvent.click(screen.getByRole("button", { name: "Request stop for batch-two in repo/dashboard" }));

    await waitFor(() => expect(stopResolvers).toHaveLength(1));
    expect(stopBodies).toHaveLength(1);
    stopResolvers[0]();
    await waitFor(() => expect(stopResolvers).toHaveLength(2));
    expect(stopBodies).toHaveLength(2);
    stopResolvers[1]();
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh dashboard" })).toBeEnabled());
  });

  it("retains narrow-layout containment safeguards for all four surfaces", () => {
    const stylesheet = readFileSync(`${cwd()}/src/client/styles.css`, "utf8");
    expect(stylesheet).toMatch(/@media \(max-width: 980px\)[\s\S]*\.attention-card[\s\S]*flex-direction: column/);
    expect(stylesheet).toMatch(/\.attention-card h2,[\s\S]*overflow-wrap: anywhere/);
    expect(stylesheet).toMatch(/\.surface-nav,[\s\S]*overflow-x: auto/);
  });
});
