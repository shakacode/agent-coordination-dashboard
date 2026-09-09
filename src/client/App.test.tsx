import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { App } from "./App";
import { EMPTY_STATE_LINE, SYSTEM_STATUS_LINK_LABEL } from "./attention/AttentionView";
import { BACK_LABEL, NO_ACTION_LINE } from "./attention/SystemStatus";
import { emptyPayload, unreachablePayload } from "./attention/fixtures";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubAttentionFetch() {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => emptyPayload
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

it("renders the attention view as the landing page", async () => {
  const fetchMock = stubAttentionFetch();

  render(<App />);

  expect(await screen.findByRole("heading", { level: 1, name: "0 actions need Justin" })).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith("/api/attention", expect.objectContaining({ method: "GET" }));
});

it("switches to System Status and back without a route", async () => {
  stubAttentionFetch();

  render(<App />);

  await screen.findByRole("heading", { level: 1, name: "0 actions need Justin" });
  // Both controls open the same view; the empty-state line carries the second.
  const [header, emptyState] = screen.getAllByRole("button", { name: SYSTEM_STATUS_LINK_LABEL });
  expect(emptyState).toBeInTheDocument();

  fireEvent.click(header);

  expect(screen.getByRole("heading", { level: 1, name: "System Status" })).toBeVisible();
  expect(screen.getByRole("main").firstElementChild?.textContent).toEqual(NO_ACTION_LINE);

  fireEvent.click(screen.getByRole("button", { name: BACK_LABEL }));

  expect(screen.getByRole("heading", { level: 1, name: "0 actions need Justin" })).toBeVisible();
  expect(screen.getByRole("main").textContent).toContain(EMPTY_STATE_LINE);
});

it("carries the stale marker across to System Status when the backend dies", async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => emptyPayload
  });
  fetchMock.mockRejectedValue(new Error("attention request failed: network"));
  vi.stubGlobal("fetch", fetchMock);

  render(<App />);

  await screen.findByRole("heading", { level: 1, name: "0 actions need Justin" });
  // A foreground refresh that fails keeps the last good payload and raises the
  // marker; both views must then say the backend is unreachable.
  fireEvent.click(screen.getByRole("button", { name: "Refresh now" }));
  await screen.findByText(/backend unreachable$/);

  fireEvent.click(screen.getAllByRole("button", { name: SYSTEM_STATUS_LINK_LABEL })[0]);

  expect(screen.getByRole("heading", { level: 1, name: "System Status" })).toBeVisible();
  expect(within(screen.getByRole("main")).getByText(/backend unreachable$/)).toBeVisible();
});

it("preserves the outage start time while visiting System Status", async () => {
  const started = new Date(2026, 8, 8, 10, 0).getTime();
  const clock = vi.spyOn(Date, "now").mockReturnValue(started);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true, status: 200, json: async () => unreachablePayload
  }));
  render(<App />);
  const headline = "Backend unreachable since 10:00";
  await screen.findByRole("heading", { level: 1, name: headline });
  fireEvent.click(screen.getByRole("button", { name: SYSTEM_STATUS_LINK_LABEL }));
  expect(screen.queryByRole("heading", { name: headline })).not.toBeInTheDocument();
  clock.mockReturnValue(started + 10 * 60000);
  fireEvent.click(screen.getByRole("button", { name: BACK_LABEL }));
  expect(screen.getByRole("heading", { level: 1, name: headline })).toBeVisible();
  expect(screen.getAllByRole("main")).toHaveLength(1);
});
