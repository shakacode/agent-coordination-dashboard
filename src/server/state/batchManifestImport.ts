import { mkdir, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import {
  normalizeBatchManifestDraft,
  normalizeBatchManifestForWrite,
  parsePrBatchLaunchPrompt,
  type BatchManifestDraft,
  type BatchManifestFile
} from "../../shared/batchManifest";

export interface ImportedBatchManifestResult {
  manifest: BatchManifestFile;
  path: string;
}

export interface WriteImportedBatchManifestOptions {
  now?: Date;
  machineId?: string;
}

export class BatchManifestImportError extends Error {
  statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

const SAFE_BATCH_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function assertSafeBatchId(batchId: string): void {
  if (!SAFE_BATCH_ID_PATTERN.test(batchId)) {
    throw new BatchManifestImportError("Batch id must use only letters, numbers, dot, underscore, and hyphen.");
  }
}

function validateImportedManifest(draft: BatchManifestDraft): void {
  if (!draft.batchId) {
    throw new BatchManifestImportError("Batch id is required.");
  }
  if (!draft.objective) {
    throw new BatchManifestImportError("Objective is required.");
  }
  if (!draft.launchPrompt) {
    throw new BatchManifestImportError("Coordination prompt is required.");
  }
  const parsedPrompt = parsePrBatchLaunchPrompt(draft.launchPrompt);
  if (parsedPrompt.batchId !== draft.batchId) {
    throw new BatchManifestImportError(
      `Coordination prompt batch id ${parsedPrompt.batchId} does not match batch plan id ${draft.batchId}.`
    );
  }
  if (draft.targets.length === 0) {
    throw new BatchManifestImportError("At least one target is required.");
  }
  if (!draft.repo && draft.targets.some((target) => !target.repo)) {
    throw new BatchManifestImportError("Repo is required unless every target includes a repo.");
  }
  const reposByTarget = new Map<string, Set<string>>();
  for (const target of draft.targets) {
    const repo = target.repo || draft.repo || "";
    reposByTarget.set(target.target, new Set([...(reposByTarget.get(target.target) || []), repo]));
  }
  const ambiguousTarget = Array.from(reposByTarget.entries()).find(([, repos]) => repos.size > 1);
  if (ambiguousTarget) {
    throw new BatchManifestImportError(
      `Target ${ambiguousTarget[0]} appears in multiple repos, but lane targets are number-only. Split this into separate batch plans.`
    );
  }
  if (draft.lanes.length === 0) {
    throw new BatchManifestImportError("At least one lane is required.");
  }
  const manifestTargets = new Set(draft.targets.map((target) => target.target));
  for (const lane of draft.lanes) {
    if (lane.targets.length === 0) {
      throw new BatchManifestImportError(`Lane ${lane.name} must include at least one target.`);
    }
    const unknownTarget = lane.targets.find((target) => !manifestTargets.has(target));
    if (unknownTarget) {
      throw new BatchManifestImportError(`Lane ${lane.name} references target ${unknownTarget} not listed in batch plan targets.`);
    }
  }
}

function dashboardMachineId(options: WriteImportedBatchManifestOptions): string {
  const machine = options.machineId?.trim() || hostname().trim() || "unknown-machine";
  return machine.startsWith("dashboard:") ? machine : `dashboard:${machine}`;
}

function normalizeImportedDraft(
  input: Partial<BatchManifestDraft>,
  options: WriteImportedBatchManifestOptions
): BatchManifestDraft {
  const draft = normalizeBatchManifestDraft(input);
  return {
    ...draft,
    createdAt: draft.createdAt || (options.now || new Date()).toISOString(),
    createdByMachine: draft.createdByMachine || dashboardMachineId(options)
  };
}

export async function writeImportedBatchManifest(
  stateRoot: string,
  input: Partial<BatchManifestDraft>,
  options: WriteImportedBatchManifestOptions = {}
): Promise<ImportedBatchManifestResult> {
  const draft = normalizeImportedDraft(input, options);
  assertSafeBatchId(draft.batchId);
  validateImportedManifest(draft);

  const manifest = normalizeBatchManifestForWrite(draft);
  const relativePath = `batches/${manifest.batch_id}.json`;
  const batchesDirectory = join(stateRoot, "batches");
  await mkdir(batchesDirectory, { recursive: true });
  try {
    await writeFile(join(batchesDirectory, `${manifest.batch_id}.json`), `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx"
    });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code === "EEXIST") {
      throw new BatchManifestImportError(`Batch plan ${relativePath} already exists.`, 409);
    }
    throw error;
  }

  return {
    manifest,
    path: relativePath
  };
}
