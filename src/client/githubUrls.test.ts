import { describe, expect, it } from "vitest";
import {
  canonicalGithubItemUrl,
  canonicalPullRequestUrl,
  canonicalPullRequestUrlForTarget,
  githubBranchUrl
} from "./githubUrls";

describe("canonicalGithubItemUrl", () => {
  it.each([
    ["https://github.com/Owner/Repo/issues/47?notification=1#issuecomment-2", "https://github.com/Owner/Repo/issues/47"],
    ["https://github.com/Owner/Repo/pull/57/files?diff=split#file-1", "https://github.com/Owner/Repo/pull/57"],
    ["https://github.com/Owner/Repo/pull/57/checks", "https://github.com/Owner/Repo/pull/57"],
    ["https://github.com/Owner/Repo/pull/57/commits/abc", "https://github.com/Owner/Repo/pull/57"]
  ])("canonicalizes a safe item URL: %s", (input, expected) => {
    expect(canonicalGithubItemUrl(input)).toBe(expected);
  });

  it.each([
    "http://github.com/Owner/Repo/issues/47",
    "https://user@github.com/Owner/Repo/issues/47",
    "https://user:secret@github.com/Owner/Repo/issues/47",
    "https://github.com:443/Owner/Repo/issues/47",
    "https://github.com:0443/Owner/Repo/issues/47",
    "https://github.com:444/Owner/Repo/issues/47",
    "https://example.test/Owner/Repo/issues/47",
    "https://github.com/Owner/Repo/issues/47/files",
    "https://github.com/Owner/Repo/pull/57/untrusted"
  ])("rejects an unsafe or unsupported item URL: %s", (input) => {
    expect(canonicalGithubItemUrl(input)).toBeUndefined();
  });

  it("keeps the PR-only wrapper strict", () => {
    expect(canonicalPullRequestUrl("https://github.com/Owner/Repo/issues/47")).toBeUndefined();
    expect(canonicalPullRequestUrl("https://github.com/pull/Repo/issues/47")).toBeUndefined();
    expect(canonicalPullRequestUrl("https://github.com/Owner/pull/issues/47")).toBeUndefined();
    expect(canonicalPullRequestUrl("https://github.com/pull/pull/pull/47")).toBe("https://github.com/pull/pull/pull/47");
  });

  it("binds canonical PR URLs to their structured repository and target identity", () => {
    expect(
      canonicalPullRequestUrlForTarget(
        "https://github.com/Owner/Repo/pull/57/files?diff=split#file-1",
        "owner/repo",
        "57"
      )
    ).toBe("https://github.com/Owner/Repo/pull/57");
    expect(canonicalPullRequestUrlForTarget("https://github.com/Owner/Other/pull/57", "Owner/Repo", "57")).toBeUndefined();
    expect(canonicalPullRequestUrlForTarget("https://github.com/Owner/Repo/pull/58", "Owner/Repo", "57")).toBeUndefined();
  });
});

describe("githubBranchUrl", () => {
  it("encodes a validated repository branch", () => {
    expect(githubBranchUrl("Owner/Repo", "codex/operator navigation")).toBeUndefined();
    expect(githubBranchUrl("Owner/Repo", "codex/operator-navigation")).toBe(
      "https://github.com/Owner/Repo/tree/codex/operator-navigation"
    );
  });
});
