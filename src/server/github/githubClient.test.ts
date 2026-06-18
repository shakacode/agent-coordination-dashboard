import { describe, expect, it } from "vitest";
import { parseIssueList, parsePrList } from "./githubClient";

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
});

