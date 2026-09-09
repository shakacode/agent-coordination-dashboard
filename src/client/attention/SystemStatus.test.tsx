import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ATTENTION_TEXT_LIMIT, ATTENTION_TRUNCATION_MARKER, truncateForRender } from "../../shared/attention";
import {
  isAttentionPayload,
  type AttentionDiagnosticPayload,
  type AttentionPayload,
  type AttentionSourcePayload
} from "../api";
import { MISSING_SCOPE_MESSAGE, formatClockTime } from "./AttentionView";
import {
  BACK_LABEL,
  DASHBOARD_SCOPE,
  NONE_TEXT,
  NO_ACTION_LINE,
  NO_LAUNCH_URI_TEXT,
  SystemStatus,
  UNKNOWN_TEXT
} from "./SystemStatus";
import {
  FIXTURE_MARKDOWN_QUESTION,
  FIXTURE_NOW_ISO,
  FIXTURE_NOW_MS,
  FIXTURE_OPEN_URI,
  FIXTURE_OTHER_HOST,
  authErrorSource,
  authErrorSourceWithMessage,
  crossHostCard,
  fullCard,
  makeAttentionPayload,
  markdownQuestionRecord,
  nativeOpenUnknownCard,
  okSource,
  openAgeCard,
  partialSource,
  truncatedSource,
  unreachableSource
} from "./fixtures";

function renderStatus(
  payload: AttentionPayload | null,
  overrides: { failure?: string | null; lastSuccessAt?: number | null; onBack?: () => void } = {}
) {
  const { failure = null, lastSuccessAt = FIXTURE_NOW_MS, onBack = () => {} } = overrides;
  return render(
    <SystemStatus payload={payload} lastSuccessAt={lastSuccessAt} failure={failure} onBack={onBack} />
  );
}

/** One diagnostic of a given kind, so a test names only what it is about. */
function diagnostic(
  kind: string,
  message: string,
  repository: string | null = "shakacode/agent-coordination"
): AttentionDiagnosticPayload {
  return { repository, kind, message };
}

function withDiagnostics(...diagnostics: AttentionDiagnosticPayload[]): AttentionPayload {
  return makeAttentionPayload([], { sources: [okSource], diagnostics });
}

function section(name: string): HTMLElement {
  return screen.getByRole("region", { name });
}

/** Every diagnostic entry on the page, whichever section it landed in. */
function renderedDiagnostics(container: HTMLElement): Array<{ kind: string; message: string }> {
  return [...container.querySelectorAll(".system-status__diagnostic")].map((entry) => ({
    kind: entry.querySelector(".system-status__kind")?.textContent ?? "",
    message: entry.querySelector(".system-status__message")?.textContent ?? ""
  }));
}

describe("the first line", () => {
  it("renders the exact no-action line before anything else", () => {
    renderStatus(withDiagnostics());

    const main = screen.getByRole("main");
    expect(main.firstElementChild?.textContent).toEqual(NO_ACTION_LINE);
    expect(NO_ACTION_LINE).toEqual("No action is needed from Justin in this file.");
    expect(screen.getByText(NO_ACTION_LINE)).toBeVisible();
  });

  it("keeps the no-action line first before any payload has arrived", () => {
    renderStatus(null, { failure: "attention request failed: network" });

    const main = screen.getByRole("main");
    expect(main.firstElementChild?.textContent).toEqual(NO_ACTION_LINE);
    expect(screen.getByText("Backend unreachable")).toBeVisible();
  });

  it("says it is loading when no payload has arrived and nothing has failed", () => {
    renderStatus(null);

    expect(screen.getByText("Loading actions…")).toBeVisible();
  });
});

