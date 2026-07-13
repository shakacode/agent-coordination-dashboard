import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { DashboardAnnotation, DashboardAnnotationKind, WorkItem } from "../shared/types";

const REPO = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const TARGET = /^\d+$/;
const MAX_TEXT = 500;

export interface AnnotationDraft {
  repo: string;
  target: string;
  kind: DashboardAnnotationKind;
  until?: string;
  note?: string;
  operator?: string;
}

function annotationKey(repo: string, target: string): string {
  return `${repo}/${target}`;
}

function parseAnnotations(value: unknown): DashboardAnnotation[] {
  if (!Array.isArray(value)) throw new Error("annotations must be an array");
  return value.map((entry) => {
    if (!entry || typeof entry !== "object") throw new Error("annotation must be an object");
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate.key !== "string" || !/^[^/]+\/[^/]+\/\d+$/.test(candidate.key)) throw new Error("annotation key is invalid");
    if (!(["dismiss", "snooze"] as unknown[]).includes(candidate.kind)) throw new Error("annotation kind is invalid");
    if (typeof candidate.createdAt !== "string" || !Number.isFinite(Date.parse(candidate.createdAt))) throw new Error("annotation createdAt is invalid");
    if (candidate.until !== undefined && (typeof candidate.until !== "string" || !Number.isFinite(Date.parse(candidate.until)))) throw new Error("annotation until is invalid");
    if (candidate.kind === "snooze" && candidate.until === undefined) throw new Error("snooze annotation requires until");
    if (candidate.note !== undefined && typeof candidate.note !== "string") throw new Error("annotation note is invalid");
    if (candidate.operator !== undefined && typeof candidate.operator !== "string") throw new Error("annotation operator is invalid");
    return candidate as unknown as DashboardAnnotation;
  });
}

function normalizeDraft(draft: AnnotationDraft, now: Date): DashboardAnnotation {
  const repo = draft.repo.trim();
  const target = draft.target.trim();
  if (!REPO.test(repo) || !TARGET.test(target)) throw new Error("annotation requires a valid owner/repo and numeric target");
  if (!(["dismiss", "snooze"] as unknown[]).includes(draft.kind)) throw new Error("annotation kind must be dismiss or snooze");
  const until = draft.until?.trim();
  if (draft.kind === "snooze" && (!until || !Number.isFinite(Date.parse(until)) || Date.parse(until) <= now.getTime())) {
    throw new Error("snooze until must be a future timestamp");
  }
  const text = (value: string | undefined, label: string) => {
    const normalized = value?.trim();
    if (normalized && normalized.length > MAX_TEXT) throw new Error(`${label} is too long`);
    return normalized || undefined;
  };
  return {
    key: annotationKey(repo, target),
    kind: draft.kind,
    until: draft.kind === "snooze" ? new Date(until!).toISOString() : undefined,
    note: text(draft.note, "annotation note"),
    operator: text(draft.operator, "annotation operator"),
    createdAt: now.toISOString()
  };
}

export function createAnnotationStore(path: string, now: () => Date = () => new Date()) {
  let writeQueue = Promise.resolve();
  async function read(): Promise<DashboardAnnotation[]> {
    try {
      return parseAnnotations(JSON.parse(await readFile(path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new Error(`Could not read dashboard annotations at ${path}: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }
  async function replace(entries: DashboardAnnotation[]) {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    await writeFile(temporary, `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  }
  function serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = writeQueue.then(operation, operation);
    writeQueue = result.then(() => undefined, () => undefined);
    return result;
  }
  return {
    read,
    save: (draft: AnnotationDraft) => serialized(async () => {
      const annotation = normalizeDraft(draft, now());
      const entries = (await read()).filter((entry) => entry.key !== annotation.key);
      await replace([...entries, annotation]);
      return annotation;
    }),
    remove: (repo: string, target: string) => serialized(async () => {
      if (!REPO.test(repo) || !TARGET.test(target)) throw new Error("annotation requires a valid owner/repo and numeric target");
      const key = annotationKey(repo, target);
      const entries = await read();
      await replace(entries.filter((entry) => entry.key !== key));
    })
  };
}

export function applyAnnotations(items: WorkItem[], annotations: DashboardAnnotation[], now = new Date()): WorkItem[] {
  const byKey = new Map(annotations.map((annotation) => [annotation.key, annotation]));
  return items.map((item) => {
    const annotation = byKey.get(annotationKey(item.repo, item.target));
    if (!annotation) return item;
    const active = annotation.kind === "dismiss" || (annotation.until !== undefined && Date.parse(annotation.until) > now.getTime());
    if (!active) return item;
    return {
      ...item,
      attention: annotation.kind === "dismiss" || item.operatorState === "needs_attention" ? undefined : item.attention,
      operatorState: annotation.kind === "dismiss"
        ? "archived_view"
        : item.operatorState === "needs_attention" ? "ready" : item.operatorState,
      annotation: { ...annotation, active: true }
    };
  });
}
