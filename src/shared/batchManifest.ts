import type { BatchLane, BatchRecord, BatchReservation, BatchTarget, WorkItemType } from "./types";

export interface BatchManifestDraft {
  batchId: string;
  repo?: string;
  objective?: string;
  targets: BatchTarget[];
  lanes: BatchLane[];
  reservations: BatchReservation[];
  createdAt?: string;
  createdByMachine?: string;
  launchPrompt?: string;
}

export interface ParseBatchLaunchPromptOptions {
  now?: Date;
  machineId?: string;
}

export interface BatchManifestFile {
  schema_version: number;
  batch_id: string;
  repo?: string;
  objective?: string;
  targets: Array<Record<string, string>>;
  lanes: Array<{
    name: string;
    owner: string;
    targets: string[];
    depends_on: string[];
    status: string;
  }>;
  reservations: Array<Record<string, string>>;
  created_at?: string;
  created_by_machine?: string;
  launch_prompt?: string;
}

const TARGET_REF_PATTERN = /\b(PR|Pull Request|Issue|Target)\s*#(\d+)\b/i;
const ALL_TARGET_REFS_PATTERN = /\b(PR|Pull Request|Issue|Target)\s*#(\d+)\b/gi;
const GITHUB_URL_PATTERN = /https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/(pull|issues)\/(\d+)/i;

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function targetTypeFromLabel(label: string): WorkItemType {
  if (/^issue$/i.test(label)) {
    return "issue";
  }
  if (/^target$/i.test(label)) {
    return "unknown";
  }
  return "pull_request";
}

function targetTypeFromUrlKind(kind: string): WorkItemType {
  return kind === "issues" ? "issue" : "pull_request";
}

function normalizeTargetType(value: unknown): WorkItemType {
  const type = stringValue(value).toLowerCase();
  if (["pull_request", "pull-request", "pull request", "pr"].includes(type)) {
    return "pull_request";
  }
  if (type === "issue") {
    return "issue";
  }
  return "unknown";
}

function targetFromLine(line: string): BatchTarget | undefined {
  const ref = line.match(TARGET_REF_PATTERN);
  const url = line.match(GITHUB_URL_PATTERN);
  if (!ref && !url) {
    return undefined;
  }
  if (ref && url) {
    const refType = targetTypeFromLabel(ref[1]);
    const urlType = targetTypeFromUrlKind(url[2]);
    if (ref[2] !== url[3] || (refType !== "unknown" && refType !== urlType)) {
      throw new Error(`Target reference ${ref[0]} does not match GitHub URL ${url[0]}.`);
    }
  }

  const type = ref ? targetTypeFromLabel(ref[1]) : targetTypeFromUrlKind(url?.[2] || "");
  const target = ref?.[2] || url?.[3] || "";
  if (!target) {
    return undefined;
  }

  return {
    type,
    target,
    ...(url ? { repo: url[1], url: url[0] } : {})
  };
}

function allTargetRefs(line: string): BatchTarget[] {
  const targets: BatchTarget[] = [];
  for (const match of line.matchAll(ALL_TARGET_REFS_PATTERN)) {
    targets.push({
      type: targetTypeFromLabel(match[1]),
      target: match[2]
    });
  }
  const url = line.match(GITHUB_URL_PATTERN);
  if (url && !targets.some((target) => target.target === url[3])) {
    targets.push({
      type: targetTypeFromUrlKind(url[2]),
      target: url[3],
      repo: url[1],
      url: url[0]
    });
  }
  return targets;
}

function targetKey(target: BatchTarget): string {
  return `${target.repo || ""}:${target.type}:${target.target}`;
}

function mergeTarget(existing: BatchTarget | undefined, incoming: BatchTarget): BatchTarget {
  const merged = {
    ...existing,
    ...incoming,
    title: incoming.title || existing?.title
  };
  if (!merged.title) {
    delete merged.title;
  }
  return merged;
}

function pushUniqueTarget(targets: BatchTarget[], incoming: BatchTarget): BatchTarget {
  const ambiguous = targets.find(
    (target) =>
      target.target === incoming.target &&
      Boolean(target.repo && incoming.repo && target.repo !== incoming.repo)
  );
  if (ambiguous) {
    throw new Error(`Cannot import multi-repo prompt with duplicate PR/issue number #${incoming.target}.`);
  }
  const index = targets.findIndex((target) => targetKey(target) === targetKey(incoming));
  if (index === -1) {
    targets.push(incoming);
    return incoming;
  }
  targets[index] = mergeTarget(targets[index], incoming);
  return targets[index];
}

function parseHeaderValue(lines: string[], label: string): string | undefined {
  const pattern = new RegExp(`^${label}:\\s*(.+)$`, "i");
  return lines.map((line) => line.trim().match(pattern)?.[1]?.trim()).find((value): value is string => Boolean(value));
}

