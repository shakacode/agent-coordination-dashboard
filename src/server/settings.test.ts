import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeTargetRepos, readDashboardSettings, writeDashboardSettings } from "./settings";

describe("dashboard settings", () => {
  it("normalizes repo filters", () => {
    expect(normalizeTargetRepos([" shakacode/react_on_rails ", "bad", "./app", "repo/..", ".../repo", "shakacode/react_on_rails"])).toEqual([
      "shakacode/react_on_rails"
    ]);
  });

  it("persists target repos", async () => {
    const root = await mkdtemp(join(tmpdir(), "dashboard-settings-"));
    const path = join(root, "settings.json");

    await writeDashboardSettings(path, { targetRepos: ["shakacode/react_on_rails"] });
    const settings = await readDashboardSettings(path, { targetRepos: ["fallback/repo"] });

    expect(settings.targetRepos).toEqual(["shakacode/react_on_rails"]);
    expect(await readFile(path, "utf8")).toContain("shakacode/react_on_rails");
  });

  it("uses fallback only when the settings file does not exist", async () => {
    const root = await mkdtemp(join(tmpdir(), "dashboard-settings-missing-"));
    const path = join(root, "settings.json");

    await expect(readDashboardSettings(path, { targetRepos: ["fallback/repo"] })).resolves.toEqual({
      targetRepos: ["fallback/repo"]
    });
  });

  it("rejects malformed persisted settings instead of falling back", async () => {
    const root = await mkdtemp(join(tmpdir(), "dashboard-settings-bad-"));
    const path = join(root, "settings.json");
    await writeFile(path, "{", "utf8");

    await expect(readDashboardSettings(path, { targetRepos: ["fallback/repo"] })).rejects.toThrow(
      "Could not read dashboard settings"
    );
  });
});
