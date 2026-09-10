import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AttentionSourceIntervalSeconds, DashboardSettings } from "../shared/types";
import { isValidGitHubRepository } from "./github/validation";

export function settingsPath(configuredPath = ""): string {
  return configuredPath || join(homedir(), ".local", "state", "agents-coordination-dashboard", "settings.json");
}

export function normalizeTargetRepos(value: unknown): string[] {
  const rawItems = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  const repos = rawItems
    .map((item) => String(item).trim())
    .filter(isValidGitHubRepository);
  return Array.from(new Set(repos)).sort();
}

export interface NormalizedDashboardSettings extends DashboardSettings {
  attentionWorkspace: string;
  attentionSourceIntervalSeconds: AttentionSourceIntervalSeconds;
  attentionOpenAgeDays: number;
}

/** Distinguish invalid submitted values from filesystem/read failures. */
export class DashboardSettingsValidationError extends Error {}

/** A readable file with malformed contents can be replaced by a complete PUT. */
export class DashboardSettingsContentsError extends Error {}

function invalid(key: string, rule: string): never {
  throw new DashboardSettingsValidationError(`${key}: ${rule}`);
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positiveNumber(value: unknown, key: string, maximum = Infinity): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > maximum) {
    invalid(key, `must be a positive finite number${maximum === Infinity ? "" : ` no greater than ${maximum}`}.`);
  }
  return value;
}

function normalizeInterval(value: unknown): AttentionSourceIntervalSeconds {
  const key = "attentionSourceIntervalSeconds";
  if (!object(value)) return positiveNumber(value, key, 604800);
  const defaultInterval = positiveNumber(value.default, `${key}.default`, 604800);
  if (value.repositories === undefined) return { ...value, default: defaultInterval };
  if (!object(value.repositories)) invalid(`${key}.repositories`, "must be an owner/repo interval map.");
  const repositories: Record<string, number> = {};
  for (const [repository, interval] of Object.entries(value.repositories)) {
    if (!isValidGitHubRepository(repository)) invalid(`${key}.repositories`, `invalid repository key ${repository}.`);
    const canonical = repository.toLowerCase();
    if (Object.hasOwn(repositories, canonical)) invalid(`${key}.repositories`, `duplicate repository key ${repository}.`);
    repositories[canonical] = positiveNumber(interval, `${key}.repositories.${repository}`, 604800);
  }
  return { ...value, default: defaultInterval, repositories };
}

/** The sole defaults/validation boundary; retain unrecognized JSON properties. */
export function normalizeDashboardSettings(input: unknown, options: { allowEmptyTargets?: boolean } = {}): NormalizedDashboardSettings {
  if (!object(input)) invalid("settings", "must be an object.");
  const targetRepos = normalizeTargetRepos(input.targetRepos);
  if (targetRepos.length === 0 && !options.allowEmptyTargets) {
    invalid("targetRepos", "At least one owner/repo target is required.");
  }
  const attentionWorkspace = input.attentionWorkspace === undefined ? "default" : input.attentionWorkspace;
  if (typeof attentionWorkspace !== "string" || attentionWorkspace.length > 160 ||
    !/^[A-Za-z0-9_:-]+(?:[.][A-Za-z0-9_:-]+)*$/.test(attentionWorkspace)) {
    invalid("attentionWorkspace", "must be a valid workspace name of at most 160 characters.");
  }
  const attentionOpenAgeDays = positiveNumber(input.attentionOpenAgeDays === undefined ? 7 : input.attentionOpenAgeDays, "attentionOpenAgeDays");
  if (!Number.isInteger(attentionOpenAgeDays)) invalid("attentionOpenAgeDays", "must be a positive integer number of days.");
  return {
    ...input,
    targetRepos,
    attentionWorkspace,
    attentionSourceIntervalSeconds: normalizeInterval(input.attentionSourceIntervalSeconds === undefined ? 900 : input.attentionSourceIntervalSeconds),
    attentionOpenAgeDays
  };
}

export async function readDashboardSettings(path: string, fallback: DashboardSettings): Promise<NormalizedDashboardSettings> {
  try {
    return normalizeDashboardSettings(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code === "ENOENT") {
      // Doctor uses empty targets solely to distinguish first run from saved scope.
      return normalizeDashboardSettings(fallback, { allowEmptyTargets: true });
    }
    const message = `Could not read dashboard settings at ${path}: ${error instanceof Error ? error.message : "unknown error"}`;
    if (error instanceof SyntaxError || error instanceof DashboardSettingsValidationError) {
      throw new DashboardSettingsContentsError(message);
    }
    throw new Error(message);
  }
}

export async function writeDashboardSettings(path: string, settings: DashboardSettings): Promise<NormalizedDashboardSettings> {
  const normalized = normalizeDashboardSettings(settings);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  return normalized;
}
