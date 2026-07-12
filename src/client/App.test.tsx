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
  });

  it("maps legacy query links into Find and retains their query", async () => {
    window.history.pushState({}, "", "/?q=43&batch=batch-a&item=repo/dashboard%2343");
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Find" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Find work" })).toHaveValue("43");
  });

  it("keeps repo plus target structured links exact when target numbers collide", async () => {
    const collision = { ...model.workItems[2], id: "other/repo/dashboard#45", repo: "other/repo/dashboard", github: { ...model.workItems[2].github!, repo: "other/repo/dashboard" } };
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => ({
      ok: true,
      json: async () => String(input) === "/api/settings" ? settings : { ...model, workItems: [...model.workItems, collision] }
    }) as Response);
    window.history.pushState({}, "", "/?repo=repo/dashboard&target=45");
    render(<App />);

    expect(await screen.findByRole("textbox", { name: "Find work" })).toHaveValue("repo/dashboard#45");
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
      return { ok: true, json: async () => url === "/api/settings" ? settings : { ...model, batches: [batch] } } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);
    await userEvent.click(await screen.findByText("Batch operations"));
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

  it("retains narrow-layout containment safeguards for all four surfaces", () => {
    const stylesheet = readFileSync(`${cwd()}/src/client/styles.css`, "utf8");
    expect(stylesheet).toMatch(/@media \(max-width: 980px\)[\s\S]*\.attention-card[\s\S]*flex-direction: column/);
    expect(stylesheet).toMatch(/\.attention-card h2,[\s\S]*overflow-wrap: anywhere/);
    expect(stylesheet).toMatch(/\.surface-nav,[\s\S]*overflow-x: auto/);
  });
});
