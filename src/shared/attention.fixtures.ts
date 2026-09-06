/**
 * Attention fixtures shared by the shared-module tests and by the model tests
 * that consume them (shakacode/agent-coordination-dashboard#127).
 *
 * The two records seeded from upstream are
 * `schema/state/v1/attention/fixtures/valid/attention-open.json` and
 * `attention-resolved.json` in shakacode/agent-coordination at commit
 * 52d391ff8f5686d66ca9bd865543907d8faee195. The live Worker does not serve the
 * attention prefix yet, so these vendored shapes are the only contract fixtures.
 */

import { ATTENTION_TEXT_LIMIT, type AttentionRecord, type AttentionSource } from "./attention";

export const attentionRepository = "shakacode/agent-coordination";
export const attentionTaskId = "01a06677-7565-7530-b322-d1429fc9415b";

export const codexSource: AttentionSource = {
  provider: "codex",
  host_id: "m1",
  task_id: attentionTaskId,
  open_uri: `codex://threads/${attentionTaskId}`,
  last_seen_at: "2026-09-03T09:20:00Z",
  capabilities: {
    native_open: "available",
    prompt_forwarding: "unknown"
  }
};

/** Upstream `attention-open.json`. */
export const openAttentionRecord: AttentionRecord = {
  schema_version: 1,
  workspace: "default",
  id: "agent-coordination-pr284-github-api-coverage",
  repository: attentionRepository,
  target: "https://github.com/shakacode/agent-coordination/pull/284",
  status: "open",
  kind: "security",
  question: "May this exact head proceed despite unmappable repair authors?",
  choices: ["Acknowledge the exact head and risk", "Rebuild with attributable commits"],
  priority_class: "current-head-merge",
  priority_reason: "The exact head is otherwise merge-ready",
  safe_resume: "Refresh the exact head and continue the security gate",
  source: codexSource,
  source_generation: 5,
  created_at: "2026-09-03T09:00:00Z",
  refreshed_at: "2026-09-03T09:20:00Z"
};

/** Upstream `attention-resolved.json`. */
export const resolvedAttentionRecord: AttentionRecord = {
  ...openAttentionRecord,
  status: "resolved",
  source: {
    provider: "codex",
    host_id: "m1",
    task_id: attentionTaskId,
    last_seen_at: "2026-09-03T09:30:00Z",
    capabilities: {
      native_open: "unknown",
      prompt_forwarding: "unavailable"
    }
  },
  source_generation: 6,
  refreshed_at: "2026-09-03T09:30:00Z",
  resolved_at: "2026-09-03T09:30:00Z"
};

/** The same record carrying every optional v1.1 card field. */
export const deskContractAttentionRecord: AttentionRecord = {
  ...openAttentionRecord,
  id: "agent-coordination-pr284-desk-card",
  what_changes: "The security gate accepts the exact head with unmappable repair authors.",
  risk_downside: "An unattributable commit stays in the merged history.",
  recommendation: "Acknowledge the exact head and record the attribution gap.",
  one_action: "Reply `acknowledge` on the pull request.",
  unlocks: "Two merge-ready pull requests behind this gate",
  unlocks_count: 2,
  walkthrough_mode: "requested",
  walkthrough_url: "https://github.com/shakacode/agent-coordination/pull/284#pullrequestreview-2481103311",
  hil_task_title: "Security gate for the exact head",
  refresh_interval_seconds: 120
};

export function makeAttentionRecord(overrides: Partial<AttentionRecord> = {}): AttentionRecord {
  return { ...openAttentionRecord, ...overrides };
}

/** Fields a producer may emit that no card may ever read. */
export const unknownAttentionFields = {
  prompt: "Full agent prompt that must never reach a card",
  transcript: ["turn one", "turn two"],
  decision_channel: "github_comment"
};

export const attentionRecordWithUnknownFields = {
  ...openAttentionRecord,
  ...unknownAttentionFields
} as unknown as AttentionRecord;

/** Longer than the 4,000-character text bound, so rendering must cap it. */
export const oversizedRenderText = "x".repeat(ATTENTION_TEXT_LIMIT + 200);

export interface AttentionUrlCase {
  label: string;
  repository: string;
  url: string;
}

