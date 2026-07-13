import { describe, expect, it } from "vitest";
import { canonicalGithubItemUrl, canonicalPullRequestUrl } from "./githubUrls";

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
});
