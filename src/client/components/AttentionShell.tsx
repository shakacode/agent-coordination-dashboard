import type { WorkItem } from "../../shared/types";
import { isOperationalWorkItem, isSelectableWorkItem } from "../../shared/workItemSelection";
import { displayAttribution, firstDisplayAttribution } from "../../shared/attribution";
import type { OperatorDeepLink, OverviewOperatorFilter } from "../operatorRows";
import { OperatorActions, type AnnotationAction } from "./OperatorActions";

export type DashboardSurface = "attention" | "now" | "find" | "history";

function workLabel(item: WorkItem): string {
  const kind = item.type === "pull_request" ? "PR" : item.type === "issue" ? "Issue" : "Work";
  const target = displayAttribution(item.target);
  return `${kind}${target === "unattributed" ? " unattributed" : ` #${target}`}`;
}

function itemTitle(item: WorkItem): string {
  return displayAttribution(item.github?.title, "Unattributed work item");
}

function holder(item: WorkItem): string {
  return firstDisplayAttribution([item.claim?.agentId, item.heartbeat?.agentId]);
}

function canonicalGithubItemUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") return undefined;
    const pathname = url.pathname.replace(/\/$/, "");
    if (!/^\/[^/]+\/[^/]+\/(?:pull|issues)\/\d+$/.test(pathname)) return undefined;
    return `${url.origin.toLowerCase()}${pathname.toLowerCase()}`;
  } catch {
    return undefined;
  }
}

