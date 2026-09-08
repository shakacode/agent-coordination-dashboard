import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AttentionCapabilityState } from "../../shared/attention";
import type { AttentionCardPayload, AttentionPayload } from "../api";
import { MISSING_TARGET_TEXT, formatAge } from "./AttentionCard";
import { AttentionView, EMPTY_STATE_LINE, MISSING_SCOPE_MESSAGE, formatClockTime } from "./AttentionView";
import {
  FIXTURE_HOST,
  FIXTURE_MARKDOWN_QUESTION,
  FIXTURE_NOW_MS,
  FIXTURE_OPEN_URI,
  FIXTURE_OTHER_HOST,
  FIXTURE_TARGET_URL,
  FIXTURE_WALKTHROUGH_URL,
  authErrorPayload,
  authErrorWithMessagePayload,
  crossHostCard,
  crossHostRecord,
  degradedWithCardsPayload,
  deskPayload,
  diagnosticsOnlyEmptyPayload,
  diagnosticsOnlyPayload,
  diagnosticsTruncatedPayload,
  emptyPayload,
  fullCard,
  fullRecord,
  invalidLinksCard,
  makeAttentionPayload,
  markdownQuestionPayload,
  markdownQuestionRecord,
  nativeOpenUnavailableCard,
  nativeOpenUnknownCard,
  nonContiguousNumberPayload,
  openAgeCard,
  openAgeRecord,
  partialSourceEmptyPayload,
  partialSourcePayload,
  partialSourceWithInformationalDiagnosticsPayload,
  reducedCard,
  reducedRecord,
  samePrPayload,
  sharedIdPayload,
  singleOpenDayCard,
  truncatedSourceEmptyPayload,
  truncatedSourcePayload,
  unknownDiagnosticKindPayload,
  unreachableAndIncompletePayload,
  unreachablePayload
} from "./fixtures";

/** Fixture fields are optional on the record type; a missing one is a test bug. */
function must(value: string | undefined, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`fixture is missing ${label}`);
  }
  return value;
}

function renderView(
  payload: AttentionPayload | null,
  overrides: { failure?: string | null; lastSuccessAt?: number | null; onRefresh?: () => void } = {}
) {
  const { failure = null, lastSuccessAt = FIXTURE_NOW_MS, onRefresh = () => {} } = overrides;
  return render(
    <AttentionView
      payload={payload}
      lastSuccessAt={lastSuccessAt}
      failure={failure}
      onRefresh={onRefresh}
      now={() => FIXTURE_NOW_MS}
    />
  );
}

function cardLabels(): string[] {
  return screen
    .getAllByRole("article")
    .map((card) => within(card).getByRole("heading", { level: 2 }).textContent ?? "");
}

describe("numbering and order", () => {
  it("numbers every card of the desk payload contiguously in payload order", () => {
    renderView(deskPayload);

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("5 actions need Justin");
    expect(cardLabels()).toEqual(["1 of 5", "2 of 5", "3 of 5", "4 of 5", "5 of 5"]);
  });

  it("keeps payload order", () => {
    renderView(makeAttentionPayload([fullCard, reducedCard, openAgeCard]));

    const cards = screen.getAllByRole("article");
    expect(within(cards[0]).getByText(fullRecord.id)).toBeInTheDocument();
    expect(within(cards[1]).getByText(reducedRecord.id)).toBeInTheDocument();
    expect(within(cards[2]).getByText(openAgeRecord.id)).toBeInTheDocument();
  });

  it("labels by list position when the payload numbers skip", () => {
    renderView(nonContiguousNumberPayload);

    expect(cardLabels()).toEqual(["1 of 3", "2 of 3", "3 of 3"]);
    // The payload's own number is kept, but only inside Technical details.
    expect(screen.getAllByText("Payload number")).toHaveLength(3);
    expect(screen.getByText("9")).toBeInTheDocument();
  });
});

