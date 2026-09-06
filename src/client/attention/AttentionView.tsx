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

/** The operator name is the decided literal for 1a; PR 1b makes it a setting. */
const OPERATOR_NAME = "Justin";

/** Local 24-hour, zero-padded wall-clock time from an injected instant. */
export function formatClockTime(instantMs: number): string {
  const at = new Date(instantMs);
  const hours = String(at.getHours()).padStart(2, "0");
  const minutes = String(at.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

/**
 * The one source the degraded line speaks for: an unreachable source outranks
 * an auth error, because an unreachable backend hides the scope answer too.
 */
function findDegradedSource(payload: AttentionPayload | null): AttentionSourcePayload | null {
  if (payload === null) {
    return null;
  }
  return (
    payload.sources.find((source) => source.status === "unreachable") ??
    payload.sources.find((source) => source.status === "auth_error") ??
    null
  );
}

function degradedLine(source: AttentionSourcePayload, degradedSinceMs: number): string {
  if (source.status === "auth_error") {
    const message = source.message;
    return typeof message === "string" && message.trim().length > 0 ? message : MISSING_SCOPE_MESSAGE;
  }
  return `Backend unreachable since ${formatClockTime(degradedSinceMs)}`;
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
  const degradedSource = findDegradedSource(payload);
  // "since HH:MM" is when this run first saw the degradation, so the instant is
  // captured on the render that observes it and released when it clears.
  const [degradedSince, setDegradedSince] = useState<number | null>(null);
  if (degradedSource !== null && degradedSince === null) {
    setDegradedSince(now());
  }
  if (degradedSource === null && degradedSince !== null) {
    setDegradedSince(null);
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
  const notice = degradedSource === null ? null : degradedLine(degradedSource, degradedSince ?? now());
  // With no cards and a degraded source the count is not the truth, so the
  // degraded line takes the header instead of claiming zero actions.
  const degradedEmpty = total === 0 && notice !== null;
  const staleMarker =
    failure !== null && lastSuccessAt !== null
      ? `last refresh ${formatClockTime(lastSuccessAt)}, backend unreachable`
      : null;

  return (
    <main className="attention">
      <header className="attention__header">
        <h1 className="attention__heading">
          {degradedEmpty ? notice : `${total} actions need ${OPERATOR_NAME}`}
        </h1>
        {refreshButton}
      </header>
      {notice !== null && !degradedEmpty ? <p className="attention__notice">{notice}</p> : null}
      {staleMarker === null ? null : <p className="attention__stale">{staleMarker}</p>}
      {total === 0 && notice === null ? <p className="attention__empty">{EMPTY_STATE_LINE}</p> : null}
      {total === 0 ? null : (
        <ol className="attention__cards">
          {cards.map((card, index) => (
            <li className="attention__card-item" key={card.id}>
              <AttentionCard card={card} position={index + 1} total={total} now={now} />
            </li>
          ))}
        </ol>
      )}
    </main>
  );
}
