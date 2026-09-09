/**
 * The System Status view: everything the payload says about its own read.
 *
 * It is a second view rather than a route — the app has no router — reached
 * from the Attention view's header and from the one line in its empty state,
 * and it goes back the same way. Nothing here calls GitHub, launches an agent,
 * or mutates a coordination record: like the Attention view it renders the
 * payload it was handed and nothing else.
 *
 * Every value reaches the DOM as a React text node, through the shared helpers
 * in `src/shared/attention.ts`. Record text and record links arrive only on
 * `card.record`, which is `projectAttentionRecord`'s output: the render
 * allowlist has already dropped every field a card may not read, and the link
 * validators have already reduced `target`, `walkthrough_url`, and
 * `source.open_uri` to an accepted URL or `null`. Text that never passed
 * through the projection — a diagnostic message, a source's repository or
 * message, a card's host — is capped here with {@link truncateForRender}, the
 * same bound the projection applies. The client's own guard checks `host` only
 * for being a string, so the cap does not rest on the server keeping it to `M5`
 * or `M1`. No raw record text reaches the DOM by another path, and
 * the `codex://` launch URI stays copyable text, never a link, exactly as it
 * is on a card.
 *
 * GitHub budget state and label disagreement are deliberately absent: they are
 * deferred to shakacode/agent-coordination-dashboard#120.
 */

import type { ReactNode } from "react";
import { truncateForRender } from "../../shared/attention";
import type {
  AttentionCardPayload,
  AttentionDiagnosticPayload,
  AttentionPayload,
  AttentionSourcePayload
} from "../api";
import { LOADING_LINE, MISSING_SCOPE_MESSAGE, NO_PAYLOAD_LINE, staleMarkerLine } from "./AttentionView";
import "./attention.css";

/**
 * The first rendered line, exactly.
 *
 * This page reports; it never asks. The line says so before anything else on
 * it, so a reader who arrives from the attention list knows immediately that
 * nothing below is a decision waiting on them. The operator name is the same
 * decided literal the Attention view's headline uses.
 */
export const NO_ACTION_LINE = "No action is needed from Justin in this file.";

export const SYSTEM_STATUS_TITLE = "System Status";

/** The way back to the attention list; the only other control on the page. */
export const BACK_LABEL = "Back to attention";

/** Shown by a section that has nothing to report, so silence is never ambiguous. */
export const NONE_TEXT = "None.";

/** Scope shown for a diagnostic that belongs to the dashboard, not one repository. */
export const DASHBOARD_SCOPE = "dashboard";

/** Per the repository's UNKNOWN rule, for a payload value that is not readable. */
export const UNKNOWN_TEXT = "UNKNOWN";

/** Shown for a card whose source offers no launch URI the validators accepted. */
export const NO_LAUNCH_URI_TEXT = "no launch URI";

/**
 * Between the parts of one entry.
 *
 * It is a text node rather than a CSS rule so an entry still reads as separate
 * values with no stylesheet at all: this view adds no CSS of its own and reuses
 * the attention page's, which knows nothing about these rows.
 */
const SEPARATOR = " · ";

/**
 * Which section each diagnostic kind belongs to.
 *
 * The kinds are the model's vocabulary in
 * `src/server/attention/buildAttentionModel.ts`, plus the reader's kinds, which
 * pass through under their own names. `clock_skew` sits with the stale kinds
 * because it comes out of the same freshness rule and suppresses a card in the
 * same way: a record whose `refreshed_at` runs ahead of the dashboard clock has
 * no more been shown to be current than a record whose `refreshed_at` is too
 * old.
 *
 * The map is not a filter. Every kind outside it — a reader diagnostic naming a
 * record that could not be parsed or validated, and any kind added upstream
 * after this view shipped — lands in the invalid-or-unknown-class section, so
 * the page shows every diagnostic in the payload and hides none.
 */
