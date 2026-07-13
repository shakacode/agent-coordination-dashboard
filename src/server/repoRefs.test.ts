import { describe, expect, it } from "vitest";
import { repoRefsFromStructuredEventField } from "./repoRefs";

describe("repoRefsFromStructuredEventField", () => {
  it.each([
    ["repo read/write", "read/write"],
    ["Repository: frontend/backend", "frontend/backend"],
    ["blocked on ci/passed", "ci/passed"],
    ["ci/passed", "ci/passed"],
    ["Repository: other/private.js", "other/private.js"],
    ["other/private.js#12", "other/private.js"],
    ["blocked on repo other/private.js review", "other/private.js"]
  ])("lets high-confidence or explicit repository context win for %s", (value, ref) => {
    expect(repoRefsFromStructuredEventField(value)).toContain(ref);
  });

  it.each([
    "read/write checks",
    "frontend/backend review",
    "ci/queued checks",
    "ci/skipped checks",
    "ci/cancelled checks",
    "ci/canceled checks",
    "deploy/qa validation",
    "deploy/prod release",
    "deploy/canary rollout"
  ])("preserves known operational slash vocabulary in plain phrases: %s", (value) => {
    expect(repoRefsFromStructuredEventField(value)).toEqual([]);
  });

  it.each([
    ["reviewing other/private changes", "other/private"],
    ["(other/private) blocked", "other/private"]
  ])("conservatively treats a non-allowlisted embedded slash ref as a repository: %s", (value, ref) => {
    expect(repoRefsFromStructuredEventField(value)).toContain(ref);
  });
});
