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
    ["(other/private) blocked", "other/private"],
    ["reviewing other/private.js changes", "other/private.js"],
    ["updated src/client.ts", "src/client.ts"],
    ["updated components/Button.tsx", "components/Button.tsx"],
    ["updated bin/setup.sh", "bin/setup.sh"],
    ["updated fixtures/data.json", "fixtures/data.json"],
    ["updated workspace/private/file.js", "workspace/private"],
    ["reviewing other/private/path", "other/private"],
    ["reviewing ci/passed/private", "ci/passed"],
    ["reviewing read/write/private", "read/write"],
    ["reviewing deploy/qa/private", "deploy/qa"]
  ])("conservatively treats a non-allowlisted embedded slash ref as a repository: %s", (value, ref) => {
    expect(repoRefsFromStructuredEventField(value)).toContain(ref);
  });

  it.each([
    "updated ./other/private.js",
    "updated ../other/private.js",
    "updated /workspace/private/file.js",
    "updated file:///workspace/private/file.js"
  ])("preserves an explicitly local path in structured prose: %s", (value) => {
    expect(repoRefsFromStructuredEventField(value)).toEqual([]);
  });
});
