import { spawnSync } from "node:child_process";
import { access, constants, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
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
 * `--state-root` under `os.tmpdir()` and a child environment whose
 * `AGENT_COORD_API_URL` is empty and whose every other `AGENT_COORD_*`
 * variable — the token, an ambient state root, the machine id, the policy — is
 * removed, so neither the operator's `~/.config/agent-coord/env`, nor
 * `~/.local/state`, nor the HTTP backend can be reached and no ambient setting
 * can compete with the flag. (The CLI prints one warning when a user config and
 * `--state-root` are both present, and still uses the local backend.) The case
 * proves that last point rather than asserting it: it points
 * `AGENT_COORD_STATE_ROOT` at a decoy directory for the length of the run and
 * requires the decoy to stay empty. The reader is called in filesystem mode for
 * the same reason.
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
 * Every `AGENT_COORD_*` variable that is removed from the child environment.
 *
 * `AGENT_COORD_API_URL` is not here because it is set to the empty string
 * instead: an empty value is what selects the local backend, while an absent
 * one would let the CLI's own user config supply a URL.
 */
const STRIPPED_ENV_VARS = [
  "AGENT_COORD_API_TOKEN",
  "AGENT_COORD_STATE_ROOT",
  "AGENT_COORD_MACHINE_ID",
  "AGENT_COORD_POLICY"
] as const;

/** True for a path that is a regular file the current user may execute. */
async function isExecutableFile(path: string): Promise<boolean> {
  try {
    // `stat`, not `lstat`: a symlink to an executable is one. The `isFile`
    // check matters because a directory also answers `X_OK`.
    if (!(await stat(path)).isFile()) {
      return false;
    }
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a command against `PATH` in process, the way
 * `scripts/lifecycle.test.ts` does.
 *
 * The walk deliberately spawns nothing. A gate that shelled out to `which`
 * would report "not on PATH" on any host without that binary, so a missing
 * `which` — not a missing `agent-coord` — could silently turn the contract
 * test into a no-op. An empty `PATH` entry means the working directory, which
 * is what a shell does with it.
 */
async function isOnPath(command: string): Promise<boolean> {
  for (const entry of (process.env.PATH ?? "").split(delimiter)) {
    if (await isExecutableFile(resolve(entry === "" ? "." : entry, command))) {
      return true;
    }
  }
  return false;
}

/** The first required command that is missing, or `undefined` when both resolve. */
async function firstMissingCommand(): Promise<string | undefined> {
  for (const command of REQUIRED_COMMANDS) {
    if (!(await isOnPath(command))) {
      return command;
    }
  }
  return undefined;
}

interface CliRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** The child environment: local backend only, and no ambient coordination state. */
function cliEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, AGENT_COORD_API_URL: "" };
  for (const name of STRIPPED_ENV_VARS) {
    delete env[name];
  }
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
    const missingCommand = await firstMissingCommand();
    if (missingCommand !== undefined) {
      context.skip(`skipped: ${missingCommand} not on PATH`);
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
    // The decoy an ambient `AGENT_COORD_STATE_ROOT` would send the CLI to. It
    // has to stay empty for the whole run.
    const decoyRoot = await mkdtemp(join(tmpdir(), "acd-attention-contract-decoy-"));
    const ambientStateRoot = process.env.AGENT_COORD_STATE_ROOT;
    try {
      process.env.AGENT_COORD_STATE_ROOT = decoyRoot;
      const childEnv = cliEnv();
      expect(childEnv.AGENT_COORD_API_URL).toBe("");
      for (const name of STRIPPED_ENV_VARS) {
        expect(name in childEnv).toBe(false);
      }

      expectCliSuccess(
        ["attention-upsert", "--state-root", stateRoot, "--record-json", "-"],
        fixtureJson
      );
      expect(await readdir(decoyRoot)).toEqual([]);

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
      expect(await readdir(decoyRoot)).toEqual([]);

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
      if (ambientStateRoot === undefined) {
        delete process.env.AGENT_COORD_STATE_ROOT;
      } else {
        process.env.AGENT_COORD_STATE_ROOT = ambientStateRoot;
      }
      await rm(stateRoot, { recursive: true, force: true });
      await rm(decoyRoot, { recursive: true, force: true });
    }
  },
  CASE_TIMEOUT_MS
);
