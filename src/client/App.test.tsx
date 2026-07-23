import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
// @ts-expect-error App tests inspect the checked-in CSS, while the browser tsconfig intentionally excludes Node types.
import { readFileSync } from "node:fs";
// @ts-expect-error See the node:fs import above.
import { cwd } from "node:process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardModel, DashboardRuntimeSettings } from "../shared/types";
import type { ItemTimelineResponse } from "./api";
import { App, DASHBOARD_SNAPSHOT_CACHE_KEY, backgroundRefreshTimeoutMs, batchReferenceFromSearchParams, nextActiveSnoozeDelayMs } from "./App";

const settings: DashboardRuntimeSettings = { targetRepos: ["repo/dashboard"], scopeId: "test-runtime-scope" };

it("parses repository-scoped batch deep links", () => {
  expect(batchReferenceFromSearchParams(new URLSearchParams("?batch=batch-a&repo=repo%2Fdashboard"))).toEqual({
    batchId: "batch-a",
    repo: "repo/dashboard"
  });
  expect(batchReferenceFromSearchParams(new URLSearchParams("?repo=repo%2Fdashboard"))).toBeUndefined();
});

function liveHeartbeat(agentId: string, updatedAt: string, extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    agentId,
    status: "in_progress",
    updatedAt,
    expiresAt: "2026-07-21T12:30:00.000Z",
    path: `heartbeats/${agentId}.json`,
    liveness: "live" as const,
    ...extra
  };
}

const model = {
  generatedAt: "2026-07-21T12:00:00.000Z",
  stateRoot: "/state",
  targetRepos: ["repo/dashboard"],
  trulyOpenCount: 2,
  trulyOpenCountStatus: "available",
  agents: [
    {
      agentId: "codex-live",
      machineId: "m1",
      liveness: "live",
      claims: [],
      currentWork: [],
      warnings: [],
      heartbeat: liveHeartbeat("codex-live", "2026-07-21T11:59:00.000Z", { host: "Codex", machineId: "m1", repo: "repo/dashboard", target: "43" })
    },
    {
      agentId: "claude-live",
      machineId: "m1",
      liveness: "live",
      claims: [],
      currentWork: [],
      warnings: [],
      heartbeat: liveHeartbeat("claude-live", "2026-07-21T11:59:00.000Z", { host: "Claude", machineId: "m1" })
    }
  ],
  batches: [
    {
      schemaVersion: 1,
      batchId: "batch-alpha",
      repo: "repo/dashboard",
      objective: "Land the telemetry contract with QA.",
      createdAt: "2026-07-21T10:00:00.000Z",
      createdByMachine: "m1",
      launchPrompt: "/goal\nUse $pr-batch to complete this batch.",
      lanes: [
        { name: "l1", owner: "codex-live", targets: ["201"], dependsOn: [], status: "running", liveness: "live", blockedOn: [], host: "Codex" },
        { name: "l2", owner: "codex-live", targets: ["202"], dependsOn: ["l1"], status: "blocked", liveness: "no-heartbeat", blockedOn: ["batch-alpha:201"], host: "Codex" }
      ],
      path: "batches/batch-alpha.json"
    }
  ],
  events: [],
  batchOperations: [
    { batchId: "batch-alpha", repo: "repo/dashboard", batchPath: "batches/batch-alpha.json", controlStatus: "running", eventCount: 4, qa: { total: 2, missing: 1, requested: 0, inProgress: 0, passed: 1, failed: 0, unknown: 0 } }
  ],
  qaValidations: [],
  healthItems: [
    { id: "h1", severity: "warning", category: "heartbeat", title: "Heartbeat drift", detail: "A heartbeat drifted to another machine.", machineId: "m1" }
  ],
  warnings: [
    { severity: "warning", message: "Work has 2 heartbeat records for the same target.", repo: "repo/dashboard", target: "43" },
    { severity: "info", message: "Skipped 104 claim records outside saved target repositories." }
  ],
  workItems: [
    {
      id: "repo/dashboard#43", repo: "repo/dashboard", target: "43", type: "pull_request", schedulingState: "in_process",
      operatorState: "running", warnings: [], selected: false,
      heartbeat: liveHeartbeat("codex-live", "2026-07-21T11:59:00.000Z", { host: "Codex", machineId: "m1", repo: "repo/dashboard", target: "43" }),
      github: { repo: "repo/dashboard", target: "43", type: "pull_request", title: "Running dashboard work", url: "https://github.com/repo/dashboard/pull/43", state: "OPEN", labels: [], loadState: "loaded", branch: "codex/run" }
    },
    {
      id: "repo/dashboard#46", repo: "repo/dashboard", target: "46", type: "pull_request", schedulingState: "in_process",
      operatorState: "needs_attention", warnings: [], selected: false,
      attention: { kind: "blocked_user_input", label: "Review approval requested", action: "Open PR" },
      heartbeat: liveHeartbeat("claude-live", "2026-07-21T11:59:00.000Z", { host: "Claude", machineId: "m1", repo: "repo/dashboard", target: "46" }),
      github: { repo: "repo/dashboard", target: "46", type: "pull_request", title: "Needs input work", url: "https://github.com/repo/dashboard/pull/46", state: "OPEN", labels: [], loadState: "loaded" }
    },
    {
      id: "repo/dashboard#45", repo: "repo/dashboard", target: "45", type: "issue", schedulingState: "ready_for_batch",
      operatorState: "ready", warnings: [], selected: false,
      github: { repo: "repo/dashboard", target: "45", type: "issue", title: "Ready dashboard work", url: "https://github.com/repo/dashboard/issues/45", state: "OPEN", labels: [], loadState: "loaded" }
    },
    {
      id: "repo/dashboard#44", repo: "repo/dashboard", target: "44", type: "pull_request", schedulingState: "started_not_processing",
      operatorState: "terminal", terminalState: "done", warnings: [], selected: false,
      github: { repo: "repo/dashboard", target: "44", type: "pull_request", title: "Finished dashboard work", url: "https://github.com/repo/dashboard/pull/44", state: "MERGED", labels: [], loadState: "loaded" }
    }
  ]
} satisfies DashboardModel;

