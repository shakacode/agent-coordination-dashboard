import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { DashboardSettings } from "../shared/types";
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

export async function readDashboardSettings(path: string, fallback: DashboardSettings): Promise<DashboardSettings> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<DashboardSettings>;
    const targetRepos = normalizeTargetRepos(parsed.targetRepos);
    if (targetRepos.length === 0) {
      throw new Error("settings must include at least one owner/repo target.");
    }
    return { targetRepos };
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code === "ENOENT") {
      return fallback;
    }
    throw new Error(`Could not read dashboard settings at ${path}: ${error instanceof Error ? error.message : "unknown error"}`);
  }
}

export async function writeDashboardSettings(path: string, settings: DashboardSettings): Promise<DashboardSettings> {
  const normalized = { targetRepos: normalizeTargetRepos(settings.targetRepos) };
  if (normalized.targetRepos.length === 0) {
    throw new Error("At least one owner/repo target is required.");
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  return normalized;
}
