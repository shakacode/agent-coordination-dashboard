import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  ATTENTION_READ_ENTRY_LIMIT,
  ATTENTION_READ_OUTCOME_KINDS,
  ATTENTION_READ_TIME_BUDGET_MS,
  ATTENTION_RECORD_MAX_BYTES,
  ATTENTION_WORKSPACE,
  readAttentionRecords,
  type AttentionFileSystem,
  type AttentionReadResult,
  type AttentionRepositoryRead,
  type ReadAttentionRecordsOptions
} from "./readAttentionRecords";

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE_PATH = join(HERE, "readAttentionRecords.ts");
const FIXTURES_DIR = join(HERE, "fixtures");

const REPOSITORY = "shakacode/agent-coordination";
const OTHER_REPOSITORY = "shakacode/agent-coordination-dashboard";
const PREFIX = `attention/${ATTENTION_WORKSPACE}/${REPOSITORY}`;
const OTHER_PREFIX = `attention/${ATTENTION_WORKSPACE}/${OTHER_REPOSITORY}`;
/** Shares no substring with {@link REPOSITORY}, so a leak assertion cannot pass by accident. */
const MISMATCH_REPOSITORY = "acme/widgets";
const MISMATCH_PREFIX = `attention/${ATTENTION_WORKSPACE}/${MISMATCH_REPOSITORY}`;
const CHECKED_AT = new Date("2026-09-06T20:00:00.000Z");
const API_URL = "https://coord.example.test";

/** Both valid fixtures name {@link REPOSITORY}; the open one is the default record. */
const OPEN_RECORD_JSON = readFileSync(join(FIXTURES_DIR, "valid", "attention-open.json"), "utf8");
const RESOLVED_RECORD_JSON = readFileSync(join(FIXTURES_DIR, "valid", "attention-resolved.json"), "utf8");
/** Fails the schema on the `timestamp` pattern and names {@link REPOSITORY}. */
const SCHEMA_INVALID_JSON = readFileSync(join(FIXTURES_DIR, "invalid", "attention-leap-second.json"), "utf8");

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function stateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "attention-reader-"));
  roots.push(root);
  return root;
}

/** Write files into `<root>/attention/default/<repository>/`. */
async function seedRepository(
  root: string,
  repository: string,
  files: Record<string, string>
): Promise<string> {
  const directory = join(root, "attention", ATTENTION_WORKSPACE, ...repository.split("/"));
  await mkdir(directory, { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    await writeFile(join(directory, name), contents, "utf8");
  }
  return directory;
}

const realFileSystem: AttentionFileSystem = {
  readdir: (path) => readdir(path),
  stat: (path) => stat(path),
  readFile: (path) => readFile(path, "utf8")
};

/** The real filesystem with individual operations replaced. */
function seam(overrides: Partial<AttentionFileSystem>): AttentionFileSystem {
  return { ...realFileSystem, ...overrides };
}

function codedError(code: string): Error {
  return Object.assign(new Error(`${code}: forced by test`), { code });
}

/** A monotonic clock that walks the given readings and then holds the last one. */
function fakeClock(readings: readonly number[]): () => number {
  let index = 0;
  return () => readings[Math.min(index++, readings.length - 1)];
}

function fsOptions(overrides: Partial<ReadAttentionRecordsOptions> = {}): ReadAttentionRecordsOptions {
  return {
    stateRoot: "/nonexistent",
    targetRepos: [REPOSITORY],
    now: () => CHECKED_AT,
    ...overrides
  };
}

function apiOptions(overrides: Partial<ReadAttentionRecordsOptions> = {}): ReadAttentionRecordsOptions {
  return {
    stateRoot: "/nonexistent",
    targetRepos: [REPOSITORY],
    coordApiUrl: API_URL,
    coordApiToken: "test-token",
    now: () => CHECKED_AT,
    ...overrides
  };
}

function only(result: AttentionReadResult): AttentionRepositoryRead {
  expect(result.repositories).toHaveLength(1);
  return result.repositories[0];
}

interface StubResponse {
  status?: number;
  body: unknown;
}

/** A `fetch` that answers `GET /v1/state?prefix=…` from a per-prefix table. */
function apiFetch(responses: Record<string, StubResponse>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const prefix = new URL(href).searchParams.get("prefix") ?? "";
    const stub = responses[prefix] ?? { body: { entries: [] } };
    return new Response(JSON.stringify(stub.body), {
      status: stub.status ?? 200,
      headers: { "content-type": "application/json" }
    });
  }) as unknown as typeof fetch;
}

