import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAttentionModel } from "./buildAttentionModel";
import {
  ATTENTION_READ_OUTCOME_KINDS,
  ATTENTION_WORKSPACE,
  type AttentionReadCounts,
  type AttentionReadResult,
  type AttentionRepositoryRead
} from "./readAttentionRecords";
import {
  ATTENTION_SAMPLE_INTERVAL_MS,
  ATTENTION_SAMPLES_FILENAME,
  attentionSamplesPath,
  createAttentionSampler,
  type AttentionSampleRow,
  type AttentionSamplerOptions
} from "./sampler";
import type { AttentionPayload, AttentionRecord } from "../../shared/attention";
import { attentionRepository, codexSource, makeAttentionRecord } from "../../shared/attention.fixtures";

/** The dashboard clock for the first sample; later samples move on from here. */
const NOW = new Date("2026-09-03T09:30:00.000Z");
const MINUTE_MS = 60000;

/**
 * The exact columns, in order, that the kill test in
 * shakacode/agent-coordination-dashboard#134 reads out of the file.
 */
const SAMPLE_COLUMNS = [
  "ts",
  "open",
  "urgent",
  "new_urgent_since_last",
  "stale_sources",
  "stale_companions",
  "open_age_flagged",
  "document_loads_since_last"
];

const roots: string[] = [];

async function stateRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

/** The settings file the sampler resolves the samples file beside. */
function settingsFileIn(root: string): string {
  return join(root, "settings.json");
}

async function readRows(root: string): Promise<AttentionSampleRow[]> {
  const text = await readFile(join(root, ATTENTION_SAMPLES_FILENAME), "utf8");
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as AttentionSampleRow);
}

function emptyCounts(): AttentionReadCounts {
  const outcomes = {} as AttentionReadCounts["outcomes"];
  for (const kind of ATTENTION_READ_OUTCOME_KINDS) {
    outcomes[kind] = 0;
  }
  return { seen: 0, read: 0, skipped: 0, outcomes };
}

function readOf(records: AttentionRecord[], at: Date): AttentionReadResult {
  const repositoryRead: AttentionRepositoryRead = {
    repository: attentionRepository,
    workspace: ATTENTION_WORKSPACE,
    mode: "fs",
    prefix: `attention/${ATTENTION_WORKSPACE}/${attentionRepository}`,
    sourceStatus: { status: "ok", checkedAt: at.toISOString() },
    records,
    diagnostics: [],
    partial: false,
    counts: emptyCounts()
  };
  return {
    workspace: ATTENTION_WORKSPACE,
    mode: "fs",
    checkedAt: at.toISOString(),
    repositories: [repositoryRead]
  };
}

/**
 * The payload the route would have served at `at`.
 *
 * The sampler is fed the real model output rather than a hand-written payload,
 * so the counts it reports are checked against the rules the model actually
 * applies — a suppression kind renamed upstream shows up here as a wrong count,
 * not as a fixture that agrees with the sampler and with nothing else.
 */
function payloadAt(records: AttentionRecord[], at: Date): AttentionPayload {
  return buildAttentionModel(readOf(records, at), { now: at, machineId: "m1" });
}

interface RecordOverrides {
  id: string;
  pull: number;
  created_at: string;
  priority_class?: AttentionRecord["priority_class"];
  /** Minutes before the sample clock; past the staleness window it is suppressed. */
  refreshedMinutesAgo?: number;
  lastSeenMinutesAgo?: number;
}

/** A record positioned against one sample clock, fresh unless asked otherwise. */
function recordAt(overrides: RecordOverrides, at: Date): AttentionRecord {
  const minutesBefore = (minutes: number): string => new Date(at.getTime() - minutes * MINUTE_MS).toISOString();
  return makeAttentionRecord({
    id: overrides.id,
    target: `https://github.com/${attentionRepository}/pull/${overrides.pull}`,
    priority_class: overrides.priority_class ?? "unblocks-work",
    created_at: overrides.created_at,
    refreshed_at: minutesBefore(overrides.refreshedMinutesAgo ?? 0),
    source: { ...codexSource, last_seen_at: minutesBefore(overrides.lastSeenMinutesAgo ?? 0) }
  });
}

/** Urgent, two days old: it counts as urgent but not as an aged card. */
function urgentRecord(at: Date): AttentionRecord {
  return recordAt(
    { id: "urgent-two-days", pull: 301, priority_class: "urgent-risk", created_at: "2026-09-01T09:00:00Z" },
    at
  );
}

/** Open for a fortnight, so the model flags its age. */
function agedRecord(at: Date): AttentionRecord {
  return recordAt({ id: "aged-fortnight", pull: 302, created_at: "2026-08-20T09:00:00Z" }, at);
}