export const acceptedTargetUrls: AttentionUrlCase[] = [
  {
    label: "the record's own pull request",
    repository: attentionRepository,
    url: "https://github.com/shakacode/agent-coordination/pull/284"
  },
  {
    label: "a repository spelled with different case",
    repository: "ShakaCode/Agent-Coordination",
    url: "https://github.com/shakacode/agent-coordination/pull/284"
  },
  {
    label: "a repository name with an underscore",
    repository: "shakacode/react_on_rails",
    url: "https://github.com/shakacode/react_on_rails/pull/1"
  },
  {
    label: "a repository name with a dot",
    repository: "shakacode/shakacode.com",
    url: "https://github.com/shakacode/shakacode.com/pull/1204"
  }
];

/** Rejected by `validateAttentionTarget` and by `validateWalkthroughUrl`. */
export const commonRejectedUrls: AttentionUrlCase[] = [
  { label: "plain http", repository: attentionRepository, url: "http://github.com/shakacode/agent-coordination/pull/284" },
  { label: "another host", repository: attentionRepository, url: "https://gitlab.com/shakacode/agent-coordination/pull/284" },
  {
    label: "a host that only starts with github.com",
    repository: attentionRepository,
    url: "https://github.com.evil.test/shakacode/agent-coordination/pull/284"
  },
  {
    label: "userinfo pointing at another host",
    repository: attentionRepository,
    url: "https://github.com@evil.test/shakacode/agent-coordination/pull/284"
  },
  {
    label: "an explicit port",
    repository: attentionRepository,
    url: "https://github.com:8443/shakacode/agent-coordination/pull/284"
  },
  { label: "a protocol-relative URL", repository: attentionRepository, url: "//github.com/shakacode/agent-coordination/pull/284" },
  { label: "a javascript URL", repository: attentionRepository, url: "javascript:alert(1)" },
  { label: "another repository", repository: attentionRepository, url: "https://github.com/evil/agent-coordination/pull/284" },
  { label: "another repository name", repository: attentionRepository, url: "https://github.com/shakacode/agent-workflows/pull/284" },
  { label: "an issue URL", repository: attentionRepository, url: "https://github.com/shakacode/agent-coordination/issues/284" },
  {
    label: "a query string",
    repository: attentionRepository,
    url: "https://github.com/shakacode/agent-coordination/pull/284?diff=split"
  },
  {
    label: "a comment fragment",
    repository: attentionRepository,
    url: "https://github.com/shakacode/agent-coordination/pull/284#issuecomment-1"
  },
  { label: "a non-numeric pull number", repository: attentionRepository, url: "https://github.com/shakacode/agent-coordination/pull/abc" },
  { label: "a missing pull number", repository: attentionRepository, url: "https://github.com/shakacode/agent-coordination/pull/" },
  { label: "pull number zero", repository: attentionRepository, url: "https://github.com/shakacode/agent-coordination/pull/0" },
  { label: "a zero-padded pull number", repository: attentionRepository, url: "https://github.com/shakacode/agent-coordination/pull/0284" },
  { label: "a trailing slash", repository: attentionRepository, url: "https://github.com/shakacode/agent-coordination/pull/284/" },
  { label: "an empty owner segment", repository: attentionRepository, url: "https://github.com//agent-coordination/pull/284" },
  {
    label: "a percent-encoded owner",
    repository: attentionRepository,
    url: "https://github.com/%73hakacode/agent-coordination/pull/284"
  },
  {
    label: "surrounding whitespace",
    repository: attentionRepository,
    url: " https://github.com/shakacode/agent-coordination/pull/284 "
  },
  {
    label: "a second URL after a newline",
    repository: attentionRepository,
    url: "https://github.com/shakacode/agent-coordination/pull/284\nhttps://evil.test"
  },
  {
    label: "an uppercase scheme",
    repository: attentionRepository,
    url: "HTTPS://github.com/shakacode/agent-coordination/pull/284"
  },
  { label: "an empty URL", repository: attentionRepository, url: "" },
  {
    label: "a repository the record cannot own",
    repository: "shakacode",
    url: "https://github.com/shakacode/agent-coordination/pull/284"
  },
  {
    label: "a repository with a parent-directory segment",
    repository: "../agent-coordination",
    url: "https://github.com/../agent-coordination/pull/284"
  }
];

