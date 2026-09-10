/**
 * Hourly attention sampling for the kill test in
 * shakacode/agent-coordination-dashboard#134.
 *
 * The job is not a product surface: nothing in the Human Attention view shows
 * these rows, and the view never reads the file. It exists so the kill test can
 * ask, after 336 hours, whether the page earned its place — whether the median
 * open count stayed above three, and whether the desk came back to the page
 * more often than new urgent items arrived.
 *
 * That question only means something if the sample is independent of the page:
 * a row every hour whether or not anyone looked. So the interval is a server
 * timer rather than a request hook, and the only thing a request contributes is
 * the document-load count.
 *
 * The job stays inside the read-only product boundary. It reads the attention
 * payload the model already built, appends one line to the dashboard's own
 * state directory, and touches no coordination record and no GitHub endpoint.
 *
 * Every failure is swallowed after a warning. A sample that cannot be written
 * is a lost row in a measurement file; it is never a failed request and never a
 * blank page.
 */

import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { normalizeTargetRepos } from "../settings";
import type { AttentionModelDiagnosticKind } from "./buildAttentionModel";
import type { AttentionPayload } from "../../shared/attention";

/** One hour, the sampling period the kill test counts rows in. */
export const ATTENTION_SAMPLE_INTERVAL_MS = 3600000;

/** The samples file, written beside `settings.json` in the state directory. */
export const ATTENTION_SAMPLES_FILENAME = "attention-samples.jsonl";
export const ATTENTION_SAMPLE_SCOPE_FILENAME = "attention-samples.scope.json";

/** Repository spelling/order is not a change of measurement population. */
function normalizedScope(repositories: readonly string[]): string[] {
  return normalizeTargetRepos(repositories.map((repository) => repository.toLowerCase()));
}

interface SampleScope {
  targetRepos: string[];
  workspace: string;
}

function sampleScope(repositories: readonly string[], workspace: string): SampleScope {
  return { targetRepos: normalizedScope(repositories), workspace };
}

/**
 * The suppression kinds the row counts, pinned to the model's own vocabulary so
 * renaming one upstream fails this build instead of silently zeroing a column.
 */
const STALE_SOURCE_KIND: AttentionModelDiagnosticKind = "stale_source";
const STALE_COMPANION_KIND: AttentionModelDiagnosticKind = "stale_companion";

/** The urgency class the kill test's "new urgent items" arm counts. */
const URGENT_PRIORITY_CLASS = "urgent-risk";

/**
 * One JSONL row. These keys and no others: the kill test reads the file with a
 * fixed reader, so an added or renamed column is a breaking change to it.
 */
export interface AttentionSampleRow {
  /** The payload snapshot time, ISO 8601; it can precede the hourly write. */
  ts: string;
  /** Rendered open cards at that instant. */
  open: number;
  /** Rendered open cards in the `urgent-risk` class. */
  urgent: number;
  /** Urgent cards created after the previous row's `ts`. */
  new_urgent_since_last: number;
  /** `stale_source` suppressions in the payload. */
  stale_sources: number;
  /** `stale_companion` suppressions in the payload. */
  stale_companions: number;
  /** Rendered cards the model flagged for their open age. */
  open_age_flagged: number;
  /** HTML document loads and loopback foreground refreshes since the last row. */
  document_loads_since_last: number;
}

/** The hourly job, called by the scheduler; it never rejects. */
export type AttentionSampleTick = () => Promise<void>;

/**
 * Schedules {@link AttentionSampleTick} every `delayMs` and returns the call
 * that cancels it. Returning the cancel rather than a handle keeps the timer
 * type private to whoever scheduled it, so a test seam has nothing to fake.
 */
export type AttentionSampleScheduler = (tick: AttentionSampleTick, delayMs: number) => () => void;

