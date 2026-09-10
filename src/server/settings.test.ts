import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeDashboardSettings, normalizeTargetRepos, readDashboardSettings, writeDashboardSettings } from "./settings";

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
      targetRepos: ["fallback/repo"], attentionWorkspace: "default", attentionSourceIntervalSeconds: 900, attentionOpenAgeDays: 7
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

describe("attention settings normalization", () => {
  it("roundtrips every key and normalizes repository interval spelling", async () => {
    const root = await mkdtemp(join(tmpdir(), "dashboard-settings-roundtrip-"));
    const path = join(root, "settings.json");
    const input = { targetRepos: ["example/app"], attentionWorkspace: "Desk.east:1", attentionOpenAgeDays: 2,
      attentionSourceIntervalSeconds: { default: 600, repositories: { "Example/App": 120 }, futureInterval: true },
      future: { nested: [1, "two", null] } };
    const saved = await writeDashboardSettings(path, input);
    expect(saved).toEqual({ ...input, attentionSourceIntervalSeconds: { ...input.attentionSourceIntervalSeconds, repositories: { "example/app": 120 } } });
    expect(await readDashboardSettings(path, { targetRepos: [] })).toEqual(saved);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(saved);
  });

  it.each([
    ["attentionWorkspace", "../private"], ["attentionWorkspace", ""], ["attentionWorkspace", "a".repeat(161)],
    ["attentionWorkspace", "a..b"], ["attentionWorkspace", null],
    ["attentionOpenAgeDays", 0], ["attentionOpenAgeDays", 2.5], ["attentionOpenAgeDays", "7"], ["attentionOpenAgeDays", Infinity],
    ["attentionSourceIntervalSeconds", 0], ["attentionSourceIntervalSeconds", 604801],
    ["attentionSourceIntervalSeconds", "900"], ["attentionSourceIntervalSeconds", { default: 0 }],
    ["attentionSourceIntervalSeconds", { default: 900, repositories: { "../app": 20 } }],
    ["attentionSourceIntervalSeconds", { default: 900, repositories: { "example/app": -1 } }],
    ["attentionSourceIntervalSeconds", { default: 900, repositories: { "Example/App": 30, "example/app": 60 } }]
  ])("rejects invalid %s: %j without writing", async (key, value) => {
    const root = await mkdtemp(join(tmpdir(), "dashboard-settings-invalid-"));
    const path = join(root, "settings.json");
    await writeFile(path, "unchanged");
    const input = { targetRepos: ["example/app"], [key as string]: value };
    expect(() => normalizeDashboardSettings(input)).toThrow(key as string);
    await expect(writeDashboardSettings(path, input)).rejects.toThrow(key as string);
    expect(await readFile(path, "utf8")).toBe("unchanged");
  });

  it("normalizes fallback defaults without losing the doctor first-run sentinel", async () => {
    const root = await mkdtemp(join(tmpdir(), "dashboard-settings-fallback-"));
    const settings = await readDashboardSettings(join(root, "missing"), { targetRepos: [], future: true });
    expect(settings).toEqual({ targetRepos: [], future: true, attentionWorkspace: "default", attentionSourceIntervalSeconds: 900, attentionOpenAgeDays: 7 });
    await expect(writeDashboardSettings(join(root, "saved"), settings)).rejects.toThrow("targetRepos");
    await expect(readDashboardSettings(join(root, "missing"), { targetRepos: [], attentionWorkspace: "../escape" })).rejects.toThrow("attentionWorkspace");
  });
});
