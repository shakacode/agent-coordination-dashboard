import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { validateAttentionRecord, type AttentionRecordValidationError } from "./validator";
import {
  readStatePrefixes,
  toAttentionPrefix,
  type AttentionPrefix,
  type CoordinationApiOptions,
  type StatePrefixReadResult,
  type StateSourceState
} from "../coordinationApi";
import type { AttentionRecord } from "../../shared/attention";

/**
 * Read the attention records for the configured target repositories.
 *
 * The module is pure read logic: no routes, no cache, no timer, no settings
 * I/O, and no logging. It never throws for data, filesystem, or backend
 * problems — every one of those becomes a typed diagnostic plus a per
 * repository source status, so the read-only attention view can render
 * `UNKNOWN` and a warning instead of an error page.
 *
 * Two modes, chosen by the same rule `src/server/config.ts` and
 * `src/server/doctor.ts` already use: filesystem when no coordination API URL
 * is configured, API otherwise. Filesystem mode walks the state root with
 * `node:fs/promises` and never spawns `agent-coord` or any other child
 * process; API mode goes through the coordination read client and never
 * touches the disk, GitHub, or `fetch` directly.
 */

/**
 * The only workspace the dashboard reads today. PR 1b turns it into a setting;
 * until then every prefix and every result carries this constant.
 */
export const ATTENTION_WORKSPACE = "default";

/** Per repository read budget: listing entries examined before the read stops. */
export const ATTENTION_READ_ENTRY_LIMIT = 2000;

/** Per repository read budget: monotonic milliseconds before the read stops. */
export const ATTENTION_READ_TIME_BUDGET_MS = 2000;

/** 256 KiB. Larger files are skipped before parsing, never read into memory. */
export const ATTENTION_RECORD_MAX_BYTES = 262144;

/**
 * The record file suffix from the schema's storage key,
 * `attention/{workspace}/{owner}/{name}/{id}.json`.
 *
 * It is the whole candidate rule in filesystem mode. The `agent-coord` local
 * store writes each record under a lock and leaves a persistent zero-byte
 * `<id>.json.lock` beside it that it never removes, so a reader that treated
 * every regular file as a record would raise one spurious diagnostic per record
 * and spend half its budget on sidecars. Matching the storage key instead of
 * excluding one known suffix also covers the next sidecar or editor backup
 * without another rule.
 */
export const ATTENTION_RECORD_FILE_SUFFIX = ".json";

/**
 * Every outcome a single candidate record can have. The set is closed: a file
 * or listing entry produces exactly one of these, or none at all when it is
 * not a candidate (a directory, a socket, an entry the budget never reached).
 *
 * `oversize` and `vanished` cannot occur in API mode: entries arrive already
 * parsed inside one listing, so there is no file to stat and no window between
 * a listing and a read. They are never synthesized to fill the gap.
 */
export const ATTENTION_READ_OUTCOME_KINDS = [
  "ok",
  "vanished",
  "unreadable",
  "invalid_json",
  "oversize",
  "schema_invalid",
  "repository_mismatch",
  "workspace_mismatch",
  "id_mismatch"
] as const;

export type AttentionReadOutcomeKind = (typeof ATTENTION_READ_OUTCOME_KINDS)[number];

/**
 * The outcomes that are reported.
 *
 * `ok` needs no diagnostic, and `vanished` is silent by design: a control tower
 * writes records with an atomic rename, so an `ENOENT` between `readdir` and
 * the read is the normal effect of a concurrent write, not a fault. It is
 * counted in {@link AttentionReadCounts.outcomes} and nowhere else.
 */
export type AttentionReadDiagnosticKind = Exclude<AttentionReadOutcomeKind, "ok" | "vanished">;

export type AttentionReadMode = "fs" | "api";

