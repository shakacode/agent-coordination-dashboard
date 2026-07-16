import type { ClaimCustodyEvent, LivenessSpan, PhaseSpan } from "../../shared/custodyTimeline";
import type { BatchEvent } from "../../shared/types";
import { firstDisplayAttribution } from "../../shared/attribution";
import type { ItemTimelineResponse } from "../api";
import { OperatorActions, type AnnotationAction } from "./OperatorActions";
import { safePullRequestUrl } from "../githubUrls";
import { fallbackTimelineWorkItem } from "../../shared/fallbackWorkItem";

function duration(durationMs: number): string {
  const seconds = Math.max(0, Math.round(durationMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function parseTimestampMs(value: string | undefined): number | undefined {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : undefined;
}

// The formatters are shared across custody entries because constructing
// Intl.DateTimeFormat per entry is costly on long append-only chains, and
// they are created lazily at first render rather than module import so they
// capture the environment's time zone after tests have pinned it. The visible
// text is the operator's local wall clock; the exact ISO-8601 instant stays
// on the element for copy/paste.
let dayFormat: Intl.DateTimeFormat | undefined;
let clockFormat: Intl.DateTimeFormat | undefined;

function localDay(ms: number): string {
  dayFormat ??= new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
  return dayFormat.format(ms);
}

function localClock(ms: number): string {
  clockFormat ??= new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return clockFormat.format(ms);
}

function TimePoint({ value }: { value: string | undefined }) {
  const ms = parseTimestampMs(value);
  if (ms === undefined) return <>time UNKNOWN</>;
  const isoValue = new Date(ms).toISOString();
  return <time className="timeline-time" dateTime={isoValue} title={isoValue}>{localDay(ms)} {localClock(ms)}</time>;
}

function TimeRange({ startedAt, endedAt }: { startedAt: string; endedAt: string }) {
  const startMs = parseTimestampMs(startedAt);
  const endMs = parseTimestampMs(endedAt);
  if (startMs === undefined || endMs === undefined) return <>time UNKNOWN</>;
  const startIso = new Date(startMs).toISOString();
  const endIso = new Date(endMs).toISOString();
  const sameLocalDay = new Date(startMs).toDateString() === new Date(endMs).toDateString();
  return <><time className="timeline-time" dateTime={startIso} title={startIso}>{localDay(startMs)} {localClock(startMs)}</time>–<time className="timeline-time" dateTime={endIso} title={endIso}>{sameLocalDay ? localClock(endMs) : `${localDay(endMs)} ${localClock(endMs)}`}</time></>;
}

function sourceIsUnknown(timeline: ItemTimelineResponse): boolean {
  return timeline.sourceStatus.some((source) => ["auth_error", "unreachable"].includes(source.status));
}

function unique(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value?.trim()))));
}

export function uniquePullRequestUrls(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  return values.flatMap((value) => {
    if (!value?.trim()) return [];
    const safeValue = safePullRequestUrl(value);
    if (!safeValue) return [];
    const url = new URL(safeValue);
    const identity = `${url.hostname.toLowerCase()}${url.pathname.match(/^\/[^/]+\/[^/]+\/pull\/\d+/)?.[0] || url.pathname}`;
    if (seen.has(identity)) return [];
    seen.add(identity);
    return [safeValue];
  });
}

function TimelineWarnings({ timeline }: { timeline: ItemTimelineResponse }) {
  const warnings = timeline.warnings.filter(
    (warning, index, all) => all.findIndex((candidate) => candidate.severity === warning.severity && candidate.message === warning.message) === index
  );
  if (warnings.length === 0) return null;
  return <section aria-label="Timeline warnings">{warnings.map((warning) => (
    <p className={`item-timeline-warning item-timeline-warning-${warning.severity}`} key={`${warning.severity}:${warning.message}`}>
      {warning.severity.toUpperCase()}: {warning.message}
    </p>
  ))}</section>;
}

function copy(value: string) {
  void navigator.clipboard?.writeText(value);
}

function claimedHolderIsDead(timeline: ItemTimelineResponse, agentId: string): boolean {
  const heartbeat = timeline.item?.heartbeat;
  if (heartbeat?.agentId === agentId && !["unknown", "no-heartbeat"].includes(heartbeat.liveness)) {
    return heartbeat.liveness === "dead";
  }
  const latestLiveness = timeline.liveness
    .map((span, index) => ({ span, index }))
    .filter(({ span }) => span.agentId === agentId)
    .sort((left, right) =>
      Date.parse(left.span.startedAt) - Date.parse(right.span.startedAt)
      || Date.parse(left.span.endedAt) - Date.parse(right.span.endedAt)
      || left.index - right.index
    )
    .at(-1)?.span;
  return latestLiveness?.liveness === "dead";
}

function Handle({ handle }: { handle: string | undefined }) {
  if (!handle) return <span>Thread UNKNOWN</span>;
  return <button className="timeline-handle" onClick={() => copy(handle)} type="button">Copy thread handle {handle}</button>;
}

