/**
 * Attention payload fixtures for the view tests and the QA screenshots.
 *
 * `/api/attention` does not exist until shakacode/agent-coordination-dashboard#128
 * and the live coordination Worker does not serve the attention prefix yet, so
 * these payloads — built from the vendored records in
 * `src/shared/attention.fixtures.ts` through `projectAttentionRecord` — are the
 * only contract the view can be exercised against.
 *
 * The application never imports this module at runtime: it is test and QA
 * scaffolding only, so no fixture-serving code path exists in the app.
 */

import {
  projectAttentionRecord,
  type AttentionCapabilityState,
  type AttentionRecord
} from "../../shared/attention";
import {
  attentionRepository,
  attentionTaskId,
  codexSource,
  deskContractAttentionRecord,
  makeAttentionRecord,
  openAttentionRecord
} from "../../shared/attention.fixtures";
import type { AttentionCardPayload, AttentionPayload, AttentionSourcePayload } from "../api";

/** Fixed clock every fixture age and timestamp is expressed against. */
export const FIXTURE_NOW_ISO = "2026-09-06T12:00:00Z";
export const FIXTURE_NOW_MS = Date.parse(FIXTURE_NOW_ISO);

/** The host the fixture dashboard runs on, and the one it does not. */
export const FIXTURE_HOST = "M1";
export const FIXTURE_OTHER_HOST = "M5";

export const FIXTURE_OPEN_URI = `codex://threads/${attentionTaskId}`;
export const FIXTURE_TARGET_URL = "https://github.com/shakacode/agent-coordination/pull/284";
export const FIXTURE_WALKTHROUGH_URL =
  "https://github.com/shakacode/agent-coordination/pull/284#pullrequestreview-2481103311";

/** Markdown and a script tag that must reach the DOM as literal characters. */
export const FIXTURE_MARKDOWN_QUESTION =
  "**bold** [link](https://evil.test) <script>alert(1)</script>";

export const okSource: AttentionSourcePayload = {
  repository: attentionRepository,
  mode: "fs",
  status: "ok",
  checked_at: FIXTURE_NOW_ISO,
  partial: false,
  truncated: false
};

export const emptySource: AttentionSourcePayload = { ...okSource, status: "empty" };

export const unreachableSource: AttentionSourcePayload = {
  ...okSource,
  mode: "api",
  status: "unreachable",
  message: "Coordination API did not answer the attention prefix"
};

export const authErrorSource: AttentionSourcePayload = { ...okSource, mode: "api", status: "auth_error" };

export const authErrorSourceWithMessage: AttentionSourcePayload = {
  ...authErrorSource,
  message: "Coordination token rejected with 403 on the attention prefix"
};

function toCard(record: AttentionRecord, overrides: Partial<AttentionCardPayload> = {}): AttentionCardPayload {
  return {
    number: 1,
    id: record.id,
    repository: record.repository,
    record: projectAttentionRecord(record),
    host: FIXTURE_HOST,
    host_matches: true,
    native_open: record.source.capabilities.native_open,
    same_pr: false,
    open_days: 0,
    verify_open_age: false,
    ...overrides
  };
}

/** Builds a payload and assigns the contiguous `1..N` numbers #128 promises. */
export function makeAttentionPayload(
  cards: AttentionCardPayload[],
  overrides: Partial<AttentionPayload> = {}
): AttentionPayload {
  return {
    generated_at: FIXTURE_NOW_ISO,
    dashboard_host: FIXTURE_HOST,
    sources: [okSource],
    diagnostics: [],
    ...overrides,
    cards: cards.map((card, index) => ({ ...card, number: index + 1 }))
  };
}

/** Every v1.1 desk-contract field, four hours old, on the dashboard's own host. */
export const fullRecord: AttentionRecord = makeAttentionRecord({
  ...deskContractAttentionRecord,
  created_at: "2026-09-06T08:00:00Z",
  refreshed_at: "2026-09-06T11:30:00Z"
});

/** Upstream v1: no card fields, so question, choices, and reason move into the body. */
export const reducedRecord: AttentionRecord = makeAttentionRecord({
  id: "agent-coordination-pr284-github-api-coverage",
  created_at: "2026-09-06T06:00:00Z",
  refreshed_at: "2026-09-06T11:00:00Z"
});

export const crossHostRecord: AttentionRecord = makeAttentionRecord({
  ...deskContractAttentionRecord,
  id: "agent-coordination-pr284-cross-host",
  hil_task_title: "Security gate for the exact head",
  source: { ...codexSource, host_id: "m5" },
  created_at: "2026-09-06T10:00:00Z"
});

/**
 * A session on the dashboard's own host whose agent cannot be opened natively.
 * `native_open` comes from the record's own capabilities, so the card and the
 * record agree, and the bare-URI rule's second half has something to fail on.
 */