function matches(item: WorkItem, query: string): boolean {
  const value = query.trim().toLowerCase();
  if (!value) return true;
  if (/^#?\d+$/.test(value)) return item.target === value.replace(/^#/, "");
  const githubItemUrl = canonicalGithubItemUrl(query.trim());
  if (githubItemUrl) {
    return [item.github?.url, item.claim?.prUrl, item.heartbeat?.prUrl]
      .some((candidate) => canonicalGithubItemUrl(candidate) === githubItemUrl);
  }
  if (/^[^/#\s]+\/[^/#\s]+#\d+$/.test(value)) return item.id.toLowerCase() === value;
  return [
    item.id,
    item.repo,
    item.target,
    item.github?.title,
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

function isNowItem(item: WorkItem): boolean {
  return Boolean(
    item.heartbeat
    && ["live", "stale"].includes(item.heartbeat.liveness)
    && isOperationalWorkItem(item)
  );
}

function matchesOverviewFilter(item: WorkItem, filter: OverviewOperatorFilter | undefined, repairWorkItemIds: ReadonlySet<string>): boolean {
  if (!filter) return true;
  if (!isOperationalWorkItem(item)) return false;
  if (filter === "ready_for_batch") return item.schedulingState === "ready_for_batch";
  if (filter === "needs_recovery") return item.schedulingState === "started_not_processing";
  if (filter === "processing_now") return isNowItem(item);
  if (filter === "qa_attention") return item.attention?.kind === "qa_missing";
  return item.attention?.kind === "batch_stopped"
    || item.attention?.kind === "batch_stop_requested"
    || repairWorkItemIds.has(item.id)
    || item.batchSignals?.some((signal) => /repair|missing|mismatch|stopp/i.test(signal.status)) === true;
}

function matchesDeepLink(item: WorkItem, deepLink: OperatorDeepLink | undefined, repairWorkItemIds: ReadonlySet<string>): boolean {
  if (!deepLink) return true;
  if (deepLink.repo && item.repo !== deepLink.repo) return false;
  if (deepLink.target && item.target !== deepLink.target) return false;
  if (deepLink.batchId || deepLink.laneName) {
    const sameSignalMatch = item.batchSignals?.some((signal) =>
      (!deepLink.batchId || signal.batchId === deepLink.batchId)
      && (!deepLink.laneName || signal.laneName === deepLink.laneName)
    );
    if (!sameSignalMatch) return false;
  }
  return matchesOverviewFilter(item, deepLink.overviewFilter, repairWorkItemIds);
}

function elapsedSince(value: string | undefined): string {
  const timestamp = value ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(timestamp)) return "unattributed";
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

function activityTime(item: WorkItem): number {
  const value = Date.parse(item.lastActivityAt || "");
  return Number.isFinite(value) ? value : 0;
}

function WorkCard({
  item,
  onToggle,
  selectionDisabled = false,
  onOpenBatchOperations,
  onOpenItem,
  onAnnotate,
  onClearAnnotation,
  now
}: {
  item: WorkItem;
  onToggle?: (id: string) => void;
  selectionDisabled?: boolean;
  onOpenBatchOperations?: () => void;
  onOpenItem?: (item: WorkItem) => void;
  onAnnotate?: (item: WorkItem, annotation: AnnotationAction) => Promise<void> | void;
  onClearAnnotation?: (item: WorkItem) => Promise<void> | void;
  now: Date | string;
}) {
  const reason = item.attention;
  const heartbeat = item.heartbeat;
  const phase = heartbeat?.status || item.batchSignals?.[0]?.status || "unattributed";
  const machine = firstDisplayAttribution([heartbeat?.machineId, item.claim?.machineId]);
  const thread = firstDisplayAttribution([heartbeat?.threadHandle, item.claim?.threadHandle]);
  const elapsed = elapsedSince(item.lastActivityAt || heartbeat?.updatedAt || item.claim?.updatedAt);
  const githubUrl = canonicalGithubItemUrl(item.github?.url) ? item.github?.url : undefined;
  return (
    <article className="attention-card">
      <div>
        <p className="attention-card-kicker">{displayAttribution(item.repo)}</p>
        <h2>{workLabel(item)}: {itemTitle(item)}</h2>
        {reason ? <p>{reason.label}</p> : null}
        {item.annotation?.kind === "dismiss" ? <p className="attention-card-meta">Dismissed by operator</p> : null}
        {item.annotation?.kind === "snooze" ? <p className="attention-card-meta">Snoozed until {item.annotation.until}</p> : null}
        {item.terminalProvenance?.source === "github" ? <p className="attention-card-meta">Derived from GitHub</p> : null}
        {item.github?.loadState === "unknown" ? <p className="attention-card-meta">GitHub state: UNKNOWN</p> : null}
        {item.github?.branchState === "deleted" ? <p className="attention-card-meta">Branch deleted (supporting signal)</p> : null}
        {item.github?.branchState === "unknown" ? <p className="attention-card-meta">Branch state: UNKNOWN</p> : null}
        <p className="attention-card-meta">Holder: {holder(item)} · {displayAttribution(item.batchSignals?.[0]?.batchId, "unbatched")}</p>
        <p className="attention-card-meta"><span>Phase: {phase}</span> · {elapsed} ago · {machine} · {thread}</p>
      </div>
      <div className="attention-card-actions">
        {onOpenItem ? <button onClick={() => onOpenItem(item)} type="button">Open timeline</button> : null}
        {isSelectableWorkItem(item) ? (
          <label className="attention-card-select">
            <input
              aria-label={`Include ${item.id} in PR-batch prompt`}
              checked={item.selected}
              disabled={selectionDisabled}
              onChange={() => onToggle?.(item.id)}
              type="checkbox"
            />
            <span>Batch</span>
          </label>
        ) : null}
        {reason?.action === "Open batch operations" ? (
          <button onClick={onOpenBatchOperations} type="button">Open batch operations</button>
        ) : null}
        {githubUrl ? <a href={githubUrl} rel="noreferrer" target="_blank">{item.github?.state.toLowerCase() === "merged" ? "Open merge" : "Open"}</a> : null}
        <OperatorActions
          item={item}
          now={new Date(now)}
          onAnnotate={onAnnotate ? (annotation) => onAnnotate(item, annotation) : undefined}
          onClearAnnotation={onClearAnnotation ? () => onClearAnnotation(item) : undefined}
          takeoverAvailable={reason?.kind === "dead_holder"}
        />
      </div>
    </article>
  );
}

export function AttentionShell({
  items,
  surface,
  query,
  onQueryChange,
  onToggle,
  selectionDisabled = false,
  now = new Date(),
  deepLink,
  onSurfaceChange,
  onOpenBatchOperations,
  onOpenItem,
  onClearDeepLink,
  mergeTimeStatus = "unavailable",
  historyMergedTodayOnly = false,
  onShowMergedToday,
  onAnnotate,
  onClearAnnotation,
  repairWorkItemIds = new Set<string>(),
  repairBatchCount = 0
}: {
  items: WorkItem[];
  surface: DashboardSurface;
  query: string;
  onQueryChange: (query: string) => void;
  onToggle?: (id: string) => void;
  selectionDisabled?: boolean;
  now?: Date | string;
  deepLink?: OperatorDeepLink;
  onSurfaceChange?: (surface: DashboardSurface) => void;
  onOpenBatchOperations?: () => void;
  onOpenItem?: (item: WorkItem) => void;
  onClearDeepLink?: () => void;
  mergeTimeStatus?: "available" | "unavailable";
  historyMergedTodayOnly?: boolean;
  onShowMergedToday?: () => void;
  onAnnotate?: (item: WorkItem, annotation: AnnotationAction) => Promise<void> | void;
  onClearAnnotation?: (item: WorkItem) => Promise<void> | void;
  repairWorkItemIds?: ReadonlySet<string>;
  repairBatchCount?: number;
}) {
  const attentionItems = items.filter((item) => item.operatorState === "needs_attention");
  const runningItems = items.filter(isNowItem);
  const historyItems = items
    .filter((item) => ["terminal", "archived_view"].includes(item.operatorState || ""))
    .sort((left, right) => activityTime(right) - activityTime(left));
  const runningToday = runningItems.length;
  const currentDay = new Date(now).toDateString();
  const mergedTodayItems = historyItems.filter((item) =>
    item.github?.type === "pull_request"
    && item.github.state.toLowerCase() === "merged"
    && item.github.mergedAt
    && new Date(item.github.mergedAt).toDateString() === currentDay
  );
  const mergedToday = mergedTodayItems.length;
  const card = (item: WorkItem, allowResume = true) => (
    <WorkCard
      item={item}
      key={item.id}
      onToggle={onToggle}
      selectionDisabled={selectionDisabled}
      onOpenBatchOperations={onOpenBatchOperations}
      onOpenItem={onOpenItem}
      onAnnotate={allowResume ? onAnnotate : undefined}
      onClearAnnotation={onClearAnnotation}
      now={now}
    />
  );

  if (surface === "attention") {
    return (
      <section aria-label="Attention" className="attention-surface">
        <header className="attention-surface-header">
          <div>
            <p className="eyebrow">Mission control</p>
            <h1>Attention</h1>
          </div>
          <span className="status-strip">
            <button aria-label={`Show ${runningToday} running lanes`} onClick={() => onSurfaceChange?.("now")} type="button">{runningToday} running</button>
            <button aria-label={`Show ${attentionItems.length} items needing attention`} onClick={() => onSurfaceChange?.("attention")} type="button">{attentionItems.length} need attention</button>
          </span>
        </header>
        {attentionItems.length === 0 ? (
          <p className="empty-state">
            All clear — <button onClick={() => onSurfaceChange?.("now")} type="button">{runningToday} lanes running</button>, {mergeTimeStatus === "available" ? (
              <button onClick={onShowMergedToday} type="button">{mergedToday} merged today</button>
            ) : <span title="GitHub merge timestamps are not available">merged today unavailable</span>}.
          </p>
        ) : (
          <div className="attention-card-list">{attentionItems.map((item) => card(item))}</div>
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
        <header className="attention-surface-header"><div><p className="eyebrow">Live work only</p><h1>Now</h1></div><button className="status-strip" onClick={() => onSurfaceChange?.("now")} type="button">{runningItems.length} live or stale</button></header>
        {byBatch.size === 0 ? <p className="empty-state">No live lanes right now.</p> : Array.from(byBatch).map(([batch, batchItems]) => (
          <section className="now-batch" key={batch}><h2>{batch}</h2>{batchItems.map((item) => card(item, false))}</section>
        ))}
      </section>
    );
  }

  if (surface === "history") {
    const historyScope = historyMergedTodayOnly ? mergedTodayItems : historyItems;
    const filteredHistory = historyScope.filter((item) => matches(item, query));
    return (
      <section aria-label="History" className="attention-surface">
        <header className="attention-surface-header"><div><p className="eyebrow">Terminal and archived work</p><h1>History</h1></div><button aria-label={`Show all ${historyItems.length} history items`} className="status-strip" onClick={() => { onQueryChange(""); onSurfaceChange?.("history"); }} type="button">{historyScope.length} items</button></header>
        {historyMergedTodayOnly ? <p className="active-filter">Showing proven merges from today. <button onClick={() => onSurfaceChange?.("history")} type="button">Clear</button></p> : null}
        <label className="search-field"><span>Filter</span><input aria-label="Filter history" onChange={(event) => onQueryChange(event.target.value)} placeholder="Filter history" value={query} /></label>
        {filteredHistory.length === 0 ? <p className="empty-state">No terminal or aged-out work matches this filter.</p> : <div className="attention-card-list">{filteredHistory.map((item) => card(item, false))}</div>}
      </section>
    );
  }

  const results = items.filter((item) => matchesDeepLink(item, deepLink, repairWorkItemIds) && matches(item, query));
  const activeConstraints = [deepLink?.repo && `repo ${deepLink.repo}`, deepLink?.target && `target #${deepLink.target}`, deepLink?.batchId && `batch ${deepLink.batchId}`, deepLink?.laneName && `lane ${deepLink.laneName}`, deepLink?.overviewFilter && `filter ${deepLink.overviewFilter}`].filter(Boolean);
  return (
    <section aria-label="Find" className="attention-surface">
      <header className="attention-surface-header"><div><p className="eyebrow">Target, branch, batch, thread, or machine</p><h1>Find</h1></div></header>
      <label className="search-field"><span>⌘K</span><input aria-label="Find work" autoFocus onChange={(event) => onQueryChange(event.target.value)} placeholder="Find work" value={query} /></label>
      {activeConstraints.length > 0 ? <p className="active-filter">Constrained by {activeConstraints.join(" · ")} <button onClick={onClearDeepLink} type="button">Clear constraints</button></p> : null}
      {deepLink?.overviewFilter === "batch_repair" && repairBatchCount > 0 ? <button className="secondary-action" onClick={onOpenBatchOperations} type="button">Open {repairBatchCount} batch repair records</button> : null}
      {results.length === 0 ? <p className="empty-state">No work items match this search.</p> : <div className="attention-card-list">{results.map((item) => card(item))}</div>}
    </section>
  );
}
