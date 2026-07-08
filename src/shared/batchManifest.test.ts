import { describe, expect, it } from "vitest";
import { normalizeBatchManifestDraft, normalizeBatchManifestForWrite, parsePrBatchLaunchPrompt } from "./batchManifest";

const launchPrompt = [
  "Use $pr-batch to complete this batch with subagents.",
  "",
  "Repository: shakacode/react_on_rails",
  "Batch id: batch-react-on-rails-4005-4010",
  "Batch objective: Stabilize the selected React on Rails work.",
  "",
  "Items:",
  "- PR #4005: https://github.com/shakacode/react_on_rails/pull/4005",
  "  Context: Fix FOUC integration tests",
  "- Issue #4010: https://github.com/shakacode/react_on_rails/issues/4010",
  "  Context: Document flaky installer behavior",
  "",
  "Suggested lanes:",
  "- tests (owner: worker-a): PR #4005",
  "- docs (owner: worker-b): Issue #4010",
  "",
  "Reservations:",
  "- Deferred PR #3999 for release owner review."
].join("\n");

describe("batch manifest helpers", () => {
  it("parses pr-batch launch prompt metadata into an editable manifest draft", () => {
    const parsed = parsePrBatchLaunchPrompt(launchPrompt, {
      now: new Date("2026-06-20T10:00:00Z"),
      machineId: "macbook-a"
    });

    expect(parsed).toMatchObject({
      batchId: "batch-react-on-rails-4005-4010",
      repo: "shakacode/react_on_rails",
      objective: "Stabilize the selected React on Rails work.",
      createdAt: "2026-06-20T10:00:00.000Z",
      createdByMachine: "macbook-a",
      launchPrompt
    });
    expect(parsed.targets).toEqual([
      {
        type: "pull_request",
        target: "4005",
        url: "https://github.com/shakacode/react_on_rails/pull/4005",
        title: "Fix FOUC integration tests"
      },
      {
        type: "issue",
        target: "4010",
        url: "https://github.com/shakacode/react_on_rails/issues/4010",
        title: "Document flaky installer behavior"
      }
    ]);
    expect(parsed.lanes).toEqual([
      {
        name: "tests",
        owner: "worker-a",
        targets: ["4005"],
        dependsOn: [],
        status: "queued",
        liveness: "no-heartbeat",
        blockedOn: []
      },
      {
        name: "docs",
        owner: "worker-b",
        targets: ["4010"],
        dependsOn: [],
        status: "queued",
        liveness: "no-heartbeat",
        blockedOn: []
      }
    ]);
    expect(parsed.reservations).toEqual([
      {
        type: "pull_request",
        target: "3999",
        reason: "Deferred PR #3999 for release owner review."
      }
    ]);
  });

  it("normalizes documented snake_case retained manifest JSON for import", () => {
    const normalized = normalizeBatchManifestDraft({
      batch_id: "batch-snake",
      repo: "shakacode/react_on_rails",
      objective: "Import existing retained manifest.",
      targets: [{ type: "pull_request", target: "4005" }],
      lanes: [
        {
          name: "tests",
          owner: "worker-a",
          targets: ["4005"],
          depends_on: ["prep"],
          status: "queued"
        }
      ],
      reservations: [],
      created_at: "2026-06-20T10:00:00.000Z",
      created_by_machine: "macbook-a",
      launch_prompt: launchPrompt
    });

    expect(normalized).toEqual(
      expect.objectContaining({
        batchId: "batch-snake",
        createdAt: "2026-06-20T10:00:00.000Z",
        createdByMachine: "macbook-a",
        launchPrompt
      })
    );
    expect(normalized.lanes[0]).toEqual(expect.objectContaining({ dependsOn: ["prep"] }));
  });

  it("normalizes imported manifests to the retained snake_case JSON shape", () => {
    const manifest = normalizeBatchManifestForWrite({
      batchId: "batch-react-on-rails-4005-4010",
      repo: "shakacode/react_on_rails",
      objective: "Stabilize the selected React on Rails work.",
      targets: [{ type: "pull_request", target: "4005" }],
      lanes: [
        {
          name: "tests",
          owner: "worker-a",
          targets: ["4005"],
          dependsOn: [],
          status: "queued",
          liveness: "no-heartbeat",
          blockedOn: []
        }
      ],
      reservations: [{ type: "issue", target: "4010", reason: "Blocked on upstream feedback." }],
      createdAt: "2026-06-20T10:00:00.000Z",
      createdByMachine: "macbook-a",
      launchPrompt: "Use $pr-batch..."
    });

    expect(manifest).toEqual({
      schema_version: 1,
      batch_id: "batch-react-on-rails-4005-4010",
      repo: "shakacode/react_on_rails",
      objective: "Stabilize the selected React on Rails work.",
      targets: [{ type: "pull_request", target: "4005" }],
      lanes: [
        {
          name: "tests",
          owner: "worker-a",
          targets: ["4005"],
          depends_on: [],
          status: "queued"
        }
      ],
      reservations: [{ type: "issue", target: "4010", reason: "Blocked on upstream feedback." }],
      created_at: "2026-06-20T10:00:00.000Z",
      created_by_machine: "macbook-a",
      launch_prompt: "Use $pr-batch..."
    });
  });

  it("keeps multi-repo prompts repo-less with per-target repositories", () => {
    const parsed = parsePrBatchLaunchPrompt(
      [
        "Use $pr-batch to complete this batch with subagents.",
        "Repository: repo-a/app, repo-b/api",
        "Batch id: multi-repo-batch",
        "Batch objective: Process two repos.",
        "Items:",
        "- PR #12: https://github.com/repo-a/app/pull/12",
        "- Issue #34: https://github.com/repo-b/api/issues/34"
      ].join("\n")
    );

    expect(parsed.repo).toBeUndefined();
    expect(parsed.targets).toEqual([
      {
        type: "pull_request",
        target: "12",
        repo: "repo-a/app",
        url: "https://github.com/repo-a/app/pull/12"
      },
      {
        type: "issue",
        target: "34",
        repo: "repo-b/api",
        url: "https://github.com/repo-b/api/issues/34"
      }
    ]);
  });

  it("rejects same-number targets from different repos in multi-repo prompts", () => {
    expect(() =>
      parsePrBatchLaunchPrompt([
        "Use $pr-batch to complete this batch with subagents.",
        "Repository: repo-a/app, repo-b/api",
        "Batch id: multi-repo-same-number",
        "Items:",
        "- PR #12: https://github.com/repo-a/app/pull/12",
        "- Issue #12: https://github.com/repo-b/api/issues/12"
      ].join("\n"))
    ).toThrow("duplicate PR/issue number");
  });

  it("rejects item lines whose text reference does not match the GitHub URL", () => {
    expect(() =>
      parsePrBatchLaunchPrompt([
        "Use $pr-batch to complete this batch with subagents.",
        "Repository: shakacode/react_on_rails",
        "Batch id: mismatched-target",
        "Items:",
        "- PR #4005: https://github.com/shakacode/react_on_rails/pull/4010"
      ].join("\n"))
    ).toThrow("does not match GitHub URL");

    expect(() =>
      parsePrBatchLaunchPrompt([
        "Use $pr-batch to complete this batch with subagents.",
        "Repository: shakacode/react_on_rails",
        "Batch id: mismatched-kind",
        "Items:",
        "- Issue #4005: https://github.com/shakacode/react_on_rails/pull/4005"
      ].join("\n"))
    ).toThrow("does not match GitHub URL");
  });

  it("parses generated unknown target labels", () => {
    const parsed = parsePrBatchLaunchPrompt(
      [
        "Use $pr-batch to complete this batch with subagents.",
        "Repository: shakacode/react_on_rails",
        "Batch id: unknown-target-batch",
        "Items:",
        "- Target #777: UNKNOWN URL",
        "  Context: UNKNOWN title"
      ].join("\n")
    );

    expect(parsed.targets).toEqual([
      {
        type: "unknown",
        target: "777",
        title: "UNKNOWN title"
      }
    ]);
    expect(parsed.lanes[0]).toMatchObject({
      name: "lane-777",
      targets: ["777"]
    });
  });

  it("does not parse generated item detail lines as extra targets", () => {
    const parsed = parsePrBatchLaunchPrompt(
      [
        "Use $pr-batch to complete this batch with subagents.",
        "Repository: shakacode/react_on_rails",
        "Batch id: detail-lines-batch",
        "Items:",
        "- PR #4005: https://github.com/shakacode/react_on_rails/pull/4005",
        "  Goal: Process PR #4005 using the repository workflow.",
        "  Context: Fixes issue #123 in related docs"
      ].join("\n")
    );

    expect(parsed.targets).toEqual([
      {
        type: "pull_request",
        target: "4005",
        url: "https://github.com/shakacode/react_on_rails/pull/4005",
        title: "Fixes issue #123 in related docs"
      }
    ]);
  });
});