export interface AttentionSamplerOptions {
  /**
   * The dashboard's `settings.json`, already resolved through `settingsPath`.
   * The samples file is its neighbour, so both live in the one state directory.
   */
  settingsFilePath: string;
  /**
   * The payload source.
   *
   * Production hands this the same cached read the route uses rather than a
   * fresh read of its own: an hourly sample must not double the read load, and
   * a payload up to one cache TTL old is still a fair snapshot of an hour.
   */
  readPayload: () => Promise<AttentionPayload>;
  /** Injectable for tests; defaults to the current time. */
  now?: () => Date;
  /** Injectable for tests; defaults to {@link ATTENTION_SAMPLE_INTERVAL_MS}. */
  intervalMs?: number;
  /** Injectable for tests; defaults to an unref'd `setInterval`. */
  schedule?: AttentionSampleScheduler;
  /** Injectable for tests; defaults to the console. */
  logger?: Pick<Console, "warn">;
}

export interface AttentionSampler {
  /**
   * Record one operator arrival: an HTML document load or a loopback
   * foreground refresh. Never a poll.
   */
  countDocumentLoad(): void;
  /** Start a new visit bucket when the repository set or workspace changes. */
  setScope(repositories: readonly string[], workspace?: string): void;
  /** Append one row now. Never throws and never rejects. */
  sample: AttentionSampleTick;
  /** Begin sampling every interval. Idempotent. */
  start(): void;
  /** Stop sampling. Idempotent. */
  stop(): void;
}

/** The samples file for a given `settings.json`. */
export function attentionSamplesPath(settingsFilePath: string): string {
  return join(dirname(settingsFilePath), ATTENTION_SAMPLES_FILENAME);
}