/** `refreshed_at` past twice the default refresh interval; the companion is fresh. */
function staleSourceRecord(at: Date): AttentionRecord {
  return recordAt(
    { id: "stale-source", pull: 303, created_at: "2026-09-02T09:00:00Z", refreshedMinutesAgo: 31 },
    at
  );
}

/** `source.last_seen_at` past the same window; the record itself is fresh. */
function staleCompanionRecord(at: Date): AttentionRecord {
  return recordAt(
    { id: "stale-companion", pull: 304, created_at: "2026-09-02T09:00:00Z", lastSeenMinutesAgo: 31 },
    at
  );
}

function samplerFor(root: string, at: Date, overrides: Partial<AttentionSamplerOptions> = {}) {
  return createAttentionSampler({
    settingsFilePath: settingsFileIn(root),
    readPayload: async () => payloadAt([], at),
    now: () => at,
    ...overrides
  });
}

describe("attention sampler", () => {
  beforeEach(() => {
    // No test here may depend on real elapsed time: the sampler's own clock is
    // injected, and the scheduling test drives the interval by hand.
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
  });

  it("appends one row carrying exactly the columns the kill test reads", async () => {
    const root = await stateRoot("attention-sampler-row-");
    const records = [
      urgentRecord(NOW),
      agedRecord(NOW),
      staleSourceRecord(NOW),
      staleCompanionRecord(NOW)
    ];
    const sampler = samplerFor(root, NOW, { readPayload: async () => payloadAt(records, NOW) });

    sampler.countDocumentLoad();
    sampler.countDocumentLoad();
    await sampler.sample();

    const rows = await readRows(root);
    expect(rows).toHaveLength(1);
    // The order matters as much as the set: the kill test reads a fixed file.
    expect(Object.keys(rows[0])).toEqual(SAMPLE_COLUMNS);
    expect(rows[0]).toEqual({
      ts: NOW.toISOString(),
      // The two suppressed records are not cards, so they are not open either.
      open: 2,
      urgent: 1,
      new_urgent_since_last: 1,
      stale_sources: 1,
      stale_companions: 1,
      open_age_flagged: 1,
      document_loads_since_last: 2
    });
  });

  it("writes the file beside settings.json, creating the state directory when it is missing", async () => {
    const root = await stateRoot("attention-sampler-mkdir-");
    const stateDirectory = join(root, "nested", "state");
    const sampler = createAttentionSampler({
      settingsFilePath: join(stateDirectory, "settings.json"),
      readPayload: async () => payloadAt([], NOW),
      now: () => NOW
    });

    await sampler.sample();

    expect(attentionSamplesPath(join(stateDirectory, "settings.json"))).toBe(
      join(stateDirectory, ATTENTION_SAMPLES_FILENAME)
    );
    await expect(readFile(join(stateDirectory, ATTENTION_SAMPLES_FILENAME), "utf8")).resolves.toContain('"open":0');
  });

  it("counts new urgent records against the previous row read back from the file, across a restart", async () => {
    const root = await stateRoot("attention-sampler-restart-");
    const later = new Date(NOW.getTime() + 10 * MINUTE_MS);
    const laterStill = new Date(NOW.getTime() + 20 * MINUTE_MS);
    const arrivedBetween = new Date(NOW.getTime() + 5 * MINUTE_MS).toISOString();
    const secondUrgent = (at: Date): AttentionRecord =>
      recordAt({ id: "urgent-arrived", pull: 305, priority_class: "urgent-risk", created_at: arrivedBetween }, at);

    // Each sampler is a fresh process: nothing carries over but the file.
    const first = samplerFor(root, NOW, { readPayload: async () => payloadAt([urgentRecord(NOW)], NOW) });
    await first.sample();

    const second = samplerFor(root, later, {
      readPayload: async () => payloadAt([urgentRecord(later), secondUrgent(later)], later)
    });
    await second.sample();

    const third = samplerFor(root, laterStill, {
      readPayload: async () => payloadAt([urgentRecord(laterStill), secondUrgent(laterStill)], laterStill)
    });
    await third.sample();

    const rows = await readRows(root);
    expect(rows.map((row) => row.ts)).toEqual([NOW, later, laterStill].map((at) => at.toISOString()));
    // Nothing precedes the first row, so every open urgent record is new in it.
    expect(rows[0]).toMatchObject({ urgent: 1, new_urgent_since_last: 1 });
    // Only the record created after the first row's ts is new in the second.
    expect(rows[1]).toMatchObject({ urgent: 2, new_urgent_since_last: 1 });
    // The third restart re-reads the same two records and reports neither
    // again: the boundary came off the file, not out of memory.
    expect(rows[2]).toMatchObject({ urgent: 2, new_urgent_since_last: 0 });
  });

  it("takes the boundary from the newest readable row when the file ends in a torn line", async () => {
    const root = await stateRoot("attention-sampler-torn-");
    const complete: AttentionSampleRow = {
      ts: NOW.toISOString(),
      open: 1,
      urgent: 1,
      new_urgent_since_last: 1,
      stale_sources: 0,
      stale_companions: 0,
      open_age_flagged: 0,
      document_loads_since_last: 0
    };
    await writeFile(
      join(root, ATTENTION_SAMPLES_FILENAME),
      `${JSON.stringify(complete)}\n{"ts":"2026-09-03T09:4`,
      "utf8"
    );
    const later = new Date(NOW.getTime() + 10 * MINUTE_MS);
    const sampler = samplerFor(root, later, {
      readPayload: async () => payloadAt([urgentRecord(later)], later)
    });

    await sampler.sample();

    const lines = (await readFile(join(root, ATTENTION_SAMPLES_FILENAME), "utf8"))
      .split("\n")
      .filter((line) => line !== "");
    expect(lines).toHaveLength(3);
    // The torn line stays exactly as it was, and the new row is a line of its
    // own: appending onto that tail would lose the new row as well.
    expect(lines[1]).toBe('{"ts":"2026-09-03T09:4');
    // A half-written line must not read as "no previous row" either: that would
    // report the same urgent record as new a second time.
    expect(JSON.parse(lines[2]) as AttentionSampleRow).toMatchObject({
      ts: later.toISOString(),
      urgent: 1,
      new_urgent_since_last: 0
    });
  });

  it("swallows a write failure after one warning, and carries the counts into the next row", async () => {
    const root = await stateRoot("attention-sampler-write-failure-");
    // A directory where the file belongs: the append fails, the read does not.
    await mkdir(join(root, ATTENTION_SAMPLES_FILENAME), { recursive: true });
    const warnings: string[] = [];
    const logger = { warn: (message: string) => warnings.push(message) };
    const sampler = samplerFor(root, NOW, {
      logger,
      readPayload: async () => payloadAt([urgentRecord(NOW)], NOW)
    });

    sampler.countDocumentLoad();
    await expect(sampler.sample()).resolves.toBeUndefined();

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(join(root, ATTENTION_SAMPLES_FILENAME));

    await rm(join(root, ATTENTION_SAMPLES_FILENAME), { force: true, recursive: true });
    sampler.countDocumentLoad();
    await sampler.sample();

    const rows = await readRows(root);
    expect(rows).toHaveLength(1);
    // A row that never landed consumed nothing: both loads are still owed.
    expect(rows[0]).toMatchObject({ document_loads_since_last: 2, new_urgent_since_last: 1 });
  });

  it("carries a load that arrives while a row is being written into the next row", async () => {
    const root = await stateRoot("attention-sampler-load-window-");
    const clock = { value: NOW };
    const sampler = samplerFor(root, NOW, { now: () => clock.value });

    sampler.countDocumentLoad();
    const pending = sampler.sample();
    // After the row claimed its count and before it landed.
    sampler.countDocumentLoad();
    await pending;

    clock.value = new Date(NOW.getTime() + 10 * MINUTE_MS);
    await sampler.sample();

    const rows = await readRows(root);
    // Zeroing the counter instead of subtracting the claim would lose the
    // second arrival entirely.
    expect(rows.map((row) => row.document_loads_since_last)).toEqual([1, 1]);
  });

  it("keeps serving the payload when the read fails, and writes no row for it", async () => {
    const root = await stateRoot("attention-sampler-read-failure-");
    const warnings: string[] = [];
    const sampler = samplerFor(root, NOW, {
      logger: { warn: (message: string) => warnings.push(message) },
      readPayload: async () => {
        throw new Error("attention read exploded");
      }
    });

    await expect(sampler.sample()).resolves.toBeUndefined();

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("attention read exploded");
    await expect(readRows(root)).rejects.toThrow();
  });

  it("samples once an hour and stops on demand", async () => {
    const root = await stateRoot("attention-sampler-interval-");
    // The kill test counts 336 hourly rows, so the period is an hour exactly.
    expect(ATTENTION_SAMPLE_INTERVAL_MS).toBe(60 * 60 * 1000);
    const reads: string[] = [];
    const sampler = samplerFor(root, NOW, {
      readPayload: async () => {
        reads.push("read");
        return payloadAt([], NOW);
      }
    });

    expect(vi.getTimerCount()).toBe(0);
    sampler.start();
    // Idempotent: a second start must not arm a second interval.
    sampler.start();
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(ATTENTION_SAMPLE_INTERVAL_MS - 1);
    expect(reads).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(reads).toHaveLength(1);

    sampler.stop();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(ATTENTION_SAMPLE_INTERVAL_MS * 2);
    // Join the tick that is still writing, so the temp root outlives it.
    await sampler.sample();
    expect(reads).toHaveLength(1);
  });
});