function Ownership({ machineId, host, operator }: { machineId?: string; host?: string; operator?: string }) {
  const details = [
    machineId ? `Machine: ${machineId}` : "Machine: UNKNOWN",
    host ? `Host: ${host}` : "",
    operator ? `Operator: ${operator}` : ""
  ].filter(Boolean);
  return <span>{details.join(" · ")}</span>;
}

function RowAnchors({ branch, prUrl }: { branch?: string; prUrl?: string }) {
  const href = prUrl ? safePullRequestUrl(prUrl) : undefined;
  const number = href?.match(/\/pull\/(\d+)(?:\/|$)/)?.[1];
  return <span className="timeline-anchors"><span>Branch: {branch || "UNKNOWN"}</span>{href ? <a href={href} rel="noreferrer" target="_blank">PR {number}</a> : <span>PR: UNKNOWN</span>}</span>;
}

function Claim({ event }: { event: ClaimCustodyEvent }) {
  const action = event.action === "taken_over"
    ? `${event.previousAgentId || "UNKNOWN"} → ${event.agentId}`
    : event.action === "unknown"
      ? `UNKNOWN ownership by ${event.agentId}`
      : `${event.action} by ${event.agentId}`;
  return <li className="timeline-entry timeline-claim"><strong>{action} · <TimePoint value={event.timestamp} /></strong><span>{event.generation === undefined ? "CAS generation UNKNOWN" : `CAS generation ${event.generation}`}</span><Ownership machineId={event.machineId} host={event.host} operator={event.operator} /><Handle handle={event.threadHandle} /><RowAnchors branch={event.branch} prUrl={event.prUrl} /></li>;
}

function Liveness({ span }: { span: LivenessSpan }) {
  const startMs = parseTimestampMs(span.startedAt);
  const endMs = parseTimestampMs(span.endedAt);
  const elapsed = startMs === undefined || endMs === undefined ? undefined : endMs - startMs;
  return <li className={`timeline-entry timeline-liveness timeline-${span.liveness}`}><strong>{span.liveness} · <TimeRange startedAt={span.startedAt} endedAt={span.endedAt} />{elapsed === undefined ? null : ` (${duration(elapsed)})`}</strong><span>{span.status} · {span.agentId}</span><Ownership machineId={span.machineId} host={span.host} operator={span.operator} /><Handle handle={span.threadHandle} /><RowAnchors branch={span.branch} prUrl={span.prUrl} /></li>;
}

function Phase({ span }: { span: PhaseSpan }) {
  return <li className="timeline-entry timeline-phase"><strong>{span.phase} · <TimeRange startedAt={span.startedAt} endedAt={span.endedAt} /> ({duration(span.durationMs)})</strong><span>{span.message || "Phase event"}</span><Ownership machineId={span.machineId} host={span.host} operator={span.operator} /><Handle handle={span.threadHandle} /><RowAnchors branch={span.branch} prUrl={span.prUrl} /></li>;
}

function Telemetry({ event }: { event: BatchEvent }) {
  return <li className="timeline-entry timeline-event"><strong>{event.type} · <TimePoint value={event.timestamp} /></strong><span>{event.status || event.message || "Telemetry evidence"}</span><Ownership machineId={event.machineId} host={event.host} operator={event.operator} /><Handle handle={event.threadHandle} /><RowAnchors branch={event.branch} prUrl={event.prUrl} /></li>;
}

function eventProvenanceKey(path: string | undefined, eventId: string | undefined): string | undefined {
  return path && eventId ? `${path}\u0000${eventId}` : undefined;
}

function claimKey(event: ClaimCustodyEvent, index: number): string {
  return eventProvenanceKey(event.sourceEventPath, event.sourceEventId)
    || `${event.timestamp || "UNKNOWN"}\u0000${event.agentId}\u0000${event.generation ?? "UNKNOWN"}\u0000${index}`;
}

function livenessKey(span: LivenessSpan, index: number): string {
  return `${span.agentId}\u0000${span.startedAt}\u0000${span.endedAt}\u0000${index}`;
}

function phaseKey(span: PhaseSpan, index: number): string {
  return eventProvenanceKey(span.eventPath, span.eventId)
    || `${span.eventId}\u0000${span.startedAt}\u0000${index}`;
}

function timelineTimestamp(value: string | undefined): number {
  return parseTimestampMs(value) ?? Number.MAX_SAFE_INTEGER;
}

