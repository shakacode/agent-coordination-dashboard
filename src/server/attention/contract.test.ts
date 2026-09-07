import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { ATTENTION_WORKSPACE, readAttentionRecords } from "./readAttentionRecords";

/**
 * The one contract test between the real `agent-coord` attention CLI and this
 * reader.
 *
 * Every other test in `src/server/attention` seeds files itself, so all of them
 * would keep passing if the CLI moved the storage key, renamed a field, or
 * changed what `attention-resolve` writes. This case is the only place where
 * the writer is the actual Ruby CLI: it upserts the vendored fixture into a
 * throwaway state root, reads it back through
 * {@link readAttentionRecords}, resolves it, and reads it back again.
 *
 * It is hermetic by construction. The CLI is always given an explicit
 * `--state-root` under `os.tmpdir()` and an environment whose
 * `AGENT_COORD_API_URL` is empty and whose `AGENT_COORD_API_TOKEN` is unset, so
 * neither the operator's `~/.config/agent-coord/env`, nor `~/.local/state`, nor
 * the HTTP backend can be reached. (The CLI prints one warning when a user
 * config and `--state-root` are both present, and still uses the local
 * backend.) The reader is called in filesystem mode for the same reason.
 *
 * Hosted CI has neither Ruby nor `agent-coord`, so the case skips there with a
 * visible reason rather than failing; the skip path is what CI exercises and
 * the local path is what `.agents/bin/validate` exercises before a push.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(HERE, "fixtures", "valid", "attention-open.json");

const REPOSITORY = "shakacode/agent-coordination";
const [REPOSITORY_OWNER, REPOSITORY_NAME] = REPOSITORY.split("/");

/** Both commands are given this long before the spawn is killed. */
const CLI_TIMEOUT_MS = 30_000;

/** Two Ruby process starts plus two directory walks, with room to spare. */
const CASE_TIMEOUT_MS = 120_000;

/**
 * The generation `attention-resolve` is asked for. `attention-resolve` refuses
 * a generation below the stored one, and the fixture stores 5; the case asserts
 * that relationship rather than trusting this constant.
 */
const RESOLVE_GENERATION = 6;

/** The executables the case drives, in the order their absence is reported. */
const REQUIRED_COMMANDS = ["agent-coord", "ruby"] as const;

/**
 * A which-style lookup: `which <command>` exits 0 only when the name resolves
 * on the current `PATH`.
 *
 * `spawnSync` is given an argument vector and never a shell string, so nothing
 * here interpolates into a command line. A `which` that cannot itself be
 * spawned leaves `status` null, which counts as "not resolvable" — the case
 * skips instead of failing on a machine that cannot answer the question.
 */
function isOnPath(command: string): boolean {
  return spawnSync("which", [command], { encoding: "utf8" }).status === 0;
}

/**
 * The first required command that is missing, or `undefined` when both
 * resolve. Computed once at load: `PATH` does not change under the suite.
 */
const MISSING_COMMAND = REQUIRED_COMMANDS.find((command) => !isOnPath(command));

/** The reason the reporter shows when the case is skipped. */
const SKIP_REASON = MISSING_COMMAND === undefined ? "" : `skipped: ${MISSING_COMMAND} not on PATH`;

interface CliRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** The child environment: local backend only, and no token in the process. */
function cliEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, AGENT_COORD_API_URL: "" };
  delete env.AGENT_COORD_API_TOKEN;
  return env;
}

