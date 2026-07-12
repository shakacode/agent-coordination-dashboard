import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
  });
});
