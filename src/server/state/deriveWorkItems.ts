import type { BatchEvent, BatchOperation, BatchRecord, QaValidationItem, WorkItem, WorkItemOperatorState, WorkItemTerminalState } from "../../shared/types";
import { repoLessBatchLaneMatchesWorkItem } from "../../shared/batchSignal";

export const WEDGED_AFTER_MS = 15 * 60 * 1000;
export const ARCHIVE_AFTER_MS = 24 * 60 * 60 * 1000;

interface DeriveWorkItemsInput {
  workItems: WorkItem[];
  now: Date;
  events?: BatchEvent[];
  qaValidations?: QaValidationItem[];
  batchOperations?: BatchOperation[];
  batches?: BatchRecord[];
}

function operationMatchesItem(operation: BatchOperation, item: WorkItem, input: DeriveWorkItemsInput): boolean {
  if (!item.batchSignals?.some((signal) => signal.batchId === operation.batchId)) return false;
  if (operation.repo) return operation.repo === item.repo;
  const batch = input.batches?.find((candidate) =>
    operation.batchPath ? candidate.path === operation.batchPath : candidate.batchId === operation.batchId
  );
  if (batch?.repo) return batch.repo === item.repo;
  const explicitTarget = batch?.targets?.find((target) => target.target === item.target && (target.repo || batch.repo) === item.repo);
  if (explicitTarget) return true;
  if (batch) return repoLessBatchLaneMatchesWorkItem(batch, operation.batchId, item, input.workItems);
  const repos = new Set(input.workItems.filter((candidate) => candidate.batchSignals?.some((signal) => signal.batchId === operation.batchId)).map((candidate) => candidate.repo));
  return repos.size === 1 && repos.has(item.repo);
}

function timestamp(value: string | undefined): number {
  const result = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(result) ? result : 0;
}

function latestTimestamp(values: Array<string | undefined>): string | undefined {
  return values.filter((value): value is string => timestamp(value) > 0).sort((left, right) => timestamp(right) - timestamp(left))[0];
}

function terminalState(statuses: string[]): WorkItemTerminalState | undefined {
  const status = statuses.join(" ").toLowerCase();
  if (/\b(superseded|replaced)\b/.test(status)) return "superseded";
  if (/\b(abandoned|cancelled|canceled)\b/.test(status)) return "abandoned";
  if (/\b(closed)\b/.test(status)) return "closed";
  if (/\b(done|complete|completed|merged)\b/.test(status)) return "done";
  return undefined;
}

function currentDeclaredTerminal(
  candidates: Array<{ status?: string; updatedAt?: string }>
): { state: WorkItemTerminalState; completedAt?: string } | undefined {
  const timestamped = candidates
    .map((candidate, index) => ({ ...candidate, index, time: timestamp(candidate.updatedAt) }))
    .filter((candidate) => candidate.status && candidate.time > 0)
    .sort((left, right) => {
      const timeDifference = right.time - left.time;
      if (timeDifference !== 0) return timeDifference;
      const terminalDifference =
        Number(Boolean(terminalState([right.status!]))) - Number(Boolean(terminalState([left.status!])));
      return terminalDifference || left.index - right.index;
    });
  if (timestamped.length > 0) {
    const state = terminalState([timestamped[0].status!]);
    return state ? { state, completedAt: timestamped[0].updatedAt } : undefined;
  }
  const state = terminalState(candidates.flatMap((candidate) => candidate.status ? [candidate.status] : []));
  return state ? { state } : undefined;
}

function latestTimestampedLifecycle(candidates: Array<{ status?: string; updatedAt?: string }>) {
  return candidates
    .map((candidate, index) => ({ ...candidate, index, time: timestamp(candidate.updatedAt) }))
    .filter((candidate): candidate is typeof candidate & { status: string } => Boolean(candidate.status) && candidate.time > 0)
    .sort((left, right) => right.time - left.time || left.index - right.index)[0];
}

interface EffectiveGitHubLifecycle {
  terminalState?: WorkItemTerminalState;
  completedAt?: string;
  terminalUrl?: string;
  mayHaveOpenPullRequest: boolean;
}

