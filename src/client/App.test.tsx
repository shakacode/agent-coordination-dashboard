import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { App } from "./App";

it("renders the placeholder until the attention view lands", () => {
  render(<App />);

  expect(screen.getByText("Attention view arrives in PR 1a")).toBeInTheDocument();
});