export interface AttentionReadDiagnostic {
  /** The configured `owner/name` this diagnostic belongs to. */
  repository: string;
  workspace: string;
  mode: AttentionReadMode;
  kind: AttentionReadDiagnosticKind;
  /**
   * `attention/<workspace>/<owner>/<name>[/<file>]`: the record's path relative
   * to the state root in filesystem mode, the listing path in API mode, and the
   * repository's own prefix for a diagnostic about the source rather than one
   * record. Absolute paths never appear here.
   */
  path: string;
  reason: string;
}

/**
 * Counts for one repository's read, with the invariant `seen === read + skipped`.
 *
 * - `seen`: every entry in the listing, candidate or not, whether or not the
 *   budget reached it.
 * - `read`: entries whose bytes were read, so exactly the entries that produced
 *   `ok`, `invalid_json`, `schema_invalid`, `repository_mismatch`,
 *   `workspace_mismatch`, or `id_mismatch`. A zero-byte candidate is read (and
 *   reported as `invalid_json`), not skipped.
 * - `skipped`: everything else — names that are not
 *   {@link ATTENTION_RECORD_FILE_SUFFIX} candidates, non-regular entries,
 *   oversize files, files that vanished or could not be read, and candidates
 *   the budget stopped short of.
 * - `outcomes`: the per-outcome tally, including the silent `vanished` count.
 */
export interface AttentionReadCounts {
  seen: number;
  read: number;
  skipped: number;
  outcomes: Record<AttentionReadOutcomeKind, number>;
}

/**
 * Reachability of one repository's records, not the quality of their data: a
 * listing that answered with nothing but malformed files is still `ok`.
 * `empty` means the listing held no entries, which includes a state root,
 * attention directory, workspace directory, or repository directory that does
 * not exist — an uninitialized coordination root is a normal first-run state.
 */
export interface AttentionReadSourceStatus {
  status: StateSourceState;
  checkedAt: string;
  /** Present only when the coordination API answered with a status code. */
  httpStatus?: number;
}

export interface AttentionRepositoryRead {
  /** The configured `owner/name`, exactly as it appears in `targetRepos`. */
  repository: string;
  workspace: string;
  mode: AttentionReadMode;
  /** `attention/<workspace>/<owner>/<name>`. */
  prefix: string;
  sourceStatus: AttentionReadSourceStatus;
  /** Schema-valid records at their own storage key in this repository and workspace. */
  records: AttentionRecord[];
  diagnostics: AttentionReadDiagnostic[];
  /** True when the read budget stopped before the whole listing was examined. */
  partial: boolean;
  counts: AttentionReadCounts;
}

export interface AttentionReadResult {
  workspace: string;
  mode: AttentionReadMode;
  checkedAt: string;
  repositories: AttentionRepositoryRead[];
}

/** The `node:fs` surface this reader uses, narrowed to what it needs. */
export interface AttentionFileStats {
  isFile(): boolean;
  size: number;
}

/** The outcome of one bounded candidate read. */
export interface AttentionFileRead {
  /** The whole file, or `""` when {@link AttentionFileRead.oversize} is true. */
  text: string;
  /** True when the descriptor still had bytes past the limit. */
  oversize: boolean;
}

/**
 * Filesystem seam. The default delegates to `node:fs/promises`; a test
 * substitutes it to force `ENOENT` between the listing and the read, an
 * `EACCES` that a `chmod` fixture cannot produce deterministically for every
 * user the suite runs as, or a file that grows past the limit after its `stat`.
 */
export interface AttentionFileSystem {
  readdir(path: string): Promise<readonly string[]>;
  stat(path: string): Promise<AttentionFileStats>;
  /**
   * Read at most `maxBytes + 1` bytes through one descriptor, reporting
   * `oversize` rather than returning more than `maxBytes`.
   */
  readBounded(path: string, maxBytes: number): Promise<AttentionFileRead>;
}