describe("a failing fetch", () => {
  it("marks the payload stale while the backend is unreachable, in the Attention view's words", () => {
    // useAttention keeps the last good payload across a failed poll, so this is
    // the ordinary state after the backend dies: a full page describing a read
    // that is no longer current. The page whose subject is backend health may
    // not be the one page that forgets it.
    const lastSuccessAt = FIXTURE_NOW_MS - 5 * 60 * 1000;
    renderStatus(withDiagnostics(diagnostic("invalid_json", "a record that could not be parsed")), {
      failure: "attention request failed: network",
      lastSuccessAt
    });

    expect(screen.getByText(`last refresh ${formatClockTime(lastSuccessAt)}, backend unreachable`)).toBeVisible();
    // The last good payload still renders in full behind the marker.
    expect(
      within(section("Invalid or unknown-class records")).getByText("a record that could not be parsed")
    ).toBeVisible();
    expect(screen.getByText(`Payload generated at ${FIXTURE_NOW_ISO}`)).toBeVisible();
  });

  it("shows no stale marker while the backend is answering", () => {
    renderStatus(withDiagnostics());

    expect(screen.queryByText(/backend unreachable$/)).toBeNull();
  });
});

describe("diagnostic classes", () => {
  it("lists a stale source with the record it names", () => {
    const entry = diagnostic(
      "stale_source",
      'Record agent-coordination-pr284-desk-card has an unreadable refreshed_at "not-a-date"; the card is suppressed.'
    );
    renderStatus(withDiagnostics(entry));

    expect(within(section("Stale sources and companions")).getByText(entry.message)).toBeVisible();
  });

  it("lists a stale companion with the record it names", () => {
    const entry = diagnostic(
      "stale_companion",
      'Record agent-coordination-pr284-desk-card has an unreadable source.last_seen_at "nope"; the card is suppressed.'
    );
    renderStatus(withDiagnostics(entry));

    expect(within(section("Stale sources and companions")).getByText(entry.message)).toBeVisible();
  });

  it("lists a clock skew beside the stale kinds it shares a rule with", () => {
    const entry = diagnostic(
      "clock_skew",
      'Record agent-coordination-pr284-desk-card refreshed_at "2099-01-01T00:00:00Z" is more than 300 seconds ahead ' +
        "of the dashboard clock; the card is suppressed."
    );
    renderStatus(withDiagnostics(entry));

    expect(within(section("Stale sources and companions")).getByText(entry.message)).toBeVisible();
  });

  it("lists the resolved trail the model kept", () => {
    const entry = diagnostic(
      "resolved_recent",
      'Resolved agent-coordination-pr284-desk-card at "2026-09-06T09:00:00Z": no valid target.'
    );
    renderStatus(withDiagnostics(entry));

    expect(within(section("Resolved records (newest 20 per repository)")).getByText(entry.message)).toBeVisible();
  });

  it("shows resolved_total through the over-500 warning", () => {
    const entry = diagnostic(
      "resolved_total_warning",
      "Repository shakacode/agent-coordination has 612 resolved attention records, over the 500-record warning " +
        "threshold."
    );
    renderStatus(withDiagnostics(entry));

    const resolved = section("Resolved records (newest 20 per repository)");
    expect(within(resolved).getByText(entry.message)).toBeVisible();
    expect(within(resolved).getByText("resolved_total_warning")).toBeVisible();
  });

  it("lists a producer duplicate", () => {
    const entry = diagnostic(
      "producer_duplicate",
      'Records a, b ask the same question about target "https://github.com/shakacode/agent-coordination/pull/284" ' +
        "from different sources; each one still renders."
    );
    renderStatus(withDiagnostics(entry));

    expect(within(section("Producer duplicates")).getByText(entry.message)).toBeVisible();
  });

  it("lists a suppressed host", () => {
    const entry = diagnostic(
      "unknown_host",
      'Record agent-coordination-pr284-desk-card names host "m9", which is neither M5 nor M1; the card is suppressed.'
    );
    renderStatus(withDiagnostics(entry));

    expect(within(section("Suppressed hosts")).getByText(entry.message)).toBeVisible();
  });

  it("lists the cross-host count beside the cards it counted", () => {
    const entry = diagnostic("cross_host_count", "1 of 2 rendered cards belong to another host.", null);
    renderStatus(
      makeAttentionPayload([fullCard, crossHostCard], { sources: [okSource], diagnostics: [entry] })
    );

    const crossHost = section("Cross-host items");
    expect(within(crossHost).getByText("1 of 2 rendered cards belong to another host.", { selector: "p" })).toBeVisible();
    expect(within(crossHost).getByText(crossHostCard.id)).toBeVisible();
    expect(within(crossHost).getByText(`answerable on ${FIXTURE_OTHER_HOST}`)).toBeVisible();
    expect(within(crossHost).getByText(DASHBOARD_SCOPE)).toBeVisible();
  });

  it("lists the dashboard host with the unset-machine-id warning", () => {
    const entry = diagnostic(
      "dashboard_host_unknown",
      "The dashboard machine id is not set, so the dashboard host is UNKNOWN.",
      null
    );
    renderStatus(
      makeAttentionPayload([], { sources: [okSource], diagnostics: [entry], dashboard_host: "UNKNOWN" })
    );

    const host = section("Dashboard host");
    expect(within(host).getByText("This dashboard reports its host as UNKNOWN.")).toBeVisible();
    expect(within(host).getByText(entry.message)).toBeVisible();
  });

  it("lists the open-age flagged count", () => {
    const entry = diagnostic("open_age_flagged", "1 rendered cards have been open longer than 7 days.", null);
    // One flagged card beside one that is not, so the count is a real filter.
    expect(fullCard.verify_open_age).toBe(false);
    expect(openAgeCard.verify_open_age).toBe(true);
    renderStatus(makeAttentionPayload([fullCard, openAgeCard], { sources: [okSource], diagnostics: [entry] }));

    const openAge = section("Open-age flagged");
    expect(
      within(openAge).getByText("1 of 2 rendered cards are flagged for their open age.")
    ).toBeVisible();
    expect(within(openAge).getByText(entry.message)).toBeVisible();
  });

  it("lists a truncated card list", () => {
    const entry = diagnostic(
      "truncated",
      "Repository shakacode/agent-coordination kept the 200 highest-ranked open records and dropped 12."
    );
    renderStatus(withDiagnostics(entry));

    expect(within(section("Truncation and partial reads")).getByText(entry.message)).toBeVisible();
  });

  it("lists dropped diagnostics", () => {
    const entry = diagnostic("diagnostics_truncated", "The payload raised 12 more diagnostics than the 200 shown.", null);
    renderStatus(withDiagnostics(entry));

    expect(within(section("Truncation and partial reads")).getByText(entry.message)).toBeVisible();
  });

  it("counts partial and truncated repository reads", () => {
    renderStatus(makeAttentionPayload([], { sources: [okSource, partialSource, truncatedSource] }));

    expect(
      within(section("Truncation and partial reads")).getByText(
        "1 of 3 repositories reported a partial read; 1 truncated their card list."
      )
    ).toBeVisible();
  });

  it("lists an invalid record with its reason", () => {
    const entry = diagnostic(
      "invalid_json",
      "attention/default/shakacode/agent-coordination/broken.json: The record is not valid JSON."
    );
    renderStatus(withDiagnostics(entry));

    const invalid = section("Invalid or unknown-class records");
    expect(within(invalid).getByText(entry.message)).toBeVisible();
    expect(within(invalid).getByText("invalid_json")).toBeVisible();
  });

  it("lists a record the schema rejected with its reason", () => {
    const entry = diagnostic(
      "schema_invalid",
      "attention/default/shakacode/agent-coordination/bad.json: /priority_class must be one of the allowed values."
    );
    renderStatus(withDiagnostics(entry));

    expect(within(section("Invalid or unknown-class records")).getByText(entry.message)).toBeVisible();
  });

  it("lists a diagnostic class this view has never heard of rather than hiding it", () => {
    const entry = diagnostic(
      "some_kind_added_after_this_view_shipped",
      "A diagnostic kind the model gained after this view was written"
    );
    renderStatus(withDiagnostics(entry));

    const invalid = section("Invalid or unknown-class records");
    expect(within(invalid).getByText(entry.message)).toBeVisible();
    expect(within(invalid).getByText("some_kind_added_after_this_view_shipped")).toBeVisible();
  });

  it("shows every diagnostic exactly once across the page", () => {
    const diagnostics = [
      diagnostic("stale_source", "stale source message"),
      diagnostic("stale_companion", "stale companion message"),
      diagnostic("clock_skew", "clock skew message"),
      diagnostic("resolved_recent", "resolved recent message"),
      diagnostic("resolved_total_warning", "resolved total message"),
      diagnostic("producer_duplicate", "producer duplicate message"),
      diagnostic("unknown_host", "unknown host message"),
      diagnostic("cross_host_count", "cross host message", null),
      diagnostic("dashboard_host_unknown", "dashboard host message", null),
      diagnostic("open_age_flagged", "open age message", null),
      diagnostic("truncated", "truncated message"),
      diagnostic("diagnostics_truncated", "diagnostics truncated message", null),
      diagnostic("invalid_json", "invalid json message"),
      diagnostic("brand_new_kind", "brand new message")
    ];
    const { container } = renderStatus(withDiagnostics(...diagnostics));

    const rendered = renderedDiagnostics(container);
    expect(rendered).toHaveLength(diagnostics.length);
    for (const entry of diagnostics) {
      expect(rendered.filter((shown) => shown.kind === entry.kind && shown.message === entry.message)).toHaveLength(1);
    }
  });

  it("says so plainly when a class has nothing to report", () => {
    renderStatus(withDiagnostics());

    for (const name of [
      "Stale sources and companions",
      "Suppressed hosts",
      "Producer duplicates",
      "Resolved records (newest 20 per repository)",
      "Invalid or unknown-class records",
      "Coordination read scope"
    ]) {
      expect(within(section(name)).getByText(NONE_TEXT)).toBeVisible();
    }
  });
});

