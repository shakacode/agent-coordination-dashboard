import { describe, expect, it } from "vitest";
import { parseRepoScopeExclusion } from "./SignalGroups";

describe("parseRepoScopeExclusion", () => {
  it("parses the count and record label from a repo-scope exclusion notice", () => {
    expect(
      parseRepoScopeExclusion({ severity: "info", message: "Skipped 104 claim records outside saved target repositories." })
    ).toEqual({ count: 104, label: "claim records" });
    expect(
      parseRepoScopeExclusion({ severity: "info", message: "Skipped 366 batch history records outside saved target repositories." })
    ).toEqual({ count: 366, label: "batch history records" });
  });

  it("does not claim non-info signals even when the message matches the template", () => {
    expect(
      parseRepoScopeExclusion({ severity: "warning", message: "Skipped 104 claim records outside saved target repositories." })
    ).toBeUndefined();
    expect(
      parseRepoScopeExclusion({ severity: "critical", message: "Skipped 104 claim records outside saved target repositories." })
    ).toBeUndefined();
  });

  it("does not claim messages that merely resemble the scope template", () => {
    expect(
      parseRepoScopeExclusion({ severity: "info", message: "Skipped 104 claim records outside saved target repositories. Check settings." })
    ).toBeUndefined();
    expect(
      parseRepoScopeExclusion({ severity: "info", message: "Agent skipped 3 claim records outside saved target repositories." })
    ).toBeUndefined();
    expect(
      parseRepoScopeExclusion({ severity: "info", message: "Skipped some claim records outside saved target repositories." })
    ).toBeUndefined();
  });
});