function runCli(args: readonly string[], input?: string): CliRun {
  const result = spawnSync("agent-coord", [...args], {
    encoding: "utf8",
    env: cliEnv(),
    timeout: CLI_TIMEOUT_MS,
    ...(input === undefined ? {} : { input })
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? ""
  };
}

/** Everything a failed run knows, for the assertion message. */
function describeRun(args: readonly string[], run: CliRun): string {
  return `agent-coord ${args.join(" ")} exited ${String(run.status)}\nstdout: ${run.stdout}\nstderr: ${run.stderr}`;
}

function expectCliSuccess(args: readonly string[], input?: string): CliRun {
  const run = runCli(args, input);
  expect(run.status, describeRun(args, run)).toBe(0);
  return run;
}

/** The single repository read the case asserts against. */
async function readOnlyRepository(stateRoot: string) {
  const result = await readAttentionRecords({
    stateRoot,
    targetRepos: [REPOSITORY],
    coordApiUrl: ""
  });
  expect(result.mode).toBe("fs");
  expect(result.repositories).toHaveLength(1);
  return result.repositories[0];
}

async function isRegularFile(path: string): Promise<boolean> {
  return (await stat(path)).isFile();
}

it(
  "round trips a record from agent-coord attention-upsert and attention-resolve through the reader",
  async (context) => {
    if (SKIP_REASON !== "") {
      context.skip(SKIP_REASON);
    }

    const fixtureJson = await readFile(FIXTURE_PATH, "utf8");
    const fixture = JSON.parse(fixtureJson) as {
      id: string;
      repository: string;
      target: string;
      workspace: string;
      source_generation: number;
    };
    expect(fixture.repository).toBe(REPOSITORY);
    expect(fixture.workspace).toBe(ATTENTION_WORKSPACE);
    // Why the resolve asks for 6: a generation below the stored one is refused.
    expect(fixture.source_generation).toBeLessThan(RESOLVE_GENERATION);

    const stateRoot = await mkdtemp(join(tmpdir(), "acd-attention-contract-"));
    try {
      expectCliSuccess(
        ["attention-upsert", "--state-root", stateRoot, "--record-json", "-"],
        fixtureJson
      );

      // The storage key the reader matches, written by the CLI rather than by
      // this test: attention/<workspace>/<owner>/<name>/<id>.json.
      const recordPath = join(
        stateRoot,
        "attention",
        ATTENTION_WORKSPACE,
        REPOSITORY_OWNER,
        REPOSITORY_NAME,
        `${fixture.id}.json`
      );
      expect(await isRegularFile(recordPath)).toBe(true);
      // The persistent zero-byte sidecar the local store leaves beside every
      // record. It is the reason the reader matches `<id>.json` names instead
      // of treating every regular file as a candidate, so the case pins that it
      // is really there and that it produces no diagnostic below.
      expect(await isRegularFile(`${recordPath}.lock`)).toBe(true);

      const afterUpsert = await readOnlyRepository(stateRoot);
      expect(afterUpsert.sourceStatus.status).toBe("ok");
      expect(afterUpsert.diagnostics).toEqual([]);
      expect(afterUpsert.records).toHaveLength(1);
      const open = afterUpsert.records[0];
      expect(open.id).toBe(fixture.id);
      expect(open.repository).toBe(fixture.repository);
      expect(open.target).toBe(fixture.target);
      expect(open.status).toBe("open");

      expectCliSuccess([
        "attention-resolve",
        "--state-root",
        stateRoot,
        "--workspace",
        ATTENTION_WORKSPACE,
        "--repo",
        REPOSITORY,
        "--attention-id",
        fixture.id,
        "--source-generation",
        String(RESOLVE_GENERATION)
      ]);

      const afterResolve = await readOnlyRepository(stateRoot);
      expect(afterResolve.sourceStatus.status).toBe("ok");
      expect(afterResolve.diagnostics).toEqual([]);
      expect(afterResolve.records).toHaveLength(1);
      const resolved = afterResolve.records[0];
      expect(resolved.id).toBe(fixture.id);
      expect(resolved.status).toBe("resolved");
      expect(resolved.source_generation).toBe(RESOLVE_GENERATION);
      expect(typeof resolved.resolved_at).toBe("string");
      expect(Number.isNaN(Date.parse(resolved.resolved_at ?? ""))).toBe(false);
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  },
  CASE_TIMEOUT_MS
);