export function ItemPage({ timeline, onBack, onAnnotate, onClearAnnotation, commandActionsDisabled = false }: { timeline: ItemTimelineResponse; onBack: () => void; onAnnotate?: (annotation: AnnotationAction) => Promise<void> | void; onClearAnnotation?: () => Promise<void> | void; commandActionsDisabled?: boolean }) {
  const heartbeat = timeline.item?.heartbeat;
  const terminal = ["terminal", "archived_view"].includes(timeline.item?.operatorState || "") || timeline.item?.terminalState !== undefined;
  const activeClaim = !terminal && timeline.item?.claim?.status === "active" ? timeline.item.claim : undefined;
  const heartbeatHolder = !terminal
    && !timeline.item?.claim
    && ["live", "stale"].includes(heartbeat?.liveness || "")
    ? heartbeat?.agentId
    : undefined;
  const loadedGitHub = timeline.item?.github?.loadState === "loaded" ? timeline.item.github : undefined;
  const holder = firstDisplayAttribution([activeClaim?.agentId, heartbeatHolder], "UNKNOWN");
  const state = timeline.item?.operatorState || "UNKNOWN";
  const holderDead = Boolean(activeClaim && claimedHolderIsDead(timeline, activeClaim.agentId));
  const actionItem = timeline.item || fallbackTimelineWorkItem(timeline.repo, timeline.target);
  const branches = unique([...timeline.branches, loadedGitHub?.branch]);
  const prUrls = uniquePullRequestUrls([...timeline.prUrls, loadedGitHub?.url]);
  const custodySourceEvents = new Set(timeline.claims.flatMap((claim) => {
    const provenance = eventProvenanceKey(claim.sourceEventPath, claim.sourceEventId);
    return provenance ? [provenance] : [];
  }));
  const eventIdCounts = new Map<string, number>();
  for (const event of timeline.events) {
    eventIdCounts.set(event.eventId, (eventIdCounts.get(event.eventId) || 0) + 1);
  }
  const custodyEntries = [
    ...timeline.claims.map((event, index) => ({ kind: "claim" as const, event, index, tie: 0, at: timelineTimestamp(event.timestamp) })),
    ...timeline.liveness.map((span, index) => ({ kind: "liveness" as const, span, index, tie: 1, at: timelineTimestamp(span.startedAt) })),
    ...timeline.events
      .filter((event) => !timeline.phases.some((span) => {
        const phaseProvenance = eventProvenanceKey(span.eventPath, span.eventId);
          return phaseProvenance
            ? phaseProvenance === eventProvenanceKey(event.path, event.eventId)
            : span.eventId === event.eventId && eventIdCounts.get(event.eventId) === 1;
      }))
      .filter((event) => {
        const provenance = eventProvenanceKey(event.path, event.eventId);
        return !provenance || !custodySourceEvents.has(provenance);
      })
      .map((event, index) => ({ kind: "event" as const, event, index, tie: 2, at: timelineTimestamp(event.timestamp) })),
    ...timeline.phases.map((span, index) => ({ kind: "phase" as const, span, index, tie: 3, at: timelineTimestamp(span.startedAt) }))
  ].sort((left, right) => left.at - right.at || left.tie - right.tie || left.index - right.index);
  return (
    <section aria-label="Work item timeline" className="item-page">
      <button className="secondary-action" onClick={onBack} type="button">Back to Find</button>
      <header className="item-page-header">
        <div>
          <p className="eyebrow">{timeline.repo}</p>
          <h1>Work item #{timeline.target}</h1>
          <p>Current state: {state}</p>
          <p>Holder: {holder}</p>
          <p>GitHub: {timeline.item?.github?.loadState === "loaded" ? `${timeline.item.github.state} · ${timeline.item.github.reviewDecision || "review UNKNOWN"} · CI: ${(timeline.item.github.ciStatus || "unknown").toUpperCase()}` : "UNKNOWN"}</p>
        </div>
        <OperatorActions commandActionsDisabled={commandActionsDisabled} item={actionItem} onAnnotate={onAnnotate} onClearAnnotation={onClearAnnotation} resumeAvailable={Boolean(timeline.item) && !terminal} takeoverAvailable={holderDead} />
      </header>
      {sourceIsUnknown(timeline) ? <p className="item-timeline-warning">Coordination data: UNKNOWN</p> : null}
      <TimelineWarnings timeline={timeline} />
      <section className="item-anchors" aria-label="GitHub anchors">
        {branches.length ? <span>Branch: {branches.join(", ")}</span> : <span>Branch: UNKNOWN</span>}
        {prUrls.length ? prUrls.map((href) => {
          const number = href.match(/\/pull\/(\d+)(?:\/|$)/)?.[1];
          return <a href={href} key={href} rel="noreferrer" target="_blank">PR {number}</a>;
        }) : <span>PR: UNKNOWN</span>}
      </section>
      <section aria-label="Full custody chain">
        <h2>Full custody chain</h2>
        <p className="custody-direction">Ordered oldest → newest</p>
        <ol className="custody-timeline">
          {custodyEntries.map((entry) => {
            if (entry.kind === "claim") return <Claim event={entry.event} key={`claim-${claimKey(entry.event, entry.index)}`} />;
            if (entry.kind === "liveness") return <Liveness span={entry.span} key={`liveness-${livenessKey(entry.span, entry.index)}`} />;
            if (entry.kind === "event") return <Telemetry event={entry.event} key={`event-${entry.event.path}\u0000${entry.event.eventId}`} />;
            return <Phase span={entry.span} key={`phase-${phaseKey(entry.span, entry.index)}`} />;
          })}
        </ol>
      </section>
    </section>
  );
}