export interface ReadAttentionRecordsOptions extends CoordinationApiOptions {
  /** `AGENT_COORD_STATE_ROOT`; used in filesystem mode only. */
  stateRoot: string;
  /** `owner/name` strings as `normalizeTargetRepos` produces them. */
  targetRepos: readonly string[];
  /** Injectable for tests; defaults to {@link ATTENTION_READ_ENTRY_LIMIT}. */
  maxEntriesPerRepository?: number;
  /** Injectable for tests; defaults to {@link ATTENTION_READ_TIME_BUDGET_MS}. */
  timeBudgetMs?: number;
  /** Injectable for tests; defaults to {@link ATTENTION_RECORD_MAX_BYTES}. */
  maxFileBytes?: number;
  /** Monotonic milliseconds; injectable so a test proves the time budget without waiting. */
  monotonicNow?: () => number;
  /** Injectable for tests; defaults to `node:fs/promises`. */
  fileSystem?: AttentionFileSystem;
}

/** Chunk size for {@link readBoundedFile}; a record is far smaller than this. */
const READ_CHUNK_BYTES = 65536;

/**
 * Read a candidate through a single descriptor, stopping one byte past the
 * limit.
 *
 * `stat` is only a pre-check: between it and the read the file can be replaced
 * or appended to, so a size read from `stat` is not a bound on what a later
 * `readFile` would return. Bounding the read itself keeps a file that grows
 * past the limit from being pulled into memory and parsed, and reports it as
 * `oversize` exactly as the pre-check would have. Reads are positional against
 * one open handle, so no second `open` can land on a different file.
 */
