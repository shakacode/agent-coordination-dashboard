/**
 * The Human Attention view: the dashboard's only page.
 *
 * It renders exactly what the payload says, in payload order, and numbers the
 * cards by list position so a gap in the payload's `number` field can never
 * break contiguity. Nothing here calls GitHub, launches an agent, or mutates a
 * coordination record: the view is read-only by construction.
 */

import { useState, type ReactNode } from "react";
import type { AttentionPayload, AttentionSourcePayload } from "../api";
import { AttentionCard } from "./AttentionCard";
import "./attention.css";

/** The one line the empty state adds under the header. */
export const EMPTY_STATE_LINE = "Nothing needs a decision. Backend health is on System Status.";

/** Fallback for an `auth_error` source that carries no message. */
export const MISSING_SCOPE_MESSAGE = "Coordination token lacks the attention read scope";

/** Shown before the first payload arrives. */
export const LOADING_LINE = "Loading actions…";

/** Shown when the first fetch failed and there is no last good payload to keep. */
export const NO_PAYLOAD_LINE = "Backend unreachable";

/**
 * The diagnostic kinds that describe the payload rather than report a loss.
 *
 * The set is closed and everything outside it counts as missing data, including
 * kinds added after this client ships. The direction is the point. An unknown
 * kind that is really harmless produces a warning the operator did not need,
 * and the cure is one line here once someone notices. The opposite default —
 * treating an unknown kind as harmless — hides a record the server dropped,
 * and nobody ever notices, because the whole symptom is an absence: the reader
 * suppresses a record with `stale_source` or `invalid_json` while the source
 * stays `ok` and not partial, and the page then says "0 actions need Justin"
 * with data genuinely missing. AGENTS.md line 32 asks for `UNKNOWN` or a
 * visible warning when state cannot be read, so the recoverable failure is the
 * only acceptable one.
 *
 * These six are what the model emits on healthy reads, and
 * `dashboard_host_unknown` is present on every machine whose
 * `AGENT_COORD_MACHINE_ID` is not exactly `M5` or `M1`, so counting them would
 * leave the notice permanently on and unread.
 *
 * The list is a stopgap: it is a copy of part of the model's vocabulary and it
 * will drift. Issue #164 is the durable answer — a server-side count of
 * suppressed records on the source, after which the client needs no vocabulary
 * at all and this set can go.
 */
export const INFORMATIONAL_DIAGNOSTIC_KINDS: readonly string[] = [
  "resolved_recent",
  "cross_host_count",
  "dashboard_host_unknown",
  "open_age_flagged",
  "producer_duplicate",
  "resolved_total_warning"
];

/** The operator name is the decided literal for 1a; PR 1b makes it a setting. */
const OPERATOR_NAME = "Justin";