function withNativeOpen(nativeOpen: AttentionCapabilityState, id: string): AttentionRecord {
  return makeAttentionRecord({
    ...deskContractAttentionRecord,
    id,
    hil_task_title: "Merge gate with no native open",
    source: { ...codexSource, capabilities: { native_open: nativeOpen, prompt_forwarding: "unknown" } },
    created_at: "2026-09-06T10:30:00Z"
  });
}

export const nativeOpenUnavailableRecord: AttentionRecord = withNativeOpen(
  "unavailable",
  "agent-coordination-pr284-native-open-unavailable"
);

export const nativeOpenUnknownRecord: AttentionRecord = withNativeOpen(
  "unknown",
  "agent-coordination-pr284-native-open-unknown"
);

/** Both link fields are rejected by the shared validators, so both project to null. */
export const invalidLinksRecord: AttentionRecord = makeAttentionRecord({
  ...deskContractAttentionRecord,
  id: "agent-coordination-pr284-invalid-links",
  target: "javascript:alert(1)",
  walkthrough_url: "https://evil.test/shakacode/agent-coordination/pull/284",
  created_at: "2026-09-06T09:00:00Z"
});

export const markdownQuestionRecord: AttentionRecord = makeAttentionRecord({
  id: "agent-coordination-pr284-markdown-question",
  question: FIXTURE_MARKDOWN_QUESTION,
  choices: ["<b>accept</b>", "[reject](https://evil.test)"],
  created_at: "2026-09-06T11:00:00Z"
});

/** Ten days open against the fixed clock, so the age flag is set. */
export const openAgeRecord: AttentionRecord = makeAttentionRecord({
  ...deskContractAttentionRecord,
  id: "agent-coordination-pr284-open-ten-days",
  hil_task_title: "Long-running merge gate",
  created_at: "2026-08-27T12:00:00Z",
  refreshed_at: "2026-09-06T11:00:00Z"
});

export const samePrFirstRecord: AttentionRecord = makeAttentionRecord({
  ...deskContractAttentionRecord,
  id: "agent-coordination-pr284-same-pr-review",
  hil_task_title: "Review gate on pull 284",
  created_at: "2026-09-06T07:00:00Z"
});

export const samePrSecondRecord: AttentionRecord = makeAttentionRecord({
  ...deskContractAttentionRecord,
  id: "agent-coordination-pr284-same-pr-merge",
  hil_task_title: "Merge gate on pull 284",
  created_at: "2026-09-06T07:30:00Z"
});

export const fullCard: AttentionCardPayload = toCard(fullRecord);

export const reducedCard: AttentionCardPayload = toCard(reducedRecord);

export const crossHostCard: AttentionCardPayload = toCard(crossHostRecord, {
  host: FIXTURE_OTHER_HOST,
  host_matches: false
});

export const nativeOpenUnavailableCard: AttentionCardPayload = toCard(nativeOpenUnavailableRecord);

export const nativeOpenUnknownCard: AttentionCardPayload = toCard(nativeOpenUnknownRecord);

export const invalidLinksCard: AttentionCardPayload = toCard(invalidLinksRecord);

export const markdownQuestionCard: AttentionCardPayload = toCard(markdownQuestionRecord);

export const openAgeCard: AttentionCardPayload = toCard(openAgeRecord, {
  open_days: 10,
  verify_open_age: true
});

export const samePrCards: AttentionCardPayload[] = [
  toCard(samePrFirstRecord, { same_pr: true }),
  toCard(samePrSecondRecord, { same_pr: true })
];

/** The desk view a QA screenshot captures: every card shape in one payload. */
export const deskPayload: AttentionPayload = makeAttentionPayload([
  fullCard,
  reducedCard,
  crossHostCard,
  invalidLinksCard,
  openAgeCard
]);

export const samePrPayload: AttentionPayload = makeAttentionPayload(samePrCards);

export const markdownQuestionPayload: AttentionPayload = makeAttentionPayload([markdownQuestionCard]);

export const emptyPayload: AttentionPayload = makeAttentionPayload([], { sources: [emptySource] });

export const unreachablePayload: AttentionPayload = makeAttentionPayload([], {
  sources: [okSource, unreachableSource],
  diagnostics: [
    { repository: attentionRepository, kind: "source_unreachable", message: "Coordination API did not answer" }
  ]
});

export const authErrorPayload: AttentionPayload = makeAttentionPayload([], { sources: [authErrorSource] });

export const authErrorWithMessagePayload: AttentionPayload = makeAttentionPayload([], {
  sources: [authErrorSourceWithMessage]
});

/** Cards exist and one source is still degraded: header plus a notice line. */
export const degradedWithCardsPayload: AttentionPayload = makeAttentionPayload([fullCard, reducedCard], {
  sources: [okSource, unreachableSource]
});

/**
 * A payload whose `number` fields skip: the view must still label by list
 * position, so the labels stay `1 of 3`, `2 of 3`, `3 of 3`.
 */
export const nonContiguousNumberPayload: AttentionPayload = {
  ...makeAttentionPayload([]),
  cards: [
    { ...fullCard, number: 4 },
    { ...reducedCard, number: 9 },
    { ...openAgeCard, number: 11 }
  ]
};
