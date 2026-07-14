import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type RefObject } from "react";
import { Plus, RefreshCw, X } from "lucide-react";
import { generatePrBatchPrompt } from "../shared/prompt";
import { isSelectableWorkItem } from "../shared/workItemSelection";
import { displayAttribution, firstDisplayAttribution } from "../shared/attribution";
import { repoLessBatchLaneMatchesWorkItem } from "../shared/batchSignal";
import { effectiveCustody } from "../shared/effectiveCustody";
import { fallbackTimelineWorkItem } from "../shared/fallbackWorkItem";
import type { BatchOperation, BatchRecord, CoordinationResource, CoordinationWarning, DashboardModel, DashboardRuntimeSettings } from "../shared/types";
import { deleteAnnotation, fetchDashboard, fetchItemTimeline, fetchSettings, requestBatchStop, saveAnnotation, saveImportedBatchManifest, saveSettings, type ItemTimelineResponse } from "./api";
import { BatchesTab } from "./components/BatchesTab";
import { AttentionShell, type DashboardSurface } from "./components/AttentionShell";
import { HealthTab } from "./components/HealthTab";
import { ItemPage } from "./components/ItemPage";
import type { AnnotationAction } from "./components/OperatorActions";
import { MachinesTab } from "./components/MachinesTab";
import { PromptDrawer } from "./components/PromptDrawer";
import { SignalGroupList } from "./components/SignalGroups";
import {
  hasStructuredOperatorDeepLink,
  operatorDeepLinkFromSearchParams,
  type OperatorDeepLink,
  type OverviewOperatorFilter
} from "./operatorRows";
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

