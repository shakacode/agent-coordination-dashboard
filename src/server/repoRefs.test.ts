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

  it.each([
    "ci/passed checks; updated ./ci/passed/private",
    "read/write checks; updated ../read/write/private",
    "deploy/qa checks; updated /deploy/qa/private",
    "ci/passed checks; updated file:///ci/passed/private",
    "ci/passed checks; updated [./ci/passed/private]",
    "ci/passed checks; updated {./ci/passed/private}",
    "ci/passed checks; updated `./ci/passed/private`",
    "ci/passed checks; updated \"./ci/passed/private\"",
    "ci/passed checks; updated './ci/passed/private'",
    "ci/passed checks; updated C:/ci/passed/private",
    "ci/passed checks; updated D:/ci/passed/private",
    "ci/passed checks; updated file://localhost/ci/passed/private",
    "ci/passed checks; updated file:/ci/passed/private",
    "ci/passed checks; updated \"C:/Program Files/ci/passed/private\"",
    "ci/passed checks; updated '/Users/Justin Gordon/ci/passed/private'",
    "ci/passed checks; updated `/Users/ジャスティン/ci/passed/private`",
    "ci/passed checks; updated /Users/ジャスティン/ci/passed/private",
    "ci/passed checks; updated /Users/JoséFolder/ci/passed/private",
    "ci/passed checks; updated /Users/Team🚀Folder/ci/passed/private",
    "ci/passed checks; updated /Users/Team👍🏽Folder/ci/passed/private",
    "ci/passed checks; updated /Users/Team👩‍💻Folder/ci/passed/private",
    "ci/passed checks; updated \"/Users/Team–Folder/ci/passed/private\"",
    "ci/passed checks ./ci/passed/private",
    "ci/passed checks ./ci/passed/private",
    "ci/passed checks; updated \"C:/release/\\\"candidate/ci/passed/private\""
  ])("ignores explicit local paths when applying operational vocabulary: %s", (value) => {
    expect(repoRefsFromStructuredEventField(value)).toEqual([]);
  });

  it.each([
    ["ci/passed; updated ./x/y; deploy/qa/private", "deploy/qa"],
    ["ci/passed, updated ./x/y, other/private/path", "other/private"],
    ["ci/passed: updated ./x/y: other/private/path", "other/private"],
    ["ci/passed|updated ./x/y|other/private/path", "other/private"],
    ["ci/passed!updated ./x/y!other/private/path", "other/private"],
    ["ci/passed?updated ./x/y?other/private/path", "other/private"],
    ["ci/passed=updated ./x/y=other/private/path", "other/private"],
    ["ci/passed; updated ./x/y other/private/path", "other/private"],
    ["ci/passed; updated ./x/y other/private/path", "other/private"],
    ["ci/passed; updated ./x/y—other/private/path", "other/private"],
    ["ci/passed checks; fetched https://ci/passed/private", "ci/passed"]
  ])("does not let explicit paths consume punctuation-adjacent repository chains: %s", (value, ref) => {
    expect(repoRefsFromStructuredEventField(value)).toContain(ref);
  });

  it.each(["\u2028", "\u2029", "\u0085", "\u0000", "\t", "\u200B"])(
    "does not let quoted paths consume a repository chain across control boundary U+%s",
    (boundary) => {
      expect(repoRefsFromStructuredEventField(`ci/passed; updated "./x/y${boundary}other/private/path"`)).toContain("other/private");
    }
  );

  it.each(["\u0085", "\u0000", "\t", "\u200B"])(
    "does not let an escaped control boundary remain inside a quoted path: U+%s",
    (boundary) => {
      expect(repoRefsFromStructuredEventField(`ci/passed; updated "./x/y\\${boundary}other/private/path"`)).toContain("other/private");
    }
  );

  it.each([
    'ci/passed; updated ./safe"./x/y"other/private/path',
    "ci/passed; updated ./safe'./x/y'other/private/path",
    "ci/passed; updated ./safe`./x/y`other/private/path"
  ])("preserves token boundaries around a removed quoted path: %s", (value) => {
    expect(repoRefsFromStructuredEventField(value)).toContain("other/private");
  });

  it.each([
    String.raw`ci/passed; updated \"./x/y other/private/path"`,
    String.raw`ci/passed; updated \'./x/y other/private/path'`,
    "ci/passed; updated \\`./x/y other/private/path`"
  ])("does not treat an odd-backslash quote as a path opener: %s", (value) => {
    expect(repoRefsFromStructuredEventField(value)).toContain("other/private");
  });

  it.each([
    String.raw`ci/passed; updated \\"./x/y ci/passed/private"`,
    String.raw`ci/passed; updated \\'./x/y ci/passed/private'`,
    "ci/passed; updated \\\\`./x/y ci/passed/private`"
  ])("treats an even-backslash quote as a path opener: %s", (value) => {
    expect(repoRefsFromStructuredEventField(value)).toEqual([]);
  });

  it.each([
    String.raw`ci/passed checks; updated \"./junk"./Program Files/ci/passed/private"`,
    String.raw`ci/passed checks; updated \'./junk'./Program Files/ci/passed/private'`,
    "ci/passed checks; updated \\`./junk`./Program Files/ci/passed/private`"
  ])("reconsiders the next quote after rejecting an escaped opener: %s", (value) => {
    expect(repoRefsFromStructuredEventField(value)).toEqual([]);
  });
});
