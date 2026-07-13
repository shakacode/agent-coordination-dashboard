import { describe, expect, it } from "vitest";
import { fallbackTimelineWorkItem } from "./fallbackWorkItem";

describe("fallbackTimelineWorkItem", () => {
  it("builds one neutral timeline action item contract", () => {
    expect(fallbackTimelineWorkItem("repo/dashboard", "47")).toEqual({
      id: "repo/dashboard#47",
      repo: "repo/dashboard",
      target: "47",
      type: "unknown",
      schedulingState: "started_not_processing",
      provenance: { classification: "unknown", evidence: [] },
      warnings: [],
      selected: false
    });
  });
});