/** Local 24-hour, zero-padded wall-clock time from an injected instant. */
export function formatClockTime(instantMs: number): string {
  const at = new Date(instantMs);
  const hours = String(at.getHours()).padStart(2, "0");
  const minutes = String(at.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

/** The count headline, with a verb that agrees with a single action. */
function countHeadline(total: number): string {
  return total === 1 ? `1 action needs ${OPERATOR_NAME}` : `${total} actions need ${OPERATOR_NAME}`;
}

type DegradationKind = "unreachable" | "auth_error" | "incomplete";

type Degradation =
  | { kind: "unreachable"; source: AttentionSourcePayload }
  | { kind: "auth_error"; source: AttentionSourcePayload }
  | { kind: "incomplete"; incompleteSources: number; diagnostics: number };

/**
 * The one degradation the page speaks for, in the decided precedence:
 * unreachable, then auth_error, then incomplete. An unreachable backend hides
 * the scope answer, and either of those hides whether the rest of the read was
 * complete, so the worse fact is the one that gets the line.
 *
 * Incomplete means records may be missing: a source that read only part of its
 * records, one whose read was truncated, or any diagnostic that is not purely
 * descriptive. In each the card count is a floor, not a total. A payload
 * carrying only informational diagnostics is not incomplete, so a clean read
 * with nothing to decide still reaches the empty state.
 * @see INFORMATIONAL_DIAGNOSTIC_KINDS
 */
function findDegradation(payload: AttentionPayload | null): Degradation | null {
  if (payload === null) {
    return null;
  }
  const unreachable = payload.sources.find((source) => source.status === "unreachable");
  if (unreachable !== undefined) {
    return { kind: "unreachable", source: unreachable };
  }
  const authError = payload.sources.find((source) => source.status === "auth_error");
  if (authError !== undefined) {
    return { kind: "auth_error", source: authError };
  }
  const incompleteSources = payload.sources.filter((source) => source.partial || source.truncated).length;
  // Every diagnostic counts in the notice once incompleteness is established,
  // informational ones included: the trigger is narrow, the count is not.
  const diagnostics = payload.diagnostics.length;
  const lostRecords = payload.diagnostics.some((entry) => !INFORMATIONAL_DIAGNOSTIC_KINDS.includes(entry.kind));
  if (incompleteSources > 0 || lostRecords) {
    return { kind: "incomplete", incompleteSources, diagnostics };
  }
  return null;
}

function degradationNotice(degradation: Degradation, sinceMs: number): string {
  if (degradation.kind === "unreachable") {
    return `Backend unreachable since ${formatClockTime(sinceMs)}`;
  }
  if (degradation.kind === "auth_error") {
    const message = degradation.source.message;
    return typeof message === "string" && message.trim().length > 0 ? message : MISSING_SCOPE_MESSAGE;
  }
  return `Some records may be missing: ${degradation.incompleteSources} repositories reported incomplete reads and ${degradation.diagnostics} diagnostics`;
}

/**
 * The header when no card arrived: a count reads as "nothing to do" when the
 * truth is "nothing readable", so the degradation takes the header instead.
 * Unreachable and auth_error say the whole story there and need no second line;
 * the incomplete header names the state and leaves its counts to the notice.
 */
function degradedHeadline(degradation: Degradation, sinceMs: number): string {
  if (degradation.kind === "incomplete") {
    return `Attention data incomplete since ${formatClockTime(sinceMs)}`;
  }
  return degradationNotice(degradation, sinceMs);
}

export interface AttentionViewProps {
  /** The last good payload, or `null` before the first successful fetch. */
  payload: AttentionPayload | null;
  /** Local instant of the last successful fetch, for the stale marker. */
  lastSuccessAt: number | null;
  /** Message of the most recent failed fetch since the last success. */
  failure: string | null;
  onRefresh: () => void;
  /** Injected clock, so ages and wall-clock times are deterministic in tests. */
  now: () => number;
}

export function AttentionView({ payload, lastSuccessAt, failure, onRefresh, now }: AttentionViewProps): ReactNode {
  const degradation = findDegradation(payload);
  const degradationKind: DegradationKind | null = degradation === null ? null : degradation.kind;
  // "since HH:MM" is when this run first saw this degradation, so the instant is
  // captured on the render that observes it, replaced when the kind changes, and
  // released when it clears.
  const [degradedSince, setDegradedSince] = useState<{ kind: DegradationKind; at: number } | null>(null);
  if (degradationKind === null && degradedSince !== null) {
    setDegradedSince(null);
  }
  if (degradationKind !== null && (degradedSince === null || degradedSince.kind !== degradationKind)) {
    setDegradedSince({ kind: degradationKind, at: now() });
  }

  const refreshButton = (
    <button className="attention__refresh" type="button" onClick={onRefresh}>
      Refresh now
    </button>
  );

  if (payload === null) {
    return (
      <main className="attention">
        <header className="attention__header">
          <h1 className="attention__heading">Human attention</h1>
          {refreshButton}
        </header>
        <p className="attention__status">{failure === null ? LOADING_LINE : NO_PAYLOAD_LINE}</p>
      </main>
    );
  }

  const cards = payload.cards;
  const total = cards.length;
  const sinceMs = degradedSince !== null && degradedSince.kind === degradationKind ? degradedSince.at : now();
  const headline =
    total === 0 && degradation !== null ? degradedHeadline(degradation, sinceMs) : countHeadline(total);
  // The unreachable and auth_error headers already carry their whole notice.
  const notice =
    degradation !== null && (total > 0 || degradation.kind === "incomplete")
      ? degradationNotice(degradation, sinceMs)
      : null;
  const staleMarker =
    failure !== null && lastSuccessAt !== null
      ? `last refresh ${formatClockTime(lastSuccessAt)}, backend unreachable`
      : null;

  return (
    <main className="attention">
      <header className="attention__header">
        <h1 className="attention__heading">{headline}</h1>
        {refreshButton}
      </header>
      {notice === null ? null : <p className="attention__notice">{notice}</p>}
      {staleMarker === null ? null : <p className="attention__stale">{staleMarker}</p>}
      {total === 0 && degradation === null ? <p className="attention__empty">{EMPTY_STATE_LINE}</p> : null}
      {total === 0 ? null : (
        <ol className="attention__cards">
          {cards.map((card, index) => (
            // The record's logical key is repository plus id, so two
            // repositories may carry the same id without colliding here.
            <li className="attention__card-item" key={`${card.repository}#${card.id}`}>
              <AttentionCard card={card} position={index + 1} total={total} now={now} />
            </li>
          ))}
        </ol>
      )}
    </main>
  );
}
