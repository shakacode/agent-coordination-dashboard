import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { generatePrBatchPrompt } from "../shared/prompt";
import { isSelectableWorkItem } from "../shared/workItemSelection";
import { displayAttribution } from "../shared/attribution";
import { effectiveCustody } from "../shared/effectiveCustody";
import { fallbackTimelineWorkItem } from "../shared/fallbackWorkItem";
import type { BatchRecord, CoordinationResource, CoordinationWarning, DashboardModel, DashboardRuntimeSettings } from "../shared/types";
import { deleteAnnotation, fetchDashboard, fetchItemTimeline, fetchSettings, requestBatchStop, saveAnnotation, saveImportedBatchManifest, saveSettings, type ItemTimelineResponse } from "./api";
import { buildCoordinationView, type BatchCard } from "./coordinationView";
import type { OperatorRow } from "./operatorRows";
import { TopBar } from "./components/TopBar";
import { DashboardShell, type TabId } from "./components/DashboardShell";
import type { BatchFilter } from "./components/BatchesBoard";
import type { JobFilter } from "./components/JobsBoard";
import { JobDetailDrawer } from "./components/JobDetailDrawer";
import { BatchDetailDrawer } from "./components/BatchDetailDrawer";
import { ItemPage } from "./components/ItemPage";
import { HealthTab } from "./components/HealthTab";
import { PromptDrawer } from "./components/PromptDrawer";
import { BatchImportPanel } from "./components/BatchImportPanel";
import { EventHistoryPanel } from "./components/EventHistoryPanel";
import type { AnnotationAction } from "./components/OperatorActions";
import type { JobRow } from "./coordinationView";
import { parseRepoScopeExclusion, SignalGroupList } from "./components/SignalGroups";
import { groupWarnings } from "./signalGroups";
import { canonicalGithubItemUrl } from "./githubUrls";

type WorkItem = DashboardModel["workItems"][number];
const MIN_BACKGROUND_REFRESH_TIMEOUT_MS = 4000;
const BACKGROUND_REFRESH_TIMEOUT_GRACE_MS = 1000;
const BACKGROUND_CACHE_WRITE_INTERVAL_MS = 60_000;
const REQUIRED_COORDINATION_RESOURCES: readonly CoordinationResource[] = ["claims", "heartbeats", "batches"];
const BATCH_ACTION_COORDINATION_RESOURCES: readonly CoordinationResource[] = [
  ...REQUIRED_COORDINATION_RESOURCES,
  "events"
];
export const DASHBOARD_SNAPSHOT_CACHE_KEY = "agent-coordination-dashboard:last-known-snapshot:v2";

interface CachedDashboardSnapshot {
  version: 2;
  savedAt: string;
  dashboard: DashboardModel;
  settings: DashboardRuntimeSettings;
}