function listing(entries: readonly { path: string; data: unknown }[]): StubResponse {
  return { body: { entries } };
}

function entryFor(name: string, json: string): { path: string; data: unknown } {
  return { path: `${PREFIX}/${name}`, data: JSON.parse(json) as unknown };
}

/** Fails the test if API mode reaches the disk. */
const forbiddenFileSystem: AttentionFileSystem = {
  readdir: () => Promise.reject(new Error("API mode must not read the filesystem")),
  stat: () => Promise.reject(new Error("API mode must not read the filesystem")),
  readFile: () => Promise.reject(new Error("API mode must not read the filesystem"))
};

describe("readAttentionRecords module boundary", () => {
  it("imports nothing but the validator, the coordination client, the shared types, and its clock", () => {
    const source = readFileSync(MODULE_PATH, "utf8");

    const specifiers = [...source.matchAll(/\bfrom\s*["']([^"']+)["']/g)].map((match) => match[1]);

    expect([...new Set(specifiers)].sort()).toEqual([
      "../../shared/attention",
      "../coordinationApi",
      "./validator",
      "node:fs/promises",
      "node:path",
      "node:perf_hooks"
    ]);
    // No side-effect import, no dynamic import, and no CommonJS escape hatch,
    // so the list above is the module's whole static import surface. A deleted
    // dashboard module, a GitHub client, or `node:child_process` cannot be
    // reached from here.
    expect(source).not.toMatch(/^\s*import\s*["']/m);
    expect(source).not.toMatch(/\bimport\s*\(/);
    expect(source).not.toMatch(/\brequire\s*\(/);
    expect(source).not.toContain("child_process");
  });

  it("exports the documented default budget and size limits", () => {
    expect(ATTENTION_READ_ENTRY_LIMIT).toBe(2000);
    expect(ATTENTION_READ_TIME_BUDGET_MS).toBe(2000);
    expect(ATTENTION_RECORD_MAX_BYTES).toBe(262144);
    expect(ATTENTION_WORKSPACE).toBe("default");
    expect([...ATTENTION_READ_OUTCOME_KINDS]).toEqual([
      "ok",
      "vanished",
      "unreadable",
      "invalid_json",
      "oversize",
      "schema_invalid",
      "repository_mismatch"
    ]);
  });

  it("applies the default limits when no budget is injected", async () => {
    const root = await stateRoot();
    await seedRepository(root, REPOSITORY, { "open.json": OPEN_RECORD_JSON });
    const sizes: number[] = [];
    const entryCounts: number[] = [];

    const result = await readAttentionRecords(
      fsOptions({
        stateRoot: root,
        fileSystem: seam({
          readdir: async (path) => {
            const names = await readdir(path);
            entryCounts.push(names.length);
            return names;
          },
          stat: async (path) => {
            const stats = await stat(path);
            sizes.push(stats.size);
            return stats;
          }
        })
      })
    );

    // The default budget is wide enough that a one-record directory is neither
    // truncated nor treated as oversize.
    expect(entryCounts[0]).toBeLessThan(ATTENTION_READ_ENTRY_LIMIT);
    expect(sizes[0]).toBeLessThan(ATTENTION_RECORD_MAX_BYTES);
    expect(only(result).partial).toBe(false);
    expect(only(result).records).toHaveLength(1);
  });
});

describe("readAttentionRecords filesystem mode", () => {
  it("returns schema-valid records with an ok status and no diagnostics", async () => {
    const root = await stateRoot();
    await seedRepository(root, REPOSITORY, {
      "open.json": OPEN_RECORD_JSON,
      "resolved.json": RESOLVED_RECORD_JSON
    });

    const result = await readAttentionRecords(fsOptions({ stateRoot: root }));

    expect(result.mode).toBe("fs");
    expect(result.workspace).toBe(ATTENTION_WORKSPACE);
    expect(result.checkedAt).toBe(CHECKED_AT.toISOString());
    const repository = only(result);
    expect(repository.repository).toBe(REPOSITORY);
    expect(repository.prefix).toBe(PREFIX);
    expect(repository.sourceStatus).toEqual({ status: "ok", checkedAt: CHECKED_AT.toISOString() });
    expect(repository.diagnostics).toEqual([]);
    expect(repository.partial).toBe(false);
    expect(repository.counts).toEqual({
      seen: 2,
      read: 2,
      skipped: 0,
      outcomes: {
        ok: 2,
        vanished: 0,
        unreadable: 0,
        invalid_json: 0,
        oversize: 0,
        schema_invalid: 0,
        repository_mismatch: 0
      }
    });
    // The `status=open` filter is not applied here; both statuses come back.
    expect(repository.records.map((record) => record.status).sort()).toEqual(["open", "resolved"]);
    expect(repository.records[0].repository).toBe(REPOSITORY);
  });

  it("reads every regular file regardless of extension", async () => {
    const root = await stateRoot();
    await seedRepository(root, REPOSITORY, { "record-without-extension": OPEN_RECORD_JSON });

    const repository = only(await readAttentionRecords(fsOptions({ stateRoot: root })));

    expect(repository.records).toHaveLength(1);
    expect(repository.counts.read).toBe(1);
  });

  it("reports an empty source for a state root that does not exist", async () => {
    const result = await readAttentionRecords(fsOptions({ stateRoot: join(tmpdir(), "attention-reader-absent-root") }));

    const repository = only(result);
    expect(repository.sourceStatus.status).toBe("empty");
    expect(repository.records).toEqual([]);
    expect(repository.diagnostics).toEqual([]);
    expect(repository.partial).toBe(false);
    expect(repository.counts.seen).toBe(0);
  });

  it("reports an empty source for a missing repository directory under an existing root", async () => {
    const root = await stateRoot();
    await seedRepository(root, OTHER_REPOSITORY, { "open.json": OPEN_RECORD_JSON });

    const repository = only(await readAttentionRecords(fsOptions({ stateRoot: root })));

    expect(repository.sourceStatus.status).toBe("empty");
    expect(repository.records).toEqual([]);
    expect(repository.diagnostics).toEqual([]);
  });

  it("reports an empty source for an existing but empty repository directory", async () => {
    const root = await stateRoot();
    await seedRepository(root, REPOSITORY, {});

    const repository = only(await readAttentionRecords(fsOptions({ stateRoot: root })));

    expect(repository.sourceStatus.status).toBe("empty");
    expect(repository.counts.seen).toBe(0);
  });

  it("reports an unreachable source with the error code when the root exists but cannot be read", async () => {
    const root = await stateRoot();
    await seedRepository(root, REPOSITORY, { "open.json": OPEN_RECORD_JSON });

    const repository = only(
      await readAttentionRecords(
        fsOptions({
          stateRoot: root,
          fileSystem: seam({ readdir: () => Promise.reject(codedError("EACCES")) })
        })
      )
    );

    expect(repository.sourceStatus.status).toBe("unreachable");
    expect(repository.records).toEqual([]);
    expect(repository.diagnostics).toEqual([
      {
        repository: REPOSITORY,
        workspace: ATTENTION_WORKSPACE,
        mode: "fs",
        kind: "unreadable",
        path: PREFIX,
        reason: "Could not list the attention directory (EACCES)."
      }
    ]);
  });

  it("keeps a non-ENOENT listing failure out of the empty status for every error code", async () => {
    const root = await stateRoot();
    await seedRepository(root, REPOSITORY, { "open.json": OPEN_RECORD_JSON });

    for (const code of ["EPERM", "ENOTDIR", "EIO"]) {
      const repository = only(
        await readAttentionRecords(
          fsOptions({
            stateRoot: root,
            fileSystem: seam({ readdir: () => Promise.reject(codedError(code)) })
          })
        )
      );

      expect(repository.sourceStatus.status).toBe("unreachable");
      expect(repository.diagnostics[0].reason).toContain(code);
    }
  });

  it("reports invalid JSON as a diagnostic and keeps reading the rest", async () => {
    const root = await stateRoot();
    await seedRepository(root, REPOSITORY, {
      "broken.json": "{ not json",
      "open.json": OPEN_RECORD_JSON
    });

    const repository = only(await readAttentionRecords(fsOptions({ stateRoot: root })));

    expect(repository.records).toHaveLength(1);
    expect(repository.counts.outcomes.invalid_json).toBe(1);
    expect(repository.counts).toMatchObject({ seen: 2, read: 2, skipped: 0 });
    const diagnostic = repository.diagnostics[0];
    expect(diagnostic.kind).toBe("invalid_json");
    expect(diagnostic.path).toBe(`${PREFIX}/broken.json`);
    expect(diagnostic.reason).toContain("Could not parse the record file as JSON");
    // Diagnostics stay relative to the state root; no absolute path leaks.
    expect(diagnostic.reason).not.toContain(root);
  });

  it("reports a schema failure with the serializable error list and drops the record", async () => {
    const root = await stateRoot();
    await seedRepository(root, REPOSITORY, { "leap-second.json": SCHEMA_INVALID_JSON });

    const repository = only(await readAttentionRecords(fsOptions({ stateRoot: root })));

    expect(repository.records).toEqual([]);
    expect(repository.sourceStatus.status).toBe("ok");
    const diagnostic = repository.diagnostics[0];
    expect(diagnostic.kind).toBe("schema_invalid");
    expect(diagnostic.path).toBe(`${PREFIX}/leap-second.json`);
    const errors = JSON.parse(diagnostic.reason.slice(diagnostic.reason.indexOf("["))) as {
      keyword: string;
      instancePath: string;
    }[];
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.map((error) => error.keyword)).toContain("pattern");
  });

  it("rejects a record that names another repository as repository_mismatch", async () => {
    const root = await stateRoot();
    // A valid record for `shakacode/agent-coordination` filed under a different
    // repository's directory (PR #143 Codex P1).
    await seedRepository(root, MISMATCH_REPOSITORY, { "open.json": OPEN_RECORD_JSON });

    const repository = only(
      await readAttentionRecords(fsOptions({ stateRoot: root, targetRepos: [MISMATCH_REPOSITORY] }))
    );

    expect(repository.records).toEqual([]);
    expect(repository.counts.outcomes.repository_mismatch).toBe(1);
    expect(repository.diagnostics).toEqual([
      {
        repository: MISMATCH_REPOSITORY,
        workspace: ATTENTION_WORKSPACE,
        mode: "fs",
        kind: "repository_mismatch",
        path: `${MISMATCH_PREFIX}/open.json`,
        reason: `Record does not name repository ${MISMATCH_REPOSITORY}.`
      }
    ]);
    // The rejected record's own repository is never echoed into the diagnostic.
    expect(repository.diagnostics[0].reason).not.toContain(REPOSITORY);
  });

  it("accepts a record whose repository differs only by ASCII case", async () => {
    const root = await stateRoot();
    const mixedCase = "ShakaCode/Agent-Coordination";
    await seedRepository(root, mixedCase, { "open.json": OPEN_RECORD_JSON });

    const repository = only(await readAttentionRecords(fsOptions({ stateRoot: root, targetRepos: [mixedCase] })));

    expect(repository.records).toHaveLength(1);
    expect(repository.counts.outcomes.repository_mismatch).toBe(0);
  });

  it("skips a file one byte over the size limit before parsing it", async () => {
    const root = await stateRoot();
    await seedRepository(root, REPOSITORY, { "big.json": OPEN_RECORD_JSON });
    const reads: string[] = [];

    const repository = only(
      await readAttentionRecords(
        fsOptions({
          stateRoot: root,
          maxFileBytes: Buffer.byteLength(OPEN_RECORD_JSON, "utf8") - 1,
          fileSystem: seam({
            readFile: (path) => {
              reads.push(path);
              return readFile(path, "utf8");
            }
          })
        })
      )
    );

    expect(reads).toEqual([]);
    expect(repository.records).toEqual([]);
    expect(repository.counts).toMatchObject({ seen: 1, read: 0, skipped: 1 });
    expect(repository.counts.outcomes.oversize).toBe(1);
    const diagnostic = repository.diagnostics[0];
    expect(diagnostic.kind).toBe("oversize");
    expect(diagnostic.path).toBe(`${PREFIX}/big.json`);
    expect(diagnostic.reason).toContain("over the");
  });

  it("reads a file whose size is exactly the limit", async () => {
    const root = await stateRoot();
    await seedRepository(root, REPOSITORY, { "exact.json": OPEN_RECORD_JSON });

    const repository = only(
      await readAttentionRecords(
        fsOptions({ stateRoot: root, maxFileBytes: Buffer.byteLength(OPEN_RECORD_JSON, "utf8") })
      )
    );

    expect(repository.records).toHaveLength(1);
    expect(repository.counts.outcomes.oversize).toBe(0);
  });

  it("counts a file that vanishes between the listing and the read without reporting it", async () => {
    const root = await stateRoot();
    await seedRepository(root, REPOSITORY, {
      "gone.json": OPEN_RECORD_JSON,
      "open.json": OPEN_RECORD_JSON
    });

    const repository = only(
      await readAttentionRecords(
        fsOptions({
          stateRoot: root,
          fileSystem: seam({
            readFile: (path) =>
              path.endsWith("gone.json") ? Promise.reject(codedError("ENOENT")) : readFile(path, "utf8")
          })
        })
      )
    );

    // A tower writes records with an atomic rename, so this is normal, not a fault.
    expect(repository.diagnostics).toEqual([]);
    expect(repository.counts.outcomes.vanished).toBe(1);
    expect(repository.counts).toMatchObject({ seen: 2, read: 1, skipped: 1 });
    expect(repository.records).toHaveLength(1);
    expect(repository.sourceStatus.status).toBe("ok");
  });

  it("counts a file that vanishes before its stat without reporting it", async () => {
    const root = await stateRoot();
    await seedRepository(root, REPOSITORY, { "gone.json": OPEN_RECORD_JSON });

    const repository = only(
      await readAttentionRecords(
        fsOptions({
          stateRoot: root,
          fileSystem: seam({ stat: () => Promise.reject(codedError("ENOENT")) })
        })
      )
    );

    expect(repository.diagnostics).toEqual([]);
    expect(repository.counts.outcomes.vanished).toBe(1);
  });

  it("reports an unreadable file as a diagnostic", async () => {
    const root = await stateRoot();
    await seedRepository(root, REPOSITORY, { "denied.json": OPEN_RECORD_JSON });

    const repository = only(
      await readAttentionRecords(
        fsOptions({
          stateRoot: root,
          fileSystem: seam({ readFile: () => Promise.reject(codedError("EACCES")) })
        })
      )
    );

    expect(repository.sourceStatus.status).toBe("ok");
    expect(repository.counts).toMatchObject({ seen: 1, read: 0, skipped: 1 });
    expect(repository.diagnostics).toEqual([
      {
        repository: REPOSITORY,
        workspace: ATTENTION_WORKSPACE,
        mode: "fs",
        kind: "unreadable",
        path: `${PREFIX}/denied.json`,
        reason: "Could not read the record file (EACCES)."
      }
    ]);
  });

  it("skips non-regular entries without following them and without recursing", async () => {
    const root = await stateRoot();
    const directory = await seedRepository(root, REPOSITORY, { "open.json": OPEN_RECORD_JSON });
    await mkdir(join(directory, "nested"), { recursive: true });
    await writeFile(join(directory, "nested", "open.json"), OPEN_RECORD_JSON, "utf8");

    const repository = only(await readAttentionRecords(fsOptions({ stateRoot: root })));

    expect(repository.records).toHaveLength(1);
    expect(repository.counts).toMatchObject({ seen: 2, read: 1, skipped: 1 });
    expect(repository.diagnostics).toEqual([]);
  });

  it("stops at the entry budget and reports partial with counts", async () => {
    const root = await stateRoot();
    await seedRepository(root, REPOSITORY, {
      "a.json": OPEN_RECORD_JSON,
      "b.json": OPEN_RECORD_JSON,
      "c.json": OPEN_RECORD_JSON
    });

    const repository = only(
      await readAttentionRecords(fsOptions({ stateRoot: root, maxEntriesPerRepository: 2 }))
    );

    expect(repository.partial).toBe(true);
    expect(repository.records).toHaveLength(2);
    expect(repository.counts).toMatchObject({ seen: 3, read: 2, skipped: 1 });
    expect(repository.counts.outcomes.ok).toBe(2);
  });

  it("stops at the time budget and reports partial without waiting", async () => {
    const root = await stateRoot();
    await seedRepository(root, REPOSITORY, {
      "a.json": OPEN_RECORD_JSON,
      "b.json": OPEN_RECORD_JSON,
      "c.json": OPEN_RECORD_JSON
    });

    const repository = only(
      await readAttentionRecords(
        fsOptions({
          stateRoot: root,
          timeBudgetMs: 50,
          // Started at 0, still inside the budget for the first entry, past it
          // for the second.
          monotonicNow: fakeClock([0, 10, 500])
        })
      )
    );

    expect(repository.partial).toBe(true);
    expect(repository.records).toHaveLength(1);
    expect(repository.counts).toMatchObject({ seen: 3, read: 1, skipped: 2 });
  });

  it("is not partial when the listing ends exactly at the entry budget", async () => {
    const root = await stateRoot();
    await seedRepository(root, REPOSITORY, { "a.json": OPEN_RECORD_JSON, "b.json": OPEN_RECORD_JSON });

    const repository = only(
      await readAttentionRecords(fsOptions({ stateRoot: root, maxEntriesPerRepository: 2 }))
    );

    expect(repository.partial).toBe(false);
    expect(repository.counts).toMatchObject({ seen: 2, read: 2, skipped: 0 });
  });

  it("keeps each repository's status, counts, and diagnostics independent", async () => {
    const root = await stateRoot();
    await seedRepository(root, REPOSITORY, { "open.json": OPEN_RECORD_JSON });

    const result = await readAttentionRecords(
      fsOptions({
        stateRoot: root,
        targetRepos: [REPOSITORY, OTHER_REPOSITORY],
        fileSystem: seam({
          readdir: (path) => (path.endsWith(OTHER_REPOSITORY.split("/")[1]) ? Promise.reject(codedError("EIO")) : readdir(path))
        })
      })
    );

    expect(result.repositories.map((repository) => repository.sourceStatus.status)).toEqual(["ok", "unreachable"]);
    expect(result.repositories[0].records).toHaveLength(1);
    expect(result.repositories[0].diagnostics).toEqual([]);
    expect(result.repositories[1].diagnostics[0].repository).toBe(OTHER_REPOSITORY);
  });

  it("refuses a configured repository that cannot address a prefix instead of touching the disk", async () => {
    const root = await stateRoot();

    for (const configured of ["../../etc", "shakacode/../../etc", "owner/..", "no-slash", "owner/name/extra"]) {
      const repository = only(
        await readAttentionRecords(
          fsOptions({ stateRoot: root, targetRepos: [configured], fileSystem: forbiddenFileSystem })
        )
      );

      expect(repository.sourceStatus.status).toBe("unreachable");
      expect(repository.records).toEqual([]);
      expect(repository.diagnostics[0].kind).toBe("unreadable");
      expect(repository.diagnostics[0].reason).toContain(configured);
    }
  });

  it("returns no repositories when none are configured", async () => {
    const result = await readAttentionRecords(fsOptions({ targetRepos: [] }));

    expect(result.repositories).toEqual([]);
    expect(result.mode).toBe("fs");
  });
});

describe("readAttentionRecords API mode", () => {
  it("reads one prefix per repository and never touches the filesystem", async () => {
    const requested: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      requested.push(new URL(href).searchParams.get("prefix") ?? "");
      return new Response(JSON.stringify({ entries: [entryFor("open.json", OPEN_RECORD_JSON)] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as unknown as typeof fetch;

    const result = await readAttentionRecords(
      apiOptions({ fetchImpl, fileSystem: forbiddenFileSystem })
    );

    expect(requested).toEqual([PREFIX]);
    expect(result.mode).toBe("api");
    const repository = only(result);
    expect(repository.mode).toBe("api");
    expect(repository.prefix).toBe(PREFIX);
    expect(repository.sourceStatus).toEqual({
      status: "ok",
      checkedAt: CHECKED_AT.toISOString(),
      httpStatus: 200
    });
    expect(repository.records).toHaveLength(1);
    expect(repository.diagnostics).toEqual([]);
    expect(repository.partial).toBe(false);
    expect(repository.counts).toMatchObject({ seen: 1, read: 1, skipped: 0 });
    expect(repository.counts.outcomes.ok).toBe(1);
  });

  it("reads exactly one prefix per repository when several are configured", async () => {
    const requested: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      requested.push(new URL(href).searchParams.get("prefix") ?? "");
      return new Response(JSON.stringify({ entries: [] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as unknown as typeof fetch;

    const result = await readAttentionRecords(
      apiOptions({ targetRepos: [REPOSITORY, OTHER_REPOSITORY], fetchImpl })
    );

    expect(requested.sort()).toEqual([OTHER_PREFIX, PREFIX].sort());
    expect(result.repositories.map((repository) => repository.prefix).sort()).toEqual([OTHER_PREFIX, PREFIX].sort());
  });

  it("treats an empty listing as empty rather than as an error", async () => {
    const repository = only(
      await readAttentionRecords(apiOptions({ fetchImpl: apiFetch({ [PREFIX]: listing([]) }) }))
    );

    expect(repository.sourceStatus.status).toBe("empty");
    expect(repository.records).toEqual([]);
    expect(repository.diagnostics).toEqual([]);
    expect(repository.counts).toMatchObject({ seen: 0, read: 0, skipped: 0 });
    expect(repository.partial).toBe(false);
  });

  for (const status of [401, 403]) {
    it(`surfaces HTTP ${status} as an auth_error naming the missing attention read scope`, async () => {
      const repository = only(
        await readAttentionRecords(
          apiOptions({
            fetchImpl: apiFetch({ [PREFIX]: { status, body: { error: "missing scope" } } })
          })
        )
      );

      expect(repository.sourceStatus.status).toBe("auth_error");
      expect(repository.sourceStatus.httpStatus).toBe(status);
      expect(repository.records).toEqual([]);
      expect(repository.diagnostics).toHaveLength(1);
      const diagnostic = repository.diagnostics[0];
      expect(diagnostic.kind).toBe("unreadable");
      expect(diagnostic.path).toBe(PREFIX);
      expect(diagnostic.reason).toContain(String(status));
      expect(diagnostic.reason).toContain(`read access to the ${PREFIX} prefix`);
    });
  }

  it("surfaces a missing token as an auth_error naming the token environment variable", async () => {
    const repository = only(
      await readAttentionRecords(
        apiOptions({
          coordApiToken: "",
          coordApiTokenEnvVar: "AGENT_COORD_API_TOKEN",
          fetchImpl: apiFetch({})
        })
      )
    );

    expect(repository.sourceStatus.status).toBe("auth_error");
    expect(repository.diagnostics[0].reason).toContain("AGENT_COORD_API_TOKEN");
    expect(repository.diagnostics[0].reason).toContain(`read access to the ${PREFIX} prefix`);
  });

  it("carries the client's warning when the listing is unreachable", async () => {
    const repository = only(
      await readAttentionRecords(
        apiOptions({
          fetchImpl: apiFetch({ [PREFIX]: { status: 500, body: { error: "boom" } } })
        })
      )
    );

    expect(repository.sourceStatus.status).toBe("unreachable");
    expect(repository.sourceStatus.httpStatus).toBe(500);
    expect(repository.diagnostics[0].kind).toBe("unreadable");
    expect(repository.diagnostics[0].reason).toContain("boom");
  });

  it("carries the client's warning when the request itself fails", async () => {
    const fetchImpl = (() => Promise.reject(new Error("connect ECONNREFUSED"))) as unknown as typeof fetch;

    const repository = only(await readAttentionRecords(apiOptions({ fetchImpl })));

    expect(repository.sourceStatus.status).toBe("unreachable");
    expect(repository.records).toEqual([]);
    expect(repository.diagnostics[0].reason).toContain("ECONNREFUSED");
  });

  it("reports a schema failure for a listing entry with the entry's listing path", async () => {
    const repository = only(
      await readAttentionRecords(
        apiOptions({
          fetchImpl: apiFetch({
            [PREFIX]: listing([entryFor("leap-second.json", SCHEMA_INVALID_JSON)])
          })
        })
      )
    );

    expect(repository.records).toEqual([]);
    expect(repository.sourceStatus.status).toBe("ok");
    expect(repository.counts).toMatchObject({ seen: 1, read: 1, skipped: 0 });
    const diagnostic = repository.diagnostics[0];
    expect(diagnostic.kind).toBe("schema_invalid");
    expect(diagnostic.mode).toBe("api");
    expect(diagnostic.path).toBe(`${PREFIX}/leap-second.json`);
    expect(diagnostic.reason).toContain("does not match the attention record schema");
  });

  it("rejects a listing entry that names another repository as repository_mismatch", async () => {
    const mismatched = {
      path: `${MISMATCH_PREFIX}/open.json`,
      data: JSON.parse(OPEN_RECORD_JSON) as unknown
    };

    const repository = only(
      await readAttentionRecords(
        apiOptions({
          targetRepos: [MISMATCH_REPOSITORY],
          fetchImpl: apiFetch({ [MISMATCH_PREFIX]: listing([mismatched]) })
        })
      )
    );

    expect(repository.records).toEqual([]);
    expect(repository.counts.outcomes.repository_mismatch).toBe(1);
    expect(repository.diagnostics).toEqual([
      {
        repository: MISMATCH_REPOSITORY,
        workspace: ATTENTION_WORKSPACE,
        mode: "api",
        kind: "repository_mismatch",
        path: `${MISMATCH_PREFIX}/open.json`,
        reason: `Record does not name repository ${MISMATCH_REPOSITORY}.`
      }
    ]);
    // The rejected record's own repository is never echoed into the diagnostic.
    expect(repository.diagnostics[0].reason).not.toContain(REPOSITORY);
  });

  it("reports invalid entries as unreadable warnings while keeping the valid ones", async () => {
    const repository = only(
      await readAttentionRecords(
        apiOptions({
          fetchImpl: apiFetch({
            [PREFIX]: {
              body: {
                entries: [
                  entryFor("open.json", OPEN_RECORD_JSON),
                  { path: `${OTHER_PREFIX}/open.json`, data: JSON.parse(OPEN_RECORD_JSON) as unknown }
                ]
              }
            }
          })
        })
      )
    );

    // The client drops the out-of-prefix entry with a warning and refuses to
    // call the listing healthy; both facts survive into this repository's read.
    expect(repository.records).toHaveLength(1);
    expect(repository.sourceStatus.status).toBe("unreachable");
    expect(repository.diagnostics.some((diagnostic) => diagnostic.reason.includes("Out-of-scope"))).toBe(true);
  });

  it("stops at the entry budget and reports partial", async () => {
    const repository = only(
      await readAttentionRecords(
        apiOptions({
          maxEntriesPerRepository: 1,
          fetchImpl: apiFetch({
            [PREFIX]: listing([
              entryFor("a.json", OPEN_RECORD_JSON),
              entryFor("b.json", OPEN_RECORD_JSON),
              entryFor("c.json", OPEN_RECORD_JSON)
            ])
          })
        })
      )
    );

    expect(repository.partial).toBe(true);
    expect(repository.records).toHaveLength(1);
    expect(repository.counts).toMatchObject({ seen: 3, read: 1, skipped: 2 });
  });

  it("stops at the time budget and reports partial without waiting", async () => {
    const repository = only(
      await readAttentionRecords(
        apiOptions({
          timeBudgetMs: 50,
          monotonicNow: fakeClock([0, 10, 500]),
          fetchImpl: apiFetch({
            [PREFIX]: listing([
              entryFor("a.json", OPEN_RECORD_JSON),
              entryFor("b.json", OPEN_RECORD_JSON),
              entryFor("c.json", OPEN_RECORD_JSON)
            ])
          })
        })
      )
    );

    expect(repository.partial).toBe(true);
    expect(repository.records).toHaveLength(1);
    expect(repository.counts).toMatchObject({ seen: 3, read: 1, skipped: 2 });
  });

  it("reports a repository that cannot form a prefix as unreachable without a request", async () => {
    const fetchImpl = (() => Promise.reject(new Error("no request expected"))) as unknown as typeof fetch;

    const result = await readAttentionRecords(
      apiOptions({ targetRepos: ["owner/name/extra"], fetchImpl })
    );

    const repository = only(result);
    expect(repository.sourceStatus.status).toBe("unreachable");
    expect(repository.records).toEqual([]);
    expect(repository.diagnostics[0].mode).toBe("api");
    expect(repository.diagnostics[0].reason).toContain("owner/name/extra");
  });

  it("keeps one unreachable repository from hiding one that answered", async () => {
    const result = await readAttentionRecords(
      apiOptions({
        targetRepos: [REPOSITORY, OTHER_REPOSITORY],
        fetchImpl: apiFetch({
          [PREFIX]: listing([entryFor("open.json", OPEN_RECORD_JSON)]),
          [OTHER_PREFIX]: { status: 500, body: { error: "boom" } }
        })
      })
    );

    expect(result.repositories.map((repository) => repository.sourceStatus.status)).toEqual(["ok", "unreachable"]);
    expect(result.repositories[0].records).toHaveLength(1);
    expect(result.repositories[0].diagnostics).toEqual([]);
    expect(result.repositories[1].records).toEqual([]);
  });

  it("selects API mode from a configured URL and filesystem mode without one", async () => {
    const root = await stateRoot();
    await seedRepository(root, REPOSITORY, { "open.json": OPEN_RECORD_JSON });

    const withoutUrl = await readAttentionRecords(fsOptions({ stateRoot: root, coordApiUrl: "   " }));
    const withUrl = await readAttentionRecords(
      apiOptions({
        stateRoot: root,
        fileSystem: forbiddenFileSystem,
        fetchImpl: apiFetch({ [PREFIX]: listing([]) })
      })
    );

    expect(withoutUrl.mode).toBe("fs");
    expect(withoutUrl.repositories[0].records).toHaveLength(1);
    expect(withUrl.mode).toBe("api");
    expect(withUrl.repositories[0].records).toEqual([]);
  });
});
