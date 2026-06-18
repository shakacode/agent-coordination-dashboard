import { describe, expect, it } from "vitest";
import { loadOpenGitHubItems, parseIssueList, parsePrList } from "./githubClient";

describe("github list parsers", () => {
  it("normalizes open PRs", () => {
    const previews = parsePrList(
      "shakacode/react_on_rails",
      JSON.stringify([
        {
          number: 4005,
          title: "Fix FOUC",
          url: "https://github.com/shakacode/react_on_rails/pull/4005",
          state: "OPEN",
          author: { login: "justin" },
          labels: [{ name: "ci" }],
          headRefName: "jg-codex/fouc",
          reviewDecision: "CHANGES_REQUESTED"
        }
      ])
    );

    expect(previews[0]).toMatchObject({
      repo: "shakacode/react_on_rails",
      target: "4005",
      type: "pull_request",
      title: "Fix FOUC",
      branch: "jg-codex/fouc",
      reviewDecision: "CHANGES_REQUESTED"
    });
  });

  it("normalizes open issues", () => {
    const previews = parseIssueList(
      "shakacode/react_on_rails",
      JSON.stringify([
        {
          number: 4010,
          title: "Investigate hydration",
          url: "https://github.com/shakacode/react_on_rails/issues/4010",
          state: "OPEN",
          author: { login: "maintainer" },
          labels: [{ name: "bug" }]
        }
      ])
    );

    expect(previews[0]).toMatchObject({
      repo: "shakacode/react_on_rails",
      target: "4010",
      type: "issue",
      labels: ["bug"]
    });
  });

  it("requests an explicit high limit for GitHub lists", async () => {
    const calls: string[][] = [];
    const result = await loadOpenGitHubItems("shakacode/react_on_rails", {
      run: async (args) => {
        calls.push(args);
        return { stdout: "[]", stderr: "", exitCode: 0 };
      }
    });

    expect(result.items).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(calls).toHaveLength(2);
    expect(calls.every((args) => args.includes("--limit"))).toBe(true);
    expect(calls.every((args) => args[args.indexOf("--limit") + 1] === "1000")).toBe(true);
  });

  it("surfaces GitHub command failures as warnings", async () => {
    const result = await loadOpenGitHubItems("shakacode/react_on_rails", {
      run: async () => ({ stdout: "", stderr: "auth required", exitCode: 1 })
    });

    expect(result.items).toEqual([]);
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings[0].message).toContain("auth required");
  });
});