describe("card contents", () => {
  it("renders the full v1.1 card with the decision fields collapsed", () => {
    renderView(makeAttentionPayload([fullCard]));

    expect(screen.getByText(must(fullRecord.hil_task_title, "hil_task_title"))).toBeVisible();
    expect(screen.getByText(must(fullRecord.what_changes, "what_changes"))).toBeVisible();
    expect(screen.getByText(must(fullRecord.risk_downside, "risk_downside"))).toBeVisible();
    expect(screen.getByText(must(fullRecord.recommendation, "recommendation"))).toBeVisible();
    expect(screen.getByText(must(fullRecord.one_action, "one_action"))).toBeVisible();
    expect(screen.getByText("M1")).toBeVisible();
    expect(screen.getByText(formatAge(fullRecord.created_at, FIXTURE_NOW_MS))).toBeVisible();
    expect(screen.getByText("4 hours old")).toBeVisible();

    expect(screen.getByText("Technical details")).toBeVisible();
    expect(screen.getByText(fullRecord.question)).not.toBeVisible();
    expect(screen.getByText(fullRecord.choices[0])).not.toBeVisible();
    expect(screen.getByText(fullRecord.priority_reason)).not.toBeVisible();
    expect(screen.getByText(fullRecord.kind)).not.toBeVisible();
    expect(screen.getByText(fullRecord.safe_resume)).not.toBeVisible();
    expect(screen.getByText(fullRecord.created_at)).not.toBeVisible();
    expect(screen.getByText(fullRecord.refreshed_at)).not.toBeVisible();
  });

  it("never renders source_generation, which the shared render allowlist excludes", () => {
    const { container } = renderView(makeAttentionPayload([fullCard]));

    expect(container.textContent).not.toContain("source_generation");
    expect(screen.queryByText(String(fullRecord.source_generation))).toBeNull();
  });

  it("renders the reduced v1 card's question, choices, and reason in the body", () => {
    renderView(makeAttentionPayload([reducedCard]));

    expect(screen.getByText(reducedRecord.question)).toBeVisible();
    expect(screen.getByText(reducedRecord.choices[0])).toBeVisible();
    expect(screen.getByText(reducedRecord.choices[1])).toBeVisible();
    expect(screen.getByText(reducedRecord.priority_reason)).toBeVisible();
    // The details block keeps the remaining technical fields.
    expect(screen.getByText(reducedRecord.safe_resume)).not.toBeVisible();
  });

  it("marks a card that shares a pull request with another card", () => {
    renderView(samePrPayload);

    expect(screen.getAllByText("same PR")).toHaveLength(2);
  });

  it("shows the open-age flag with the payload's day count", () => {
    renderView(makeAttentionPayload([openAgeCard]));

    expect(screen.getByText("verify: open 10 days")).toBeVisible();
    expect(screen.getByText("10 days old")).toBeVisible();
  });

  it("uses the singular header when exactly one action needs a decision", () => {
    renderView(makeAttentionPayload([fullCard]));

    expect(screen.getByRole("heading", { level: 1, name: "1 action needs Justin" })).toBeVisible();
  });

  it("uses the singular day in the open-age flag", () => {
    renderView(makeAttentionPayload([singleOpenDayCard]));

    expect(screen.getByText("verify: open 1 day")).toBeVisible();
    expect(screen.getByText("1 day old")).toBeVisible();
  });

  it("keys cards by repository and id so two repositories may share an id", () => {
    const [first, second] = sharedIdPayload.cards;
    expect(first.id).toEqual(second.id);
    expect(first.repository).not.toEqual(second.repository);

    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      renderView(sharedIdPayload);

      expect(screen.getAllByRole("article")).toHaveLength(2);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });

  it("does not show the open-age flag when the payload leaves it unset", () => {
    renderView(makeAttentionPayload([fullCard]));

    expect(screen.queryByText(/^verify: open /)).toBeNull();
    expect(screen.queryByText("same PR")).toBeNull();
  });
});