const itemTimeline: ItemTimelineResponse = {
  repo: "repo/dashboard",
  target: "43",
  item: model.workItems[0],
  claims: [],
  liveness: [],
  phases: [],
  events: [],
  branches: ["codex/run"],
  prUrls: ["https://github.com/repo/dashboard/pull/43"],
  sourceStatus: [],
  warnings: []
};

function okJson(value: unknown) {
  return { ok: true, json: async () => value };
}

function stubDefaultFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/settings")) return okJson(settings);
      if (url.startsWith("/api/item/")) return okJson(itemTimeline);
      return okJson(model);
    })
  );
}

describe("App", () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.pushState({}, "", "/");
    stubDefaultFetch();
    // defineProperty (configurable) overrides any accessor a prior userEvent call installed.
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined), readText: vi.fn().mockResolvedValue("") }
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("computes the earliest future snooze expiry exactly", () => {
    const workItems = model.workItems.map((item, index) => ({
      ...item,
      ...(index < 2 ? { annotation: { key: item.id, kind: "snooze" as const, until: index === 0 ? "2026-07-12T10:01:00Z" : "2026-07-12T10:02:00Z", createdAt: "2026-07-12T09:00:00Z", active: true as const } } : {})
    }));
    expect(nextActiveSnoozeDelayMs(workItems, Date.parse("2026-07-12T10:00:00Z"))).toBe(60_000);
  });

  it("keeps the background refresh timeout above the floor", () => {
    expect(backgroundRefreshTimeoutMs(0)).toBe(4000);
    expect(backgroundRefreshTimeoutMs(10_000)).toBe(11_000);
  });

  it("opens on the Batches view with the three-tab shell and host legend", async () => {
    render(<App />);

    expect(await screen.findByRole("button", { name: /Batches/ })).toBeInTheDocument();
    expect(document.title).toBe("Agent Coordination Dashboard");
    expect(screen.getByText("Agent Coordination")).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "Dashboard views" });
    expect(within(nav).getByRole("button", { name: /Batches/ })).toHaveAttribute("aria-current", "page");
    expect(within(nav).getByRole("button", { name: /Jobs/ })).toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: /Machines/ })).toBeInTheDocument();
    // Host legend aggregates live/total per host (one Codex agent, one Claude agent).
    const legend = screen.getByLabelText("Host fleet");
    expect(within(legend).getByText("Codex")).toBeInTheDocument();
    expect(within(legend).getByText("Claude")).toBeInTheDocument();
    expect(within(legend).getAllByText("1 live · 1")).toHaveLength(2);
    // Batch card renders from real batch data.
    expect(screen.getByRole("button", { name: /Land the telemetry contract with QA\..*Details/ })).toBeInTheDocument();
  });

  it("renders an accessible dashboard skeleton when no cached snapshot exists", () => {
    render(<App />);
    expect(screen.getByRole("status", { name: "Loading coordination dashboard" })).toBeInTheDocument();
  });

  it("paints the last-known snapshot after current settings validate its scope", async () => {
    localStorage.setItem(DASHBOARD_SNAPSHOT_CACHE_KEY, JSON.stringify({ version: 2, savedAt: "2026-07-21T11:00:00.000Z", dashboard: model, settings }));
    // Hold the fresh dashboard read so the snapshot banner stays visible.
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/settings")) return okJson(settings);
      if (url.startsWith("/api/dashboard")) return new Promise(() => {});
      return okJson(model);
    }));
    render(<App />);
    expect(await screen.findByText("Showing last-known snapshot")).toBeInTheDocument();
  });

  it("rejects a cached snapshot from a different runtime scope", async () => {
    localStorage.setItem(DASHBOARD_SNAPSHOT_CACHE_KEY, JSON.stringify({ version: 2, savedAt: "2026-07-21T11:00:00.000Z", dashboard: model, settings: { ...settings, scopeId: "other-scope" } }));
    render(<App />);
    await screen.findByRole("button", { name: /Batches/ });
    expect(screen.queryByText("Showing last-known snapshot")).not.toBeInTheDocument();
  });

  it("routes repo-scope exclusion notices to the target repositories row, not the notices panel", async () => {
    render(<App />);
    await screen.findByRole("button", { name: /Batches/ });
    // The fleet warning stays; the scope-exclusion note is redirected to the repo row.
    expect(screen.getByText("1 configured · 104 records excluded")).toBeInTheDocument();
    expect(screen.queryByText(/Skipped 104 claim records/)).not.toBeInTheDocument();
    const notices = screen.getByText(/Warnings · 1/);
    expect(notices).toBeInTheDocument();
  });

  it("shows the full-width degraded banner when required coordination reads fail", async () => {
    const degraded = {
      ...model,
      coordinationTokenEnvVar: "AGENT_COORD_API_TOKEN" as const,
      sourceStatus: [
        { resource: "claims" as const, mode: "api" as const, status: "auth_error" as const, httpStatus: 401, checkedAt: model.generatedAt },
        { resource: "heartbeats" as const, mode: "api" as const, status: "auth_error" as const, httpStatus: 401, checkedAt: model.generatedAt },
        { resource: "batches" as const, mode: "api" as const, status: "auth_error" as const, httpStatus: 401, checkedAt: model.generatedAt }
      ]
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/settings")) return okJson(settings);
      return okJson(degraded);
    }));
    render(<App />);
    expect(await screen.findByRole("alert", { name: "Coordination backend degraded" })).toBeInTheDocument();
    expect(screen.getByText(/Coordination backend unreachable/)).toBeInTheDocument();
  });

  it("adds and removes target repositories through the scope row", async () => {
    const putBodies: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/settings")) {
        if (init?.method === "PUT") {
          putBodies.push(String(init.body));
          return okJson({ ...settings, targetRepos: JSON.parse(String(init.body)).targetRepos });
        }
        return okJson(settings);
      }
      return okJson(model);
    }));
    render(<App />);
    await userEvent.click(await screen.findByText("Target repositories"));
    await userEvent.type(screen.getByLabelText("Add target repository"), "owner/next");
    await userEvent.click(screen.getByRole("button", { name: "Add repository" }));
    await waitFor(() => expect(putBodies.some((body) => body.includes("owner/next"))).toBe(true));
  });

  it("opens a job detail drawer from the Jobs board and keeps copy actions local", async () => {
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: /Jobs/ }));
    await userEvent.click(await screen.findByRole("button", { name: /Running dashboard work/ }));
    const drawer = await screen.findByRole("dialog");
    expect(within(drawer).getByText("Where it's worked on")).toBeInTheDocument();
    // Token accounting is degraded, not fabricated.
    expect(within(drawer).getByText(/Token and cost accounting is not emitted/)).toBeInTheDocument();
    await userEvent.click(within(drawer).getByRole("button", { name: "Copy resume prompt" }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining("$pr-batch"));
  });

  it("persists a snooze from the job drawer through the annotation API", async () => {
    const annotationBodies: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/settings")) return okJson(settings);
      if (url.startsWith("/api/annotations")) {
        annotationBodies.push(String(init?.body));
        return okJson({ key: "repo/dashboard#46", kind: "snooze", createdAt: model.generatedAt });
      }
      if (url.startsWith("/api/item/")) return okJson(itemTimeline);
      return okJson(model);
    }));
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: /Jobs/ }));
    await userEvent.click(await screen.findByRole("button", { name: /Needs input work/ }));
    const drawer = await screen.findByRole("dialog");
    await userEvent.selectOptions(within(drawer).getByLabelText("Dismiss or snooze"), "snooze-1h");
    await waitFor(() => expect(annotationBodies.some((body) => body.includes("snooze"))).toBe(true));
  });

  it("requests a batch stop from the batch detail drawer", async () => {
    const stopBodies: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/settings")) return okJson(settings);
      if (url.startsWith("/api/batches/stop")) {
        stopBodies.push(String(init?.body));
        return okJson({ path: "batches/batch-alpha.stop.json" });
      }
      return okJson(model);
    }));
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: /Land the telemetry contract with QA\..*Details/ }));
    const drawer = await screen.findByRole("dialog");
    await userEvent.click(within(drawer).getByRole("button", { name: /Request stop/ }));
    await waitFor(() => expect(stopBodies.some((body) => body.includes("batch-alpha"))).toBe(true));
  });

  it("jumps to a work item's detail drawer when a number is searched", async () => {
    render(<App />);
    const search = await screen.findByLabelText("Find PR or issue number");
    await userEvent.type(search, "46{enter}");
    const drawer = await screen.findByRole("dialog");
    expect(within(drawer).getByText("Needs input work")).toBeInTheDocument();
  });

  it("does not discard an explicit repository hint that matches no candidate", async () => {
    render(<App />);
    const search = await screen.findByLabelText("Find PR or issue number");
    await userEvent.type(search, "other 46{enter}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("uses the target type to disambiguate an issue number from an implementation PR number", async () => {
    const collisionModel: DashboardModel = {
      ...model,
      workItems: model.workItems.map((item, index) => index === 0
        ? {
            ...item,
            github: {
              ...item.github!,
              implementationPr: {
                repo: item.repo,
                target: "45",
                title: "Different implementation PR",
                url: "https://github.com/repo/dashboard/pull/45",
                state: "OPEN",
                labels: [],
                loadState: "loaded"
              }
            }
          }
        : item)
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) =>
      String(input).startsWith("/api/settings") ? okJson(settings) : okJson(collisionModel)
    ));
    render(<App />);

    const search = await screen.findByLabelText("Find PR or issue number");
    await userEvent.type(search, "Issue #45{enter}");
    const drawer = await screen.findByRole("dialog", { name: "Issue #45 detail" });
    expect(within(drawer).getByText("Ready dashboard work")).toBeInTheDocument();
  });

  it("requires a repository hint when an exact number is ambiguous", async () => {
    const collisionModel: DashboardModel = {
      ...model,
      targetRepos: ["repo/dashboard", "repo/other"],
      workItems: [
        ...model.workItems,
        {
          ...model.workItems[2],
          id: "repo/other#45",
          repo: "repo/other",
          github: {
            ...model.workItems[2].github!,
            repo: "repo/other",
            title: "Ready other-repository work",
            url: "https://github.com/repo/other/issues/45"
          }
        }
      ]
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) =>
      String(input).startsWith("/api/settings")
        ? okJson({ ...settings, targetRepos: collisionModel.targetRepos })
        : okJson(collisionModel)
    ));
    render(<App />);

    const search = await screen.findByLabelText("Find PR or issue number");
    await userEvent.type(search, "45{enter}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await userEvent.clear(search);
    await userEvent.type(search, "other 45{enter}");
    const drawer = await screen.findByRole("dialog", { name: "Issue #45 detail" });
    expect(within(drawer).getByText("Ready other-repository work")).toBeInTheDocument();
  });

  it("opens the custody timeline for a deep-linked item route", async () => {
    window.history.pushState({}, "", "/?item=repo/dashboard/43");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Work item #43" })).toBeInTheDocument();
  });

  it("selects ready work and builds a usable PR-batch prompt", async () => {
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: /Jobs/ }));
    await userEvent.click(await screen.findByRole("checkbox", { name: /Select Issue #45/ }));
    await userEvent.click(screen.getByText(/PR-batch prompt · 1 selected/));
    expect(screen.getByText(/Use \$pr-batch to complete this batch/)).toBeInTheDocument();
  });

  it("refreshes on demand from the top bar", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/settings")) return okJson(settings);
      return okJson(model);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);
    await screen.findByRole("button", { name: /Batches/ });
    const callsAfterLoad = fetchMock.mock.calls.length;
    await userEvent.click(screen.getByRole("button", { name: "Refresh dashboard" }));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfterLoad));
  });

  it("closes a deep-linked item when its repository leaves saved scope", async () => {
    window.history.pushState({}, "", "/?item=repo/dashboard/43");
    let currentSettings: DashboardRuntimeSettings = settings;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/settings")) return okJson(currentSettings);
      if (url.startsWith("/api/item/")) return okJson(itemTimeline);
      return okJson({ ...model, targetRepos: currentSettings.targetRepos });
    }));
    render(<App />);
    await screen.findByRole("heading", { name: "Work item #43" });
    currentSettings = { targetRepos: ["repo/other"], scopeId: "scope-2" };
    await userEvent.setup().click(screen.getByRole("button", { name: "Refresh dashboard" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Work item #43" })).not.toBeInTheDocument());
  });

  it("retains narrow-layout containment and safety styling in the stylesheet", () => {
    const stylesheet = readFileSync(`${cwd()}/src/client/styles.css`, "utf8");
    expect(stylesheet).toMatch(/@media \(max-width: 980px\)[\s\S]*\.lane-row[\s\S]*grid-template-columns/);
    expect(stylesheet).toMatch(/\.job-title,[\s\S]*overflow-wrap: anywhere/);
    expect(stylesheet).toMatch(/\.host-legend,[\s\S]*overflow-x: auto/);
    const srOnlyRule = stylesheet.match(/\.sr-only\s*\{[^}]+\}/)?.[0] || "";
    expect(srOnlyRule).toContain("clip-path: inset(50%)");
    expect(srOnlyRule).not.toMatch(/\n\s*clip:/);
    expect(stylesheet).toMatch(/:root\s*{[\s\S]*--color-bg:/);
    expect(stylesheet).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*{[\s\S]*animation: none/);
    expect(stylesheet).toMatch(/--color-on-danger-strong:\s*#ffffff/);
    expect(stylesheet).toMatch(/\.coordination-degraded-banner\s*{[\s\S]*color:\s*var\(--color-on-danger-strong\)/);
    expect(stylesheet).toMatch(/\.source-chip-error\s*{[\s\S]*color:\s*var\(--color-danger-text\)/);
    expect(stylesheet).toMatch(/\.loading-skeleton-line\s*{[\s\S]*animation:/);
  });
});
