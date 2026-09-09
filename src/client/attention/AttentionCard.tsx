/**
 * One attention card.
 *
 * Every value arrives as a React text node: no Markdown, no HTML, and no
 * raw-HTML sink anywhere under `src/client`, which a test enforces by scanning
 * the client source. The only two anchors a card may render come from
 * `record.target` and `record.walkthrough_url`, which `projectAttentionRecord`
 * has already validated or set to `null`; the card never validates a raw field
 * itself and never builds an href from anything else. The `codex://` launch URI
 * is always copyable text, never a link.
 */

import type { ReactNode } from "react";
import type { AttentionCardPayload } from "../api";

/** Rendered in place of the pull request anchor when `target` did not validate. */
export const MISSING_TARGET_TEXT = "PR link unavailable";

/** Rendered when `created_at` is missing or unparsable, per the repo's UNKNOWN rule. */
export const UNKNOWN_AGE_TEXT = "age UNKNOWN";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Age in whole hours under one day, otherwise in whole days. */
export function formatAge(createdAt: string | undefined, nowMs: number): string {
  if (typeof createdAt !== "string") {
    return UNKNOWN_AGE_TEXT;
  }
  const createdMs = Date.parse(createdAt);
  if (Number.isNaN(createdMs)) {
    return UNKNOWN_AGE_TEXT;
  }
  // A record stamped in the future is a clock skew, not a negative age.
  const elapsedMs = Math.max(0, nowMs - createdMs);
  if (elapsedMs < DAY_MS) {
    const hours = Math.floor(elapsedMs / HOUR_MS);
    return `${hours} ${hours === 1 ? "hour" : "hours"} old`;
  }
  const days = Math.floor(elapsedMs / DAY_MS);
  return `${days} ${days === 1 ? "day" : "days"} old`;
}

function TextField({ label, value }: { label: string; value: string | undefined }): ReactNode {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  return (
    <>
      <dt className="attention-field__term">{label}</dt>
      <dd className="attention-field__value">{value}</dd>
    </>
  );
}

function ChoicesField({ choices }: { choices: string[] | undefined }): ReactNode {
  if (!Array.isArray(choices) || choices.length === 0) {
    return null;
  }
  return (
    <>
      <dt className="attention-field__term">Choices</dt>
      <dd className="attention-field__value">
        <ul className="attention-choices">
          {choices.map((choice, index) => (
            <li key={`${index}-${choice}`}>{choice}</li>
          ))}
        </ul>
      </dd>
    </>
  );
}

export interface AttentionCardProps {
  card: AttentionCardPayload;
  /** Contiguous 1-based list position; never the payload's `number`. */
  position: number;
  total: number;
  /** Injected clock, so the age is deterministic in tests. */
  now: () => number;
}

export function AttentionCard({ card, position, total, now }: AttentionCardProps): ReactNode {
  const { record } = card;
  const labelId = `attention-card-${position}`;
  const recordId = record.id ?? card.id;
  const title = typeof record.hil_task_title === "string" ? record.hil_task_title : null;
  const companionTitle = title ?? recordId;
  const target = typeof record.target === "string" ? record.target : null;
  const walkthroughUrl = typeof record.walkthrough_url === "string" ? record.walkthrough_url : null;
  const openUri = typeof record.source?.open_uri === "string" ? record.source.open_uri : null;
  // The payload decides where the session lives; the card never guesses.
  const opensHere = card.host_matches && card.native_open === "available";
  const hasCardFields = [record.what_changes, record.risk_downside, record.recommendation, record.one_action].some(
    (value) => typeof value === "string" && value.length > 0
  );

  const decisionFields = (
    <>
      <TextField label="Question" value={record.question} />
      <ChoicesField choices={record.choices} />
      <TextField label="Why now" value={record.priority_reason} />
    </>
  );

  return (
    <article className="attention-card" aria-labelledby={labelId}>
      <h2 className="attention-card__label" id={labelId}>
        {`${position} of ${total}`}
      </h2>
      {title === null ? null : <p className="attention-card__title">{title}</p>}
      <p className="attention-card__meta">
        <span className="attention-card__host">{card.host}</span>
        <span className="attention-card__age">{formatAge(record.created_at, now())}</span>
        <span className="attention-card__repository">{card.repository}</span>
        {card.same_pr ? <span className="attention-card__flag">same PR</span> : null}
        {card.verify_open_age ? (
          <span className="attention-card__flag">
            {`verify: open ${card.open_days} ${card.open_days === 1 ? "day" : "days"}`}
          </span>
        ) : null}
      </p>
      <dl className="attention-card__fields">
        {hasCardFields ? (
          <>
            <TextField label="What changes" value={record.what_changes} />
            <TextField label="Real risk" value={record.risk_downside} />
            <TextField label="Recommendation" value={record.recommendation} />
            <TextField label="One action" value={record.one_action} />
          </>
        ) : (
          decisionFields
        )}
      </dl>
      <p className="attention-card__links">
        {target === null ? (
          <span className="attention-card__missing-link">{MISSING_TARGET_TEXT}</span>
        ) : (
          <a className="attention-card__link" href={target} target="_blank" rel="noopener noreferrer">
            {target}
          </a>
        )}
        {walkthroughUrl === null ? null : (
          <a className="attention-card__link" href={walkthroughUrl} target="_blank" rel="noopener noreferrer">
            {walkthroughUrl}
          </a>
        )}
      </p>
      {openUri === null ? null : (
        <p className="attention-card__open">
          {opensHere ? null : (
            <span className="attention-card__open-hint">{`open on ${card.host}: ${companionTitle}`}</span>
          )}
          <code className="attention-card__uri">{openUri}</code>
        </p>
      )}
      <details className="attention-card__details">
        <summary>Technical details</summary>
        <dl className="attention-card__fields">
          {hasCardFields ? decisionFields : null}
          <TextField label="Kind" value={record.kind} />
          <TextField label="Safe resume" value={record.safe_resume} />
          <TextField label="Created" value={record.created_at} />
          <TextField label="Refreshed" value={record.refreshed_at} />
          <TextField label="Resolved" value={record.resolved_at} />
          <TextField label="Record id" value={recordId} />
          {card.number === position ? null : <TextField label="Payload number" value={String(card.number)} />}
        </dl>
      </details>
    </article>
  );
}