describe("links", () => {
  it("links the validated pull request and walkthrough URLs and nothing else", () => {
    renderView(makeAttentionPayload([fullCard]));

    const target = screen.getByRole("link", { name: FIXTURE_TARGET_URL });
    expect(target).toHaveAttribute("href", FIXTURE_TARGET_URL);
    expect(target).toHaveAttribute("rel", "noopener noreferrer");
    expect(target).toHaveAttribute("target", "_blank");

    const walkthrough = screen.getByRole("link", { name: FIXTURE_WALKTHROUGH_URL });
    expect(walkthrough).toHaveAttribute("href", FIXTURE_WALKTHROUGH_URL);
    expect(walkthrough).toHaveAttribute("rel", "noopener noreferrer");
    expect(walkthrough).toHaveAttribute("target", "_blank");

    expect(screen.getAllByRole("link")).toHaveLength(2);
  });

  it("renders no anchor when the projection rejected both link fields", () => {
    renderView(makeAttentionPayload([invalidLinksCard]));

    expect(screen.queryAllByRole("link")).toHaveLength(0);
    expect(screen.getByText(MISSING_TARGET_TEXT)).toBeVisible();
  });

  it("renders no walkthrough anchor when the record carries no walkthrough URL", () => {
    renderView(makeAttentionPayload([reducedCard]));

    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(screen.getByRole("link", { name: FIXTURE_TARGET_URL })).toBeInTheDocument();
  });

  it("shows the codex URI bare when the host matches and native open is available", () => {
    const { container } = renderView(makeAttentionPayload([reducedCard]));

    expect(screen.getByText(FIXTURE_OPEN_URI)).toBeVisible();
    expect(screen.queryByText(/^open on /)).toBeNull();
    expect(container.querySelector('a[href^="codex:"]')).toBeNull();
    expect(screen.queryByRole("link", { name: FIXTURE_OPEN_URI })).toBeNull();
  });

  it("prefixes the codex URI with the owning host when the card is not local", () => {
    const { container } = renderView(makeAttentionPayload([crossHostCard]));

    const title = must(crossHostRecord.hil_task_title, "hil_task_title");
    expect(screen.getByText(`open on ${FIXTURE_OTHER_HOST}: ${title}`)).toBeVisible();
    expect(screen.getByText(FIXTURE_OPEN_URI)).toBeVisible();
    expect(container.querySelector('a[href^="codex:"]')).toBeNull();
    expect(screen.queryByRole("link", { name: FIXTURE_OPEN_URI })).toBeNull();
  });

  const nativeOpenCases: Array<[AttentionCapabilityState, AttentionCardPayload]> = [
    ["unavailable", nativeOpenUnavailableCard],
    ["unknown", nativeOpenUnknownCard]
  ];

  it.each(nativeOpenCases)(
    "prefixes the codex URI on this very host when native open is %s",
    (state, card) => {
      // The card is local: only native_open may send it down the prefixed path.
      expect(card.host_matches).toBe(true);
      expect(card.native_open).toEqual(state);

      const { container } = renderView(makeAttentionPayload([card]));

      const title = must(card.record.hil_task_title, "hil_task_title");
      expect(screen.getByText(`open on ${FIXTURE_HOST}: ${title}`)).toBeVisible();
      expect(screen.getByText(FIXTURE_OPEN_URI)).toBeVisible();
      expect(container.querySelector('a[href^="codex:"]')).toBeNull();
      expect(screen.queryByRole("link", { name: FIXTURE_OPEN_URI })).toBeNull();
    }
  );

  it("falls back to the record id when a non-local card has no companion title", () => {
    const untitled = { ...crossHostCard, record: { ...crossHostCard.record, hil_task_title: undefined } };
    renderView(makeAttentionPayload([untitled]));

    expect(screen.getByText(`open on ${FIXTURE_OTHER_HOST}: ${crossHostRecord.id}`)).toBeVisible();
  });
});