async function readBoundedFile(path: string, maxBytes: number): Promise<AttentionFileRead> {
  const handle = await open(path, "r");
  try {
    const limit = maxBytes + 1;
    const chunks: Buffer[] = [];
    let total = 0;
    while (total < limit) {
      const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, limit - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
      if (bytesRead === 0) {
        break;
      }
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
    // One byte past the limit is enough to know the file is over it; the bytes
    // themselves are dropped rather than decoded.
    return total > maxBytes
      ? { text: "", oversize: true }
      : { text: Buffer.concat(chunks).toString("utf8"), oversize: false };
  } finally {
    await handle.close();
  }
}

/** The default seam, exported so a test can wrap one operation and keep the rest real. */
export const nodeAttentionFileSystem: AttentionFileSystem = {
  readdir: (path) => readdir(path),
  stat: (path) => stat(path),
  readBounded: (path, maxBytes) => readBoundedFile(path, maxBytes)
};

function emptyOutcomes(): Record<AttentionReadOutcomeKind, number> {
  // Written out rather than derived so a new outcome kind fails to compile
  // until it is counted here.
  return {
    ok: 0,
    vanished: 0,
    unreadable: 0,
    invalid_json: 0,
    oversize: 0,
    schema_invalid: 0,
    repository_mismatch: 0,
    workspace_mismatch: 0,
    id_mismatch: 0
  };
}

function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error ? String(error.code) : "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

/**
 * Filesystem failures are reported by error code alone. A `node:fs` error
 * message embeds the absolute path it failed on, and every diagnostic path in
 * this module is relative to the state root.
 */
function fsReason(prose: string, error: unknown): string {
  return `${prose} (${errorCode(error) || "unknown error"}).`;
}

function schemaReason(errors: AttentionRecordValidationError[]): string {
  return `Record does not match the attention record schema: ${JSON.stringify(errors)}`;
}

/** Lead of every `invalid_json` reason; nothing after it may quote the file. */
const INVALID_JSON_REASON = "Could not parse the record file as JSON";

/**
 * The parse offset alone, when the engine reports one.
 *
 * The rest of a `JSON.parse` message is dropped because V8 quotes the input's
 * first bytes back inside it (`Unexpected token 'A', "AGENT_COOR"... is not
 * valid JSON`). A diagnostic is rendered by the attention view, and the walk
 * follows symlinks that may resolve outside the state root, so a reason that
 * carried file contents would make the dashboard a read oracle for the opening
 * bytes of any file a record name can point at.
 */
function parsePosition(error: unknown): string {
  const match = /\bat position (\d+)\b/.exec(errorMessage(error));
  return match === null ? "" : ` at position ${match[1]}`;
}

/**
 * GitHub owner and repository names are ASCII and case-insensitive, the same
 * rule `src/shared/attention.ts` applies when it matches a record against its
 * own pull request URL.
 */
function sameRepository(left: unknown, right: string): boolean {
  // The schema makes `repository` a required string, so the guard is only here
  // to keep the never-throws contract independent of the vendored schema.
  if (typeof left !== "string") {
    return false;
  }
  const [leftOwner, leftName, ...leftRest] = left.split("/");
  const [rightOwner, rightName, ...rightRest] = right.split("/");
  if (leftRest.length > 0 || rightRest.length > 0 || !leftName || !rightName) {
    return false;
  }
  return leftOwner.toLowerCase() === rightOwner.toLowerCase() && leftName.toLowerCase() === rightName.toLowerCase();
}

/**
 * True for a listing name that can be a record file. `<id>.json.lock` and every
 * other sidecar fail here, and a bare `.json` is a name the storage key cannot
 * produce.
 */
/**
 * The one location a record may occupy:
 * `attention/<workspace>/<owner>/<name>/<id>.json`. Filesystem paths are built
 * from the same prefix, so this is the whole rule in both modes.
 */
function storageKey(prefix: string, id: string): string {
  return `${prefix}/${id}${ATTENTION_RECORD_FILE_SUFFIX}`;
}

function isCandidateName(name: string): boolean {
  return name.length > ATTENTION_RECORD_FILE_SUFFIX.length && name.endsWith(ATTENTION_RECORD_FILE_SUFFIX);
}

/** One repository's read in progress. */
interface RepositoryRead {
  repository: string;
  prefix: string;
  mode: AttentionReadMode;
  records: AttentionRecord[];
  diagnostics: AttentionReadDiagnostic[];
  outcomes: Record<AttentionReadOutcomeKind, number>;
  /** Entries whose bytes were read and parsed. */
  read: number;
}

function startRead(repository: string, prefix: string, mode: AttentionReadMode): RepositoryRead {
  return { repository, prefix, mode, records: [], diagnostics: [], outcomes: emptyOutcomes(), read: 0 };
}

function report(read: RepositoryRead, kind: AttentionReadDiagnosticKind, path: string, reason: string): void {
  read.diagnostics.push({
    repository: read.repository,
    workspace: ATTENTION_WORKSPACE,
    mode: read.mode,
    kind,
    path,
    reason
  });
}

/** Count one candidate's outcome, and report it unless it is `ok` or `vanished`. */
function outcome(read: RepositoryRead, kind: AttentionReadOutcomeKind, path: string, reason: string): void {
  read.outcomes[kind] += 1;
  if (kind !== "ok" && kind !== "vanished") {
    report(read, kind, path, reason);
  }
}

/**
 * Validate one already-parsed candidate and keep it when it is a schema-valid
 * record for this repository. Shared by both modes so a file and a listing
 * entry are judged identically.
 */
function ingest(read: RepositoryRead, path: string, value: unknown): void {
  const result = validateAttentionRecord(value);
  if (!result.ok) {
    outcome(read, "schema_invalid", path, schemaReason(result.errors));
    return;
  }
  const record = result.record as AttentionRecord;
  if (!sameRepository(record.repository, read.repository)) {
    // The record claims a repository other than the one whose prefix or
    // directory it was read from, so it is dropped rather than returned: a
    // record in one repository's storage must never be attributed to another.
    // The reason names the expected repository and the path but never the
    // claimed one, for the same reason `readStatePrefix` refuses to name an
    // out-of-scope listing path — echoing it would hand an unrelated
    // repository's name to every caller that displays warnings.
    outcome(read, "repository_mismatch", path, `Record does not name repository ${read.repository}.`);
    return;
  }
  if (record.workspace !== ATTENTION_WORKSPACE) {
    // Same rule one axis over: the prefix and the directory both fix the
    // workspace, so a record that names another one is another workspace's
    // state and must not be mixed into this result. Workspace names are exact,
    // not case-folded like GitHub owner and repository names, and the claimed
    // one is withheld from the reason for the reason given above.
    outcome(read, "workspace_mismatch", path, `Record does not name workspace ${ATTENTION_WORKSPACE}.`);
    return;
  }
  if (path !== storageKey(read.prefix, record.id)) {
    // The last axis of the storage key. The record's own id has to be the one
    // its location spells, so a stale copy left beside the record it was taken
    // from, or any other in-prefix entry, cannot surface as a duplicate or
    // under someone else's id. In filesystem mode this is exactly "the file is
    // named `<id>.json`"; in API mode it is the listing path. The reason names
    // the path, never the claimed id, as above.
    outcome(read, "id_mismatch", path, `Record id does not match its storage key ${path}.`);
    return;
  }
  outcome(read, "ok", path, "");
  read.records.push(record);
}

function finish(
  read: RepositoryRead,
  status: StateSourceState,
  checkedAt: string,
  seen: number,
  partial: boolean,
  httpStatus?: number
): AttentionRepositoryRead {
  return {
    repository: read.repository,
    workspace: ATTENTION_WORKSPACE,
    mode: read.mode,
    prefix: read.prefix,
    sourceStatus: { status, checkedAt, ...(httpStatus === undefined ? {} : { httpStatus }) },
    records: read.records,
    diagnostics: read.diagnostics,
    partial,
    counts: { seen, read: read.read, skipped: seen - read.read, outcomes: read.outcomes }
  };
}

interface ResolvedBudget {
  maxEntries: number;
  timeBudgetMs: number;
  maxFileBytes: number;
  monotonicNow: () => number;
}

function resolveBudget(options: ReadAttentionRecordsOptions): ResolvedBudget {
  return {
    maxEntries: options.maxEntriesPerRepository ?? ATTENTION_READ_ENTRY_LIMIT,
    timeBudgetMs: options.timeBudgetMs ?? ATTENTION_READ_TIME_BUDGET_MS,
    maxFileBytes: options.maxFileBytes ?? ATTENTION_RECORD_MAX_BYTES,
    monotonicNow: options.monotonicNow ?? (() => performance.now())
  };
}

/**
 * The repository's prefix, or `null` when its `owner` or `name` cannot form
 * one. `toAttentionPrefix` is the guard in both modes, not just in API mode: it
 * rejects the empty, `.`, `..`, and slash- or whitespace-bearing segments that
 * would otherwise be joined into a filesystem path and escape the state root.
 */
function repositoryPrefix(repository: string): AttentionPrefix | null {
  const [owner, name, ...rest] = repository.split("/");
  if (rest.length > 0 || !owner || !name) {
    return null;
  }
  return toAttentionPrefix(ATTENTION_WORKSPACE, owner, name);
}

/** The prefix a repository would have, for reporting when it cannot have one. */
function candidatePrefix(repository: string): string {
  return `attention/${ATTENTION_WORKSPACE}/${repository}`;
}

function unusableRepository(
  repository: string,
  mode: AttentionReadMode,
  checkedAt: string
): AttentionRepositoryRead {
  const read = startRead(repository, candidatePrefix(repository), mode);
  report(
    read,
    "unreadable",
    read.prefix,
    `Configured repository ${repository} is not an owner/name pair that can address attention records.`
  );
  return finish(read, "unreachable", checkedAt, 0, false);
}

async function readRepositoryFromFilesystem(
  repository: string,
  prefix: AttentionPrefix,
  stateRoot: string,
  fileSystem: AttentionFileSystem,
  budget: ResolvedBudget,
  checkedAt: string
): Promise<AttentionRepositoryRead> {
  const read = startRead(repository, prefix, "fs");
  // Every segment came through `toAttentionPrefix`, so none of them can be
  // empty, `.`, `..`, or contain a separator: the join stays under the root.
  const directory = join(stateRoot, ...prefix.split("/"));
  const startedAt = budget.monotonicNow();

  let entries: readonly string[];
  try {
    entries = await fileSystem.readdir(directory);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      // A missing state root, attention directory, workspace directory, or
      // repository directory all surface here as one `ENOENT`, and all four
      // mean the same thing: nothing has been written yet.
      return finish(read, "empty", checkedAt, 0, false);
    }
    report(read, "unreadable", prefix, fsReason("Could not list the attention directory", error));
    return finish(read, "unreachable", checkedAt, 0, false);
  }

  // Sorted so the budget cuts the same listing the same way on every platform;
  // `readdir` order is otherwise filesystem-defined.
  const names = [...entries].sort();
  let examined = 0;
  let stopped = false;
  for (const name of names) {
    if (!isCandidateName(name)) {
      // Not a record name, so it is skipped before anything touches it: no
      // stat, no read, no diagnostic, and no charge against the budget. The
      // `agent-coord` local store leaves a persistent `<id>.json.lock` beside
      // every record, and a lock owned by another user on a shared root would
      // otherwise turn into a permanent `unreadable` warning per record.
      continue;
    }
    // The limit counts candidates examined rather than files actually read, so
    // a directory full of `.json` subdirectories cannot walk past the budget.
    if (examined >= budget.maxEntries || budget.monotonicNow() - startedAt >= budget.timeBudgetMs) {
      stopped = true;
      break;
    }
    examined += 1;
    const path = `${prefix}/${name}`;
    const filePath = join(directory, name);

    let stats: AttentionFileStats;
    try {
      // `stat`, not `lstat`: a symlink that resolves to a regular file is a
      // record, and one that resolves to anything else is skipped below.
      stats = await fileSystem.stat(filePath);
    } catch (error) {
      const code = errorCode(error);
      outcome(
        read,
        code === "ENOENT" ? "vanished" : "unreadable",
        path,
        fsReason("Could not stat the record file", error)
      );
      continue;
    }

    if (!stats.isFile()) {
      // Directories, sockets, and symlinks that do not resolve to a regular
      // file are skipped and never followed; the walk is not recursive.
      continue;
    }
    if (stats.size > budget.maxFileBytes) {
      // The cheap pre-check: a file already over the limit is never opened.
      outcome(
        read,
        "oversize",
        path,
        `Record file is ${stats.size} bytes, over the ${budget.maxFileBytes}-byte limit.`
      );
      continue;
    }

    let contents: AttentionFileRead;
    try {
      contents = await fileSystem.readBounded(filePath, budget.maxFileBytes);
    } catch (error) {
      const code = errorCode(error);
      outcome(
        read,
        code === "ENOENT" ? "vanished" : "unreadable",
        path,
        fsReason("Could not read the record file", error)
      );
      continue;
    }
    if (contents.oversize) {
      // The pre-check passed but the file was larger by the time it was read.
      outcome(read, "oversize", path, `Record file grew past the ${budget.maxFileBytes}-byte limit while it was read.`);
      continue;
    }

    read.read += 1;
    if (contents.text.length === 0) {
      // A writer that renames into place never exposes an empty file at a
      // record's final name, and the lock sidecar is already excluded by the
      // name rule, so an empty `<id>.json` is corrupted local state and stays
      // visible. There are no bytes to quote, so the reason can name it.
      outcome(read, "invalid_json", path, `${INVALID_JSON_REASON}: empty file.`);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents.text);
    } catch (error) {
      outcome(read, "invalid_json", path, `${INVALID_JSON_REASON}${parsePosition(error)}.`);
      continue;
    }
    ingest(read, path, parsed);
  }

  return finish(read, names.length === 0 ? "empty" : "ok", checkedAt, names.length, stopped);
}