/** Accepted by `validateWalkthroughUrl` only. */
export const walkthroughOnlyUrls: AttentionUrlCase[] = [
  {
    label: "the files tab",
    repository: attentionRepository,
    url: "https://github.com/shakacode/agent-coordination/pull/284/files"
  },
  {
    label: "a published review anchor",
    repository: attentionRepository,
    url: "https://github.com/shakacode/agent-coordination/pull/284#pullrequestreview-2481103311"
  }
];

export const rejectedTargetUrls: AttentionUrlCase[] = [...commonRejectedUrls, ...walkthroughOnlyUrls];

export const acceptedWalkthroughUrls: AttentionUrlCase[] = [...acceptedTargetUrls, ...walkthroughOnlyUrls];

export const rejectedWalkthroughUrls: AttentionUrlCase[] = [
  ...commonRejectedUrls,
  {
    label: "a review anchor with no digits",
    repository: attentionRepository,
    url: "https://github.com/shakacode/agent-coordination/pull/284#pullrequestreview-"
  },
  {
    label: "a non-numeric review anchor",
    repository: attentionRepository,
    url: "https://github.com/shakacode/agent-coordination/pull/284#pullrequestreview-abc"
  },
  {
    label: "a discussion anchor",
    repository: attentionRepository,
    url: "https://github.com/shakacode/agent-coordination/pull/284#discussion_r1"
  },
  {
    label: "the files tab with a trailing slash",
    repository: attentionRepository,
    url: "https://github.com/shakacode/agent-coordination/pull/284/files/"
  },
  {
    label: "the files tab with a query string",
    repository: attentionRepository,
    url: "https://github.com/shakacode/agent-coordination/pull/284/files?w=1"
  },
  {
    label: "the commits tab",
    repository: attentionRepository,
    url: "https://github.com/shakacode/agent-coordination/pull/284/commits"
  },
  {
    label: "the files tab plus a review anchor",
    repository: attentionRepository,
    url: "https://github.com/shakacode/agent-coordination/pull/284/files#pullrequestreview-2481103311"
  }
];

export interface AttentionOpenUriCase {
  label: string;
  source: AttentionSource | null | undefined;
  expected: string | null;
}

export const openUriCases: AttentionOpenUriCase[] = [
  {
    label: "a codex source whose open_uri matches its task id",
    source: codexSource,
    expected: `codex://threads/${attentionTaskId}`
  },
  {
    label: "a codex source with no open_uri",
    source: resolvedAttentionRecord.source,
    expected: null
  },
  {
    label: "a codex source pointing at another task id",
    source: { ...codexSource, open_uri: "codex://threads/00000000-0000-0000-0000-000000000000" },
    expected: null
  },
  {
    label: "a codex thread URI with a query string",
    source: { ...codexSource, open_uri: `codex://threads/${attentionTaskId}?resume=1` },
    expected: null
  },
  {
    label: "a codex thread URI with a trailing slash",
    source: { ...codexSource, open_uri: `codex://threads/${attentionTaskId}/` },
    expected: null
  },
  {
    label: "a codex source with an https open_uri",
    source: { ...codexSource, open_uri: "https://chatgpt.com/codex/threads/abc" },
    expected: null
  },
  {
    label: "another provider carrying a codex thread URI",
    source: { ...codexSource, provider: "claude" },
    expected: null
  },
  {
    label: "a provider spelled with different case",
    source: { ...codexSource, provider: "Codex" },
    expected: null
  },
  {
    label: "a task id with path traversal",
    source: {
      ...codexSource,
      task_id: "../../escape",
      open_uri: "codex://threads/../../escape"
    },
    expected: null
  },
  {
    label: "a task id with whitespace",
    source: { ...codexSource, task_id: "task one", open_uri: "codex://threads/task one" },
    expected: null
  },
  { label: "a missing source", source: undefined, expected: null },
  { label: "a null source", source: null, expected: null }
];

export interface AttentionRankingFixture {
  label: string;
  records: AttentionRecord[];
  expectedIds: string[];
}