function parseRepositories(lines: string[]): string[] {
  const repos: string[] = [];
  const repoLine = parseHeaderValue(lines, "Repository");
  for (const repo of repoLine?.match(/[^\s,/]+\/[^\s,]+/g) || []) {
    repos.push(repo);
  }

  for (const line of lines) {
    const url = line.match(GITHUB_URL_PATTERN);
    if (url) {
      repos.push(url[1]);
    }
  }
  return Array.from(new Set(repos));
}

function sectionName(line: string): "items" | "lanes" | "reservations" | undefined {
  if (/^Items:\s*$/i.test(line.trim())) {
    return "items";
  }
  if (/^(Suggested\s+lanes|Lanes):\s*$/i.test(line.trim())) {
    return "lanes";
  }
  if (/^(Reservations|Deferred|Deferred items|Reserved items):\s*$/i.test(line.trim())) {
    return "reservations";
  }
  if (/^[A-Z][A-Za-z\s]+:\s*$/.test(line.trim())) {
    return undefined;
  }
  return undefined;
}

function parseLaneLine(line: string): BatchLane | undefined {
  const match = line.match(/^\s*-\s*(?:Lane\s+)?([^(:]+?)\s*(?:\((?:owner|agent):\s*([^)]+)\))?\s*:\s*(.+)$/i);
  if (!match) {
    return undefined;
  }
  const targets = allTargetRefs(match[3]).map((target) => target.target);
  if (targets.length === 0) {
    return undefined;
  }
  return {
    name: match[1].trim(),
    owner: (match[2] || "unassigned").trim(),
    targets: Array.from(new Set(targets)),
    dependsOn: [],
    status: "queued",
    liveness: "no-heartbeat",
    blockedOn: []
  };
}

function fallbackLanes(targets: BatchTarget[]): BatchLane[] {
  return targets.map((target) => ({
    name: `lane-${target.type === "pull_request" ? "pr" : target.type}-${target.target}`.replace("lane-unknown-", "lane-"),
    owner: "unassigned",
    targets: [target.target],
    dependsOn: [],
    status: "queued",
    liveness: "no-heartbeat",
    blockedOn: []
  }));
}

function sanitizeBatchIdPart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function hashString(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export function suggestBatchId(repo: string | undefined, targets: BatchTarget[]): string {
  const repoPart = sanitizeBatchIdPart(repo || "unknown-repo") || "unknown-repo";
  const targetPart = targets
    .map((target) => `${target.type}:${target.target}`)
    .sort()
    .join(",");
  return `batch-${repoPart}-${hashString(`${repoPart}|${targetPart}`)}`;
}

export function parsePrBatchLaunchPrompt(
  prompt: string,
  options: ParseBatchLaunchPromptOptions = {}
): BatchManifestDraft {
  const lines = prompt.split(/\r?\n/);
  const repos = parseRepositories(lines);
  const repo = repos.length === 1 ? repos[0] : undefined;
  const objective = parseHeaderValue(lines, "Batch objective");
  const targets: BatchTarget[] = [];
  const lanes: BatchLane[] = [];
  const reservations: BatchReservation[] = [];
  let currentSection: "items" | "lanes" | "reservations" | undefined;
  let currentItem: BatchTarget | undefined;

  for (const line of lines) {
    const nextSection = sectionName(line);
    if (nextSection || /^[A-Z][A-Za-z\s]+:\s*$/.test(line.trim())) {
      currentSection = nextSection;
      currentItem = undefined;
      continue;
    }

    if (currentSection === "items") {
      const context = line.match(/^\s*Context:\s*(.+)$/i)?.[1]?.trim();
      if (context && currentItem) {
        currentItem.title = context;
      }
      if (!/^\s*-\s*/.test(line)) {
        continue;
      }

      const target = targetFromLine(line);
      if (target) {
        currentItem = pushUniqueTarget(targets, {
          ...target,
          repo: target.repo && target.repo !== repo ? target.repo : undefined
        });
      }
      continue;
    }

    if (currentSection === "lanes") {
      const lane = parseLaneLine(line);
      if (lane) {
        lanes.push(lane);
      }
      continue;
    }

    if (currentSection === "reservations") {
      for (const target of allTargetRefs(line)) {
        reservations.push({
          type: target.type,
          target: target.target,
          reason: line.replace(/^\s*-\s*/, "").trim()
        });
      }
    }
  }

  const batchId = parseHeaderValue(lines, "Batch id") || suggestBatchId(repo || repos.join(","), targets);

  return {
    batchId,
    repo,
    objective,
    targets,
    lanes: lanes.length > 0 ? lanes : fallbackLanes(targets),
    reservations,
    createdAt: options.now?.toISOString(),
    createdByMachine: options.machineId,
    launchPrompt: prompt
  };
}

export function normalizeBatchTargets(value: unknown): BatchTarget[] {
  const rawTargets = Array.isArray(value) ? value : [];
  return rawTargets
    .map((raw) => {
      if (typeof raw === "string" || typeof raw === "number") {
        const target = String(raw).trim();
        return target ? { type: "unknown" as const, target } : undefined;
      }
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return undefined;
      }
      const record = raw as Record<string, unknown>;
      const target = stringValue(record.target) || stringValue(record.number) || stringValue(record.id);
      return target
        ? {
            type: normalizeTargetType(record.type),
            target,
            url: stringValue(record.url) || undefined,
            title: stringValue(record.title) || undefined,
            repo: stringValue(record.repo) || undefined
          }
        : undefined;
    })
    .filter((target): target is BatchTarget => Boolean(target));
}