const scheduleHourly: AttentionSampleScheduler = (tick, delayMs) => {
  const handle = setInterval(tick, delayMs);
  // The HTTP server is what keeps the dashboard process alive. An hourly
  // sample must not extend a process that is otherwise finished. `unref` is
  // Node's; a browser-shaped timer host does not offer one, and there is
  // nothing to hold open there either.
  handle.unref?.();
  return () => {
    clearInterval(handle);
  };
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isEnoent(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

/**
 * The newest `ts` the file already carries, as an instant, or `null` when the
 * file has no row to read one from.
 *
 * Scanning back from the end rather than taking the last line outright: a row
 * truncated by a half-finished append must not reset the boundary to "no
 * previous row", which would count every open urgent record a second time. The
 * newest row that parses wins; when none does, the file is treated as empty,
 * which is the same state as the very first sample.
 */
function previousSampleInstant(text: string): number | null {
  const lines = text.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (line === "") {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const ts: unknown = (parsed as Partial<AttentionSampleRow> | null)?.ts;
    const instant = typeof ts === "string" ? Date.parse(ts) : Number.NaN;
    if (Number.isFinite(instant)) {
      return instant;
    }
  }
  return null;
}

interface PreviousSample {
  exists: boolean;
  /** The newest readable `ts` as an instant, or `null` when the file has none. */
  instant: number | null;
  /** True when the file does not end in a newline, so the next row needs one. */
  needsSeparator: boolean;
}

/**
 * The boundary for `new_urgent_since_last`, read back from the file on every
 * sample rather than held in memory.
 *
 * That is the whole point of the column: a restart loses in-memory state, and a
 * counter that reset with the process would either recount every open urgent
 * record or, if it were persisted separately, drift out of step with the rows
 * it describes. Within a scope period, the boundary is exactly the last row
 * that was actually written.
 *
 * A missing file is the first sample, not a failure. Any other read failure is
 * raised: writing a row whose boundary could not be established would report a
 * count nobody can interpret.
 */
async function readPreviousSample(samplesPath: string): Promise<PreviousSample> {
  let text: string;
  try {
    text = await readFile(samplesPath, "utf8");
  } catch (error) {
    if (isEnoent(error)) {
      return { instant: null, needsSeparator: false, exists: false };
    }
    throw error;
  }
  return {
    exists: true,
    instant: previousSampleInstant(text),
    // A row cut short by a half-finished append is one unreadable line; it must
    // not take the next row down with it by having it appended onto its tail.
    needsSeparator: text !== "" && !text.endsWith("\n")
  };
}

/**
 * A row boundary is meaningful only within one repository population. Read the
 * sidecar on every tick, including after restart. Unknown legacy history is
 * preserved, never silently attributed to the currently configured targets.
 *
 * Move old rows before replacing metadata: a crash or metadata-write failure
 * can leave an empty active period, but cannot relabel old rows as a new scope.
 * This runs inside the same single-flight operation as the append.
 */
async function prepareSamplePeriod(samplesPath: string, scope: SampleScope, restart: boolean): Promise<PreviousSample> {
  const previous = await readPreviousSample(samplesPath);
  const scopePath = join(dirname(samplesPath), ATTENTION_SAMPLE_SCOPE_FILENAME);
  let metadata: string | null;
  try {
    metadata = await readFile(scopePath, "utf8");
  } catch (error) {
    if (!isEnoent(error)) throw error;
    metadata = null;
  }
  let savedScope: string | null = null;
  try {
    const parsed = JSON.parse(metadata ?? "null");
    if ((parsed?.version === 1 || (parsed?.version === 2 && typeof parsed.workspace === "string")) && Array.isArray(parsed.targetRepos) &&
      parsed.targetRepos.every((value: unknown) => typeof value === "string") &&
      normalizedScope(parsed.targetRepos).length === parsed.targetRepos.length) {
      savedScope = JSON.stringify(sampleScope(parsed.targetRepos, parsed.version === 1 ? "default" : parsed.workspace));
    }
  } catch {
    // Malformed metadata makes the history unknown, not a new empty history.
  }
  if (!restart && savedScope === JSON.stringify(scope)) return previous;

  await mkdir(dirname(samplesPath), { recursive: true });
  if (previous.exists) {
    const archiveStem = join(dirname(samplesPath), `attention-samples.${randomUUID()}.archive`);
    // Write the archive's attribution before moving its data. An exclusive
    // unique filename never overwrites a previous measurement period.
    await writeFile(`${archiveStem}.scope.json`, metadata ?? '{"scope":"UNKNOWN"}\n', { flag: "wx" });
    await rename(samplesPath, `${archiveStem}.jsonl`);
  }
  await writeFile(scopePath, `${JSON.stringify({ version: 2, ...scope })}\n`, "utf8");
  return { instant: null, needsSeparator: false, exists: false };
}

function isUrgent(priorityClass: unknown): boolean {
  return priorityClass === URGENT_PRIORITY_CLASS;
}

/**
 * Whether a card's record was created after the previous row.
 *
 * With no previous row every open urgent record is new, as the first sample has
 * nothing to have reported them in. A `created_at` that is not a readable
 * instant is not later than anything: an unreadable timestamp has not been
 * shown to be new, and the payload it arrived in is the same one the count
 * describes.
 */
function createdAfter(createdAt: unknown, boundaryMs: number | null): boolean {
  if (boundaryMs === null) {
    return true;
  }
  const created = Date.parse(typeof createdAt === "string" ? createdAt : "");
  return Number.isFinite(created) && created > boundaryMs;
}

function countDiagnostics(payload: AttentionPayload, kind: string): number {
  return payload.diagnostics.filter((entry) => entry.kind === kind).length;
}

/**
 * Every count comes off the payload the model already produced. None of the
 * counting rules — which records are open, which are urgent, which are stale,
 * which have been open too long — is restated here; the model owns all of them,
 * and a second copy would be a second answer.
 */
function buildSampleRow(
  payload: AttentionPayload,
  ts: string,
  previousInstant: number | null,
  documentLoads: number
): AttentionSampleRow {
  const urgent = payload.cards.filter((card) => isUrgent(card.record.priority_class));
  return {
    ts,
    open: payload.cards.length,
    urgent: urgent.length,
    new_urgent_since_last: urgent.filter((card) => createdAfter(card.record.created_at, previousInstant)).length,
    stale_sources: countDiagnostics(payload, STALE_SOURCE_KIND),
    stale_companions: countDiagnostics(payload, STALE_COMPANION_KIND),
    open_age_flagged: payload.cards.filter((card) => card.verify_open_age).length,
    document_loads_since_last: documentLoads
  };
}

/**
 * The hourly sampler and the document-load counter it reports.
 *
 * The counter lives here rather than in the app because only the sampler knows
 * when a count has been reported: it is consumed by a row that landed, and by
 * nothing else.
 */
export function createAttentionSampler(options: AttentionSamplerOptions): AttentionSampler {
  const samplesPath = attentionSamplesPath(options.settingsFilePath);
  const now = options.now ?? (() => new Date());
  const intervalMs = options.intervalMs ?? ATTENTION_SAMPLE_INTERVAL_MS;
  const schedule = options.schedule ?? scheduleHourly;
  const logger = options.logger ?? console;

  let period: { scope: string | null; documentLoads: number; restart: boolean } = {
    scope: null, documentLoads: 0, restart: false
  };

  function setScope(repositories: readonly string[], workspace = "default"): void {
    const scope = JSON.stringify(sampleScope(repositories, workspace));
    if (period.scope === null) {
      period.scope = scope;
    } else if (period.scope !== scope) {
      // Visits in the old population cannot be combined with the new one.
      // Keep the old object alive for a write that already claimed its loads.
      period = { scope, documentLoads: 0, restart: true };
    }
  }
  let cancel: (() => void) | null = null;
  let inFlight: Promise<void> | null = null;

  async function appendRow(): Promise<void> {
    // Claimed before anything is awaited, so the row reports exactly the loads
    // that had arrived when the sample began. One that lands while the row is
    // being built belongs to the next row; one this row never managed to write
    // stays owed. Subtracting the claim rather than zeroing the counter is what
    // makes both true, so no arrival is dropped and none is reported twice.
    const claimedPeriod = period;
    const claimed = claimedPeriod.documentLoads;
    const payload = await options.readPayload();
    const scope = sampleScope(payload.sources.map((source) => source.repository), payload.workspace ?? "default");
    if (period.scope === null) setScope(scope.targetRepos, scope.workspace);
    if (claimedPeriod !== period || period.scope !== JSON.stringify(scope)) {
      throw new Error("Attention scope changed while the sample was being read.");
    }
    // The route represents backend failures as payloads, not rejections. A
    // failed source is unknown, not zero, and must not advance the boundary
    // past urgent records we could not read. Keep visits owed until recovery.
    if (
      payload.sources.some((source) => (source.status !== "ok" && source.status !== "empty") || source.partial) ||
      payload.diagnostics.some((entry) => entry.kind === "unreadable" || entry.kind === "diagnostics_truncated")
    ) {
      throw new Error("Attention sources could not all be read.");
    }
    // Persist the snapshot boundary, not the write time. The route may return
    // a cached payload; advancing past it would skip urgent records created
    // after that snapshot but before this sample on every subsequent restart.
    const snapshot = new Date(payload.generated_at);
    if (!(snapshot.getTime() <= now().getTime())) {
      throw new Error("Attention snapshot timestamp is invalid or in the future.");
    }
    const previous = await prepareSamplePeriod(samplesPath, scope, claimedPeriod.restart);
    claimedPeriod.restart = false;
    if (claimedPeriod !== period) {
      throw new Error("Attention scope changed before the sample could be appended.");
    }
    const ts = snapshot.toISOString();
    const row = buildSampleRow(payload, ts, previous.instant, claimed);
    await mkdir(dirname(samplesPath), { recursive: true });
    await appendFile(samplesPath, `${previous.needsSeparator ? "\n" : ""}${JSON.stringify(row)}\n`, "utf8");
    claimedPeriod.documentLoads -= claimed;
  }

  /**
   * One sample, at most one at a time. A read slower than the interval must not
   * put two samples in the same file with the same boundary; the overlapping
   * tick joins the one already running instead.
   */
  function sample(): Promise<void> {
    if (inFlight !== null) {
      return inFlight;
    }
    const running: Promise<void> = appendRow()
      .catch((error: unknown) => {
        // Best-effort by design: the row is lost and the counts it would have
        // reported roll into the next row, which is the whole consequence.
        logger.warn(`Attention sampler could not append a row to ${samplesPath}: ${errorText(error)}`);
      })
      .finally(() => {
        if (inFlight === running) {
          inFlight = null;
        }
      });
    inFlight = running;
    return running;
  }

  return {
    countDocumentLoad(): void {
      period.documentLoads += 1;
    },
    setScope,
    sample,
    start(): void {
      if (cancel === null) {
        cancel = schedule(sample, intervalMs);
      }
    },
    stop(): void {
      if (cancel !== null) {
        cancel();
        cancel = null;
      }
    }
  };
}