describe("backend source health", () => {
  it("reports each source's mode, status, check time, and bounds", () => {
    renderStatus(makeAttentionPayload([], { sources: [okSource, partialSource, truncatedSource, unreachableSource] }));

    const sources = section("Backend source health");
    expect(within(sources).getByText(`mode fs · status ok · checked ${FIXTURE_NOW_ISO}`)).toBeVisible();
    expect(
      within(sources).getByText(`mode fs · status ok · checked ${FIXTURE_NOW_ISO} · partial read`)
    ).toBeVisible();
    expect(
      within(sources).getByText(`mode api · status ok · checked ${FIXTURE_NOW_ISO} · truncated read`)
    ).toBeVisible();
    expect(
      within(sources).getByText(`mode api · status unreachable · checked ${FIXTURE_NOW_ISO}`)
    ).toBeVisible();
    expect(within(sources).getByText("Coordination API did not answer the attention prefix")).toBeVisible();
  });

  it("reports each source's resolved-record count, warning or no warning", () => {
    renderStatus(
      makeAttentionPayload([], {
        sources: [
          { ...okSource, resolved_total: 300 },
          { ...unreachableSource, repository: "shakacode/agent-coordination-dashboard", resolved_total: 0 }
        ]
      })
    );

    const sources = section("Backend source health");
    // 300 is under the 500-record threshold, so no diagnostic names it; the
    // source line is the only place the count appears.
    expect(
      within(sources).getByText(`mode fs · status ok · checked ${FIXTURE_NOW_ISO} · 300 resolved`)
    ).toBeVisible();
    expect(
      within(sources).getByText(
        `mode api · status unreachable · checked ${FIXTURE_NOW_ISO} · 0 resolved`
      )
    ).toBeVisible();
    expect(within(section("Resolved records (newest 20 per repository)")).getByText(NONE_TEXT)).toBeVisible();
  });

  it("renders the whole page when a source's resolved_total is not a number", () => {
    // The payload guard is all-or-nothing, so an advisory count must never be a
    // new way to reject the payload and blank the page (#146, #166).
    const hostile = { ...okSource, resolved_total: "many" } as unknown as AttentionSourcePayload;
    const payload = makeAttentionPayload([], { sources: [hostile] });

    expect(isAttentionPayload(payload)).toBe(true);

    renderStatus(payload);

    const sources = section("Backend source health");
    expect(within(sources).getByText(`mode fs · status ok · checked ${FIXTURE_NOW_ISO}`)).toBeVisible();
    expect(within(sources).queryByText(/resolved$/)).toBeNull();
  });

  it("omits the count entirely when a source carries none", () => {
    renderStatus(makeAttentionPayload([], { sources: [okSource] }));

    expect(
      within(section("Backend source health")).getByText(`mode fs · status ok · checked ${FIXTURE_NOW_ISO}`)
    ).toBeVisible();
  });

  it("marks an unreadable check time UNKNOWN rather than leaving it blank", () => {
    renderStatus(makeAttentionPayload([], { sources: [{ ...okSource, checked_at: "" }] }));

    expect(
      within(section("Backend source health")).getByText(`mode fs · status ok · checked ${UNKNOWN_TEXT}`)
    ).toBeVisible();
  });

  it("says so plainly when the payload carries no source at all", () => {
    renderStatus(makeAttentionPayload([], { sources: [] }));

    expect(within(section("Backend source health")).getByText(NONE_TEXT)).toBeVisible();
  });

  it("names the missing read scope with the shared fallback message", () => {
    renderStatus(makeAttentionPayload([], { sources: [authErrorSource] }));

    expect(within(section("Coordination read scope")).getByText(MISSING_SCOPE_MESSAGE)).toBeVisible();
  });

  it("prefers the auth_error source's own message when it carries one", () => {
    renderStatus(makeAttentionPayload([], { sources: [authErrorSourceWithMessage] }));

    const scope = section("Coordination read scope");
    expect(within(scope).getByText(authErrorSourceWithMessage.message ?? "")).toBeVisible();
    expect(within(scope).queryByText(MISSING_SCOPE_MESSAGE)).toBeNull();
  });
});