function effectiveGitHubLifecycle(item: WorkItem): EffectiveGitHubLifecycle {
  const github = item.github;
  const implementationPr = github?.implementationPr;
  const implementationState = implementationPr?.loadState === "loaded"
    ? implementationPr.state.trim().toLowerCase()
    : undefined;
  const normalizeUrl = (url: string) => url.replace(/[?#].*$/, "").replace(/\/+$/, "").toLowerCase();
  const closedImplementationUrl = implementationState === "closed" && implementationPr
    ? normalizeUrl(implementationPr.url)
    : undefined;
  const unresolvedLinkedPrUrl = [item.claim?.prUrl, item.heartbeat?.prUrl]
    .filter((url): url is string => Boolean(url))
    .some((url) => normalizeUrl(url) !== closedImplementationUrl);

  if (implementationPr) {
    if (implementationPr.loadState !== "loaded") {
      return { mayHaveOpenPullRequest: true };
    }
    if (implementationState === "open" || implementationState === "unknown") {
      return { mayHaveOpenPullRequest: true };
    }
    if (implementationState === "merged") {
      return {
        terminalState: "done",
        completedAt: implementationPr.mergedAt,
        terminalUrl: implementationPr.url,
        mayHaveOpenPullRequest: false
      };
    }
  }

  if (github?.loadState !== "loaded") {
    return {
      mayHaveOpenPullRequest: Boolean(
        unresolvedLinkedPrUrl
        || github?.type === "pull_request"
        || (implementationPr && implementationState !== "closed")
      )
    };
  }
  const rootState = github.state.trim().toLowerCase();
  if (github.type === "pull_request" && rootState === "merged") {
    return {
      terminalState: "done",
      completedAt: github.mergedAt,
      terminalUrl: github.url,
      mayHaveOpenPullRequest: false
    };
  }
  if (rootState === "closed") {
    return {
      terminalState: "closed",
      completedAt: github.closedAt,
      terminalUrl: github.url,
      mayHaveOpenPullRequest: false
    };
  }
  return {
    mayHaveOpenPullRequest: Boolean(
      unresolvedLinkedPrUrl
      || (github.type === "pull_request" && (rootState === "open" || rootState === "unknown"))
    )
  };
}

function attention(item: WorkItem, statuses: string[], activityAt: string | undefined, input: DeriveWorkItemsInput) {
  const status = statuses.join(" ").toLowerCase();
  const operation = input.batchOperations?.find((candidate) => operationMatchesItem(candidate, item, input));
  const validation = input.qaValidations?.find(
    (candidate) => candidate.repo === item.repo && candidate.target === item.target && ["missing", "failed"].includes(candidate.status)
  );
  const age = input.now.getTime() - timestamp(activityAt);

  if (operation?.controlStatus === "stopped") {
    return { kind: "batch_stopped" as const, label: "Batch is stopped", action: "Copy resume prompt" as const };
  }
  if (operation?.controlStatus === "stop_requested") {
    return { kind: "batch_stop_requested" as const, label: "Batch stop is pending", action: "Open batch operations" as const };
  }
  if (/\bblocked[ _-]?user[ _-]?input\b|\bneeds[ _-]?user[ _-]?input\b/.test(status)) {
    return { kind: "blocked_user_input" as const, label: "Waiting for operator input", action: "Copy resume prompt" as const };
  }
  if (validation) {
    const candidateUrl = item.github?.type === "pull_request" ? item.github.url : item.claim?.prUrl || item.heartbeat?.prUrl;
    const hasPullRequestUrl = Boolean(candidateUrl && /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+(?:[/?#]|$)/i.test(candidateUrl));
    return {
      kind: "qa_missing" as const,
      label: "QA evidence is missing or failing",
      action: hasPullRequestUrl ? "Open PR" as const : "Copy resume prompt" as const
    };
  }
  if (item.heartbeat?.liveness === "dead") {
    return { kind: "dead_holder" as const, label: "Holder is no longer live", action: "Copy resume prompt" as const };
  }
  if (/\bwedged\b/.test(status) || (item.heartbeat && ["live", "stale"].includes(item.heartbeat.liveness) && age > WEDGED_AFTER_MS)) {
    return { kind: "wedged" as const, label: "No progress for over 15 minutes", action: "Copy resume prompt" as const };
  }
  return undefined;
}

function operatorState(item: WorkItem, terminal: WorkItemTerminalState | undefined, reason: WorkItem["attention"], activityAt: string | undefined, now: Date): WorkItemOperatorState {
  if (terminal) {
    return now.getTime() - timestamp(activityAt) > ARCHIVE_AFTER_MS ? "archived_view" : "terminal";
  }
  if (reason) return "needs_attention";
  if (item.heartbeat && ["live", "stale"].includes(item.heartbeat.liveness)) return "running";
  return "ready";
}

/** Build the single, read-only operator state used by every v2 dashboard surface. */
export function deriveWorkItems(input: DeriveWorkItemsInput): WorkItem[] {
  return input.workItems.map((item) => {
    const matchingEvents = (input.events || []).filter((event) => event.repo === item.repo && event.target === item.target);
    const lifecycleCandidates = [
      { status: item.heartbeat?.status, updatedAt: item.heartbeat?.updatedAt },
      { status: item.claim?.status, updatedAt: item.claim?.updatedAt || item.claim?.claimedAt },
      ...item.batchSignals?.map((signal) => ({ status: signal.status, updatedAt: signal.updatedAt })) || [],
      ...matchingEvents.map((event) => ({ status: event.status || event.type, updatedAt: event.timestamp }))
    ];
    const coordinationActivityAt = latestTimestamp([
      item.heartbeat?.updatedAt,
      item.claim?.updatedAt,
      item.claim?.claimedAt,
      ...item.batchSignals?.map((signal) => signal.updatedAt) || [],
      ...matchingEvents.map((event) => event.timestamp)
    ]);
    const statuses = [
      item.heartbeat?.status,
      item.claim?.status,
      ...item.batchSignals?.map((signal) => signal.status) || [],
      ...matchingEvents.map((event) => event.status || event.type)
    ].filter((value): value is string => Boolean(value));
    const declaredTerminalEvidence = currentDeclaredTerminal(lifecycleCandidates);
    const declaredTerminal = declaredTerminalEvidence?.state;
    const githubLifecycle = effectiveGitHubLifecycle(item);
    const githubTerminalCandidate = declaredTerminal ? undefined : githubLifecycle.terminalState;
    const githubCompletionAt = declaredTerminal ? undefined : githubLifecycle.completedAt;
    const latestLifecycle = latestTimestampedLifecycle(lifecycleCandidates);
    const githubTerminal =
      githubTerminalCandidate
      && !(
        latestLifecycle
        && !terminalState([latestLifecycle.status])
        && (!githubCompletionAt || latestLifecycle.time > timestamp(githubCompletionAt))
      )
        ? githubTerminalCandidate
        : undefined;
    const terminal = declaredTerminal || githubTerminal;
    const completedAt = declaredTerminalEvidence?.completedAt
      || (githubTerminal ? githubCompletionAt : undefined);
    const activityAt = githubTerminal
      ? latestTimestamp([coordinationActivityAt, item.github?.implementationPr?.mergedAt, item.github?.mergedAt, item.github?.closedAt])
      : coordinationActivityAt;
    const deadPastPresentationTtl = item.heartbeat?.liveness === "dead"
      && input.now.getTime() - timestamp(activityAt) > ARCHIVE_AFTER_MS
      && !githubLifecycle.mayHaveOpenPullRequest;
    const reason = terminal || deadPastPresentationTtl ? undefined : attention(item, statuses, activityAt, input);
    return {
      ...item,
      operatorState: deadPastPresentationTtl ? "archived_view" : operatorState(item, terminal, reason, activityAt, input.now),
      terminalState: terminal,
      terminalProvenance: terminal
        ? declaredTerminal
          ? { source: "declared" }
          : { source: "github", url: githubLifecycle.terminalUrl }
        : undefined,
      completedAt,
      attention: reason,
      lastActivityAt: activityAt
    };
  });
}