function readRepositoryFromApi(
  repository: string,
  prefix: AttentionPrefix,
  result: StatePrefixReadResult,
  budget: ResolvedBudget
): AttentionRepositoryRead {
  const read = startRead(repository, prefix, "api");
  // Every warning the client raised for this prefix belongs to this
  // repository: a dropped entry, a malformed wrapper, or the auth failure whose
  // text names the `attention` read scope the token is missing.
  for (const warning of result.warnings) {
    report(read, "unreadable", prefix, warning);
  }

  // The budget starts when this repository's entries begin to be consumed. The
  // client already bounds its own request and body reads, and charging that
  // wait to this budget would throw away records that did arrive.
  const startedAt = budget.monotonicNow();
  const entries = result.entries;
  let examined = 0;
  for (const entry of entries) {
    if (examined >= budget.maxEntries || budget.monotonicNow() - startedAt >= budget.timeBudgetMs) {
      break;
    }
    examined += 1;
    // The entry arrived parsed inside the listing, so it is counted as read and
    // judged exactly as a file's parsed contents are.
    read.read += 1;
    ingest(read, entry.path, entry.data);
  }

  return finish(
    read,
    // The client's status is consumed literally: it alone knows whether the
    // listing was healthy, empty, refused, or unreachable.
    result.sourceStatus.status,
    result.sourceStatus.checkedAt,
    entries.length,
    examined < entries.length,
    result.sourceStatus.httpStatus
  );
}

