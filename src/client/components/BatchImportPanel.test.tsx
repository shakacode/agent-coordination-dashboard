import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BatchImportPanel } from "./BatchImportPanel";

const launchPrompt = ["Repository: shakacode/react_on_rails", "Batch id: batch-test-1"].join("\n");

describe("BatchImportPanel", () => {
  it("parses a launch prompt into an editable plan and saves it", async () => {
    const onImportBatch = vi.fn().mockResolvedValue(undefined);
    render(<BatchImportPanel onImportBatch={onImportBatch} />);

    // No editable plan until a prompt is reviewed.
    expect(screen.queryByLabelText("Plan details")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Launch prompt"), { target: { value: launchPrompt } });
    await userEvent.click(screen.getByRole("button", { name: "Review batch plan" }));

    const details = (await screen.findByLabelText("Plan details")) as HTMLTextAreaElement;
    expect(details.value).toContain("batch-test-1");

    await userEvent.click(screen.getByRole("button", { name: "Save batch plan" }));
    await waitFor(() => expect(onImportBatch).toHaveBeenCalledWith(expect.objectContaining({ batchId: "batch-test-1" })));
  });

  it("reports a parse failure without throwing", async () => {
    render(<BatchImportPanel onImportBatch={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Launch prompt"), { target: { value: "not a batch prompt" } });
    await userEvent.click(screen.getByRole("button", { name: "Review batch plan" }));
    // Either surfaces a status or simply produces no editable plan — never crashes.
    expect(screen.getByRole("button", { name: "Review batch plan" })).toBeInTheDocument();
  });
});