/** Any record carrying `unlocks_count` switches ranking to the desk order. */
export const unlocksCountRankingFixture: AttentionRankingFixture = {
  label: "descending unlocks_count, then created_at, then id",
  records: [
    makeAttentionRecord({
      id: "b-count-3",
      priority_class: "unblocks-work",
      unlocks_count: 3,
      created_at: "2026-09-03T09:00:00Z"
    }),
    makeAttentionRecord({
      id: "a-urgent",
      priority_class: "urgent-risk",
      unlocks_count: 0,
      created_at: "2026-09-03T10:00:00Z"
    }),
    makeAttentionRecord({
      id: "d-no-count",
      priority_class: "product-architecture",
      created_at: "2026-09-03T08:00:00Z"
    }),
    makeAttentionRecord({
      id: "c-count-9",
      priority_class: "product-architecture",
      unlocks_count: 9,
      created_at: "2026-09-03T11:00:00Z"
    }),
    makeAttentionRecord({
      id: "e-count-3-earlier",
      priority_class: "current-head-merge",
      unlocks_count: 3,
      created_at: "2026-09-03T08:30:00Z"
    }),
    makeAttentionRecord({
      id: "f-count-0-tie",
      priority_class: "unblocks-work",
      unlocks_count: 0,
      created_at: "2026-09-03T08:00:00Z"
    })
  ],
  expectedIds: ["a-urgent", "c-count-9", "e-count-3-earlier", "b-count-3", "d-no-count", "f-count-0-tie"]
};

/** With no `unlocks_count` anywhere, ranking follows the class order. */
export const classRankingFixture: AttentionRankingFixture = {
  label: "class order, then created_at, then id",
  records: [
    makeAttentionRecord({ id: "p4-product", priority_class: "product-architecture", created_at: "2026-09-03T08:00:00Z" }),
    makeAttentionRecord({ id: "p1-urgent", priority_class: "urgent-risk", created_at: "2026-09-03T12:00:00Z" }),
    makeAttentionRecord({ id: "p2-unblocks", priority_class: "unblocks-work", created_at: "2026-09-03T09:00:00Z" }),
    makeAttentionRecord({ id: "p3-head", priority_class: "current-head-merge", created_at: "2026-09-03T07:00:00Z" }),
    makeAttentionRecord({ id: "p2b-unblocks-tie", priority_class: "unblocks-work", created_at: "2026-09-03T08:00:00Z" }),
    makeAttentionRecord({ id: "p2c-unblocks-tie", priority_class: "unblocks-work", created_at: "2026-09-03T08:00:00Z" })
  ],
  expectedIds: ["p1-urgent", "p2b-unblocks-tie", "p2c-unblocks-tie", "p2-unblocks", "p3-head", "p4-product"]
};

/** Two urgent records tie on class, so created_at and then id decide. */
export const urgentTieRankingFixture: AttentionRankingFixture = {
  label: "urgent-risk ties fall through to created_at then id",
  records: [
    makeAttentionRecord({ id: "urgent-z", priority_class: "urgent-risk", created_at: "2026-09-03T08:00:00Z" }),
    makeAttentionRecord({ id: "urgent-a", priority_class: "urgent-risk", created_at: "2026-09-03T08:00:00Z" }),
    makeAttentionRecord({ id: "urgent-early", priority_class: "urgent-risk", created_at: "2026-09-03T07:00:00Z" }),
    makeAttentionRecord({ id: "not-urgent", priority_class: "unblocks-work", created_at: "2026-09-03T06:00:00Z" })
  ],
  expectedIds: ["urgent-early", "urgent-a", "urgent-z", "not-urgent"]
};

/** `created_at` is compared as an instant, not as a spelling. */
export const timestampOffsetRankingFixture: AttentionRankingFixture = {
  label: "offsets are compared as instants",
  records: [
    makeAttentionRecord({ id: "later-utc", priority_class: "unblocks-work", created_at: "2026-09-03T09:00:00Z" }),
    makeAttentionRecord({ id: "earlier-offset", priority_class: "unblocks-work", created_at: "2026-09-03T10:30:00+02:00" }),
    makeAttentionRecord({ id: "a-same-instant", priority_class: "unblocks-work", created_at: "2026-09-03T11:00:00+02:00" })
  ],
  expectedIds: ["earlier-offset", "a-same-instant", "later-utc"]
};

export const rankingFixtures: AttentionRankingFixture[] = [
  unlocksCountRankingFixture,
  classRankingFixture,
  urgentTieRankingFixture,
  timestampOffsetRankingFixture
];