describe("capability-unknown links", () => {
  it("lists a card whose native open capability is unknown with its launch URI", () => {
    renderStatus(makeAttentionPayload([fullCard, nativeOpenUnknownCard], { sources: [okSource] }));

    const capabilities = section("Capability-unknown links");
    expect(
      within(capabilities).getByText("1 of 2 rendered cards report native open as unknown.")
    ).toBeVisible();
    expect(within(capabilities).getByText(nativeOpenUnknownCard.id)).toBeVisible();
    expect(within(capabilities).getByText(FIXTURE_OPEN_URI)).toBeVisible();
    expect(within(capabilities).queryByText(fullCard.id)).toBeNull();
  });

  it("never links the codex launch URI", () => {
    const { container } = renderStatus(
      makeAttentionPayload([nativeOpenUnknownCard], { sources: [okSource] })
    );

    expect(container.querySelector('a[href^="codex:"]')).toBeNull();
    expect(screen.queryByRole("link", { name: FIXTURE_OPEN_URI })).toBeNull();
    expect(screen.queryAllByRole("link")).toHaveLength(0);
  });

  it("says the source offers no launch URI when the validators rejected it", () => {
    const withoutUri = {
      ...nativeOpenUnknownCard,
      record: { ...nativeOpenUnknownCard.record, source: { ...nativeOpenUnknownCard.record.source, open_uri: null } }
    };
    renderStatus(makeAttentionPayload([withoutUri], { sources: [okSource] }));

    expect(within(section("Capability-unknown links")).getByText(NO_LAUNCH_URI_TEXT)).toBeVisible();
  });
});