const STALE_KINDS: readonly string[] = ["stale_source", "stale_companion", "clock_skew"];
const RESOLVED_KINDS: readonly string[] = ["resolved_recent", "resolved_total_warning"];
const PRODUCER_DUPLICATE_KINDS: readonly string[] = ["producer_duplicate"];
const SUPPRESSED_HOST_KINDS: readonly string[] = ["unknown_host"];
const CROSS_HOST_KINDS: readonly string[] = ["cross_host_count"];
const TRUNCATION_KINDS: readonly string[] = ["truncated", "diagnostics_truncated"];
const OPEN_AGE_KINDS: readonly string[] = ["open_age_flagged"];
const DASHBOARD_HOST_KINDS: readonly string[] = ["dashboard_host_unknown"];

/** Every kind a named section claims; the rest fall through to the catch-all. */
const CLASSIFIED_KINDS: readonly string[] = [
  ...STALE_KINDS,
  ...RESOLVED_KINDS,
  ...PRODUCER_DUPLICATE_KINDS,
  ...SUPPRESSED_HOST_KINDS,
  ...CROSS_HOST_KINDS,
  ...TRUNCATION_KINDS,
  ...OPEN_AGE_KINDS,
  ...DASHBOARD_HOST_KINDS
];

function ofKinds(
  diagnostics: readonly AttentionDiagnosticPayload[],
  kinds: readonly string[]
): AttentionDiagnosticPayload[] {
  return diagnostics.filter((entry) => kinds.includes(entry.kind));
}

/** Reader failures and any kind added after this view shipped, with their reason. */
function unclassified(diagnostics: readonly AttentionDiagnosticPayload[]): AttentionDiagnosticPayload[] {
  return diagnostics.filter((entry) => !CLASSIFIED_KINDS.includes(entry.kind));
}

function textOrUnknown(value: string): string {
  return value.length === 0 ? UNKNOWN_TEXT : truncateForRender(value);
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }): ReactNode {
  return (
    <section aria-labelledby={id} className="system-status__section">
      <h2 className="system-status__section-title" id={id}>
        {title}
      </h2>
      {children}
    </section>
  );
}

/** One line of prose a section states before, or instead of, its entries. */
function Summary({ text }: { text: string }): ReactNode {
  return <p className="system-status__summary">{text}</p>;
}

