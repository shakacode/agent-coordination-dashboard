import { describe, expect, it } from "vitest";
import { repoRefsFromStructuredEventField } from "./repoRefs";

describe("repoRefsFromStructuredEventField", () => {
  it("does not derive a spurious com/owner ref from a Repository GitHub URL", () => {
    expect(repoRefsFromStructuredEventField("Repository: https://github.com/other/private")).toEqual(["other/private"]);
  });

  it.each([
    "Repository: https://github.com/other/private?tab=readme",
    "Repository: https://github.com/other/private#readme",
    "Repository: https://github.com/other/private.",
    "Repository: https://github.com/other/private,",
    "Repository: <https://github.com/other/private>",
    "Repository: {https://github.com/other/private}",
    "Repository: https://github.com/other/private.git",
    "Repository: https://github.com/other/private.git.",
    "Repository: http://github.com/other/private",
    "Repository: github.com/other/private",
    "Repository: https://github.com:443/other/private",
    "Repository: http://github.com:80/other/private"
  ])("canonicalizes a Repository GitHub URL: %s", (value) => {
    expect(repoRefsFromStructuredEventField(value)).toEqual(["other/private"]);
  });

  it.each([
    "See https://docs.github.com/en/repositories",
    "See https://gist.github.com/user/abcdef",
    "See https://api.github.com/repos/other/private",
    "See https://notgithub.com/other/private",
    "Repository: https://docs.github.com/en/repositories",
    "Repository: https://notgithub.com/other/private"
  ])("does not extract repository refs from a non-GitHub-repository host: %s", (value) => {
    expect(repoRefsFromStructuredEventField(value)).toEqual([]);
  });

  it.each([
    "See https://example.com/github.com/other/private",
    "See https://example.com/@github.com/other/private",
    "See _github.com/other/private",
    "See égithub.com/other/private",
    "See @github.com/other/private",
    "See javascript:github.com/other/private",
    "See data:github.com/other/private",
    "See vbscript:github.com/other/private",
    "See file:github.com/other/private",
    "See https://github.com:80/other/private",
    "See http://github.com:443/other/private",
    "See abchttps://github.com/other/private",
    "See ftphttps://github.com/other/private",
    "See javascript:https://github.com/other/private",
    "See data:https://github.com/other/private",
    "See vbscript:https://github.com/other/private",
    "See javascript:x:github.com/other/private",
    "See javascript:x:https://github.com/other/private",
    "See data:x:github.com/other/private",
    "See vbscript:x:https://github.com/other/private",
    "See ssh:https://github.com/other/private",
    "See git:github.com/other/private",
    "See git+ssh:https://github.com/other/private",
    "See blob:https://github.com/other/private",
    "See about:github.com/other/private",
    "See custom:https://github.com/other/private",
    "See javascript:blocked:https://github.com/other/private",
    "See javascript:(blocked:https://github.com/other/private)",
    "See javascript:[PR:github.com/other/private]",
    "See data:text/plain,blocked:github.com/other/private",
    "See vbscript:(status:github.com/other/private)",
    "See custom:{repo:https://github.com/other/private}",
    "See ssh:(waiting:github.com/other/private)"
  ])("requires an exact GitHub authority and scheme-specific default port: %s", (value) => {
    expect(repoRefsFromStructuredEventField(value)).toEqual([]);
  });

  it.each([
    "blocked:https://github.com/other/private",
    "PR:https://github.com/other/private",
    "blocked:github.com/other/private",
    "PR:github.com/other/private",
    "status:https://github.com/other/private",
    "phase:github.com/other/private",
    "waiting:https://github.com/other/private"
  ])("detects a canonical GitHub URL after a label colon: %s", (value) => {
    expect(repoRefsFromStructuredEventField(value)).toContain("other/private");
  });

  it("resumes repository detection after a top-level pseudo-URI pipe reset", () => {
    expect(repoRefsFromStructuredEventField("javascript:x|github.com/other/private")).toContain("other/private");
    expect(repoRefsFromStructuredEventField("data:text/plain,ignored|https://github.com/other/private")).toContain("other/private");
  });

  it.each([
    ["ci/passed; see https://example.com/docs|other/private/path", "other/private"],
    ["ci/passed; see https://example.com/docs;other/private/path", "other/private"],
    ["ci/passed; see https://example.com/docs=other/private/path", "other/private"],
    ["ci/passed; see https://example.com/docs,other/private/path", "other/private"],
    ["ci/passed; see https://example.com/docs:other/private/path", "other/private"],
    ["ci/passed; see https://example.com/docs!other/private/path", "other/private"]
  ])("preserves a foreign repository chain after an HTTP URL delimiter: %s", (value, ref) => {
    expect(repoRefsFromStructuredEventField(value)).toContain(ref);
  });

  it("preserves both a canonical GitHub ref and a foreign chain after its delimiter", () => {
    for (const delimiter of ["|", ";", "=", ",", ":", "!"]) {
      expect(repoRefsFromStructuredEventField(`https://github.com/saved/repo${delimiter}other/private/path`)).toEqual(
        expect.arrayContaining(["saved/repo", "other/private"])
      );
    }
  });

  it("parses a delimiter-adjacent canonical GitHub URL after another HTTP URL", () => {
    for (const delimiter of ["|", ";", "=", ",", ":", "!", "?", "#", "&"]) {
      expect(repoRefsFromStructuredEventField(`https://example.com/docs${delimiter}https://github.com/other/private`)).toContain("other/private");
    }
  });

  it("replays closing delimiters after HTTP and schemeless URL paths", () => {
    for (const delimiter of [")", "]", "}", ">", "'", "\"", "`"]) {
      expect(repoRefsFromStructuredEventField(`https://example.com/docs${delimiter}github.com/other/private`)).toContain("other/private");
      expect(repoRefsFromStructuredEventField(`https://example.com/docs${delimiter}https://github.com/other/private`)).toContain("other/private");
      expect(repoRefsFromStructuredEventField(`https://example.com/docs?next=x${delimiter}github.com/other/private`)).toContain("other/private");
      expect(repoRefsFromStructuredEventField(`github.com/saved/repo/issues/1${delimiter}github.com/other/private`)).toEqual(
        expect.arrayContaining(["saved/repo", "other/private"])
      );
      expect(repoRefsFromStructuredEventField(`github.com/saved/repo/issues/1${delimiter}https://github.com/other/private`)).toEqual(
        expect.arrayContaining(["saved/repo", "other/private"])
      );
    }
  });

  it.each([
    "https://user@github.com/other/private",
    "https://user:pass@github.com/other/private",
    "https://user@www.github.com/other/private",
    "https://example.com/docs|https://user@github.com/other/private"
  ])("parses an exact GitHub authority with URL-standard userinfo: %s", (value) => {
    expect(repoRefsFromStructuredEventField(value)).toContain("other/private");
  });

  it("rejects a lookalike GitHub userinfo authority", () => {
    expect(repoRefsFromStructuredEventField("https://github.com@evil.example/other/private")).toEqual([]);
  });

  it("resumes URL scanning after a structural delimiter ends query or fragment state", () => {
    for (const delimiter of ["|", ";", ",", ":", "!"]) {
      expect(repoRefsFromStructuredEventField(`https://example.com/?x=1${delimiter}https://github.com/other/private`)).toContain("other/private");
      expect(repoRefsFromStructuredEventField(`https://example.com/#section${delimiter}https://github.com/other/private`)).toContain("other/private");
    }
  });

  it("does not treat a nested named query URL as a top-level repository ref", () => {
    expect(repoRefsFromStructuredEventField("https://example.com/?x=1&next=https://github.com/other/private")).toEqual([]);
  });

  it.each([
    "https://example.com|other/private/path",
    "https://github.com|other/private/path",
    "https://example.com=other/private/path",
    "https://example.com:other/private/path",
    "https://example.com&other/private/path"
  ])("preserves a foreign chain after a host-only URL: %s", (value) => {
    expect(repoRefsFromStructuredEventField(value)).toContain("other/private");
  });

  it("removes a replayed non-GitHub URL query before generic ref scanning", () => {
    expect(repoRefsFromStructuredEventField("https://example.com/docs|https://example.com/search?q=other/private")).toEqual([]);
  });

  it.each([
    "https://user@@github.com/other/private",
    "https://user:pa@ss@github.com/other/private",
    "https://@github.com/other/private",
    "https://user'name@github.com/other/private",
    "https://user,name@github.com/other/private",
    "https://user)name@github.com/other/private"
  ])("lets URL resolve valid raw or empty userinfo: %s", (value) => {
    expect(repoRefsFromStructuredEventField(value)).toContain("other/private");
  });

  it("preserves a bare foreign chain after query or fragment state resets", () => {
    for (const delimiter of ["|", ";", ",", ":", "!"]) {
      expect(repoRefsFromStructuredEventField(`https://example.com/?x=1${delimiter}other/private/path`)).toContain("other/private");
      expect(repoRefsFromStructuredEventField(`https://example.com/#section${delimiter}other/private/path`)).toContain("other/private");
    }
  });

  it("handles thousands of URL segments without recursion or lost suffix refs", () => {
    const value = `${"https://example.com/x|".repeat(10_000)}other/private/path`;
    expect(repoRefsFromStructuredEventField(value)).toContain("other/private");
  });

  it("does not let an @ in a host-only structural suffix become userinfo", () => {
    for (const delimiter of ["|", ":", "&", "="]) {
      expect(repoRefsFromStructuredEventField(`https://example.com${delimiter}@other/private/path`)).toContain("other/private");
      expect(repoRefsFromStructuredEventField(`https://github.com${delimiter}user@other/private/path`)).toContain("other/private");
    }
  });

  it.each([
    "https://example.com:443|@other/private/path",
    "http://example.com:80|user@other/private/path",
    "http://localhost:4319|@other/private/path",
    "http://127.0.0.1:4319|@other/private/path",
    "http://[::1]|@other/private/path"
  ])("preserves host-only suffixes after ports or IPv6 authorities: %s", (value) => {
    expect(repoRefsFromStructuredEventField(value)).toContain("other/private");
  });

  it.each([
    "https://first.last:pass@github.com/other/private",
    "https://first.last|pass@github.com/other/private",
    "https://user.name,pass@github.com/other/private",
    "https://user-name.example:pass@github.com/other/private"
  ])("retains a canonical ref from hostname-shaped userinfo: %s", (value) => {
    expect(repoRefsFromStructuredEventField(value)).toContain("other/private");
  });

  it("handles a long userinfo authority with forward-only work", () => {
    const value = `https://${"a".repeat(25_000)}@github.com/other/private`;
    expect(repoRefsFromStructuredEventField(value)).toContain("other/private");
  });

  it("does not expose query or fragment refs from a canonical userinfo URL", () => {
    for (const userinfo of ["first.last:pass", "first.last|pass", "user,name", "user'name", "user)name", "user;name", "user=name", "user&name", "user!name"]) {
      expect(repoRefsFromStructuredEventField(`https://${userinfo}@github.com/other/private?next=third/repo`)).toEqual(["other/private"]);
      expect(repoRefsFromStructuredEventField(`https://${userinfo}@github.com/other/private#third/repo`)).toEqual(["other/private"]);
    }
  });

  it("detects a schemeless canonical ref replayed after a structural delimiter", () => {
    for (const delimiter of ["|", ";", "=", ",", ":", "!", "&"]) {
      expect(repoRefsFromStructuredEventField(`https://example.com${delimiter}github.com/other/private`)).toContain("other/private");
      expect(repoRefsFromStructuredEventField(`https://example.com${delimiter}www.github.com/other/private`)).toContain("other/private");
    }
  });

  it.each([
    "Repository: https://first.last:pass@github.com/other/private",
    "Repository: https://first.last|pass@github.com/other/private",
    "Repository: https://user,name@github.com/other/private"
  ])("does not add URL substrings as prompt-header repository refs: %s", (value) => {
    expect(repoRefsFromStructuredEventField(value)).toEqual(["other/private"]);
  });

  it("parses a direct query or fragment URL after a canonical userinfo URL", () => {
    for (const delimiter of ["?", "#"]) {
      expect(repoRefsFromStructuredEventField(`https://first.last:pass@github.com/saved/repo${delimiter}https://github.com/other/private`)).toEqual(
        expect.arrayContaining(["saved/repo", "other/private"])
      );
    }
  });

  it("replays a schemeless canonical ref after a named canonical-userinfo query reset", () => {
    for (const delimiter of ["?", "#"]) {
      expect(repoRefsFromStructuredEventField(`https://first.last:pass@github.com/saved/repo${delimiter}next=x|github.com/other/private`)).toEqual(
        expect.arrayContaining(["saved/repo", "other/private"])
      );
    }
  });

  it("does not expose query or fragment refs from a schemeless canonical URL", () => {
    for (const delimiter of ["?", "#"]) {
      expect(repoRefsFromStructuredEventField(`github.com/other/private${delimiter}next=third/repo`)).toEqual(["other/private"]);
      expect(repoRefsFromStructuredEventField(`https://example.com|github.com/other/private${delimiter}next=third/repo`)).toEqual(["other/private"]);
    }
  });

  it("applies direct-versus-named query semantics to schemeless canonical URLs", () => {
    for (const delimiter of ["?", "#"]) {
      expect(repoRefsFromStructuredEventField(`github.com/saved/repo${delimiter}https://github.com/other/private`)).toEqual(
        expect.arrayContaining(["saved/repo", "other/private"])
      );
      expect(repoRefsFromStructuredEventField(`github.com/saved/repo${delimiter}next=https://github.com/other/private`)).toEqual(["saved/repo"]);
    }
  });

  it("applies direct-versus-named schemeless query semantics inside HTTP URLs", () => {
    for (const delimiter of ["?", "#"]) {
      expect(repoRefsFromStructuredEventField(`https://example.com/${delimiter}github.com/other/private`)).toEqual(["other/private"]);
      expect(repoRefsFromStructuredEventField(`https://example.com/${delimiter}next=github.com/other/private`)).toEqual([]);
    }
  });

  it("scrubs schemeless GitHub subpaths before applying query state", () => {
    expect(repoRefsFromStructuredEventField("github.com/other/private/issues/1?next=third/repo")).toEqual(["other/private"]);
    expect(repoRefsFromStructuredEventField("github.com/other/private/pull/1#third/repo")).toEqual(["other/private"]);
    expect(repoRefsFromStructuredEventField("github.com/saved/repo/issues/1?https://github.com/other/private")).toEqual(
      expect.arrayContaining(["saved/repo", "other/private"])
    );
    expect(repoRefsFromStructuredEventField("github.com/saved/repo/issues/1?next=https://github.com/other/private")).toEqual(["saved/repo"]);
  });

  it.each([
    "https://[user|name@github.com/other/private",
    "https://[user=name@github.com/other/private",
    "https://[user;name@github.com/other/private"
  ])("retains a canonical ref from unmatched-bracket userinfo: %s", (value) => {
    expect(repoRefsFromStructuredEventField(value)).toContain("other/private");
  });

  it.each([
    "https://[::1|github.com/other/private",
    "https://[::1|other/private/path",
    "https://[::1|https://github.com/other/private",
    "https://[[bad;github.com/other/private",
    "https://[bad:github.com/other/private",
    "https://[bad:other/private/path",
    "https://[bad)other/private/path",
    "https://[::1:github.com/other/private",
    "https://[::1:https://github.com/other/private",
    "https://[bad)github.com/other/private",
    "https://[bad)https://github.com/other/private"
  ])("replays structural delimiters after an unmatched authority bracket: %s", (value) => {
    expect(repoRefsFromStructuredEventField(value)).toContain("other/private");
  });

  it.each([
    "https://[bad:@other/private/path",
    "https://[bad:user@other/private/path",
    "https://[user:pass@localhost/private/path",
    "https://[user:pa@ss@localhost/private/path",
    "https://[user|name@localhost/private/path",
    "https://[user=name@localhost/private/path",
    "https://[user;name@localhost/private/path",
    "https://[user,name@localhost/private/path",
    "https://[user!name@localhost/private/path",
    "https://[user&name@localhost/private/path",
    "https://[user)name@localhost/private/path",
    "https://[user}name@localhost/private/path",
    "https://[user>name@localhost/private/path",
    "https://[user]foo|bar@other/private/path",
    "https://[user]|bar@other/private/path",
    "https://x[user]foo|bar@other/private/path",
    "https://[[user]]foo|bar@localhost/private/path"
  ])("does not reinterpret a valid non-GitHub userinfo URL as a repository: %s", (value) => {
    expect(repoRefsFromStructuredEventField(value)).toEqual([]);
  });

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

  it("handles many rejected escaped openers without losing a trailing repository chain", () => {
    const value = `ci/passed; ${String.raw`\"./x/`.repeat(10_000)} other/private/path`;
    expect(repoRefsFromStructuredEventField(value)).toContain("other/private");
  });

  it.each([
    'ci/passed checks; updated "./junk""./Program Files/ci/passed/private"',
    "ci/passed checks; updated './junk''./Program Files/ci/passed/private'",
    "ci/passed checks; updated `./junk``./Program Files/ci/passed/private`"
  ])("handles adjacent quoted paths that share a delimiter boundary: %s", (value) => {
    expect(repoRefsFromStructuredEventField(value)).toEqual([]);
  });

  it.each([
    'updated "/Users/Jane/My Project/src/components"',
    'updated "/Users/Jane/My Project/other/private"',
    'updated "C:/Program Files/src/components"'
  ])("does not reintroduce repository candidates from a scrubbed structured path: %s", (value) => {
    expect(repoRefsFromStructuredEventField(value)).toEqual([]);
  });
});