function operationMatchesBatch(operation: BatchOperation, batch: BatchRecord, batches: BatchRecord[]): boolean {
  if (operation.batchPath) return operation.batchPath === batch.path;
  if (operation.batchId !== batch.batchId) return false;
  if (operation.repo) return operation.repo === batch.repo;
  return batches.filter((candidate) => candidate.batchId === operation.batchId).length === 1;
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

function readOperatorDeepLink() {
  const params = new URLSearchParams(window.location.search);
  const parsed = operatorDeepLinkFromSearchParams(params);
  const legacyItem = params.get("item");
  const itemRoute = itemRouteFromSearchParams(params);
  const canonicalItem = legacyItem?.match(/^([^/#]+\/[^/#]+)#(\d+)$/);
  const deepLink = canonicalItem
    ? { ...parsed, repo: parsed.repo || canonicalItem[1], target: parsed.target || canonicalItem[2] }
    : legacyItem && /^#?\d+$/.test(legacyItem)
      ? { ...parsed, target: parsed.target || legacyItem.replace(/^#/, "") }
    : parsed;
  const arbitraryLegacyQuery = legacyItem && !itemRoute && !canonicalItem && !/^#?\d+$/.test(legacyItem) ? legacyItem : undefined;
  return {
    ...deepLink,
    query: deepLink.query || arbitraryLegacyQuery
  };
}

function hasLegacyFindLink(): boolean {
  const params = new URLSearchParams(window.location.search);
  return Boolean((params.get("item") && !itemRouteFromSearchParams(params)) || params.get("q") || params.get("batch") || params.get("lane") || params.get("repo") || params.get("target"));
}

export function operatorDeepLinkForOverviewFilter(filter: OverviewOperatorFilter, query: string): OperatorDeepLink {
  return { overviewFilter: filter, query: query || undefined };
}

function writeOperatorLocation(deepLink: OperatorDeepLink, query: string, mode: "push" | "replace") {
  const url = new URL(window.location.href);
  for (const key of ["batch", "lane", "repo", "target", "operatorFilter", "q", "item"]) {
    url.searchParams.delete(key);
  }
  const values = {
    batch: deepLink.batchId,
    lane: deepLink.laneName,
    repo: deepLink.repo,
    target: deepLink.target,
    operatorFilter: deepLink.overviewFilter,
    q: query || undefined
  };
  for (const [key, value] of Object.entries(values)) {
    if (value) {
      url.searchParams.set(key, value);
    }
  }
  window.history[`${mode}State`]({}, "", `${url.pathname}${url.search}${url.hash}`);
}

function writeItemLocation(route: ItemRoute, mode: "push" | "replace") {
  const url = new URL(window.location.href);
  for (const key of ["batch", "lane", "repo", "target", "operatorFilter", "q", "item"]) url.searchParams.delete(key);
  url.searchParams.set("item", `${route.repo}/${route.target}`);
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

export function App() {
  const initialSnapshot = useMemo(readCachedDashboardSnapshot, []);
  const initialSnapshotRef = useRef(initialSnapshot);
  const [dashboard, setDashboard] = useState<DashboardModel | null>(null);
  const [settings, setSettings] = useState<DashboardRuntimeSettings | null>(null);
  const [cachedSnapshotAt, setCachedSnapshotAt] = useState<string | null>(null);
  const [repoDraft, setRepoDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [operatorDeepLink, setOperatorDeepLink] = useState<OperatorDeepLink>(readOperatorDeepLink);
  const [itemRoute, setItemRoute] = useState<ItemRoute | undefined>(() => itemRouteFromSearchParams(new URLSearchParams(window.location.search)));
  const itemRouteInScope = Boolean(itemRoute && settings?.targetRepos.includes(itemRoute.repo));
  const [itemTimeline, setItemTimeline] = useState<ItemTimelineResponse | null>(null);
  const [itemError, setItemError] = useState<string | null>(null);
  const [operatorQuery, setOperatorQuery] = useState(operatorDeepLink.query || "");
  const [activeSurface, setActiveSurface] = useState<DashboardSurface>(() =>
    operatorDeepLink.query || hasStructuredOperatorDeepLink(operatorDeepLink) || hasLegacyFindLink() ? "find" : "attention"
  );
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [foregroundLoadInFlight, setForegroundLoadInFlight] = useState(false);
  const [historyMergedTodayOnly, setHistoryMergedTodayOnly] = useState(false);
  const [batchDetailScope, setBatchDetailScope] = useState<"events" | "repairs" | "all">("all");
  const [diagnosticScope, setDiagnosticScope] = useState<"agents" | "health" | "all">("all");
  const currentDataUnavailable = Boolean(cachedSnapshotAt || error || foregroundLoadInFlight);
  const backgroundLoadInFlight = useRef(false);
  const userActionInFlightCount = useRef(0);
  const userActionQueue = useRef<Promise<void>>(Promise.resolve());
  const dashboardRequestVersion = useRef(0);
  const currentSettingsRef = useRef<DashboardRuntimeSettings | null>(null);
  const batchOperationsRef = useRef<HTMLDetailsElement>(null);
  const diagnosticsRef = useRef<HTMLDetailsElement>(null);
  const warningsRef = useRef<HTMLElement>(null);
  const lastCacheWriteAttemptAt = useRef(0);

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
  const repairBatches = useMemo(() => {
    if (!dashboard) return [];
    const stopped = dashboard.batchOperations.filter((operation) => operation.controlStatus !== "running");
    return dashboard.batches.filter((batch) =>
      batch.source === "inferred"
      || !batch.launchPrompt
      || stopped.some((operation) => operationMatchesBatch(operation, batch, dashboard.batches))
    );
  }, [dashboard]);
  const repairOperations = useMemo(() => (dashboard?.batchOperations || []).filter((operation) =>
    operation.controlStatus !== "running"
    && (repairBatches.some((batch) => operationMatchesBatch(operation, batch, dashboard?.batches || []))
      || !(dashboard?.batches || []).some((batch) => operationMatchesBatch(operation, batch, dashboard?.batches || [])))
  ), [dashboard, repairBatches]);
  const orphanRepairOperations = repairOperations.filter((operation) => !repairBatches.some((batch) => operationMatchesBatch(operation, batch, dashboard?.batches || [])));
  const repairWorkItemIds = useMemo(() => new Set((dashboard?.workItems || []).filter((item) => repairBatches.some((batch) => {
    if (batch.repo && batch.repo !== item.repo) return false;
    if (batch.targets?.some((target) => target.target === item.target && (target.repo || batch.repo) === item.repo)) return true;
    if (batch.repo) {
      return batch.lanes.some((lane) => lane.targets.includes(item.target))
        && item.batchSignals?.some((signal) => signal.batchId === batch.batchId);
    }
    return repoLessBatchLaneMatchesWorkItem(batch, batch.batchId, item, dashboard?.workItems || []);
  })).map((item) => item.id)), [dashboard, repairBatches]);
  const repairBatchCount = dashboard
    ? repairBatches.length
      + orphanRepairOperations.length
    : 0;
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
    const abortController = isBackground ? new AbortController() : undefined;
    const timeoutId = abortController
      ? window.setTimeout(() => abortController.abort(), options.backgroundTimeoutMs ?? MIN_BACKGROUND_REFRESH_TIMEOUT_MS)
      : undefined;
    const requestVersion = ++dashboardRequestVersion.current;
    let scopeChanged = false;
    try {
      const loadedSettings = await fetchSettings({ signal: abortController?.signal });
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
      }
      const initialSnapshot = initialSnapshotRef.current;
      initialSnapshotRef.current = undefined;
      if (initialSnapshot
        && initialSnapshot.settings.scopeId === loadedSettings.scopeId
        && sameTargetRepos(initialSnapshot.settings.targetRepos, loadedSettings.targetRepos)) {
        setDashboard(initialSnapshot.dashboard);
        setCachedSnapshotAt(initialSnapshot.savedAt);
      }
      const loadedDashboard = await fetchDashboard({ fresh: !isBackground, signal: abortController?.signal });
      if (requestVersion !== dashboardRequestVersion.current) {
        return;
      }
      applyFreshDashboard(loadedDashboard, loadedSettings, {
        background: isBackground,
        preserveSelections: isBackground
      });
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : "Dashboard failed to load");
    } finally {
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
    const params = new URLSearchParams(window.location.search);
    if (params.has("item") && !itemRouteFromSearchParams(params)) {
      writeOperatorLocation(operatorDeepLink, operatorQuery, "replace");
    }
  }, []);

  useEffect(() => {
    function restoreLocation() {
      const nextDeepLink = readOperatorDeepLink();
      setItemRoute(itemRouteFromSearchParams(new URLSearchParams(window.location.search)));
      setOperatorDeepLink(nextDeepLink);
      setOperatorQuery(nextDeepLink.query || "");
      setActiveSurface(nextDeepLink.query || hasStructuredOperatorDeepLink(nextDeepLink) || hasLegacyFindLink() ? "find" : "attention");
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
    const nextDeepLink = { query: operatorQuery || undefined };
    setItemRoute(undefined);
    setItemTimeline(null);
    setItemError(null);
    setOperatorDeepLink(nextDeepLink);
    setActiveSurface("find");
    writeOperatorLocation(nextDeepLink, operatorQuery, "replace");
  }, [itemRoute, operatorQuery, settings]);

  useEffect(() => {
    function openFind(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setActiveSurface("find");
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

  function updateOperatorQuery(query: string) {
    const githubUrl = canonicalGithubItemUrl(query);
    const item = githubUrl && dashboard?.workItems.find((candidate) => {
      const { claim, heartbeat } = effectiveCustody(candidate);
      return [candidate.github?.url, claim?.prUrl, heartbeat?.prUrl]
        .some((candidateUrl) => canonicalGithubItemUrl(candidateUrl)?.toLowerCase() === githubUrl.toLowerCase());
    });
    if (item) {
      setOperatorQuery(query);
      const startingUniversalSearch = activeSurface === "find" && hasStructuredOperatorDeepLink(operatorDeepLink);
      const nextDeepLink = startingUniversalSearch
        ? { query: query || undefined }
        : { ...operatorDeepLink, query: query || undefined };
      setOperatorDeepLink(nextDeepLink);
      writeOperatorLocation(nextDeepLink, query, "replace");
      openItem(item);
      return;
    }
    setOperatorQuery(query);
    const startingUniversalSearch = activeSurface === "find" && hasStructuredOperatorDeepLink(operatorDeepLink);
    const nextDeepLink = startingUniversalSearch
      ? { query: query || undefined }
      : { ...operatorDeepLink, query: query || undefined };
    setOperatorDeepLink(nextDeepLink);
    writeOperatorLocation(nextDeepLink, query, "replace");
  }

  function openSurface(surface: DashboardSurface) {
    const nextDeepLink = { query: operatorQuery || undefined };
    if (itemRoute) {
      setItemRoute(undefined);
      setItemTimeline(null);
      setItemError(null);
    }
    if (itemRoute || (surface !== "find" && hasStructuredOperatorDeepLink(operatorDeepLink))) {
      setOperatorDeepLink(nextDeepLink);
      writeOperatorLocation(nextDeepLink, operatorQuery, "replace");
    }
    setHistoryMergedTodayOnly(false);
    setActiveSurface(surface);
  }

  function openItem(item: WorkItem) {
    const route = { repo: item.repo, target: item.target };
    setItemRoute(route);
    setItemTimeline(null);
    setItemError(null);
    writeItemLocation(route, "push");
  }

  function closeItem() {
    const nextDeepLink = { query: operatorQuery || undefined };
    setItemRoute(undefined);
    setItemTimeline(null);
    setItemError(null);
    setActiveSurface("find");
    setOperatorDeepLink(nextDeepLink);
    writeOperatorLocation(nextDeepLink, operatorQuery, "push");
  }

  function clearOperatorConstraints() {
    const nextDeepLink = { query: operatorQuery || undefined };
    setOperatorDeepLink(nextDeepLink);
    writeOperatorLocation(nextDeepLink, operatorQuery, "replace");
  }

  function showMergedToday() {
    setOperatorQuery("");
    setHistoryMergedTodayOnly(true);
    setActiveSurface("history");
  }

  function openDetails(details: RefObject<HTMLDetailsElement | null>) {
    if (details.current) {
      details.current.open = true;
      details.current.scrollIntoView?.({ block: "start" });
    }
  }

  function openBatchDetails(scope: "events" | "repairs" | "all") {
    setBatchDetailScope(scope);
    openDetails(batchOperationsRef);
  }

  function openDiagnostics(scope: "agents" | "health" | "all") {
    setDiagnosticScope(scope);
    openDetails(diagnosticsRef);
  }

  function showAllWorkItems() {
    const nextDeepLink: OperatorDeepLink = {};
    setOperatorQuery("");
    setOperatorDeepLink(nextDeepLink);
    setActiveSurface("find");
    writeOperatorLocation(nextDeepLink, "", "replace");
  }

  function revealWarnings() {
    if (!warningsRef.current) {
      openDiagnostics("health");
      return;
    }
    warningsRef.current.querySelectorAll("details").forEach((details) => {
      details.open = true;
    });
    warningsRef.current.scrollIntoView?.({ block: "start" });
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

  if (!dashboard || !settings) {
    return <DashboardLoadingSkeleton />;
  }

  const localWritesDisabled = currentDataUnavailable;

  const warningLabel = dashboard.warnings.some((warning) => warning.severity !== "info") ? "warnings" : "notices";
  const sourceFailures = (dashboard.sourceStatus || []).filter((source) =>
    ["auth_error", "unreachable"].includes(source.status)
  );
  const coordinationSourceError = sourceFailures.length > 0;
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
  const failedSourceDetails = (resources: readonly CoordinationResource[]) =>
    sourceFailures
      .filter((source) => resources.includes(source.resource))
      .map((source) => `${source.resource}: ${source.status}${source.httpStatus ? ` (${source.httpStatus})` : ""}`)
      .join("; ");
  const coordinationCount = (count: number, resources: readonly CoordinationResource[]) =>
    resources.some((resource) => failedResources.has(resource)) ? "—" : String(count);
  const agentSources = ["claims", "heartbeats", "events"] as const;
  const eventSources = ["events"] as const;
  const healthSources = ["claims", "heartbeats", "batches", "events"] as const;
  const unavailableSources = (resources: readonly CoordinationResource[]) =>
    resources.filter((resource) => failedResources.has(resource));
  const warningsHeading = warningLabel === "warnings" ? "Warnings" : "Notices";
  const warningGroups = groupWarnings(dashboard.warnings);
  const visibleWarningGroups = warningGroups.slice(0, 3);
  const overflowWarningGroups = warningGroups.slice(3);
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

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <h1>Agent Coordination Dashboard</h1>
          <p>
            {coordinationSourceError ? (
              <span className="source-chip source-chip-error">{dashboard.stateRoot}</span>
            ) : (
              dashboard.stateRoot
            )}{" "}
            {!itemRoute && <>· <button className="inline-count" onClick={showAllWorkItems} type="button">
              {dashboard.trulyOpenCountStatus === "unknown" || dashboard.trulyOpenCount === undefined ? "UNKNOWN" : dashboard.trulyOpenCount} lanes truly open
            </button></>}
          </p>
        </div>
        <div className="summary-strip">
          {!itemRoute && <>
            <button className="summary-count" disabled={dashboard.agents.length === 0 || agentSources.some((resource) => failedResources.has(resource))} onClick={() => openDiagnostics("agents")} title={failedSourceDetails(agentSources) || undefined} type="button">
              {coordinationCount(dashboard.agents.length, agentSources)} agents
            </button>
            <button className="summary-count" disabled={dashboard.events.length === 0 || eventSources.some((resource) => failedResources.has(resource))} onClick={() => openBatchDetails("events")} title={failedSourceDetails(eventSources) || undefined} type="button">
              {coordinationCount(dashboard.events.length, eventSources)} events
            </button>
            <button className="summary-count" disabled={dashboard.healthItems.length === 0 || healthSources.some((resource) => failedResources.has(resource))} onClick={() => openDiagnostics("health")} title={failedSourceDetails(healthSources) || undefined} type="button">
              {coordinationCount(dashboard.healthItems.length, healthSources)} health
            </button>
          </>}
          <button className="summary-count" disabled={dashboard.warnings.length === 0} onClick={revealWarnings} type="button">
            {dashboard.warnings.length} {warningLabel}
          </button>
          <span>{new Date(dashboard.generatedAt).toLocaleTimeString()}</span>
          <button
            aria-label="Refresh dashboard"
            className="icon-button"
            disabled={isRefreshing}
            onClick={() => void loadDashboard()}
            title="Refresh"
            type="button"
          >
            <RefreshCw size={16} aria-hidden="true" />
          </button>
        </div>
      </header>

      {cachedSnapshotAt && !error ? (
        <section aria-label="Last-known dashboard snapshot" className="snapshot-banner" role="status">
          <strong>Showing last-known snapshot</strong>
          <span>Refreshing current coordination data · saved {new Date(cachedSnapshotAt).toLocaleString()}</span>
        </section>
      ) : null}
      {error ? (
        <section aria-label="Dashboard refresh failed" className="snapshot-banner snapshot-banner-error" role="alert">
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

      <details className="repo-filter" aria-label="Target repositories">
        <summary>
          <span>Target repositories</span>
          <span>{settings.targetRepos.length} configured</span>
        </summary>
        <div className="repo-filter-body">
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
                  <X size={14} aria-hidden="true" />
                </button>
              </span>
            ))}
          </div>
          <form className="repo-add-form" onSubmit={addRepo}>
            <input
              aria-label="Add target repository"
              disabled={localWritesDisabled}
              name="targetRepository"
              onChange={(event) => setRepoDraft(event.target.value)}
              placeholder="owner/repo"
              value={repoDraft}
            />
            <button aria-label="Add repository" disabled={isRefreshing || localWritesDisabled} title="Add repository" type="submit">
              <Plus size={16} aria-hidden="true" />
            </button>
          </form>
        </div>
      </details>

      {dashboard.warnings.length > 0 && (
        <section className="warnings-panel" aria-label={`Coordination ${warningLabel}`} ref={warningsRef}>
          <div className="warnings-panel-summary">
            <span className="warnings-heading">{warningsHeading}</span>
            <button className="inline-count" onClick={revealWarnings} type="button">
              {dashboard.warnings.length} {warningLabel}
            </button>
          </div>
          <SignalGroupList
            ariaLabel={`Coordination ${warningLabel} grouped by type`}
            groups={visibleWarningGroups}
            renderItem={renderWarning}
          />
          {overflowWarningGroups.length > 0 && (
            <details className="warnings-overflow">
              <summary>
                {overflowWarningGroups.length} more {overflowWarningGroups.length === 1 ? "type" : "types"}
              </summary>
              <SignalGroupList groups={overflowWarningGroups} renderItem={renderWarning} />
            </details>
          )}
        </section>
      )}

      <div className="dashboard-layout">
        <section className="content-region">
          <nav className="surface-nav" aria-label="Dashboard surfaces">
            {(["attention", "now", "find", "history"] as const).map((surface) => (
              <button className={activeSurface === surface ? "active" : ""} key={surface} onClick={() => openSurface(surface)} type="button">
                {surface[0].toUpperCase()}{surface.slice(1)}
              </button>
            ))}
          </nav>
          {itemRoute && itemRouteInScope ? itemTimeline ? (
            <>
              {itemError ? <p className="item-timeline-warning" role="alert">Coordination data: UNKNOWN — stale timeline refresh failed: {itemError}</p> : null}
              <ItemPage
                onAnnotate={localWritesDisabled ? undefined : (annotation) => mutateAnnotation(timelineWorkItem!, annotation)}
                onBack={closeItem}
                onClearAnnotation={localWritesDisabled ? undefined : () => mutateAnnotation(timelineWorkItem!)}
                timeline={itemTimeline}
              />
            </>
          ) : itemError ? (
            <p className="empty-state">Work item timeline: UNKNOWN — {itemError}</p>
          ) : <p className="empty-state">Loading work item timeline…</p> : <AttentionShell
            items={dashboard.workItems}
            deepLink={operatorDeepLink}
            historyMergedTodayOnly={historyMergedTodayOnly}
            mergeTimeStatus={dashboard.githubMergeTimeStatus || "unavailable"}
            now={dashboard.generatedAt}
            onAnnotate={localWritesDisabled ? undefined : mutateAnnotation}
            onClearAnnotation={localWritesDisabled ? undefined : (item) => mutateAnnotation(item)}
            onQueryChange={updateOperatorQuery}
            onOpenBatchOperations={() => openBatchDetails(operatorDeepLink.overviewFilter === "batch_repair" ? "repairs" : "all")}
            onOpenItem={openItem}
            onClearDeepLink={clearOperatorConstraints}
            onShowMergedToday={showMergedToday}
            onSurfaceChange={openSurface}
            onToggle={toggleWorkItem}
            query={operatorQuery}
            repairBatchCount={repairBatchCount}
            repairWorkItemIds={repairWorkItemIds}
            selectionDisabled={batchPromptDisabled}
            surface={activeSurface}
          />}
          {!itemRoute && <details className="prompt-drawer-shell">
            <summary>PR-batch prompt</summary>
            <PromptDrawer disabled={batchPromptDisabled} prompt={prompt} />
          </details>}
          {!itemRoute && <details className="secondary-tools" ref={batchOperationsRef}>
            <summary>{batchDetailScope === "events" ? "Event records" : batchDetailScope === "repairs" ? "Batch repairs" : "Batch operations"}</summary>
            {batchDetailScope === "events" ? (
              <>
                <button className="secondary-action" onClick={() => setBatchDetailScope("all")} type="button">Show all batch operations</button>
                <section aria-label="Event records" className="event-list">
                  {dashboard.events.map((event) => {
                    const repo = displayAttribution(event.repo);
                    const target = displayAttribution(event.target);
                    return <article className="event-row" key={`${event.path}:${event.eventId}`}><strong>{event.type}</strong><span>{repo}{target === "unattributed" ? "" : `#${target}`}</span><span>{displayAttribution(event.batchId, "unbatched")}</span><span>{firstDisplayAttribution([event.laneName, event.agentId])}</span><time>{event.timestamp || event.path}</time></article>;
                  })}
                </section>
              </>
            ) : (
              <BatchesTab
                batches={batchDetailScope === "repairs" ? repairBatches : dashboard.batches}
                events={batchDetailScope === "repairs" ? dashboard.events.filter((event) => repairBatches.some((batch) => event.batchPath ? event.batchPath === batch.path : event.batchId === batch.batchId && Boolean(event.repo && event.repo === batch.repo))) : dashboard.events}
                localWritesDisabled={localWritesDisabled}
                onImportBatch={localWritesDisabled ? undefined : importBatchManifest}
                onRequestStop={localWritesDisabled ? undefined : stopBatch}
                operations={batchDetailScope === "repairs" ? repairOperations : dashboard.batchOperations}
              />
            )}
            {batchDetailScope === "repairs" && orphanRepairOperations.length > 0 ? (
              <section aria-label="Orphan repair operations" className="event-list">
                {orphanRepairOperations.map((operation) => <article className="event-row" key={`${operation.batchPath || operation.repo || "unscoped"}:${operation.batchId}`}><strong>{operation.controlStatus}</strong><span>{displayAttribution(operation.repo || operation.batchPath)}</span><span>{displayAttribution(operation.batchId)}</span><span>{operation.eventCount} events</span><time>{operation.latestEventAt || "time unavailable"}</time></article>)}
              </section>
            ) : null}
          </details>}
          {!itemRoute && <details className="secondary-tools" ref={diagnosticsRef}>
            <summary>{diagnosticScope === "agents" ? "Agents" : diagnosticScope === "health" ? "Health" : "Machines and health"}</summary>
            {diagnosticScope !== "health" ? <MachinesTab agents={dashboard.agents} unavailableSources={unavailableSources(agentSources)} /> : null}
            {diagnosticScope !== "agents" ? <HealthTab items={dashboard.healthItems} unavailableSources={unavailableSources(healthSources)} /> : null}
          </details>}
        </section>
      </div>
    </main>
  );
}