interface ItemRoute {
  repo: string;
  target: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function sameTargetRepos(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((repo, index) => repo === right[index]);
}

function assertDashboardScope(dashboard: DashboardModel, settings: DashboardRuntimeSettings): void {
  if (!sameTargetRepos(dashboard.targetRepos, settings.targetRepos)) {
    throw new Error("Dashboard data does not match the current repository scope");
  }
}

function hasStrings(value: Record<string, unknown>, fields: string[]): boolean {
  return fields.every((field) => typeof value[field] === "string");
}

function hasOptionalStrings(value: Record<string, unknown>, fields: string[]): boolean {
  return fields.every((field) => value[field] === undefined || typeof value[field] === "string");
}

function isWarning(value: unknown): boolean {
  return isRecord(value)
    && hasStrings(value, ["severity", "message"])
    && hasOptionalStrings(value, ["agentId", "repo", "target"]);
}

function isClaim(value: unknown): boolean {
  return isRecord(value)
    && hasStrings(value, ["repo", "target", "agentId", "status", "path"])
    && hasOptionalStrings(value, ["machineId", "threadHandle", "host", "operator", "batchId", "branch", "prUrl", "claimedAt", "updatedAt", "expiresAt"]);
}

function isHeartbeat(value: unknown): boolean {
  return isRecord(value)
    && hasStrings(value, ["agentId", "status", "updatedAt", "expiresAt", "path", "liveness"])
    && hasOptionalStrings(value, ["machineId", "threadHandle", "host", "operator", "repo", "target", "batchId", "branch", "prUrl"]);
}

function isWorkItem(value: unknown): boolean {
  if (!isRecord(value) || !hasStrings(value, ["id", "repo", "target", "type", "schedulingState"])) return false;
  if (!hasOptionalStrings(value, ["operatorState", "terminalState", "lastActivityAt"])) return false;
  if (typeof value.selected !== "boolean" || !Array.isArray(value.warnings) || !value.warnings.every(isWarning)) return false;
  if (value.batchSignals !== undefined && (!Array.isArray(value.batchSignals) || !value.batchSignals.every((signal) =>
    isRecord(signal)
      && typeof signal.status === "string"
      && hasOptionalStrings(signal, ["batchId", "laneName", "updatedAt"])
      && isStringArray(signal.blockedOn)
  ))) return false;
  if (value.github !== undefined && (!isRecord(value.github)
    || !hasStrings(value.github, ["repo", "target", "type", "title", "url", "state", "loadState"])
    || !hasOptionalStrings(value.github, ["coordinatedType", "author", "branch", "reviewDecision", "ciStatus", "mergedAt", "closedAt", "branchState"])
    || !isStringArray(value.github.labels))) return false;
  if (value.claim !== undefined && !isClaim(value.claim)) return false;
  if (value.heartbeat !== undefined && !isHeartbeat(value.heartbeat)) return false;
  if (value.provenance !== undefined && (!isRecord(value.provenance) || typeof value.provenance.classification !== "string" || !isStringArray(value.provenance.evidence))) return false;
  if (value.attention !== undefined && (!isRecord(value.attention) || !hasStrings(value.attention, ["kind", "label", "action"]))) return false;
  if (value.annotation !== undefined && (!isRecord(value.annotation) || !hasStrings(value.annotation, ["key", "kind", "createdAt"]) || !hasOptionalStrings(value.annotation, ["until", "note", "operator"]))) return false;
  if (value.terminalProvenance !== undefined && (!isRecord(value.terminalProvenance) || typeof value.terminalProvenance.source !== "string" || !hasOptionalStrings(value.terminalProvenance, ["url"]))) return false;
  return true;
}

function isBatch(value: unknown): boolean {
  if (!isRecord(value) || !hasStrings(value, ["batchId", "path"])
    || !hasOptionalStrings(value, ["repo", "objective", "source", "createdAt", "createdByMachine", "launchPrompt", "updatedAt"])
    || !Array.isArray(value.lanes)
    || !value.lanes.every((lane) => isRecord(lane)
      && hasStrings(lane, ["name", "owner", "status", "liveness"])
      && hasOptionalStrings(lane, ["threadHandle", "host", "operator", "branch", "prUrl"])
      && isStringArray(lane.targets)
      && isStringArray(lane.dependsOn)
      && isStringArray(lane.blockedOn))) return false;
  if (value.targets !== undefined && (!Array.isArray(value.targets) || !value.targets.every((target) =>
    isRecord(target) && hasStrings(target, ["type", "target"]) && hasOptionalStrings(target, ["url", "title", "repo"])
  ))) return false;
  if (value.reservations !== undefined && (!Array.isArray(value.reservations) || !value.reservations.every((reservation) =>
    isRecord(reservation) && hasStrings(reservation, ["type", "target"]) && hasOptionalStrings(reservation, ["reason", "owner", "laneName", "repo"])
  ))) return false;
  // Completion is optional presentation data; validate leniently and let the
  // drawer render defensively so future report shapes survive the cache.
  if (value.completion !== undefined && (!isRecord(value.completion) || !isRecord(value.completion.state) || !isRecord(value.completion.audit) || !Array.isArray(value.completion.receipts))) return false;
  return true;
}

function isEvent(value: unknown): boolean {
  return isRecord(value)
    && hasStrings(value, ["eventId", "type", "path"])
    && hasOptionalStrings(value, ["batchId", "batchPath", "laneName", "machineId", "agentId", "threadHandle", "host", "operator", "repo", "target", "branch", "prUrl", "status", "message", "timestamp"]);
}

function isAgent(value: unknown): boolean {
  return isRecord(value)
    && hasStrings(value, ["agentId", "liveness"])
    && hasOptionalStrings(value, ["machineId"])
    && Array.isArray(value.claims)
    && value.claims.every(isClaim)
    && Array.isArray(value.currentWork)
    && value.currentWork.every(isWorkItem)
    && Array.isArray(value.warnings)
    && value.warnings.every(isWarning)
    && (value.heartbeat === undefined || isHeartbeat(value.heartbeat))
    && (value.latestEvent === undefined || isEvent(value.latestEvent))
    && (value.machineMetadata === undefined || (isRecord(value.machineMetadata)
      && typeof value.machineMetadata.state === "string"
      && hasOptionalStrings(value.machineMetadata, ["value", "source"])));
}

function isBatchOperation(value: unknown): boolean {
  if (!isRecord(value) || !hasStrings(value, ["batchId", "controlStatus"]) || typeof value.eventCount !== "number" || !isRecord(value.qa)) return false;
  if (!hasOptionalStrings(value, ["repo", "batchPath", "latestEventAt", "latestEventType", "stopRequestedAt", "stoppedAt"])) return false;
  const qa = value.qa;
  return ["total", "missing", "requested", "inProgress", "passed", "failed", "unknown"]
    .every((field) => typeof qa[field] === "number");
}

function isQaValidation(value: unknown): boolean {
  return isRecord(value) && hasStrings(value, ["id", "repo", "target", "type", "status", "detail"])
    && hasOptionalStrings(value, ["title", "url", "batchId", "laneName"])
    && (value.latestEvent === undefined || isEvent(value.latestEvent));
}

function isHealthItem(value: unknown): boolean {
  return isRecord(value)
    && hasStrings(value, ["id", "severity", "category", "title", "detail"])
    && hasOptionalStrings(value, ["machineId", "agentId", "repo", "target", "batchId", "laneName"]);
}

function isSourceStatus(value: unknown): boolean {
  return isRecord(value)
    && hasStrings(value, ["resource", "mode", "status", "checkedAt"])
    && (value.httpStatus === undefined || typeof value.httpStatus === "number");
}

function isCachedDashboardSnapshot(value: unknown): value is CachedDashboardSnapshot {
  if (!isRecord(value) || value.version !== 2 || typeof value.savedAt !== "string") return false;
  if (!isRecord(value.settings)) return false;
  const settings = value.settings;
  const settingsTargetRepos = settings.targetRepos;
  if (!isStringArray(settingsTargetRepos)
    || typeof settings.scopeId !== "string"
    || (settings.refreshIntervalMs !== undefined && typeof settings.refreshIntervalMs !== "number")) return false;
  const dashboard = value.dashboard;
  if (!isRecord(dashboard) || typeof dashboard.generatedAt !== "string" || typeof dashboard.stateRoot !== "string") return false;
  if (!isStringArray(dashboard.targetRepos)
    || dashboard.targetRepos.length !== settingsTargetRepos.length
    || dashboard.targetRepos.some((repo, index) => repo !== settingsTargetRepos[index])) return false;
  // Keep every optional top-level DashboardModel field here in sync before bumping the cache version.
  return (dashboard.sourceStatus === undefined || (Array.isArray(dashboard.sourceStatus) && dashboard.sourceStatus.every(isSourceStatus)))
    && (dashboard.coordinationTokenEnvVar === undefined || (typeof dashboard.coordinationTokenEnvVar === "string" && ["AGENT_COORD_API_TOKEN", "AGENT_COORD_TOKEN"].includes(dashboard.coordinationTokenEnvVar)))
    && (dashboard.githubMergeTimeStatus === undefined || (typeof dashboard.githubMergeTimeStatus === "string" && ["available", "unavailable"].includes(dashboard.githubMergeTimeStatus)))
    && (dashboard.trulyOpenCount === undefined || typeof dashboard.trulyOpenCount === "number")
    && (dashboard.trulyOpenCountStatus === undefined || (typeof dashboard.trulyOpenCountStatus === "string" && ["available", "unknown"].includes(dashboard.trulyOpenCountStatus)))
    && Array.isArray(dashboard.agents) && dashboard.agents.every(isAgent)
    && Array.isArray(dashboard.batches) && dashboard.batches.every(isBatch)
    && Array.isArray(dashboard.events) && dashboard.events.every(isEvent)
    && Array.isArray(dashboard.batchOperations) && dashboard.batchOperations.every(isBatchOperation)
    && Array.isArray(dashboard.qaValidations) && dashboard.qaValidations.every(isQaValidation)
    && Array.isArray(dashboard.healthItems) && dashboard.healthItems.every(isHealthItem)
    && Array.isArray(dashboard.warnings) && dashboard.warnings.every(isWarning)
    && Array.isArray(dashboard.workItems) && dashboard.workItems.every(isWorkItem);
}

function readCachedDashboardSnapshot(): CachedDashboardSnapshot | undefined {
  try {
    const raw = window.localStorage.getItem(DASHBOARD_SNAPSHOT_CACHE_KEY);
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    return isCachedDashboardSnapshot(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function writeCachedDashboardSnapshot(dashboard: DashboardModel, settings: DashboardRuntimeSettings): string | undefined {
  const savedAt = new Date().toISOString();
  try {
    window.localStorage.setItem(DASHBOARD_SNAPSHOT_CACHE_KEY, JSON.stringify({ version: 2, savedAt, dashboard, settings }));
    return savedAt;
  } catch {
    return undefined;
  }
}

function DashboardLoadingSkeleton() {
  return (
    <main aria-label="Loading coordination dashboard" className="app-shell loading-state" role="status">
      <span className="sr-only">Loading coordination dashboard</span>
      <div aria-hidden="true" className="loading-skeleton">
        <div className="loading-skeleton-line loading-skeleton-title" />
        <div className="loading-skeleton-line loading-skeleton-meta" />
        <div className="loading-skeleton-line loading-skeleton-nav" />
        <div className="loading-skeleton-grid">
          <div className="loading-skeleton-card"><div className="loading-skeleton-line" /><div className="loading-skeleton-line loading-skeleton-short" /></div>
          <div className="loading-skeleton-card"><div className="loading-skeleton-line" /><div className="loading-skeleton-line loading-skeleton-short" /></div>
          <div className="loading-skeleton-card"><div className="loading-skeleton-line" /><div className="loading-skeleton-line loading-skeleton-short" /></div>
        </div>
      </div>
    </main>
  );
}

function itemRouteFromSearchParams(params: URLSearchParams): ItemRoute | undefined {
  const item = params.get("item");
  const match = item?.match(/^([^/#]+\/[^/#]+)\/([^/#]+)$/);
  return match ? { repo: match[1], target: match[2] } : undefined;
}

export function backgroundRefreshTimeoutMs(refreshIntervalMs: number): number {
  const intervalMs = Number.isFinite(refreshIntervalMs) && refreshIntervalMs > 0 ? refreshIntervalMs : 0;
  return Math.max(MIN_BACKGROUND_REFRESH_TIMEOUT_MS, intervalMs + BACKGROUND_REFRESH_TIMEOUT_GRACE_MS);
}

export function nextActiveSnoozeDelayMs(workItems: WorkItem[], nowMs = Date.now()): number | undefined {
  const expiries = workItems.flatMap((item) => {
    const until = item.annotation?.kind === "snooze" ? Date.parse(item.annotation.until || "") : Number.NaN;
    return Number.isFinite(until) && until > nowMs ? [until] : [];
  });
  return expiries.length > 0 ? Math.max(0, Math.min(...expiries) - nowMs) : undefined;
}

function writeItemLocation(route: ItemRoute | undefined, mode: "push" | "replace") {
  const url = new URL(window.location.href);
  for (const key of ["batch", "lane", "repo", "target", "operatorFilter", "q", "item"]) url.searchParams.delete(key);
  if (route) url.searchParams.set("item", `${route.repo}/${route.target}`);
  window.history[`${mode}State`]({}, "", `${url.pathname}${url.search}${url.hash}`);
}

function preserveWorkItemSelections(current: DashboardModel | null, next: DashboardModel): DashboardModel {
  if (!current) {
    return next;
  }

  const selectedIds = new Set(current.workItems.filter((item) => item.selected && isSelectableWorkItem(item)).map((item) => item.id));
  if (selectedIds.size === 0) {
    return next;
  }

  return {
    ...next,
    workItems: next.workItems.map((item) => (selectedIds.has(item.id) && isSelectableWorkItem(item) ? { ...item, selected: true } : item))
  };
}

function formatClock(date: Date): string {
  let hours = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const ampm = hours >= 12 ? "PM" : "AM";
  hours = hours % 12 || 12;
  return `${hours}:${minutes} ${ampm}`;
}

export function App() {
  const initialSnapshot = useMemo(readCachedDashboardSnapshot, []);
  const initialSnapshotRef = useRef(initialSnapshot);
  const [dashboard, setDashboard] = useState<DashboardModel | null>(null);
  const [settings, setSettings] = useState<DashboardRuntimeSettings | null>(null);
  const [cachedSnapshotAt, setCachedSnapshotAt] = useState<string | null>(null);
  const [repoDraft, setRepoDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [itemRoute, setItemRoute] = useState<ItemRoute | undefined>(() => itemRouteFromSearchParams(new URLSearchParams(window.location.search)));
  const itemRouteInScope = Boolean(itemRoute && settings?.targetRepos.includes(itemRoute.repo));
  const [itemTimeline, setItemTimeline] = useState<ItemTimelineResponse | null>(null);
  const [itemError, setItemError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<TabId>("batches");
  const [jobFilter, setJobFilter] = useState<JobFilter>("all");
  const [batchFilter, setBatchFilter] = useState<BatchFilter>("all");
  const [selectedRow, setSelectedRow] = useState<{ row: OperatorRow; workItem?: WorkItem } | null>(null);
  const [selectedBatch, setSelectedBatch] = useState<BatchCard | null>(null);
  const [highlightBatch, setHighlightBatch] = useState<string | null>(null);
  const [clock, setClock] = useState(() => formatClock(new Date()));
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [foregroundLoadInFlight, setForegroundLoadInFlight] = useState(false);
  const currentDataUnavailable = Boolean(cachedSnapshotAt || error || foregroundLoadInFlight);
  const backgroundLoadInFlight = useRef(false);
  const userActionInFlightCount = useRef(0);
  const userActionQueue = useRef<Promise<void>>(Promise.resolve());
  const dashboardRequestVersion = useRef(0);
  const currentSettingsRef = useRef<DashboardRuntimeSettings | null>(null);
  const warningsRef = useRef<HTMLDetailsElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const highlightTimeout = useRef<number | undefined>(undefined);
  const lastCacheWriteAttemptAt = useRef(0);

  const view = useMemo(() => (dashboard ? buildCoordinationView(dashboard) : null), [dashboard]);

  const cacheDashboard = useCallback((nextDashboard: DashboardModel, nextSettings: DashboardRuntimeSettings, background = false) => {
    const attemptedAt = Date.now();
    if (background && attemptedAt - lastCacheWriteAttemptAt.current < BACKGROUND_CACHE_WRITE_INTERVAL_MS) {
      return undefined;
    }
    // Count attempts, not only successes, so quota failures cannot cause a tight polling loop.
    lastCacheWriteAttemptAt.current = attemptedAt;
    return writeCachedDashboardSnapshot(nextDashboard, nextSettings);
  }, []);

  const applyFreshDashboard = useCallback((
    nextDashboard: DashboardModel,
    nextSettings: DashboardRuntimeSettings,
    options: { background?: boolean; preserveSelections?: boolean } = {}
  ) => {
    assertDashboardScope(nextDashboard, nextSettings);
    currentSettingsRef.current = nextSettings;
    setSettings(nextSettings);
    setDashboard((current) => options.preserveSelections
      ? preserveWorkItemSelections(current, nextDashboard)
      : nextDashboard);
    cacheDashboard(nextDashboard, nextSettings, options.background);
    setCachedSnapshotAt(null);
    setError(null);
  }, [cacheDashboard]);

  useEffect(() => {
    document.title = "Agent Coordination Dashboard";
  }, []);

  useEffect(() => {
    const intervalId = window.setInterval(() => setClock(formatClock(new Date())), 15000);
    return () => window.clearInterval(intervalId);
  }, []);

  const requiredCoordinationUnavailable = Boolean(
    dashboard?.sourceStatus?.some(
      (source) =>
        BATCH_ACTION_COORDINATION_RESOURCES.includes(source.resource) && ["auth_error", "unreachable"].includes(source.status)
    )
  );
  const batchPromptDisabled = requiredCoordinationUnavailable || currentDataUnavailable;
  const prompt = useMemo(
    () => (batchPromptDisabled ? "" : generatePrBatchPrompt(dashboard?.workItems || [])),
    [batchPromptDisabled, dashboard]
  );
  const selectedCount = dashboard?.workItems.filter((item) => item.selected && isSelectableWorkItem(item)).length || 0;

  function beginUserAction() {
    userActionInFlightCount.current += 1;
    setIsRefreshing(true);
  }

  function finishUserAction() {
    userActionInFlightCount.current = Math.max(0, userActionInFlightCount.current - 1);
    if (userActionInFlightCount.current === 0) {
      setIsRefreshing(false);
    }
  }

  function enqueueUserAction<T>(action: () => Promise<T>): Promise<T> {
    beginUserAction();
    const run = userActionQueue.current.then(action, action).finally(finishUserAction);
    userActionQueue.current = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  const loadDashboard = useCallback(async (options: { background?: boolean; backgroundTimeoutMs?: number } = {}) => {
    const isBackground = Boolean(options.background);
    if (isBackground && (backgroundLoadInFlight.current || userActionInFlightCount.current > 0)) {
      return;
    }
    if (isBackground) {
      backgroundLoadInFlight.current = true;
    } else {
      setForegroundLoadInFlight(true);
      setError(null);
      beginUserAction();
    }
    const abortController = new AbortController();
    const timeoutId = isBackground
      ? window.setTimeout(() => abortController.abort(), options.backgroundTimeoutMs ?? MIN_BACKGROUND_REFRESH_TIMEOUT_MS)
      : undefined;
    const requestVersion = ++dashboardRequestVersion.current;
    let scopeChanged = false;
    let dashboardPromise: Promise<
      { ok: true; value: DashboardModel }
      | { ok: false; error: unknown }
    > | undefined;
    try {
      const settingsPromise = fetchSettings({ signal: abortController.signal });
      dashboardPromise = fetchDashboard({ fresh: !isBackground, signal: abortController.signal }).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error })
      );
      const loadedSettings = await settingsPromise;
      if (requestVersion !== dashboardRequestVersion.current) {
        return;
      }
      const previousSettings = currentSettingsRef.current;
      scopeChanged = Boolean(previousSettings
        && (previousSettings.scopeId !== loadedSettings.scopeId
          || !sameTargetRepos(previousSettings.targetRepos, loadedSettings.targetRepos)));
      currentSettingsRef.current = loadedSettings;
      setSettings(loadedSettings);
      if (scopeChanged) {
        setDashboard(null);
        setCachedSnapshotAt(null);
        setSelectedRow(null);
        setSelectedBatch(null);
      }
      const initialSnapshot = initialSnapshotRef.current;
      initialSnapshotRef.current = undefined;
      if (initialSnapshot
        && initialSnapshot.settings.scopeId === loadedSettings.scopeId
        && sameTargetRepos(initialSnapshot.settings.targetRepos, loadedSettings.targetRepos)) {
        setDashboard(initialSnapshot.dashboard);
        setCachedSnapshotAt(initialSnapshot.savedAt);
      }
      const dashboardResult = await dashboardPromise;
      if (!dashboardResult.ok) {
        throw dashboardResult.error;
      }
      const loadedDashboard = dashboardResult.value;
      if (requestVersion !== dashboardRequestVersion.current) {
        return;
      }
      applyFreshDashboard(loadedDashboard, loadedSettings, {
        background: isBackground,
        preserveSelections: isBackground
      });
    } catch (caught: unknown) {
      if (requestVersion !== dashboardRequestVersion.current) {
        return;
      }
      setError(caught instanceof Error ? caught.message : "Dashboard failed to load");
    } finally {
      abortController.abort();
      if (dashboardPromise) {
        await dashboardPromise;
      }
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId);
      }
      if (isBackground) {
        backgroundLoadInFlight.current = false;
      } else {
        setForegroundLoadInFlight(false);
        finishUserAction();
      }
    }
  }, [applyFreshDashboard]);

  useEffect(() => {
    void loadDashboard();
  }, [loadDashboard]);

  useEffect(() => {
    function restoreLocation() {
      setItemRoute(itemRouteFromSearchParams(new URLSearchParams(window.location.search)));
    }
    window.addEventListener("popstate", restoreLocation);
    return () => window.removeEventListener("popstate", restoreLocation);
  }, []);

  useEffect(() => {
    if (!itemRoute) {
      setItemTimeline(null);
      setItemError(null);
      return;
    }
    if (!dashboard || !itemRouteInScope) {
      setItemTimeline(null);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    setItemTimeline((current) =>
      current?.repo === itemRoute.repo && current.target === itemRoute.target ? current : null
    );
    setItemError(null);
    void fetchItemTimeline(itemRoute.repo, itemRoute.target, { signal: controller.signal }).then(
      (timeline) => {
        if (cancelled) return;
        if (timeline.repo !== itemRoute.repo || timeline.target !== itemRoute.target) {
          setItemTimeline(null);
          setItemError("Work item API returned mismatched scope");
          return;
        }
        setItemTimeline(timeline);
      },
      (caught: unknown) => {
        if (!cancelled && !controller.signal.aborted) setItemError(caught instanceof Error ? caught.message : "Work item failed to load");
      }
    );
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [dashboard?.generatedAt, itemRoute, itemRouteInScope]);

  useEffect(() => {
    if (!itemRoute || !settings || settings.targetRepos.includes(itemRoute.repo)) {
      return;
    }
    setItemRoute(undefined);
    setItemTimeline(null);
    setItemError(null);
    writeItemLocation(undefined, "replace");
  }, [itemRoute, settings]);

  useEffect(() => {
    function openFind(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchInputRef.current?.focus();
      }
    }
    window.addEventListener("keydown", openFind);
    return () => window.removeEventListener("keydown", openFind);
  }, []);

  useEffect(() => {
    const refreshIntervalMs = settings?.refreshIntervalMs || 0;
    if (refreshIntervalMs <= 0) {
      return undefined;
    }

    const intervalId = window.setInterval(() => {
      void loadDashboard({ background: true, backgroundTimeoutMs: backgroundRefreshTimeoutMs(refreshIntervalMs) });
    }, refreshIntervalMs);

    return () => window.clearInterval(intervalId);
  }, [loadDashboard, settings?.refreshIntervalMs]);

  useEffect(() => {
    if (!dashboard || (settings?.refreshIntervalMs || 0) > 0) return undefined;
    const delay = nextActiveSnoozeDelayMs(dashboard.workItems);
    if (delay === undefined) return undefined;
    const timeoutId = window.setTimeout(() => void loadDashboard(), Math.min(delay, 2_147_483_647));
    return () => window.clearTimeout(timeoutId);
  }, [dashboard, loadDashboard, settings?.refreshIntervalMs]);

  useEffect(() => () => window.clearTimeout(highlightTimeout.current), []);

  async function persistRepos(nextRepos: string[]) {
    if (cachedSnapshotAt || error) return;
    return enqueueUserAction(async () => {
      const requestVersion = ++dashboardRequestVersion.current;
      setError(null);
      try {
        const saved = await saveSettings({ targetRepos: nextRepos });
        const loadedDashboard = await fetchDashboard({ fresh: true });
        if (requestVersion === dashboardRequestVersion.current) {
          applyFreshDashboard(loadedDashboard, saved);
        }
      } catch (caught: unknown) {
        setError(caught instanceof Error ? caught.message : "Settings failed to save");
      }
    });
  }

  function addRepo(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextRepo = repoDraft.trim();
    if (!nextRepo || settings?.targetRepos.includes(nextRepo)) {
      return;
    }
    setRepoDraft("");
    void persistRepos([...(settings?.targetRepos || []), nextRepo]);
  }

  function removeRepo(repo: string) {
    const remaining = (settings?.targetRepos || []).filter((item) => item !== repo);
    if (remaining.length > 0) {
      void persistRepos(remaining);
    }
  }

  function toggleWorkItem(id: string) {
    if (requiredCoordinationUnavailable) {
      return;
    }
    setDashboard((current) => {
      if (!current) {
        return current;
      }
      return {
        ...current,
        workItems: current.workItems.map((item) =>
          item.id === id && isSelectableWorkItem(item)
            ? { ...item, selected: !item.selected }
            : item
        )
      };
    });
  }

  function openItem(item: { repo: string; target: string }) {
    const route = { repo: item.repo, target: item.target };
    setSelectedRow(null);
    setSelectedBatch(null);
    setItemRoute(route);
    setItemTimeline(null);
    setItemError(null);
    writeItemLocation(route, "push");
  }

  function closeItem() {
    setItemRoute(undefined);
    setItemTimeline(null);
    setItemError(null);
    writeItemLocation(undefined, "push");
  }

  function openRow(row: OperatorRow, workItem?: WorkItem) {
    setSelectedBatch(null);
    setSelectedRow({ row, workItem });
  }

  function openBatchCard(card: BatchCard) {
    setSelectedRow(null);
    setSelectedBatch(card);
  }

  function openBatchById(batchId: string) {
    setSelectedRow(null);
    setSelectedBatch(null);
    setTab("batches");
    setBatchFilter("all");
    setHighlightBatch(batchId);
    window.clearTimeout(highlightTimeout.current);
    highlightTimeout.current = window.setTimeout(() => setHighlightBatch(null), 2600);
  }

  function submitSearch() {
    if (!view) return;
    const githubUrl = canonicalGithubItemUrl(query);
    if (githubUrl) {
      const match = dashboard?.workItems.find((candidate) => {
        const { claim, heartbeat } = effectiveCustody(candidate);
        return [candidate.github?.url, claim?.prUrl, heartbeat?.prUrl]
          .some((candidateUrl) => canonicalGithubItemUrl(candidateUrl)?.toLowerCase() === githubUrl.toLowerCase());
      });
      if (match) {
        openItem(match);
        return;
      }
    }
    const trimmed = query.trim();
    const numberMatch = trimmed.match(/(\d+)\s*$/);
    if (!numberMatch) return;
    const digits = numberMatch[1];
    // Everything before the trailing number is treated as an optional repo hint
    // so a bare number never silently resolves to the wrong repository.
    const repoHint = trimmed.slice(0, numberMatch.index).replace(/[#\s]+$/, "").trim().toLowerCase();
    const exact = view.jobRows.filter((candidate) => String(candidate.row.target || "") === digits);
    let candidates = exact;
    if (repoHint) {
      const repoName = (repo: string) => repo.toLowerCase().split("/").pop();
      const byName = exact.filter((candidate) => candidate.row.repo.toLowerCase() === repoHint || repoName(candidate.row.repo) === repoHint);
      const byLoose = exact.filter((candidate) => candidate.row.repo.toLowerCase().includes(repoHint));
      candidates = byName.length > 0 ? byName : byLoose.length > 0 ? byLoose : exact;
    }
    const hit = candidates[0] || view.jobRows.find((candidate) => String(candidate.row.target || "").includes(digits));
    if (hit) {
      setTab("jobs");
      openRow(hit.row, hit.workItem);
    }
  }

  function toggleSelectRow(jobRow: JobRow) {
    if (jobRow.workItem) toggleWorkItem(jobRow.workItem.id);
  }

  function revealWarnings() {
    if (warningsRef.current) {
      warningsRef.current.open = true;
      warningsRef.current.scrollIntoView?.({ block: "start" });
    }
  }

  function fenceFailedAction(caught: unknown, fallback: string): never {
    const actionError = caught instanceof Error ? caught : new Error(fallback);
    setError(actionError.message);
    throw actionError;
  }

  async function mutateAnnotation(item: WorkItem, action?: AnnotationAction) {
    if (cachedSnapshotAt || error) throw new Error("Local actions require current coordination data");
    return enqueueUserAction(async () => {
      const requestVersion = ++dashboardRequestVersion.current;
      try {
        if (action) await saveAnnotation({ repo: item.repo, target: item.target, ...action });
        else await deleteAnnotation({ repo: item.repo, target: item.target });
        const [loadedSettings, loadedDashboard, loadedTimeline] = await Promise.all([
          fetchSettings(),
          fetchDashboard({ fresh: true }),
          itemRoute?.repo === item.repo && itemRoute.target === item.target ? fetchItemTimeline(item.repo, item.target) : undefined
        ]);
        if (requestVersion === dashboardRequestVersion.current) {
          applyFreshDashboard(loadedDashboard, loadedSettings);
          if (loadedTimeline) setItemTimeline(loadedTimeline);
        }
      } catch (caught: unknown) {
        fenceFailedAction(caught, "Presentation preference update failed");
      }
    });
  }

  async function importBatchManifest(manifest: Partial<BatchRecord>) {
    if (cachedSnapshotAt || error) throw new Error("Local actions require current coordination data");
    return enqueueUserAction(async () => {
      const requestVersion = ++dashboardRequestVersion.current;
      try {
        await saveImportedBatchManifest(manifest);
        const [loadedSettings, loadedDashboard] = await Promise.all([
          fetchSettings(),
          fetchDashboard({ fresh: true })
        ]);
        if (requestVersion === dashboardRequestVersion.current) {
          applyFreshDashboard(loadedDashboard, loadedSettings);
        }
      } catch (caught: unknown) {
        fenceFailedAction(caught, "Batch plan import failed");
      }
    });
  }

  async function stopBatch(input: { batchId: string; repo?: string; reason?: string }) {
    if (cachedSnapshotAt || error) throw new Error("Local actions require current coordination data");
    return enqueueUserAction(async () => {
      const requestVersion = ++dashboardRequestVersion.current;
      try {
        await requestBatchStop(input);
        const [loadedSettings, loadedDashboard] = await Promise.all([
          fetchSettings(),
          fetchDashboard({ fresh: true })
        ]);
        if (requestVersion === dashboardRequestVersion.current) {
          applyFreshDashboard(loadedDashboard, loadedSettings);
        }
      } catch (caught: unknown) {
        fenceFailedAction(caught, "Batch stop request failed");
      }
    });
  }

  if (error && (!dashboard || !settings)) {
    return <main className="app-shell error-state">{error}</main>;
  }

  if (!dashboard || !settings || !view) {
    return <DashboardLoadingSkeleton />;
  }

  const localWritesDisabled = currentDataUnavailable;

  const repoScopeExclusions = dashboard.warnings.flatMap((warning) => {
    const exclusion = parseRepoScopeExclusion(warning);
    return exclusion ? [exclusion] : [];
  });
  const fleetWarnings = dashboard.warnings.filter((warning) => !parseRepoScopeExclusion(warning));
  const excludedRecordCount = repoScopeExclusions.reduce((total, exclusion) => total + exclusion.count, 0);
  const warningLabel = fleetWarnings.some((warning) => warning.severity !== "info") ? "warnings" : "notices";
  const sourceFailures = (dashboard.sourceStatus || []).filter((source) =>
    ["auth_error", "unreachable"].includes(source.status)
  );
  const failedResources = new Set(sourceFailures.map((source) => source.resource));
  const hasAuthenticationFailure = sourceFailures.some((source) => source.status === "auth_error");
  const requiredResources = REQUIRED_COORDINATION_RESOURCES;
  const allRequiredSourcesFailed = requiredResources.every((resource) => failedResources.has(resource));
  const hasRequiredSourceFailure = requiredResources.some((resource) => failedResources.has(resource));
  const coordinationDegraded = hasAuthenticationFailure || hasRequiredSourceFailure;
  const filesystemOutage = coordinationDegraded && sourceFailures.every((source) => source.mode === "fs");
  const failedHttpStatuses = Array.from(
    new Set(sourceFailures.flatMap((source) => (source.httpStatus === undefined ? [] : [source.httpStatus])))
  );
  const degradedHttpStatus = failedHttpStatuses.length === 1 ? failedHttpStatuses[0] : undefined;
  const coordinationSourceError = sourceFailures.length > 0;
  const healthSources = ["claims", "heartbeats", "batches", "events"] as const;
  const unavailableHealthSources = healthSources.filter((resource) => failedResources.has(resource));
  const warningsHeading = warningLabel === "warnings" ? "Warnings" : "Notices";
  const warningGroups = groupWarnings(fleetWarnings);
  const renderWarning = (warning: CoordinationWarning) => {
    const repo = displayAttribution(warning.repo);
    const target = displayAttribution(warning.target);
    const context = repo !== "unattributed" ? `${repo}${target !== "unattributed" ? `#${target}` : ""}` : undefined;
    return (
      <>
        <strong>{warning.severity}</strong>
        <span>{context ? `${context}: ${warning.message}` : warning.message}</span>
      </>
    );
  };
  const timelineWorkItem = itemTimeline ? itemTimeline.item || fallbackTimelineWorkItem(itemTimeline.repo, itemTimeline.target) : undefined;
  const selectedRowBatchCard = selectedRow?.row.batchId
    ? view.batchCards.find((card) => card.id === selectedRow.row.batchId)
    : undefined;
  const selectedBatchTitle = selectedRowBatchCard?.title;

  const showItem = Boolean(itemRoute && itemRouteInScope);

  return (
    <main className="app-shell">
      <TopBar
        clock={clock}
        hostLegend={view.hostLegend}
        onQueryChange={setQuery}
        onQuerySubmit={submitSearch}
        onRefresh={() => void loadDashboard()}
        onRevealWarnings={revealWarnings}
        query={query}
        refreshing={isRefreshing}
        searchInputRef={searchInputRef}
        warningCount={fleetWarnings.length}
        warningLabel={warningLabel}
      />

      {cachedSnapshotAt && !error ? (
        <section aria-label="Last-known dashboard snapshot" className="banner banner-snapshot" role="status">
          <strong>Showing last-known snapshot</strong>
          <span>Refreshing current coordination data · saved {new Date(cachedSnapshotAt).toLocaleString()}</span>
        </section>
      ) : null}
      {error ? (
        <section aria-label="Dashboard refresh failed" className="banner banner-error" role="alert">
          <strong>Current coordination data could not be loaded</strong>
          <span>{error}. Showing the last available dashboard snapshot; local write controls are disabled until current data loads.</span>
        </section>
      ) : null}

      {coordinationDegraded && (
        <section aria-label="Coordination backend degraded" className="coordination-degraded-banner" role="alert">
          {filesystemOutage ? (
            <>
              <strong>Coordination state files unavailable — some dashboard data is unavailable</strong>
              <span>
                Check <code>AGENT_COORD_STATE_ROOT</code> permissions and state-file integrity, then refresh.
              </span>
            </>
          ) : hasAuthenticationFailure ? (
            <>
              <strong>
                {allRequiredSourcesFailed ? "Coordination backend unreachable" : "Coordination authentication failed"}
                {degradedHttpStatus ? ` (${degradedHttpStatus})` : ""} — {allRequiredSourcesFailed
                  ? "showing GitHub data only"
                  : "some coordination data is unavailable"}
              </strong>
              <span>
                Token source: {dashboard.coordinationTokenEnvVar || "no token environment variable found"}. Run{" "}
                <code>agent-coord doctor --deep</code> to diagnose and re-provision access.
              </span>
            </>
          ) : (
            <>
              <strong>
                Coordination backend unreachable{degradedHttpStatus ? ` (${degradedHttpStatus})` : ""} — some dashboard data is unavailable
              </strong>
              <span>
                Run <code>agent-coord doctor --deep</code> to inspect backend connectivity, then refresh.
              </span>
            </>
          )}
          <a href="/api/doctor" rel="noreferrer" target="_blank">
            Details
          </a>
        </section>
      )}

      <details className="repo-scope" aria-label="Target repositories">
        <summary>
          <span>Target repositories</span>
          <span>
            {settings.targetRepos.length} configured
            {excludedRecordCount > 0 ? ` · ${excludedRecordCount} ${excludedRecordCount === 1 ? "record" : "records"} excluded` : ""}
          </span>
        </summary>
        <div className="repo-scope-body">
          <div className="repo-chips">
            {settings.targetRepos.map((repo) => (
              <span className="repo-chip" key={repo}>
                {repo}
                <button
                  aria-label={`Remove ${repo}`}
                  disabled={settings.targetRepos.length === 1 || isRefreshing || localWritesDisabled}
                  onClick={() => removeRepo(repo)}
                  title={`Remove ${repo}`}
                  type="button"
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
          <form className="repo-add-form" onSubmit={addRepo}>
            <input
              aria-label="Add target repository"
              className="input"
              disabled={localWritesDisabled}
              name="targetRepository"
              onChange={(event) => setRepoDraft(event.target.value)}
              placeholder="owner/repo"
              value={repoDraft}
            />
            <button aria-label="Add repository" className="btn btn-secondary" disabled={isRefreshing || localWritesDisabled} title="Add repository" type="submit">＋</button>
          </form>
        </div>
        {repoScopeExclusions.length > 0 && (
          <div aria-label="Records excluded by repository scope" className="repo-scope-body" role="note">
            <span>
              Excluded by scope: {repoScopeExclusions.map((exclusion) => `${exclusion.count} ${exclusion.label}`).join(" · ")}
            </span>
            <span>Add a repository above to include its records.</span>
          </div>
        )}
      </details>

      {showItem ? (
        <div className="app-width">
          {itemTimeline ? (
            <>
              {itemError ? <p className="item-timeline-warning" role="alert">Coordination data: UNKNOWN — stale timeline refresh failed: {itemError}</p> : null}
              <ItemPage
                commandActionsDisabled={localWritesDisabled}
                onAnnotate={localWritesDisabled ? undefined : (annotation) => mutateAnnotation(timelineWorkItem!, annotation)}
                onBack={closeItem}
                onClearAnnotation={localWritesDisabled ? undefined : () => mutateAnnotation(timelineWorkItem!)}
                timeline={itemTimeline}
              />
            </>
          ) : itemError ? (
            <p className="empty-state">Work item timeline: UNKNOWN — {itemError}</p>
          ) : (
            <p className="empty-state">Loading work item timeline…</p>
          )}
        </div>
      ) : (
        <>
          <DashboardShell
            batchFilter={batchFilter}
            highlightBatchId={highlightBatch}
            jobFilter={jobFilter}
            onOpenBatch={openBatchCard}
            onOpenRow={openRow}
            onSetBatchFilter={setBatchFilter}
            onSetJobFilter={setJobFilter}
            onSetTab={setTab}
            onToggleSelect={localWritesDisabled ? undefined : toggleSelectRow}
            selectionDisabled={batchPromptDisabled}
            tab={tab}
            view={view}
          />

          <div className="app-width">
            {fleetWarnings.length > 0 && (
              <details className="reachable-panel" aria-label={`Coordination ${warningLabel}`} ref={warningsRef}>
                <summary>{warningsHeading} · {fleetWarnings.length}</summary>
                <SignalGroupList
                  ariaLabel={`Coordination ${warningLabel} grouped by type`}
                  groups={warningGroups}
                  renderItem={renderWarning}
                />
              </details>
            )}

            <details className="reachable-panel" aria-label="PR-batch prompt">
              <summary>PR-batch prompt · {selectedCount} selected</summary>
              <p className="board-intro">Select ready items in the Jobs board, then copy a $pr-batch handoff.</p>
              <PromptDrawer disabled={batchPromptDisabled} prompt={prompt} />
            </details>

            <details className="reachable-panel" aria-label="Import batch plan">
              <summary>Import batch plan</summary>
              <BatchImportPanel disabled={localWritesDisabled} onImportBatch={localWritesDisabled ? undefined : importBatchManifest} />
            </details>

            <details className="reachable-panel" aria-label="Event history">
              <summary>Event history · {dashboard.events.length}</summary>
              <EventHistoryPanel events={dashboard.events} />
            </details>

            <details className="reachable-panel" aria-label="Coordination health">
              <summary>Health · {dashboard.healthItems.length}</summary>
              <HealthTab items={dashboard.healthItems} unavailableSources={unavailableHealthSources} />
            </details>
          </div>
        </>
      )}

      {selectedRow && (
        <JobDetailDrawer
          batchTitle={selectedBatchTitle}
          mergeAuth={selectedRowBatchCard?.batch.mergeAuthority}
          commandActionsDisabled={localWritesDisabled}
          onAnnotate={localWritesDisabled ? undefined : (annotation) => mutateAnnotation(selectedRow.workItem!, annotation)}
          onClearAnnotation={localWritesDisabled ? undefined : () => mutateAnnotation(selectedRow.workItem!)}
          onClose={() => setSelectedRow(null)}
          onOpenBatch={openBatchById}
          onOpenTimeline={(item) => openItem(item)}
          row={selectedRow.row}
          workItem={selectedRow.workItem}
        />
      )}
      {selectedBatch && (
        <BatchDetailDrawer
          card={selectedBatch}
          localWritesDisabled={localWritesDisabled}
          onClose={() => setSelectedBatch(null)}
          onRequestStop={localWritesDisabled ? undefined : stopBatch}
        />
      )}
    </main>
  );
}