describe("empty and degraded states", () => {
  it("renders only the System Status line when nothing needs a decision", () => {
    renderView(emptyPayload);

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("0 actions need Justin");
    expect(screen.getByText(EMPTY_STATE_LINE)).toBeVisible();
    expect(screen.queryAllByRole("article")).toHaveLength(0);

    const main = screen.getByRole("main");
    expect(main.children).toHaveLength(2);
    expect(main.children[1]).toHaveTextContent(EMPTY_STATE_LINE);
  });

  it("never claims zero actions while a source is unreachable", () => {
    renderView(unreachablePayload);

    expect(screen.queryByText("0 actions need Justin")).toBeNull();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      `Backend unreachable since ${formatClockTime(FIXTURE_NOW_MS)}`
    );
    expect(screen.queryByText(EMPTY_STATE_LINE)).toBeNull();
  });

  it("never claims zero actions while the coordination token lacks the read scope", () => {
    renderView(authErrorPayload);

    expect(screen.queryByText("0 actions need Justin")).toBeNull();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(MISSING_SCOPE_MESSAGE);
  });

  it("prefers the auth_error source's own message when it carries one", () => {
    renderView(authErrorWithMessagePayload);

    const message = authErrorWithMessagePayload.sources[0].message ?? "";
    expect(message).not.toEqual("");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(message);
  });

  it("keeps the normal header and adds one notice when cards exist and a source is degraded", () => {
    renderView(degradedWithCardsPayload);

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("2 actions need Justin");
    expect(screen.getByText(`Backend unreachable since ${formatClockTime(FIXTURE_NOW_MS)}`)).toBeVisible();
    expect(screen.getAllByRole("article")).toHaveLength(2);
  });

  it("warns that records may be missing when a source read only part of them", () => {
    renderView(partialSourcePayload);

    expect(screen.getByRole("heading", { level: 1, name: "2 actions need Justin" })).toBeVisible();
    expect(
      screen.getByText("Some records may be missing: 1 repositories reported incomplete reads and 0 diagnostics")
    ).toBeVisible();
    expect(screen.getAllByRole("article")).toHaveLength(2);
  });

  it("warns that records may be missing when a source truncated its read", () => {
    renderView(truncatedSourcePayload);

    expect(screen.getByRole("heading", { level: 1, name: "1 action needs Justin" })).toBeVisible();
    expect(
      screen.getByText("Some records may be missing: 1 repositories reported incomplete reads and 0 diagnostics")
    ).toBeVisible();
  });

  it("keeps the ordinary view when a healthy read carries only informational diagnostics", () => {
    // The state observed against the merged route: sources ok, nothing partial
    // or truncated, and several diagnostics the model emits informationally.
    expect(diagnosticsOnlyPayload.sources.every((source) => source.status === "ok")).toBe(true);
    expect(diagnosticsOnlyPayload.sources.some((source) => source.partial || source.truncated)).toBe(false);
    expect(diagnosticsOnlyPayload.diagnostics.map((entry) => entry.kind)).toContain("dashboard_host_unknown");

    renderView(diagnosticsOnlyPayload);

    expect(screen.getByRole("heading", { level: 1, name: "1 action needs Justin" })).toBeVisible();
    expect(screen.queryByText(/^Some records may be missing/)).toBeNull();
    expect(screen.queryByText(/^Attention data incomplete/)).toBeNull();
    expect(screen.getAllByRole("article")).toHaveLength(1);
  });

  it("still counts every diagnostic in the notice once a source reports an incomplete read", () => {
    renderView(partialSourceWithInformationalDiagnosticsPayload);

    expect(screen.getByRole("heading", { level: 1, name: "2 actions need Justin" })).toBeVisible();
    expect(
      screen.getByText("Some records may be missing: 1 repositories reported incomplete reads and 3 diagnostics")
    ).toBeVisible();
  });

  it("warns that records may be missing when the payload dropped diagnostics it could not fit", () => {
    renderView(diagnosticsTruncatedPayload);

    expect(screen.getByRole("heading", { level: 1, name: "1 action needs Justin" })).toBeVisible();
    expect(
      screen.getByText("Some records may be missing: 0 repositories reported incomplete reads and 4 diagnostics")
    ).toBeVisible();
  });

  it("treats a diagnostic kind it has never seen as informational", () => {
    renderView(unknownDiagnosticKindPayload);

    expect(screen.getByRole("heading", { level: 1, name: "1 action needs Justin" })).toBeVisible();
    expect(screen.queryByText(/^Some records may be missing/)).toBeNull();
    expect(screen.queryByText(/^Attention data incomplete/)).toBeNull();
  });

  it("never claims zero actions when a partial read produced no cards", () => {
    renderView(partialSourceEmptyPayload);

    expect(screen.queryByText("0 actions need Justin")).toBeNull();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      `Attention data incomplete since ${formatClockTime(FIXTURE_NOW_MS)}`
    );
    expect(
      screen.getByText("Some records may be missing: 1 repositories reported incomplete reads and 0 diagnostics")
    ).toBeVisible();
    expect(screen.queryByText(EMPTY_STATE_LINE)).toBeNull();
  });

  it("never claims zero actions when a truncated read produced no cards", () => {
    renderView(truncatedSourceEmptyPayload);

    expect(screen.queryByText("0 actions need Justin")).toBeNull();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      `Attention data incomplete since ${formatClockTime(FIXTURE_NOW_MS)}`
    );
    expect(screen.queryByText(EMPTY_STATE_LINE)).toBeNull();
  });

  it("shows the decided empty state when a clean read carries only informational diagnostics", () => {
    renderView(diagnosticsOnlyEmptyPayload);

    expect(screen.getByRole("heading", { level: 1, name: "0 actions need Justin" })).toBeVisible();
    expect(screen.getByText(EMPTY_STATE_LINE)).toBeVisible();
    expect(screen.queryByText(/^Attention data incomplete/)).toBeNull();
    expect(screen.queryByText(/^Some records may be missing/)).toBeNull();
  });

  it("speaks for the unreachable source when incompleteness applies too", () => {
    renderView(unreachableAndIncompletePayload);

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      `Backend unreachable since ${formatClockTime(FIXTURE_NOW_MS)}`
    );
    expect(screen.queryByText(/^Some records may be missing/)).toBeNull();
    expect(screen.queryByText(/^Attention data incomplete/)).toBeNull();
  });

  it("marks the payload stale after a failed poll and keeps the last good cards", () => {
    const lastSuccessAt = FIXTURE_NOW_MS - 5 * 60 * 1000;
    renderView(makeAttentionPayload([fullCard]), {
      failure: "attention request failed: network",
      lastSuccessAt
    });

    expect(screen.getByText(`last refresh ${formatClockTime(lastSuccessAt)}, backend unreachable`)).toBeVisible();
    expect(screen.getAllByRole("article")).toHaveLength(1);
    expect(screen.getByText(must(fullRecord.what_changes, "what_changes"))).toBeVisible();
  });

  it("keeps the stale marker over an empty last-good payload", () => {
    const lastSuccessAt = FIXTURE_NOW_MS - 5 * 60 * 1000;
    renderView(emptyPayload, { failure: "attention request failed: network", lastSuccessAt });

    // Zero cards is still the truth, but a dead backend may not be hidden with it.
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("0 actions need Justin");
    expect(screen.getByText(`last refresh ${formatClockTime(lastSuccessAt)}, backend unreachable`)).toBeVisible();
    expect(screen.getByText(EMPTY_STATE_LINE)).toBeVisible();

    const main = screen.getByRole("main");
    expect(main.children).toHaveLength(3);
  });

  it("reports an unreachable backend before any payload has arrived", () => {
    renderView(null, { failure: "attention request failed: network", lastSuccessAt: null });

    expect(screen.getByText("Backend unreachable")).toBeVisible();
    expect(screen.queryByText("0 actions need Justin")).toBeNull();
  });
});