describe("literal text", () => {
  it("renders Markdown and a script tag in a diagnostic as characters", () => {
    const { container } = renderStatus(withDiagnostics(diagnostic("invalid_json", FIXTURE_MARKDOWN_QUESTION)));

    expect(screen.getByText(FIXTURE_MARKDOWN_QUESTION)).toBeVisible();
    expect(container.querySelectorAll("script")).toHaveLength(0);
    expect(container.querySelector("b")).toBeNull();
    expect(container.querySelector("strong")).toBeNull();
    expect(container.querySelectorAll("a")).toHaveLength(0);
  });

  it("caps an overlong diagnostic message at the shared render bound", () => {
    // The payload guard only proves the message is a string, so the client
    // applies the same cap the projection applies to record text.
    const message = "x".repeat(ATTENTION_TEXT_LIMIT + 50);
    const { container } = renderStatus(withDiagnostics(diagnostic("invalid_json", message)));

    const shown = container.querySelector(".system-status__message")?.textContent ?? "";
    expect(shown).toHaveLength(ATTENTION_TEXT_LIMIT);
    expect(shown.endsWith(ATTENTION_TRUNCATION_MARKER)).toBe(true);
    expect(shown).toEqual(truncateForRender(message));
  });

  it("caps an overlong source message at the shared render bound", () => {
    const message = "y".repeat(ATTENTION_TEXT_LIMIT + 50);
    const { container } = renderStatus(
      makeAttentionPayload([], { sources: [{ ...unreachableSource, message }] })
    );

    const shown = container.querySelector(".system-status__source-message")?.textContent ?? "";
    expect(shown).toHaveLength(ATTENTION_TEXT_LIMIT);
    expect(shown.endsWith(ATTENTION_TRUNCATION_MARKER)).toBe(true);
    expect(shown).toEqual(truncateForRender(message));
  });

  it("caps a cross-host card's host at the shared render bound", () => {
    // The client's own guard checks `host` for being a string and nothing more,
    // so the cap may not rest on the server keeping it to M5 or M1.
    const host = "M".repeat(ATTENTION_TEXT_LIMIT + 50);
    const { container } = renderStatus(
      makeAttentionPayload([{ ...crossHostCard, host }], { sources: [okSource] })
    );

    const detail = container.querySelector(".system-status__card-detail")?.textContent ?? "";
    expect(detail).toEqual(`answerable on ${truncateForRender(host)}`);
    expect(detail.endsWith(ATTENTION_TRUNCATION_MARKER)).toBe(true);
  });

  it("caps a capability-unknown card's host at the shared render bound", () => {
    const host = "U".repeat(ATTENTION_TEXT_LIMIT + 50);
    const { container } = renderStatus(
      makeAttentionPayload([{ ...nativeOpenUnknownCard, host }], { sources: [okSource] })
    );

    const detail = container.querySelector(".system-status__card-detail")?.textContent ?? "";
    expect(detail).toEqual(`native open unknown on ${truncateForRender(host)}`);
    expect(detail.endsWith(ATTENTION_TRUNCATION_MARKER)).toBe(true);
  });

  it("never renders a record field the shared allowlist excludes", () => {
    const { container } = renderStatus(
      makeAttentionPayload([fullCard, nativeOpenUnknownCard, crossHostCard], { sources: [okSource] })
    );

    expect(container.textContent).not.toContain("source_generation");
    expect(container.textContent).not.toContain(markdownQuestionRecord.question);
  });
});

describe("navigation", () => {
  it("goes back to the attention list", () => {
    const onBack = vi.fn();
    renderStatus(withDiagnostics(), { onBack });

    screen.getByRole("button", { name: BACK_LABEL }).click();

    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("reports the payload's generation instant", () => {
    renderStatus(withDiagnostics());

    expect(screen.getByText(`Payload generated at ${FIXTURE_NOW_ISO}`)).toBeVisible();
  });
});