/**
 * Read every configured repository's attention records for the `default`
 * workspace. Never throws.
 *
 * Repositories are read concurrently, but each one's budget, counts, `partial`
 * flag, status, and diagnostics are its own: one unreachable repository never
 * hides another that answered.
 *
 * Both `open` and `resolved` records are returned. The `status=open` read
 * filter from shakacode/agent-coordination#304 is not applied here — the
 * coordination client has no filter parameter yet — so the attention model
 * applies the open filter downstream.
 */
export async function readAttentionRecords(options: ReadAttentionRecordsOptions): Promise<AttentionReadResult> {
  const checkedAtDate = options.now?.() ?? new Date();
  const checkedAt = checkedAtDate.toISOString();
  const budget = resolveBudget(options);
  const repositories = [...options.targetRepos];
  // The same rule `config.ts` and `doctor.ts` use: no API URL means the local
  // state root is the source of truth.
  const mode: AttentionReadMode = (options.coordApiUrl ?? "").trim() === "" ? "fs" : "api";

  if (mode === "fs") {
    const fileSystem = options.fileSystem ?? nodeAttentionFileSystem;
    return {
      workspace: ATTENTION_WORKSPACE,
      mode,
      checkedAt,
      repositories: await Promise.all(
        repositories.map(async (repository) => {
          const prefix = repositoryPrefix(repository);
          return prefix === null
            ? unusableRepository(repository, mode, checkedAt)
            : readRepositoryFromFilesystem(repository, prefix, options.stateRoot, fileSystem, budget, checkedAt);
        })
      )
    };
  }

  const prefixes = repositories.map(repositoryPrefix);
  const readable = prefixes.filter((prefix): prefix is AttentionPrefix => prefix !== null);
  // Exactly one prefix read per readable repository, in one batch so they share
  // a single `checkedAt`. The client never throws and never reads the disk.
  const results = await readStatePrefixes(
    {
      coordApiUrl: options.coordApiUrl,
      coordApiToken: options.coordApiToken,
      coordApiTokenEnvVar: options.coordApiTokenEnvVar,
      fetchImpl: options.fetchImpl,
      now: () => checkedAtDate
    },
    readable
  );
  const byPrefix = new Map(results.map((result) => [result.sourceStatus.prefix, result] as const));

  return {
    workspace: ATTENTION_WORKSPACE,
    mode,
    checkedAt,
    repositories: repositories.map((repository, index) => {
      const prefix = prefixes[index];
      const result = prefix === null ? undefined : byPrefix.get(prefix);
      return prefix === null || result === undefined
        ? unusableRepository(repository, mode, checkedAt)
        : readRepositoryFromApi(repository, prefix, result, budget);
    })
  };
}