describe("literal text", () => {
  it("renders Markdown and a script tag as characters, creating no anchor and no script", () => {
    const { container } = renderView(markdownQuestionPayload);

    expect(screen.getByText(FIXTURE_MARKDOWN_QUESTION)).toBeVisible();
    expect(screen.getByText(markdownQuestionRecord.choices[0])).toBeVisible();
    expect(screen.getByText(markdownQuestionRecord.choices[1])).toBeVisible();

    expect(container.querySelectorAll("script")).toHaveLength(0);
    expect(container.querySelector("b")).toBeNull();
    expect(container.querySelector("strong")).toBeNull();
    for (const anchor of container.querySelectorAll("a")) {
      expect(anchor.getAttribute("href")).toEqual(FIXTURE_TARGET_URL);
    }
  });

  it("never writes raw HTML into the client tree", () => {
    // Built at run time so this assertion does not trip over its own source.
    const forbidden = ["dangerously", "SetInnerHTML"].join("");
    const sources = import.meta.glob<string>("../**/*.{ts,tsx,css}", {
      query: "?raw",
      import: "default",
      eager: true
    });
    const paths = Object.keys(sources);

    expect(paths.length).toBeGreaterThan(5);
    expect(paths.some((path) => path.endsWith("/AttentionCard.tsx"))).toBe(true);
    expect(paths.some((path) => path.endsWith("/App.tsx"))).toBe(true);
    for (const [path, source] of Object.entries(sources)) {
      expect(source, path).not.toContain(forbidden);
    }
  });
});

describe("refresh control", () => {
  it("asks the caller for a foreground refresh", () => {
    const onRefresh = vi.fn();
    renderView(emptyPayload, { onRefresh });

    screen.getByRole("button", { name: "Refresh now" }).click();

    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});

describe("clock formatting", () => {
  it("formats local time as zero-padded 24-hour HH:MM", () => {
    const instant = Date.parse("2026-09-06T04:05:00Z");
    const local = new Date(instant);
    const expected = `${String(local.getHours()).padStart(2, "0")}:${String(local.getMinutes()).padStart(2, "0")}`;

    expect(formatClockTime(instant)).toEqual(expected);
    expect(formatClockTime(instant)).toMatch(/^\d{2}:\d{2}$/);
  });

  it("reports age in hours under a day and in days beyond it", () => {
    expect(formatAge("2026-09-06T11:00:00Z", FIXTURE_NOW_MS)).toEqual("1 hour old");
    expect(formatAge("2026-09-06T08:00:00Z", FIXTURE_NOW_MS)).toEqual("4 hours old");
    expect(formatAge("2026-09-05T11:00:00Z", FIXTURE_NOW_MS)).toEqual("1 day old");
    expect(formatAge("2026-08-27T12:00:00Z", FIXTURE_NOW_MS)).toEqual("10 days old");
    expect(formatAge("not a timestamp", FIXTURE_NOW_MS)).toEqual("age UNKNOWN");
    expect(formatAge(undefined, FIXTURE_NOW_MS)).toEqual("age UNKNOWN");
  });
});
