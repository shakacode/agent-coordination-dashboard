import type { ClaimCustodyEvent, LivenessSpan, PhaseSpan } from "../../shared/custodyTimeline";
import { firstDisplayAttribution } from "../../shared/attribution";
import type { ItemTimelineResponse } from "../api";

function duration(durationMs: number): string {
  const seconds = Math.max(0, Math.round(durationMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function sourceIsUnknown(timeline: ItemTimelineResponse): boolean {
  return timeline.sourceStatus.some((source) => ["auth_error", "unreachable"].includes(source.status));
}

function safePullRequestUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.toLowerCase() === "github.com" && /^\/[^/]+\/[^/]+\/pull\/\d+\/?$/.test(url.pathname)
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function copy(value: string) {
  void navigator.clipboard?.writeText(value);
}

function Handle({ handle }: { handle: string | undefined }) {
  if (!handle) return <span>Thread UNKNOWN</span>;
  return <button className="timeline-handle" onClick={() => copy(handle)} type="button">Copy thread handle {handle}</button>;
}

function Claim({ event }: { event: ClaimCustodyEvent }) {
  const action = event.action === "taken_over" ? `${event.previousAgentId || "UNKNOWN"} → ${event.agentId}` : `${event.action} by ${event.agentId}`;
  return <li className="timeline-entry timeline-claim"><strong>{action}</strong><span>{event.generation === undefined ? "CAS generation UNKNOWN" : `CAS generation ${event.generation}`}</span><Handle handle={event.threadHandle} /></li>;
}

function Liveness({ span }: { span: LivenessSpan }) {
  const elapsed = Date.parse(span.endedAt) - Date.parse(span.startedAt);
  return <li className={`timeline-entry timeline-liveness timeline-${span.liveness}`}><strong>{span.liveness} · {duration(elapsed)}</strong><span>{span.status} · {span.agentId}</span><Handle handle={span.threadHandle} /></li>;
}

function Phase({ span }: { span: PhaseSpan }) {
  return <li className="timeline-entry timeline-phase"><strong>{span.phase} · {duration(span.durationMs)}</strong><span>{span.message || "Phase event"}</span><Handle handle={span.threadHandle} /></li>;
}

export function ItemPage({ timeline, onBack }: { timeline: ItemTimelineResponse; onBack: () => void }) {
  const holder = firstDisplayAttribution([timeline.item?.heartbeat?.agentId, timeline.item?.claim?.agentId]);
  const state = timeline.item?.operatorState || "UNKNOWN";
  const holderDead = timeline.item?.heartbeat?.liveness === "dead";
  const primary = holderDead
    ? { label: "Copy takeover command", value: `agent-coord claim --repo ${timeline.repo} --target ${timeline.target} --agent-id REPLACE_WITH_YOUR_AGENT_ID` }
    : { label: "Copy resume prompt", value: `Resume work item ${timeline.repo}#${timeline.target} from its custody timeline.` };
  const custodyEntries = [
    ...timeline.claims.map((event, index) => ({ kind: "claim" as const, event, index, tie: 0, at: Date.parse(event.timestamp || "") || Number.MAX_SAFE_INTEGER })),
    ...timeline.liveness.map((span, index) => ({ kind: "liveness" as const, span, index, tie: 1, at: Date.parse(span.startedAt) || Number.MAX_SAFE_INTEGER })),
    ...timeline.phases.map((span, index) => ({ kind: "phase" as const, span, index, tie: 2, at: Date.parse(span.startedAt) || Number.MAX_SAFE_INTEGER }))
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
          <p>GitHub: {timeline.item?.github?.loadState === "loaded" ? `${timeline.item.github.state} · ${timeline.item.github.reviewDecision || "review UNKNOWN"}` : "UNKNOWN"}</p>
        </div>
        <button onClick={() => copy(primary.value)} type="button">{primary.label}</button>
      </header>
      {sourceIsUnknown(timeline) ? <p className="item-timeline-warning">Coordination data: UNKNOWN</p> : null}
      <section className="item-anchors" aria-label="GitHub anchors">
        {timeline.branches.length ? <span>Branch: {timeline.branches.join(", ")}</span> : <span>Branch: UNKNOWN</span>}
        {timeline.prUrls.length ? timeline.prUrls.map((value) => {
          const href = safePullRequestUrl(value);
          const number = href?.match(/\/pull\/(\d+)\/?$/)?.[1];
          return href ? <a href={href} key={href} rel="noreferrer" target="_blank">PR {number}</a> : <span key={value}>PR UNKNOWN</span>;
        }) : <span>PR: UNKNOWN</span>}
      </section>
      <section aria-label="Full custody chain">
        <h2>Full custody chain</h2>
        <ol className="custody-timeline">
          {custodyEntries.map((entry) => {
            if (entry.kind === "claim") return <Claim event={entry.event} key={`claim-${entry.event.timestamp || entry.index}-${entry.event.agentId}`} />;
            if (entry.kind === "liveness") return <Liveness span={entry.span} key={`liveness-${entry.span.startedAt}-${entry.span.agentId}-${entry.index}`} />;
            return <Phase span={entry.span} key={`phase-${entry.span.eventId}`} />;
          })}
        </ol>
      </section>
    </section>
  );
}