function Diagnostics({ entries }: { entries: readonly AttentionDiagnosticPayload[] }): ReactNode {
  if (entries.length === 0) {
    return <p className="system-status__none">{NONE_TEXT}</p>;
  }
  return (
    <ul className="system-status__diagnostics">
      {entries.map((entry, index) => (
        <li className="system-status__diagnostic" key={`${index}-${entry.kind}`}>
          <span className="system-status__kind">{truncateForRender(entry.kind)}</span>
          {SEPARATOR}
          <span className="system-status__scope">
            {entry.repository === null ? DASHBOARD_SCOPE : truncateForRender(entry.repository)}
          </span>
          {SEPARATOR}
          <span className="system-status__message">{truncateForRender(entry.message)}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The source's resolved-record count, when it is a number worth showing.
 *
 * Read back as `unknown` on purpose. The payload guard in `src/client/api.ts`
 * deliberately does not check this field, because that guard is all-or-nothing:
 * a value that failed validation would reject the whole payload and blank the
 * page over an advisory count, the hazard filed as
 * shakacode/agent-coordination-dashboard#146 and #166. So the type is a claim
 * nothing verifies, and the render site is what has to be total. An unusable
 * value simply goes unreported, exactly as an unreadable timestamp does.
 */
function resolvedTotal(source: AttentionSourcePayload): number | null {
  const value: unknown = source.resolved_total;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A source's read state as one line: mode, status, when, how many resolved, and either bound it hit. */
function sourceState(source: AttentionSourcePayload): string {
  const parts = [`mode ${source.mode}`, `status ${source.status}`, `checked ${textOrUnknown(source.checked_at)}`];
  const resolved = resolvedTotal(source);
  if (resolved !== null) {
    parts.push(`${resolved} resolved`);
  }
  if (source.partial) {
    parts.push("partial read");
  }
  if (source.truncated) {
    parts.push("truncated read");
  }
  return parts.join(SEPARATOR);
}

/** One card's identity, for the sections that list cards rather than diagnostics. */
function CardEntry({ card, detail }: { card: AttentionCardPayload; detail: string }): ReactNode {
  return (
    <>
      <span className="system-status__card-id">{truncateForRender(card.record.id ?? card.id)}</span>
      {SEPARATOR}
      <span className="system-status__card-repository">{truncateForRender(card.repository)}</span>
      {SEPARATOR}
      <span className="system-status__card-detail">{detail}</span>
    </>
  );
}

export interface SystemStatusProps {
  /** The last good payload, or `null` before the first successful fetch. */
  payload: AttentionPayload | null;
  /** Local instant of the last successful fetch, for the stale marker. */
  lastSuccessAt: number | null;
  /** Message of the most recent failed fetch since the last success. */
  failure: string | null;
  onBack: () => void;
}

export function SystemStatus({ payload, lastSuccessAt, failure, onBack }: SystemStatusProps): ReactNode {
  const header = (
    <header className="attention__header">
      <h1 className="attention__heading">{SYSTEM_STATUS_TITLE}</h1>
      <button className="attention__refresh" onClick={onBack} type="button">
        {BACK_LABEL}
      </button>
    </header>
  );

  if (payload === null) {
    return (
      <main className="attention system-status">
        <p className="system-status__no-action">{NO_ACTION_LINE}</p>
        {header}
        <p className="attention__status">{failure === null ? LOADING_LINE : NO_PAYLOAD_LINE}</p>
      </main>
    );
  }

  const staleMarker = staleMarkerLine(failure, lastSuccessAt);
  const { cards, diagnostics, sources } = payload;
  const partialSources = sources.filter((source) => source.partial);
  const truncatedSources = sources.filter((source) => source.truncated);
  // An auth_error source is how a token without the attention read prefix
  // arrives; its own message wins, and the shared fallback covers a source that
  // carries none, exactly as the Attention view's notice does.
  const missingScope = sources.filter((source) => source.status === "auth_error");
  const crossHostCards = cards.filter((card) => !card.host_matches);
  const flaggedCards = cards.filter((card) => card.verify_open_age);
  // "Capability unknown" is the launch capability: the dashboard cannot promise
  // the session opens natively, so the URI is shown as text to copy.
  const capabilityUnknownCards = cards.filter((card) => card.native_open === "unknown");

  return (
    <main className="attention system-status">
      <p className="system-status__no-action">{NO_ACTION_LINE}</p>
      {header}
      <p className="system-status__generated">{`Payload generated at ${textOrUnknown(payload.generated_at)}`}</p>
      {/* The page whose subject is backend health may not be the one page that
          forgets the backend is unreachable right now. Everything below
          describes the payload above, which is the last read that succeeded. */}
      {staleMarker === null ? null : <p className="attention__stale">{staleMarker}</p>}

      <Section id="system-status-dashboard-host" title="Dashboard host">
        <Summary text={`This dashboard reports its host as ${textOrUnknown(payload.dashboard_host)}.`} />
        <Diagnostics entries={ofKinds(diagnostics, DASHBOARD_HOST_KINDS)} />
      </Section>

      <Section id="system-status-sources" title="Backend source health">
        {sources.length === 0 ? (
          <p className="system-status__none">{NONE_TEXT}</p>
        ) : (
          <ul className="system-status__sources">
            {sources.map((source, index) => (
              <li className="system-status__source" key={`${index}-${source.repository}`}>
                <span className="system-status__source-repository">{textOrUnknown(source.repository)}</span>
                {SEPARATOR}
                <span className="system-status__source-state">{sourceState(source)}</span>
                {source.message === undefined ? null : (
                  <>
                    {SEPARATOR}
                    <span className="system-status__source-message">{truncateForRender(source.message)}</span>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section id="system-status-scope" title="Coordination read scope">
        {missingScope.length === 0 ? (
          <p className="system-status__none">{NONE_TEXT}</p>
        ) : (
          <ul className="system-status__scope-errors">
            {missingScope.map((source, index) => (
              <li className="system-status__scope-error" key={`${index}-${source.repository}`}>
                <span className="system-status__source-repository">{textOrUnknown(source.repository)}</span>
                {SEPARATOR}
                <span className="system-status__source-message">
                  {source.message === undefined || source.message.trim().length === 0
                    ? MISSING_SCOPE_MESSAGE
                    : truncateForRender(source.message)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section id="system-status-truncation" title="Truncation and partial reads">
        <Summary
          text={
            `${partialSources.length} of ${sources.length} repositories reported a partial read; ` +
            `${truncatedSources.length} truncated their card list.`
          }
        />
        <Diagnostics entries={ofKinds(diagnostics, TRUNCATION_KINDS)} />
      </Section>

      <Section id="system-status-stale" title="Stale sources and companions">
        <Diagnostics entries={ofKinds(diagnostics, STALE_KINDS)} />
      </Section>

      <Section id="system-status-suppressed-hosts" title="Suppressed hosts">
        <Diagnostics entries={ofKinds(diagnostics, SUPPRESSED_HOST_KINDS)} />
      </Section>

      <Section id="system-status-duplicates" title="Producer duplicates">
        <Diagnostics entries={ofKinds(diagnostics, PRODUCER_DUPLICATE_KINDS)} />
      </Section>

      <Section id="system-status-resolved" title="Resolved records (newest 20 per repository)">
        {/* Every source carries `resolved_total`, and Backend source health
            above reports it per repository; this section holds the newest 20
            the model kept and the warning raised once a repository crosses the
            500-record threshold. What kept the count out of reach was the
            client's duplicate copy of the payload types, and removing that
            duplication is issue #165's job. */}
        <Diagnostics entries={ofKinds(diagnostics, RESOLVED_KINDS)} />
      </Section>

      <Section id="system-status-cross-host" title="Cross-host items">
        <Summary text={`${crossHostCards.length} of ${cards.length} rendered cards belong to another host.`} />
        {crossHostCards.length === 0 ? null : (
          <ul className="system-status__cards">
            {crossHostCards.map((card, index) => (
              <li className="system-status__card" key={`${index}-${card.repository}#${card.id}`}>
                <CardEntry card={card} detail={`answerable on ${truncateForRender(card.host)}`} />
              </li>
            ))}
          </ul>
        )}
        <Diagnostics entries={ofKinds(diagnostics, CROSS_HOST_KINDS)} />
      </Section>

      <Section id="system-status-open-age" title="Open-age flagged">
        <Summary text={`${flaggedCards.length} of ${cards.length} rendered cards are flagged for their open age.`} />
        <Diagnostics entries={ofKinds(diagnostics, OPEN_AGE_KINDS)} />
      </Section>

      <Section id="system-status-capabilities" title="Capability-unknown links">
        <Summary
          text={`${capabilityUnknownCards.length} of ${cards.length} rendered cards report native open as unknown.`}
        />
        {capabilityUnknownCards.length === 0 ? null : (
          <ul className="system-status__cards">
            {capabilityUnknownCards.map((card, index) => {
              const openUri = card.record.source?.open_uri;
              return (
                <li className="system-status__card" key={`${index}-${card.repository}#${card.id}`}>
                  <CardEntry
                    card={card}
                    detail={`native open ${card.native_open} on ${truncateForRender(card.host)}`}
                  />
                  {SEPARATOR}
                  {typeof openUri === "string" ? (
                    <code className="system-status__uri">{openUri}</code>
                  ) : (
                    <span className="system-status__missing-uri">{NO_LAUNCH_URI_TEXT}</span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      <Section id="system-status-invalid" title="Invalid or unknown-class records">
        <Diagnostics entries={unclassified(diagnostics)} />
      </Section>
    </main>
  );
}
