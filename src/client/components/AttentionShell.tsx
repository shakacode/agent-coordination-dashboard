import type { WorkItem } from "../../shared/types";

export type DashboardSurface = "attention" | "now" | "find" | "history";

function workLabel(item: WorkItem): string {
  const kind = item.type === "pull_request" ? "PR" : item.type === "issue" ? "Issue" : "Work";
  return `${kind} #${item.target}`;
}

function itemTitle(item: WorkItem): string {
  return item.github?.title || "Unattributed work item";
}

function holder(item: WorkItem): string {
  return item.claim?.agentId || item.heartbeat?.agentId || "unattributed";
}

function matches(item: WorkItem, query: string): boolean {
  const value = query.trim().toLowerCase();
  if (!value) return true;
  return [
    item.repo,
    item.target,
    item.github?.url,
    item.claim?.branch,
    item.heartbeat?.branch,
    item.claim?.threadHandle,
    item.heartbeat?.threadHandle,
    item.claim?.machineId,
    item.heartbeat?.machineId,
    ...item.batchSignals?.flatMap((signal) => [signal.batchId, signal.laneName]) || []
  ]
    .filter(Boolean)
    .some((candidate) => String(candidate).toLowerCase().includes(value));
}

function elapsedSince(value: string | undefined): string {
  const timestamp = value ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(timestamp)) return "unattributed";
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

function WorkCard({ item, onCopyResume }: { item: WorkItem; onCopyResume?: (item: WorkItem) => void }) {
  const reason = item.attention;
  const heartbeat = item.heartbeat;
  const phase = heartbeat?.status || item.batchSignals?.[0]?.status || "unattributed";
  const machine = heartbeat?.machineId || item.claim?.machineId || "unattributed";
  const thread = heartbeat?.threadHandle || item.claim?.threadHandle || "unattributed";
  const elapsed = elapsedSince(item.lastActivityAt || heartbeat?.updatedAt || item.claim?.updatedAt);
  return (
    <article className="attention-card">
      <div>
        <p className="attention-card-kicker">{item.repo}</p>
        <h2>{workLabel(item)}: {itemTitle(item)}</h2>
        {reason ? <p>{reason.label}</p> : null}
        <p className="attention-card-meta">Holder: {holder(item)} · {item.batchSignals?.[0]?.batchId || "unbatched"}</p>
        <p className="attention-card-meta"><span>Phase: {phase}</span> · {elapsed} ago · {machine} · {thread}</p>
      </div>
      <div className="attention-card-actions">
        {reason?.action === "Copy resume prompt" ? (
          <button onClick={() => onCopyResume?.(item)} type="button">Copy resume prompt</button>
        ) : null}
        {item.github?.url ? <a href={item.github.url} rel="noreferrer" target="_blank">Open</a> : null}
      </div>
    </article>
  );
}

export function AttentionShell({
  items,
  surface,
  query,
  onQueryChange,
  onCopyResume
}: {
  items: WorkItem[];
  surface: DashboardSurface;
  query: string;
  onQueryChange: (query: string) => void;
  onCopyResume?: (item: WorkItem) => void;
}) {
  const attentionItems = items.filter((item) => item.operatorState === "needs_attention");
  const runningItems = items.filter((item) => item.heartbeat && ["live", "stale"].includes(item.heartbeat.liveness));
  const historyItems = items.filter((item) => ["terminal", "archived_view"].includes(item.operatorState || ""));
  const runningToday = items.filter((item) => item.operatorState === "running").length;
  const mergedToday = historyItems.filter((item) => item.terminalState === "done").length;

  if (surface === "attention") {
    return (
      <section aria-label="Attention" className="attention-surface">
        <header className="attention-surface-header">
          <div>
            <p className="eyebrow">Mission control</p>
            <h1>Attention</h1>
          </div>
          <span className="status-strip">{runningToday} running · {attentionItems.length} need attention</span>
        </header>
        {attentionItems.length === 0 ? (
          <p className="empty-state">All clear — {runningToday} lanes running, {mergedToday} merged today.</p>
        ) : (
          <div className="attention-card-list">{attentionItems.map((item) => <WorkCard item={item} key={item.id} onCopyResume={onCopyResume} />)}</div>
        )}
      </section>
    );
  }

  if (surface === "now") {
    const byBatch = new Map<string, WorkItem[]>();
    for (const item of runningItems) {
      const batch = item.batchSignals?.[0]?.batchId || "Unbatched";
      byBatch.set(batch, [...(byBatch.get(batch) || []), item]);
    }
    return (
      <section aria-label="Now" className="attention-surface">
        <header className="attention-surface-header"><div><p className="eyebrow">Live work only</p><h1>Now</h1></div><span className="status-strip">{runningItems.length} live or stale</span></header>
        {byBatch.size === 0 ? <p className="empty-state">No live lanes right now.</p> : Array.from(byBatch).map(([batch, batchItems]) => (
          <section className="now-batch" key={batch}><h2>{batch}</h2>{batchItems.map((item) => <WorkCard item={item} key={item.id} />)}</section>
        ))}
      </section>
    );
  }

  if (surface === "history") {
    return (
      <section aria-label="History" className="attention-surface">
        <header className="attention-surface-header"><div><p className="eyebrow">Terminal and archived work</p><h1>History</h1></div><span className="status-strip">{historyItems.length} items</span></header>
        {historyItems.length === 0 ? <p className="empty-state">No terminal work has been observed.</p> : <div className="attention-card-list">{historyItems.map((item) => <WorkCard item={item} key={item.id} />)}</div>}
      </section>
    );
  }

  const results = items.filter((item) => matches(item, query));
  return (
    <section aria-label="Find" className="attention-surface">
      <header className="attention-surface-header"><div><p className="eyebrow">Target, branch, batch, thread, or machine</p><h1>Find</h1></div></header>
      <label className="search-field"><span>⌘K</span><input aria-label="Find work" autoFocus onChange={(event) => onQueryChange(event.target.value)} placeholder="Find work" value={query} /></label>
      {results.length === 0 ? <p className="empty-state">No work items match this search.</p> : <div className="attention-card-list">{results.map((item) => <WorkCard item={item} key={item.id} onCopyResume={onCopyResume} />)}</div>}
    </section>
  );
}
