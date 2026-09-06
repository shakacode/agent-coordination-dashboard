import { render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { App } from "./App";
import { emptyPayload } from "./attention/fixtures";

afterEach(() => {
  vi.unstubAllGlobals();
});

it("renders the attention view as the only page", async () => {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => emptyPayload
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<App />);

  expect(await screen.findByRole("heading", { level: 1, name: "0 actions need Justin" })).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith("/api/attention", expect.objectContaining({ method: "GET" }));
});