export function normalizeBatchReservations(value: unknown): BatchReservation[] {
  return normalizeBatchTargets(value).map((target, index) => {
    const raw = Array.isArray(value) ? value[index] : undefined;
    const record = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    return {
      type: target.type,
      target: target.target,
      reason: stringValue(record.reason) || undefined,
      owner: stringValue(record.owner) || undefined,
      laneName: stringValue(record.lane_name) || stringValue(record.laneName) || undefined,
      repo: target.repo
    };
  });
}

function normalizeLaneForDraft(lane: BatchLane | Record<string, unknown>): BatchLane {
  const record = lane as Record<string, unknown>;
  const liveness = stringValue(record.liveness);
  return {
    name: stringValue(lane.name) || "UNKNOWN",
    owner: stringValue(lane.owner) || "UNKNOWN",
    targets: Array.isArray(lane.targets) ? lane.targets.map(String).filter(Boolean) : [],
    dependsOn: Array.isArray(lane.dependsOn)
      ? lane.dependsOn.map(String).filter(Boolean)
      : Array.isArray(record.depends_on)
        ? record.depends_on.map(String).filter(Boolean)
        : [],
    status: stringValue(lane.status) || "queued",
    liveness: ["live", "stale", "dead", "unknown", "no-heartbeat"].includes(liveness)
      ? (liveness as BatchLane["liveness"])
      : "no-heartbeat",
    blockedOn: Array.isArray(lane.blockedOn)
      ? lane.blockedOn.map(String).filter(Boolean)
      : Array.isArray(record.blocked_on)
        ? record.blocked_on.map(String).filter(Boolean)
        : []
  };
}

export function normalizeBatchManifestDraft(input: Partial<BatchManifestDraft | BatchRecord | BatchManifestFile>): BatchManifestDraft {
  const record = input as Record<string, unknown>;
  const targets = normalizeBatchTargets(input.targets || []);
  const lanes = Array.isArray(input.lanes) ? input.lanes.map((lane) => normalizeLaneForDraft(lane as BatchLane | Record<string, unknown>)) : fallbackLanes(targets);
  return {
    batchId: stringValue(record.batchId) || stringValue(record.batch_id),
    repo: stringValue(input.repo) || undefined,
    objective: stringValue(input.objective) || undefined,
    targets,
    lanes,
    reservations: normalizeBatchReservations(input.reservations || []),
    createdAt: stringValue(record.createdAt) || stringValue(record.created_at) || undefined,
    createdByMachine: stringValue(record.createdByMachine) || stringValue(record.created_by_machine) || undefined,
    launchPrompt: stringValue(record.launchPrompt) || stringValue(record.launch_prompt) || undefined
  };
}

function compactRecord(record: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).filter((entry): entry is [string, string] => Boolean(entry[1])));
}

export function normalizeBatchManifestForWrite(input: Partial<BatchManifestDraft | BatchRecord>): BatchManifestFile {
  const draft = normalizeBatchManifestDraft(input);
  return {
    schema_version: 1,
    batch_id: draft.batchId,
    ...(draft.repo ? { repo: draft.repo } : {}),
    ...(draft.objective ? { objective: draft.objective } : {}),
    targets: draft.targets.map((target) =>
      compactRecord({
        type: target.type,
        target: target.target,
        url: target.url,
        title: target.title,
        repo: target.repo
      })
    ),
    lanes: draft.lanes.map((lane) => ({
      name: lane.name,
      owner: lane.owner,
      targets: lane.targets,
      depends_on: lane.dependsOn,
      status: lane.status
    })),
    reservations: draft.reservations.map((reservation) =>
      compactRecord({
        type: reservation.type,
        target: reservation.target,
        reason: reservation.reason,
        owner: reservation.owner,
        lane_name: reservation.laneName,
        repo: reservation.repo
      })
    ),
    ...(draft.createdAt ? { created_at: draft.createdAt } : {}),
    ...(draft.createdByMachine ? { created_by_machine: draft.createdByMachine } : {}),
    ...(draft.launchPrompt ? { launch_prompt: draft.launchPrompt } : {})
  };
}
