/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import attentionModuleSource from "../../shared/attention.ts?raw";
import {
  ATTENTION_CARD_CAP_PER_REPOSITORY,
  ATTENTION_CLOCK_SKEW_TOLERANCE_SECONDS,
  ATTENTION_DEFAULT_REFRESH_INTERVAL_SECONDS,
  ATTENTION_DIAGNOSTIC_CAP_PER_REPOSITORY,
  ATTENTION_DIAGNOSTIC_CAP_TOTAL,
  ATTENTION_DIAGNOSTIC_MESSAGE_LIMIT,
  ATTENTION_MAX_REFRESH_INTERVAL_SECONDS,
  ATTENTION_MODEL_DIAGNOSTIC_KINDS,
  ATTENTION_OPEN_AGE_FLAG_DAYS,
  ATTENTION_RESOLVED_TOTAL_WARNING_THRESHOLD,
  ATTENTION_RESOLVED_TRAIL_LENGTH,
  buildAttentionModel,
  type BuildAttentionModelOptions
} from "./buildAttentionModel";
import {
  ATTENTION_READ_OUTCOME_KINDS,
  ATTENTION_WORKSPACE,
  type AttentionReadCounts,
  type AttentionReadDiagnostic,
  type AttentionReadResult,
  type AttentionRepositoryRead
} from "./readAttentionRecords";
import {
  ATTENTION_TEXT_LIMIT,
  ATTENTION_TRUNCATION_MARKER,
  type AttentionPayload,
  type AttentionRecord,
  type AttentionSource
} from "../../shared/attention";
import {
  attentionRepository,
  codexSource,
  deskContractAttentionRecord,
  makeAttentionRecord,
  openAttentionRecord,
  rankingFixtures,
  resolvedAttentionRecord
} from "../../shared/attention.fixtures";

const REPOSITORY = attentionRepository;
const OTHER_REPOSITORY = "shakacode/agent-coordination-dashboard";
/**
 * {@link REPOSITORY} spelled the way GitHub displays it. Two configured
 * repositories can only validate the same target when they are the same
 * repository under different spellings, so this is what a cross-repository
 * duplicate looks like once grouping keys on the validated target.
 */
const CASE_VARIANT_REPOSITORY = "ShakaCode/Agent-Coordination";
const TARGET = "https://github.com/shakacode/agent-coordination/pull/284";
/** {@link TARGET}'s pull request spelled the way GitHub displays the repository. */
const CASE_VARIANT_TARGET = "https://github.com/ShakaCode/Agent-Coordination/pull/284";
const OTHER_TARGET = "https://github.com/shakacode/agent-coordination/pull/301";
const OTHER_REPOSITORY_TARGET = "https://github.com/shakacode/agent-coordination-dashboard/pull/127";
/** Rejected by `validateAttentionTarget`: another repository's pull request. */
const FOREIGN_TARGET = "https://github.com/evil/agent-coordination/pull/284";

/** The model's clock for every test; the shared fixtures are fresh against it. */
const NOW = new Date("2026-09-03T09:30:00.000Z");
const CHECKED_AT = "2026-09-03T09:30:00.000Z";
/** One minute before {@link NOW}: fresh even at the desk record's 120-second interval. */
const FRESH_AT = "2026-09-03T09:29:00Z";

const MS_PER_SECOND = 1000;
const MS_PER_DAY = 86400000;

function at(offsetMs: number): string {
  return new Date(NOW.getTime() + offsetMs).toISOString();
}

function emptyCounts(): AttentionReadCounts {
  const outcomes = {} as AttentionReadCounts["outcomes"];
  for (const kind of ATTENTION_READ_OUTCOME_KINDS) {
    outcomes[kind] = 0;
  }
  return { seen: 0, read: 0, skipped: 0, outcomes };
}

function repositoryRead(overrides: Partial<AttentionRepositoryRead> = {}): AttentionRepositoryRead {
  const repository = overrides.repository ?? REPOSITORY;
  return {
    repository,
    workspace: ATTENTION_WORKSPACE,
    mode: "fs",
    prefix: `attention/${ATTENTION_WORKSPACE}/${repository}`,
    sourceStatus: { status: "ok", checkedAt: CHECKED_AT },
    records: [],
    diagnostics: [],
    partial: false,
    counts: emptyCounts(),
    ...overrides
  };
}

function readResult(...repositories: AttentionRepositoryRead[]): AttentionReadResult {
  return {
    workspace: ATTENTION_WORKSPACE,
    mode: repositories[0]?.mode ?? "fs",
    checkedAt: CHECKED_AT,
    repositories
  };
}

/** One repository holding exactly these records, the shape most rules need. */
function readOf(...records: AttentionRecord[]): AttentionReadResult {
  return readResult(repositoryRead({ records }));
}

function build(input: AttentionReadResult, options: Partial<BuildAttentionModelOptions> = {}): AttentionPayload {
  return buildAttentionModel(input, { now: NOW, machineId: "m1", ...options });
}

function sourceWith(overrides: Partial<AttentionSource> = {}): AttentionSource {
  return { ...codexSource, last_seen_at: FRESH_AT, ...overrides };
}

/** An open record that passes every freshness rule at {@link NOW}. */
function freshRecord(overrides: Partial<AttentionRecord> = {}): AttentionRecord {
  return makeAttentionRecord({
    refreshed_at: FRESH_AT,
    source: sourceWith(),
    ...overrides
  });
}

function resolvedRecord(overrides: Partial<AttentionRecord> = {}): AttentionRecord {
  return { ...resolvedAttentionRecord, ...overrides };
}

function readerDiagnostic(overrides: Partial<AttentionReadDiagnostic> = {}): AttentionReadDiagnostic {
  return {
    repository: REPOSITORY,
    workspace: ATTENTION_WORKSPACE,
    mode: "fs",
    kind: "invalid_json",
    path: `attention/${ATTENTION_WORKSPACE}/${REPOSITORY}/broken.json`,
    reason: "Could not parse the record file as JSON at position 12.",
    ...overrides
  };
}

function kindsOf(payload: AttentionPayload): string[] {
  return payload.diagnostics.map((entry) => entry.kind);
}

function ofKind(payload: AttentionPayload, kind: string): AttentionPayload["diagnostics"] {
  return payload.diagnostics.filter((entry) => entry.kind === kind);
}

/** The single diagnostic of a kind, asserting the model raised exactly one. */
function onlyOfKind(payload: AttentionPayload, kind: string): AttentionPayload["diagnostics"][number] {
  const matches = ofKind(payload, kind);
  expect(matches).toHaveLength(1);
  return matches[0];
}

function cardIds(payload: AttentionPayload): string[] {
  return payload.cards.map((card) => card.id);
}

describe("payload shape", () => {
  it("reports the clock, the dashboard host, one source per repository, and no cards for an empty read", () => {
    const payload = build(readResult(repositoryRead({ sourceStatus: { status: "empty", checkedAt: CHECKED_AT } })));

    expect(payload.generated_at).toBe(NOW.toISOString());
    expect(payload.dashboard_host).toBe("M1");
    expect(payload.cards).toEqual([]);
    expect(payload.sources).toEqual([
      {
        repository: REPOSITORY,
        mode: "fs",
        status: "empty",
        checked_at: CHECKED_AT,
        partial: false,
        truncated: false,
        resolved_total: 0
      }
    ]);
    expect(payload.diagnostics).toEqual([]);
  });

  it("renders the v1 record as a reduced card and the v1.1 record as a full card", () => {
    const desk = freshRecord({ ...deskContractAttentionRecord, refreshed_at: FRESH_AT, source: sourceWith() });

    const reduced = build(readOf(freshRecord())).cards[0];
    const full = build(readOf(desk)).cards[0];

    expect(reduced.record.question).toBe(openAttentionRecord.question);
    expect(reduced.record.what_changes).toBeUndefined();
    expect(reduced.record.walkthrough_url).toBeUndefined();
    expect(full.record.what_changes).toBe(deskContractAttentionRecord.what_changes);
    expect(full.record.one_action).toBe(deskContractAttentionRecord.one_action);
    expect(full.record.unlocks_count).toBe(2);
    expect(full.record.walkthrough_url).toBe(deskContractAttentionRecord.walkthrough_url);
  });

  it("reaches the card only through the projection, so an invalid link arrives as null", () => {
    const payload = build(readOf(freshRecord({ target: "javascript:alert(1)" })));

    expect(payload.cards[0].record.target).toBeNull();
    expect(payload.cards[0].record.source?.open_uri).toBe(codexSource.open_uri);
    expect(payload.cards[0].record).not.toHaveProperty("prompt");
  });

  it("carries the reader's configured repository on the card", () => {
    const payload = build(
      readResult(repositoryRead({ repository: OTHER_REPOSITORY, records: [freshRecord()] }))
    );

    expect(payload.cards[0].repository).toBe(OTHER_REPOSITORY);
  });

  it("leaves generated_at empty and suppresses every record on an unusable clock", () => {
    const payload = build(readOf(freshRecord({ id: "unaged-a" }), freshRecord({ id: "unaged-b" })), {
      now: new Date(Number.NaN)
    });

    expect(payload.generated_at).toBe("");
    expect(payload.cards).toEqual([]);
    expect(ofKind(payload, "stale_source").map((entry) => entry.message)).toEqual([
      "Record unaged-a cannot be aged because the dashboard clock is not a usable instant; the card is suppressed.",
      "Record unaged-b cannot be aged because the dashboard clock is not a usable instant; the card is suppressed."
    ]);
  });
});

describe("open filter and the resolved trail", () => {
  it("renders open records only", () => {
    const payload = build(readOf(freshRecord({ id: "open-one" }), resolvedRecord({ id: "resolved-one" })));

    expect(cardIds(payload)).toEqual(["open-one"]);
  });

  it("lists the newest resolved records, newest first, and no more than the trail length", () => {
    const resolved = Array.from({ length: ATTENTION_RESOLVED_TRAIL_LENGTH + 5 }, (_unused, index) =>
      resolvedRecord({
        id: `resolved-${String(index).padStart(2, "0")}`,
        resolved_at: at(-(index + 1) * 60 * MS_PER_SECOND)
      })
    );

    const payload = build(readOf(...resolved));
    const trail = ofKind(payload, "resolved_recent");

    expect(trail).toHaveLength(ATTENTION_RESOLVED_TRAIL_LENGTH);
    expect(trail[0].message).toContain("resolved-00");
    expect(trail[ATTENTION_RESOLVED_TRAIL_LENGTH - 1].message).toContain("resolved-19");
    expect(trail.some((entry) => entry.message.includes("resolved-20"))).toBe(false);
    expect(trail.every((entry) => entry.repository === REPOSITORY)).toBe(true);
  });

  it("breaks a resolved_at tie by id, ascending", () => {
    const payload = build(
      readOf(
        resolvedRecord({ id: "trail-b", resolved_at: "2026-09-03T09:00:00Z" }),
        resolvedRecord({ id: "trail-a", resolved_at: "2026-09-03T09:00:00Z" })
      )
    );

    expect(ofKind(payload, "resolved_recent").map((entry) => entry.message)).toEqual([
      `Resolved trail-a at "2026-09-03T09:00:00Z": ${TARGET}.`,
      `Resolved trail-b at "2026-09-03T09:00:00Z": ${TARGET}.`
    ]);
  });

  it("names the validated target, or says there is none", () => {
    const payload = build(
      readOf(resolvedRecord({ id: "trail-unlinked", target: "https://evil.test/pull/284" }))
    );

    expect(onlyOfKind(payload, "resolved_recent").message).toBe(
      'Resolved trail-unlinked at "2026-09-03T09:30:00Z": no valid target.'
    );
  });

  it("does not reorder the reader's own records array", () => {
    const records = [
      resolvedRecord({ id: "trail-late", resolved_at: "2026-09-03T09:00:00Z" }),
      resolvedRecord({ id: "trail-early", resolved_at: "2026-09-03T08:00:00Z" })
    ];
    const read = repositoryRead({ records });

    build(readResult(read));

    expect(read.records.map((record) => record.id)).toEqual(["trail-late", "trail-early"]);
  });
});

describe("resolved_total", () => {
  it("counts every resolved record the reader returned, trail or not", () => {
    const resolved = Array.from({ length: ATTENTION_RESOLVED_TRAIL_LENGTH + 3 }, (_unused, index) =>
      resolvedRecord({ id: `resolved-${index}`, resolved_at: at(-index * MS_PER_SECOND) })
    );

    const payload = build(readOf(freshRecord(), ...resolved));

    expect(payload.sources[0].resolved_total).toBe(ATTENTION_RESOLVED_TRAIL_LENGTH + 3);
    expect(payload.cards).toHaveLength(1);
  });

  it("warns only above the resolved-total threshold", () => {
    const resolvedRecords = (count: number): AttentionRecord[] =>
      Array.from({ length: count }, (_unused, index) => resolvedRecord({ id: `resolved-${index}` }));

    const atThreshold = build(readOf(...resolvedRecords(ATTENTION_RESOLVED_TOTAL_WARNING_THRESHOLD)));
    const overThreshold = build(readOf(...resolvedRecords(ATTENTION_RESOLVED_TOTAL_WARNING_THRESHOLD + 1)));

    expect(ofKind(atThreshold, "resolved_total_warning")).toEqual([]);
    expect(onlyOfKind(overThreshold, "resolved_total_warning").message).toBe(
      `Repository ${REPOSITORY} has ${ATTENTION_RESOLVED_TOTAL_WARNING_THRESHOLD + 1} resolved attention records, ` +
        `over the ${ATTENTION_RESOLVED_TOTAL_WARNING_THRESHOLD}-record warning threshold.`
    );
  });

  it("takes the threshold from the options", () => {
    const payload = build(readOf(resolvedRecord({ id: "r-1" }), resolvedRecord({ id: "r-2" })), {
      resolvedTotalWarningThreshold: 1
    });

    expect(onlyOfKind(payload, "resolved_total_warning").message).toContain("2 resolved attention records");
  });
});

describe("one card per record, adjacent by target", () => {
  it("never collapses two records that share a pull request", () => {
    const payload = build(
      readOf(
        freshRecord({ id: "same-a", created_at: "2026-09-03T08:00:00Z" }),
        freshRecord({ id: "same-b", created_at: "2026-09-03T08:30:00Z" })
      )
    );

    expect(cardIds(payload)).toEqual(["same-a", "same-b"]);
    expect(payload.cards.map((card) => card.same_pr)).toEqual([true, true]);
  });

  it("moves a same-target group to its highest-ranked member and keeps rank order inside it", () => {
    const payload = build(
      readOf(
        freshRecord({ id: "lead", target: TARGET, created_at: "2026-09-03T06:00:00Z" }),
        freshRecord({ id: "middle", target: OTHER_TARGET, created_at: "2026-09-03T07:00:00Z" }),
        freshRecord({ id: "trailer", target: TARGET, created_at: "2026-09-03T08:00:00Z" })
      )
    );

    expect(cardIds(payload)).toEqual(["lead", "trailer", "middle"]);
    expect(payload.cards.map((card) => card.same_pr)).toEqual([true, true, false]);
    expect(payload.cards.map((card) => card.number)).toEqual([1, 2, 3]);
  });

  it("leaves a record with a unique target unmarked", () => {
    const payload = build(readOf(freshRecord({ id: "alone" })));

    expect(payload.cards[0].same_pr).toBe(false);
  });

  it("never relates two records by a target the projection rejects", () => {
    for (const target of [FOREIGN_TARGET, "javascript:alert(1)"]) {
      const payload = build(
        readOf(
          freshRecord({ id: "unlinked-a", target, created_at: "2026-09-03T06:00:00Z" }),
          freshRecord({ id: "grouped-a", target: OTHER_TARGET, created_at: "2026-09-03T07:00:00Z" }),
          freshRecord({ id: "unlinked-b", target, created_at: "2026-09-03T08:00:00Z" }),
          freshRecord({ id: "grouped-b", target: OTHER_TARGET, created_at: "2026-09-03T09:00:00Z" })
        )
      );

      // The two rejected targets never join, so the accepted pair is the only
      // group and the unlinked records keep their own rank positions.
      expect(cardIds(payload)).toEqual(["unlinked-a", "grouped-a", "grouped-b", "unlinked-b"]);
      expect(payload.cards.map((card) => card.same_pr)).toEqual([false, true, true, false]);
    }
  });

  it("groups two accepted targets that name one pull request under different casing", () => {
    const payload = build(
      readOf(
        freshRecord({ id: "cased-a", target: TARGET, created_at: "2026-09-03T06:00:00Z" }),
        freshRecord({ id: "middle", target: OTHER_TARGET, created_at: "2026-09-03T07:00:00Z" }),
        freshRecord({
          id: "cased-b",
          repository: CASE_VARIANT_REPOSITORY,
          target: CASE_VARIANT_TARGET,
          created_at: "2026-09-03T08:00:00Z"
        })
      )
    );

    expect(cardIds(payload)).toEqual(["cased-a", "cased-b", "middle"]);
    expect(payload.cards.map((card) => card.same_pr)).toEqual([true, true, false]);
    // Grouping is canonical; each card still shows the URL its own record spelled.
    expect(payload.cards.map((card) => card.record.target)).toEqual([TARGET, CASE_VARIANT_TARGET, OTHER_TARGET]);
  });

  it("never relates two records that carry no target at all", () => {
    const withoutTarget = (id: string, createdAt: string): AttentionRecord => {
      const record = { ...freshRecord({ id, created_at: createdAt }) } as Partial<AttentionRecord>;
      delete record.target;
      return record as AttentionRecord;
    };

    const payload = build(
      readOf(withoutTarget("no-target-a", "2026-09-03T06:00:00Z"), withoutTarget("no-target-b", "2026-09-03T07:00:00Z"))
    );

    expect(cardIds(payload)).toEqual(["no-target-a", "no-target-b"]);
    expect(payload.cards.map((card) => card.same_pr)).toEqual([false, false]);
  });
});

describe("producer duplicates", () => {
  const question = "May this exact head proceed despite unmappable repair authors?";

  it("reports the same question from two producers once and renders both", () => {
    const payload = build(
      readOf(
        freshRecord({ id: "dup-a", question, created_at: "2026-09-03T08:00:00Z" }),
        freshRecord({
          id: "dup-b",
          question,
          created_at: "2026-09-03T08:30:00Z",
          source: sourceWith({ host_id: "m5", task_id: "other-task" })
        })
      )
    );

    expect(cardIds(payload)).toEqual(["dup-a", "dup-b"]);
    expect(onlyOfKind(payload, "producer_duplicate")).toEqual({
      repository: REPOSITORY,
      kind: "producer_duplicate",
      message:
        `Records dup-a, dup-b ask the same question about target "${TARGET}" from different sources; ` +
        "each one still renders."
    });
  });

  it("reports a duplicate that differs only by task id", () => {
    const payload = build(
      readOf(
        freshRecord({ id: "dup-a", question }),
        freshRecord({ id: "dup-b", question, source: sourceWith({ task_id: "second-task" }) })
      )
    );

    expect(ofKind(payload, "producer_duplicate")).toHaveLength(1);
  });

  it("says nothing when one producer wrote both records", () => {
    const payload = build(
      readOf(freshRecord({ id: "dup-a", question }), freshRecord({ id: "dup-b", question }))
    );

    expect(ofKind(payload, "producer_duplicate")).toEqual([]);
  });

  it("says nothing when the questions differ", () => {
    const payload = build(
      readOf(
        freshRecord({ id: "dup-a", question }),
        freshRecord({ id: "dup-b", question: `${question} Really?`, source: sourceWith({ task_id: "second" }) })
      )
    );

    expect(ofKind(payload, "producer_duplicate")).toEqual([]);
  });

  it("attributes a cross-repository duplicate to no repository", () => {
    const payload = build(
      readResult(
        repositoryRead({ records: [freshRecord({ id: "dup-a", question })] }),
        repositoryRead({
          repository: CASE_VARIANT_REPOSITORY,
          records: [
            freshRecord({
              id: "dup-b",
              question,
              repository: CASE_VARIANT_REPOSITORY,
              source: sourceWith({ task_id: "second" })
            })
          ]
        })
      )
    );

    expect(cardIds(payload)).toEqual(["dup-a", "dup-b"]);
    expect(onlyOfKind(payload, "producer_duplicate").repository).toBeNull();
  });

  it("says nothing when the shared target is one the projection rejects", () => {
    const payload = build(
      readOf(
        freshRecord({ id: "dup-a", question, target: FOREIGN_TARGET }),
        freshRecord({
          id: "dup-b",
          question,
          target: FOREIGN_TARGET,
          source: sourceWith({ task_id: "second" })
        })
      )
    );

    expect(cardIds(payload)).toEqual(["dup-a", "dup-b"]);
    expect(payload.cards.map((card) => card.record.target)).toEqual([null, null]);
    expect(ofKind(payload, "producer_duplicate")).toEqual([]);
  });

  it("reports a duplicate across targets that name one pull request under different casing", () => {
    const payload = build(
      readOf(
        freshRecord({ id: "cased-a", question, target: TARGET }),
        freshRecord({
          id: "cased-b",
          question,
          repository: CASE_VARIANT_REPOSITORY,
          target: CASE_VARIANT_TARGET,
          source: sourceWith({ task_id: "second" })
        })
      )
    );

    expect(cardIds(payload)).toEqual(["cased-a", "cased-b"]);
    expect(onlyOfKind(payload, "producer_duplicate").message).toContain("cased-a, cased-b");
  });

  it("treats one host spelled differently as one producer", () => {
    const spellings = ["m1", "M1", "  M1  "];
    const oneProducer = build(
      readOf(
        ...spellings.map((host_id, index) =>
          freshRecord({ id: `spelling-${index}`, question, source: sourceWith({ host_id }) })
        )
      )
    );

    expect(oneProducer.cards.map((card) => card.host)).toEqual(["M1", "M1", "M1"]);
    expect(ofKind(oneProducer, "producer_duplicate")).toEqual([]);

    const twoProducers = build(
      readOf(
        ...spellings.map((host_id, index) =>
          freshRecord({ id: `spelling-${index}`, question, source: sourceWith({ host_id }) })
        ),
        freshRecord({ id: "other-task", question, source: sourceWith({ host_id: "M1", task_id: "second" }) })
      )
    );

    // The ids are named in card order, which ties on created_at and falls to id.
    expect(cardIds(twoProducers)).toEqual(["other-task", "spelling-0", "spelling-1", "spelling-2"]);
    expect(onlyOfKind(twoProducers, "producer_duplicate").message).toContain(
      "other-task, spelling-0, spelling-1, spelling-2"
    );
  });

  it("still reports a duplicate when the shared target is one the projection accepts", () => {
    const payload = build(
      readOf(
        freshRecord({ id: "dup-a", question, target: OTHER_TARGET }),
        freshRecord({
          id: "dup-b",
          question,
          target: OTHER_TARGET,
          source: sourceWith({ task_id: "second" })
        })
      )
    );

    expect(payload.cards.map((card) => card.record.target)).toEqual([OTHER_TARGET, OTHER_TARGET]);
    expect(onlyOfKind(payload, "producer_duplicate").message).toContain("dup-a, dup-b");
  });
});

describe("host normalization", () => {
  for (const [hostId, host] of [
    ["m5", "M5"],
    ["M5", "M5"],
    ["m1", "M1"],
    ["M1", "M1"],
    ["  M1  ", "M1"]
  ] as const) {
    it(`normalizes source.host_id ${JSON.stringify(hostId)} to ${host}`, () => {
      const payload = build(readOf(freshRecord({ source: sourceWith({ host_id: hostId }) })), {
        machineId: host
      });

      expect(payload.cards[0].host).toBe(host);
      expect(payload.cards[0].host_matches).toBe(true);
    });
  }

  it("suppresses a record whose host is neither M5 nor M1 and names the host", () => {
    const payload = build(readOf(freshRecord({ id: "wrong-host", source: sourceWith({ host_id: "m9" }) })));

    expect(payload.cards).toEqual([]);
    expect(onlyOfKind(payload, "unknown_host").message).toBe(
      'Record wrong-host names host "m9", which is neither M5 nor M1; the card is suppressed.'
    );
  });

  it("truncates an overlong host value in the diagnostic", () => {
    const payload = build(
      readOf(freshRecord({ id: "long-host", source: sourceWith({ host_id: "h".repeat(500) }) }))
    );
    const quoted = /names host "([^"]*)"/.exec(onlyOfKind(payload, "unknown_host").message);

    expect(quoted?.[1]).toHaveLength(64);
    expect(quoted?.[1].endsWith(ATTENTION_TRUNCATION_MARKER)).toBe(true);
  });

  it("reports a host that is missing rather than misspelled", () => {
    const source = { ...sourceWith() } as Partial<AttentionSource>;
    delete source.host_id;
    const payload = build(readOf(freshRecord({ id: "no-host", source: source as AttentionSource })));

    expect(onlyOfKind(payload, "unknown_host").message).toContain("names host (missing)");
  });

  it("takes the dashboard host from the machine id, case-folded", () => {
    expect(build(readOf(freshRecord()), { machineId: "M5" }).dashboard_host).toBe("M5");
    expect(build(readOf(freshRecord()), { machineId: "m1" }).dashboard_host).toBe("M1");
  });

  it("reports an unset machine id as an unknown dashboard host", () => {
    const payload = build(readOf(freshRecord()), { machineId: undefined });

    expect(payload.dashboard_host).toBe("UNKNOWN");
    expect(onlyOfKind(payload, "dashboard_host_unknown")).toEqual({
      repository: null,
      kind: "dashboard_host_unknown",
      message: "The dashboard machine id is not set, so the dashboard host is UNKNOWN."
    });
  });

  it("reports an unrecognized machine id as an unknown dashboard host", () => {
    const payload = build(readOf(freshRecord()), { machineId: "laptop" });

    expect(payload.dashboard_host).toBe("UNKNOWN");
    expect(onlyOfKind(payload, "dashboard_host_unknown").message).toBe(
      'The dashboard machine id "laptop" is neither M5 nor M1, so the dashboard host is UNKNOWN.'
    );
  });

  it("still renders a card when the dashboard host is unknown, as a cross-host card", () => {
    const payload = build(readOf(freshRecord({ id: "cross" })), { machineId: undefined });

    expect(payload.cards[0].host).toBe("M1");
    expect(payload.cards[0].host_matches).toBe(false);
  });

  it("counts the rendered cards that belong to another host", () => {
    const payload = build(
      readOf(
        freshRecord({ id: "here", source: sourceWith({ host_id: "m1" }) }),
        freshRecord({ id: "there-a", source: sourceWith({ host_id: "m5", task_id: "a" }) }),
        freshRecord({ id: "there-b", source: sourceWith({ host_id: "M5", task_id: "b" }) })
      ),
      { machineId: "m1" }
    );

    expect(payload.cards.map((card) => card.host_matches)).toEqual([true, false, false]);
    expect(onlyOfKind(payload, "cross_host_count").message).toBe("2 of 3 rendered cards belong to another host.");
  });

  it("says nothing about cross-host cards when every card is answerable here", () => {
    expect(ofKind(build(readOf(freshRecord())), "cross_host_count")).toEqual([]);
  });

  it("reads native_open from the record and defaults it to unknown", () => {
    const available = build(readOf(freshRecord())).cards[0];
    const absent = build(
      readOf(
        freshRecord({
          source: {
            provider: "codex",
            host_id: "m1",
            task_id: codexSource.task_id,
            last_seen_at: FRESH_AT
          } as unknown as AttentionSource
        })
      )
    ).cards[0];

    expect(available.native_open).toBe("available");
    expect(absent.native_open).toBe("unknown");
  });
});

describe("freshness", () => {
  const staleAfterMs = ATTENTION_DEFAULT_REFRESH_INTERVAL_SECONDS * 2 * MS_PER_SECOND;

  it("keeps a record refreshed exactly twice the default interval ago", () => {
    const payload = build(readOf(freshRecord({ id: "edge", refreshed_at: at(-staleAfterMs) })));

    expect(cardIds(payload)).toEqual(["edge"]);
  });

  it("suppresses a record refreshed longer ago than twice the default interval", () => {
    const refreshedAt = at(-staleAfterMs - MS_PER_SECOND);
    const payload = build(readOf(freshRecord({ id: "stale", refreshed_at: refreshedAt })));

    expect(payload.cards).toEqual([]);
    expect(onlyOfKind(payload, "stale_source").message).toBe(
      `Record stale refreshed_at "${refreshedAt}" is older than twice its ` +
        `${ATTENTION_DEFAULT_REFRESH_INTERVAL_SECONDS}-second refresh interval; the card is suppressed.`
    );
  });

  it("uses the record's own refresh interval when it carries one", () => {
    const refreshedAt = at(-300 * MS_PER_SECOND);
    const withInterval = build(
      readOf(freshRecord({ id: "short", refresh_interval_seconds: 120, refreshed_at: refreshedAt }))
    );
    const withoutInterval = build(readOf(freshRecord({ id: "short", refreshed_at: refreshedAt })));

    expect(withInterval.cards).toEqual([]);
    expect(onlyOfKind(withInterval, "stale_source").message).toContain("120-second refresh interval");
    expect(cardIds(withoutInterval)).toEqual(["short"]);
  });

  it("falls back to the default interval when the record's interval is not a positive number", () => {
    const refreshedAt = at(-staleAfterMs - MS_PER_SECOND);
    const payload = build(
      readOf(
        freshRecord({ id: "zero", refresh_interval_seconds: 0, refreshed_at: refreshedAt }),
        freshRecord({ id: "nan", refresh_interval_seconds: Number.NaN, refreshed_at: refreshedAt })
      )
    );

    expect(
      ofKind(payload, "stale_source").every((entry) =>
        entry.message.includes(`${ATTENTION_DEFAULT_REFRESH_INTERVAL_SECONDS}-second refresh interval`)
      )
    ).toBe(true);
  });

  it("accepts a record interval up to the seven-day bound", () => {
    const payload = build(
      readOf(
        freshRecord({
          id: "weekly",
          refresh_interval_seconds: ATTENTION_MAX_REFRESH_INTERVAL_SECONDS,
          refreshed_at: at(-8 * MS_PER_DAY)
        })
      )
    );

    expect(cardIds(payload)).toEqual(["weekly"]);
  });

  it("falls back to the default for an interval past the bound, so an ancient record is stale", () => {
    const refreshedAt = at(-8 * MS_PER_DAY);
    const payload = build(
      readOf(
        freshRecord({ id: "unbounded", refresh_interval_seconds: 1e308, refreshed_at: refreshedAt }),
        freshRecord({
          id: "past-bound",
          refresh_interval_seconds: ATTENTION_MAX_REFRESH_INTERVAL_SECONDS + 1,
          refreshed_at: refreshedAt
        })
      )
    );

    expect(payload.cards).toEqual([]);
    expect(ofKind(payload, "stale_source").map((entry) => entry.message)).toEqual([
      `Record unbounded refreshed_at "${refreshedAt}" is older than twice its ` +
        `${ATTENTION_DEFAULT_REFRESH_INTERVAL_SECONDS}-second refresh interval; the card is suppressed.`,
      `Record past-bound refreshed_at "${refreshedAt}" is older than twice its ` +
        `${ATTENTION_DEFAULT_REFRESH_INTERVAL_SECONDS}-second refresh interval; the card is suppressed.`
    ]);
  });

  it("takes the default interval from the options", () => {
    const refreshedAt = at(-300 * MS_PER_SECOND);
    const payload = build(readOf(freshRecord({ id: "short", refreshed_at: refreshedAt })), {
      defaultRefreshIntervalSeconds: 60
    });

    expect(payload.cards).toEqual([]);
    expect(onlyOfKind(payload, "stale_source").message).toContain("60-second refresh interval");
  });

  it("suppresses a record whose companion was last seen too long ago", () => {
    const lastSeenAt = at(-staleAfterMs - MS_PER_SECOND);
    const payload = build(
      readOf(freshRecord({ id: "gone", source: sourceWith({ last_seen_at: lastSeenAt }) }))
    );

    expect(payload.cards).toEqual([]);
    expect(onlyOfKind(payload, "stale_companion").message).toBe(
      `Record gone source.last_seen_at "${lastSeenAt}" is older than twice its ` +
        `${ATTENTION_DEFAULT_REFRESH_INTERVAL_SECONDS}-second refresh interval; the card is suppressed.`
    );
  });

  it("treats an unreadable refreshed_at as stale", () => {
    const payload = build(readOf(freshRecord({ id: "unreadable", refreshed_at: "yesterday" })));

    expect(payload.cards).toEqual([]);
    expect(onlyOfKind(payload, "stale_source").message).toBe(
      'Record unreadable has an unreadable refreshed_at "yesterday"; the card is suppressed.'
    );
  });

  it("treats an unreadable last_seen_at as a stale companion", () => {
    const payload = build(
      readOf(freshRecord({ id: "unreadable", source: sourceWith({ last_seen_at: "recently" }) }))
    );

    expect(payload.cards).toEqual([]);
    expect(onlyOfKind(payload, "stale_companion").message).toBe(
      'Record unreadable has an unreadable source.last_seen_at "recently"; the card is suppressed.'
    );
  });

  it("reports both timestamps when both are unreadable", () => {
    const payload = build(
      readOf(
        freshRecord({
          id: "both",
          refreshed_at: "soon",
          source: sourceWith({ last_seen_at: "later" })
        })
      )
    );

    expect(kindsOf(payload)).toEqual(["stale_source", "stale_companion"]);
  });

  it("keeps a record refreshed exactly the skew tolerance ahead of the clock", () => {
    const refreshedAt = at(ATTENTION_CLOCK_SKEW_TOLERANCE_SECONDS * MS_PER_SECOND);
    const payload = build(readOf(freshRecord({ id: "edge", refreshed_at: refreshedAt })));

    expect(cardIds(payload)).toEqual(["edge"]);
  });

  it("rejects a record refreshed further ahead of the clock than the skew tolerance", () => {
    const refreshedAt = at((ATTENTION_CLOCK_SKEW_TOLERANCE_SECONDS + 1) * MS_PER_SECOND);
    const payload = build(readOf(freshRecord({ id: "skewed", refreshed_at: refreshedAt })));

    expect(payload.cards).toEqual([]);
    expect(onlyOfKind(payload, "clock_skew").message).toBe(
      `Record skewed refreshed_at "${refreshedAt}" is more than ${ATTENTION_CLOCK_SKEW_TOLERANCE_SECONDS} ` +
        "seconds ahead of the dashboard clock; the card is suppressed."
    );
  });
});

describe("open age", () => {
  it("counts whole days open and flags only records past the threshold", () => {
    const payload = build(
      readOf(
        freshRecord({ id: "fresh", created_at: at(-2 * MS_PER_DAY) }),
        freshRecord({ id: "exactly-seven", created_at: at(-ATTENTION_OPEN_AGE_FLAG_DAYS * MS_PER_DAY) }),
        freshRecord({ id: "seven-and-a-half", created_at: at(-7.5 * MS_PER_DAY) }),
        freshRecord({ id: "eight", created_at: at(-8 * MS_PER_DAY) })
      )
    );
    const days = new Map(payload.cards.map((card) => [card.id, card]));

    expect(days.get("fresh")?.open_days).toBe(2);
    expect(days.get("exactly-seven")?.open_days).toBe(ATTENTION_OPEN_AGE_FLAG_DAYS);
    expect(days.get("exactly-seven")?.verify_open_age).toBe(false);
    expect(days.get("seven-and-a-half")?.open_days).toBe(7);
    expect(days.get("seven-and-a-half")?.verify_open_age).toBe(false);
    expect(days.get("eight")?.open_days).toBe(8);
    expect(days.get("eight")?.verify_open_age).toBe(true);
    expect(onlyOfKind(payload, "open_age_flagged").message).toBe(
      `1 rendered cards have been open longer than ${ATTENTION_OPEN_AGE_FLAG_DAYS} days.`
    );
  });

  it("reports no open days for a record created in the future or with an unreadable created_at", () => {
    const payload = build(
      readOf(
        freshRecord({ id: "ahead", created_at: at(MS_PER_DAY) }),
        freshRecord({ id: "unreadable", created_at: "the other day" })
      )
    );

    expect(payload.cards.map((card) => card.open_days)).toEqual([0, 0]);
    expect(ofKind(payload, "open_age_flagged")).toEqual([]);
  });

  it("takes the open-age threshold from the options", () => {
    const payload = build(readOf(freshRecord({ id: "three-days", created_at: at(-3 * MS_PER_DAY) })), {
      openAgeFlagDays: 2
    });

    expect(payload.cards[0].verify_open_age).toBe(true);
    expect(onlyOfKind(payload, "open_age_flagged").message).toContain("longer than 2 days");
  });
});

describe("the per-repository card cap", () => {
  function manyRecords(count: number, prefix = "card"): AttentionRecord[] {
    return Array.from({ length: count }, (_unused, index) =>
      freshRecord({ id: `${prefix}-${String(index).padStart(3, "0")}` })
    );
  }

  it("keeps the highest-ranked records, marks the source, and names the dropped count", () => {
    const payload = build(readOf(...manyRecords(ATTENTION_CARD_CAP_PER_REPOSITORY + 5)));

    expect(payload.cards).toHaveLength(ATTENTION_CARD_CAP_PER_REPOSITORY);
    expect(cardIds(payload)[0]).toBe("card-000");
    expect(cardIds(payload)).not.toContain("card-100");
    expect(payload.sources[0].truncated).toBe(true);
    expect(onlyOfKind(payload, "truncated").message).toBe(
      `Repository ${REPOSITORY} kept the ${ATTENTION_CARD_CAP_PER_REPOSITORY} highest-ranked open records ` +
        "and dropped 5."
    );
  });

  it("caps each repository on its own", () => {
    const payload = build(
      readResult(
        repositoryRead({ records: manyRecords(3, "a") }),
        repositoryRead({
          repository: OTHER_REPOSITORY,
          records: manyRecords(3, "b").map((record) => ({ ...record, repository: OTHER_REPOSITORY }))
        })
      ),
      { cardCapPerRepository: 2 }
    );

    expect(payload.sources.map((source) => source.truncated)).toEqual([true, true]);
    expect(ofKind(payload, "truncated").map((entry) => entry.repository)).toEqual([REPOSITORY, OTHER_REPOSITORY]);
    expect(payload.cards).toHaveLength(4);
  });

  it("does not count suppressed records against the cap", () => {
    const payload = build(
      readOf(
        freshRecord({ id: "kept" }),
        freshRecord({ id: "unknown-host", source: sourceWith({ host_id: "m9" }) }),
        freshRecord({ id: "stale", refreshed_at: "2026-08-01T00:00:00Z" })
      ),
      { cardCapPerRepository: 1 }
    );

    expect(cardIds(payload)).toEqual(["kept"]);
    expect(payload.sources[0].truncated).toBe(false);
    expect(ofKind(payload, "truncated")).toEqual([]);
  });
});

describe("ranking and numbering", () => {
  for (const fixture of rankingFixtures) {
    it(`reproduces the shared ranking fixture: ${fixture.label}`, () => {
      const payload = build(readOf(...fixture.records));

      expect(cardIds(payload)).toEqual(fixture.expectedIds);
      expect(payload.cards.map((card) => card.number)).toEqual(
        fixture.expectedIds.map((_unused, index) => index + 1)
      );
    });
  }

  it("numbers cards 1..N contiguously across repositories", () => {
    const payload = build(
      readResult(
        repositoryRead({
          records: [
            freshRecord({ id: "a-late", created_at: "2026-09-03T09:00:00Z" }),
            freshRecord({ id: "a-early", created_at: "2026-09-03T07:00:00Z", target: OTHER_TARGET })
          ]
        }),
        repositoryRead({
          repository: OTHER_REPOSITORY,
          records: [
            freshRecord({
              id: "b-earliest",
              repository: OTHER_REPOSITORY,
              target: OTHER_REPOSITORY_TARGET,
              created_at: "2026-09-03T06:00:00Z"
            })
          ]
        })
      )
    );

    expect(cardIds(payload)).toEqual(["b-earliest", "a-early", "a-late"]);
    expect(payload.cards.map((card) => card.number)).toEqual([1, 2, 3]);
    expect(payload.cards.map((card) => card.repository)).toEqual([OTHER_REPOSITORY, REPOSITORY, REPOSITORY]);
  });
});

describe("sources", () => {
  it("carries the reader's mode, status, checked_at, and partial flag", () => {
    const payload = build(
      readResult(
        repositoryRead({
          mode: "api",
          partial: true,
          sourceStatus: { status: "auth_error", checkedAt: CHECKED_AT, httpStatus: 401 },
          diagnostics: [readerDiagnostic({ kind: "unreadable", reason: "The token cannot read attention." })]
        })
      )
    );

    expect(payload.sources[0]).toEqual({
      repository: REPOSITORY,
      mode: "api",
      status: "auth_error",
      checked_at: CHECKED_AT,
      partial: true,
      truncated: false,
      resolved_total: 0,
      message: "The token cannot read attention."
    });
  });

  it("takes the message from the first reader diagnostic when the source is unreachable", () => {
    const payload = build(
      readResult(
        repositoryRead({
          sourceStatus: { status: "unreachable", checkedAt: CHECKED_AT },
          diagnostics: [
            readerDiagnostic({ kind: "unreadable", reason: "first reason" }),
            readerDiagnostic({ kind: "unreadable", reason: "second reason" })
          ]
        })
      )
    );

    expect(payload.sources[0].message).toBe("first reason");
  });

  it("carries no message for a healthy source", () => {
    const payload = build(readResult(repositoryRead({ diagnostics: [readerDiagnostic()] })));

    expect(payload.sources[0]).not.toHaveProperty("message");
  });

  it("reports one source per configured repository, in the reader's order", () => {
    const payload = build(
      readResult(repositoryRead(), repositoryRead({ repository: OTHER_REPOSITORY }))
    );

    expect(payload.sources.map((source) => source.repository)).toEqual([REPOSITORY, OTHER_REPOSITORY]);
  });
});

describe("diagnostics", () => {
  it("passes a reader diagnostic through under its own kind, as path and reason", () => {
    const payload = build(readResult(repositoryRead({ diagnostics: [readerDiagnostic()] })));

    expect(payload.diagnostics).toEqual([
      {
        repository: REPOSITORY,
        kind: "invalid_json",
        message: `attention/${ATTENTION_WORKSPACE}/${REPOSITORY}/broken.json: ` +
          "Could not parse the record file as JSON at position 12."
      }
    ]);
  });

  it("caps every message with a visible marker", () => {
    const payload = build(
      readResult(repositoryRead({ diagnostics: [readerDiagnostic({ reason: "x".repeat(2000) })] }))
    );

    expect(payload.diagnostics[0].message).toHaveLength(ATTENTION_DIAGNOSTIC_MESSAGE_LIMIT);
    expect(payload.diagnostics[0].message.endsWith(ATTENTION_TRUNCATION_MARKER)).toBe(true);
    expect(payload.sources[0].message).toBeUndefined();
  });

  it("caps a source message with a visible marker", () => {
    const payload = build(
      readResult(
        repositoryRead({
          sourceStatus: { status: "unreachable", checkedAt: CHECKED_AT },
          diagnostics: [readerDiagnostic({ kind: "unreadable", reason: "y".repeat(2000) })]
        })
      )
    );

    expect(payload.sources[0].message).toHaveLength(ATTENTION_DIAGNOSTIC_MESSAGE_LIMIT);
    expect(payload.sources[0].message?.endsWith(ATTENTION_TRUNCATION_MARKER)).toBe(true);
  });

  it("caps a repository's diagnostics and names what it dropped", () => {
    const diagnostics = Array.from({ length: ATTENTION_DIAGNOSTIC_CAP_PER_REPOSITORY + 50 }, (_unused, index) =>
      readerDiagnostic({ path: `attention/${ATTENTION_WORKSPACE}/${REPOSITORY}/broken-${index}.json` })
    );

    const payload = build(readResult(repositoryRead({ diagnostics })));

    expect(payload.diagnostics).toHaveLength(ATTENTION_DIAGNOSTIC_CAP_PER_REPOSITORY + 1);
    expect(payload.diagnostics[ATTENTION_DIAGNOSTIC_CAP_PER_REPOSITORY]).toEqual({
      repository: REPOSITORY,
      kind: "diagnostics_truncated",
      message:
        `Repository ${REPOSITORY} raised 50 more diagnostics than the ${ATTENTION_DIAGNOSTIC_CAP_PER_REPOSITORY} shown.`
    });
  });

  it("keeps the return-to trail behind the warnings it must not crowd out", () => {
    const payload = build(
      readResult(
        repositoryRead({
          records: [
            freshRecord({ id: "suppressed", source: sourceWith({ host_id: "m9" }) }),
            resolvedRecord({ id: "resolved-one" })
          ],
          diagnostics: [readerDiagnostic()]
        })
      )
    );

    expect(kindsOf(payload)).toEqual(["invalid_json", "unknown_host", "resolved_recent"]);
  });

  it("caps the whole payload and names what it dropped", () => {
    const diagnosticsFor = (repository: string): AttentionReadDiagnostic[] =>
      Array.from({ length: 80 }, (_unused, index) =>
        readerDiagnostic({
          repository,
          path: `attention/${ATTENTION_WORKSPACE}/${repository}/broken-${index}.json`
        })
      );

    const payload = build(
      readResult(
        repositoryRead({ diagnostics: diagnosticsFor(REPOSITORY) }),
        repositoryRead({ repository: OTHER_REPOSITORY, diagnostics: diagnosticsFor(OTHER_REPOSITORY) }),
        repositoryRead({ repository: "shakacode/shakapacker", diagnostics: diagnosticsFor("shakacode/shakapacker") })
      )
    );

    expect(payload.diagnostics).toHaveLength(ATTENTION_DIAGNOSTIC_CAP_TOTAL + 1);
    expect(payload.diagnostics[ATTENTION_DIAGNOSTIC_CAP_TOTAL]).toEqual({
      repository: null,
      kind: "diagnostics_truncated",
      message: `The payload raised 40 more diagnostics than the ${ATTENTION_DIAGNOSTIC_CAP_TOTAL} shown.`
    });
  });

  it("keeps the payload-wide diagnostics ahead of a flood of repository diagnostics", () => {
    const question = "May this exact head proceed despite unmappable repair authors?";
    const diagnosticsFor = (repository: string): AttentionReadDiagnostic[] =>
      Array.from({ length: ATTENTION_DIAGNOSTIC_CAP_PER_REPOSITORY + 50 }, (_unused, index) =>
        readerDiagnostic({
          repository,
          path: `attention/${ATTENTION_WORKSPACE}/${repository}/broken-${index}.json`
        })
      );

    const payload = build(
      readResult(
        repositoryRead({
          diagnostics: diagnosticsFor(REPOSITORY),
          records: [freshRecord({ id: "dup-a", question, created_at: at(-30 * MS_PER_DAY) })]
        }),
        repositoryRead({
          repository: CASE_VARIANT_REPOSITORY,
          diagnostics: diagnosticsFor(CASE_VARIANT_REPOSITORY),
          records: [
            freshRecord({
              id: "dup-b",
              question,
              repository: CASE_VARIANT_REPOSITORY,
              source: sourceWith({ task_id: "second" })
            })
          ]
        })
      ),
      { machineId: "laptop" }
    );

    expect(kindsOf(payload).slice(0, 4)).toEqual([
      "dashboard_host_unknown",
      "producer_duplicate",
      "cross_host_count",
      "open_age_flagged"
    ]);
    expect(payload.diagnostics).toHaveLength(ATTENTION_DIAGNOSTIC_CAP_TOTAL + 1);
    expect(payload.diagnostics[ATTENTION_DIAGNOSTIC_CAP_TOTAL]).toEqual({
      repository: null,
      kind: "diagnostics_truncated",
      message: `The payload raised 6 more diagnostics than the ${ATTENTION_DIAGNOSTIC_CAP_TOTAL} shown.`
    });
  });

  it("takes the per-repository diagnostic cap from the options", () => {
    const payload = build(
      readResult(repositoryRead({ diagnostics: [readerDiagnostic(), readerDiagnostic(), readerDiagnostic()] })),
      { diagnosticCapPerRepository: 2 }
    );

    expect(kindsOf(payload)).toEqual(["invalid_json", "invalid_json", "diagnostics_truncated"]);
  });

  it("raises every kind it declares", () => {
    const raised = new Set<string>();

    const suppressions = build(
      readResult(
        repositoryRead({
          diagnostics: [readerDiagnostic()],
          records: [
            freshRecord({ id: "unknown-host", source: sourceWith({ host_id: "m9" }) }),
            freshRecord({ id: "stale", refreshed_at: "2026-08-01T00:00:00Z" }),
            freshRecord({ id: "companion", source: sourceWith({ last_seen_at: "2026-08-01T00:00:00Z" }) }),
            freshRecord({ id: "skewed", refreshed_at: at(3600 * MS_PER_SECOND) }),
            freshRecord({ id: "old", created_at: at(-30 * MS_PER_DAY) }),
            freshRecord({ id: "cap-a", target: OTHER_TARGET }),
            freshRecord({
              id: "cap-b",
              target: OTHER_TARGET,
              source: sourceWith({ host_id: "m5", task_id: "second" })
            }),
            freshRecord({ id: "extra", target: "https://github.com/shakacode/agent-coordination/pull/999" }),
            resolvedRecord({ id: "resolved-one" }),
            resolvedRecord({ id: "resolved-two" })
          ]
        })
      ),
      {
        machineId: "laptop",
        cardCapPerRepository: 3,
        resolvedTotalWarningThreshold: 1,
        diagnosticCapPerRepository: 9
      }
    );
    for (const kind of kindsOf(suppressions)) {
      raised.add(kind);
    }

    expect(ATTENTION_MODEL_DIAGNOSTIC_KINDS.filter((kind) => !raised.has(kind))).toEqual([]);
    expect(raised.has("invalid_json")).toBe(true);
  });
});

describe("robustness", () => {
  const garbageRecords = [
    null,
    undefined,
    42,
    "open",
    ["open"],
    {},
    { status: "open" },
    { status: "open", id: 7, source: 9, refreshed_at: 11, created_at: {}, target: 13, question: [] },
    { status: "open", source: { host_id: "m1" }, refreshed_at: "never", created_at: "never" },
    { status: "resolved" },
    { status: "resolved", resolved_at: 5, target: 7, id: 9 },
    { status: "closed", id: "unknown-status" }
  ] as unknown as AttentionRecord[];

  it("never throws on records with garbage fields", () => {
    expect(() => build(readOf(...garbageRecords))).not.toThrow();
  });

  it("renders no card for a record it cannot model and reports each one it drops", () => {
    const payload = build(readOf(...garbageRecords));

    expect(payload.cards).toEqual([]);
    expect(ofKind(payload, "unknown_host").length).toBeGreaterThan(0);
    expect(kindsOf(payload)).toContain("stale_source");
    expect(kindsOf(payload)).toContain("stale_companion");
    expect(ofKind(payload, "resolved_recent")).toHaveLength(2);
  });

  it("names a record with no usable id rather than throwing", () => {
    const payload = build(
      readOf({ status: "open", id: 7, source: { host_id: "nope" } } as unknown as AttentionRecord)
    );

    expect(onlyOfKind(payload, "unknown_host").message).toContain("Record (unknown id)");
  });

  it("renders an empty id for a record whose id is not text", () => {
    const record = {
      ...freshRecord(),
      id: 7
    } as unknown as AttentionRecord;

    const payload = build(readOf(record));

    expect(payload.cards[0].id).toBe("");
    expect(payload.cards[0].number).toBe(1);
  });

  it("never throws on a read result with no repositories", () => {
    expect(build(readResult()).cards).toEqual([]);
    expect(build(readResult()).sources).toEqual([]);
  });

  it("caps oversized record text through the projection", () => {
    const payload = build(readOf(freshRecord({ question: "q".repeat(ATTENTION_TEXT_LIMIT + 100) })));

    expect(payload.cards[0].record.question).toHaveLength(ATTENTION_TEXT_LIMIT);
    expect(payload.cards[0].record.question?.endsWith(ATTENTION_TRUNCATION_MARKER)).toBe(true);
  });

  it("caps an oversized id on the card, not only inside the projected record", () => {
    const payload = build(readOf(freshRecord({ id: "i".repeat(ATTENTION_TEXT_LIMIT + 100) })));

    expect(payload.cards[0].id).toHaveLength(ATTENTION_TEXT_LIMIT);
    expect(payload.cards[0].id.endsWith(ATTENTION_TRUNCATION_MARKER)).toBe(true);
    expect(payload.cards[0].id).toBe(payload.cards[0].record.id);
  });
});

describe("shared module hygiene", () => {
  it("keeps src/shared/attention.ts free of imports", () => {
    const specifiers = [...attentionModuleSource.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*["']([^"']+)["']/g)].map(
      (match) => match[1]
    );

    expect(specifiers).toEqual([]);
    expect(attentionModuleSource).not.toMatch(/\brequire\s*\(/);
  });
});

describe("configured attention freshness", () => {
  it.each(["source", "companion"] as const)("uses record then repository then global interval for %s", (timestamp) => {
    const record = freshRecord({ refresh_interval_seconds: undefined,
      ...(timestamp === "source" ? { refreshed_at: at(-300_000) } : { source: sourceWith({ last_seen_at: at(-300_000) }) }) });
    const options = { sourceIntervalSeconds: { default: 600, repositories: { [REPOSITORY.toUpperCase()]: 120 } } };
    expect(cardIds(build(readOf(record), options))).toEqual([]);
    expect(kindsOf(build(readOf(record), options))).toContain(timestamp === "source" ? "stale_source" : "stale_companion");
    expect(build(readOf({ ...record, refresh_interval_seconds: 300 }), options).cards).toHaveLength(1);
    expect(build(readOf(record), { sourceIntervalSeconds: { default: 600, repositories: { "other/repo": 120 } } }).cards).toHaveLength(1);
    expect(build(readOf(record), { sourceIntervalSeconds: 120 }).cards).toHaveLength(0);
    expect(build(readOf({ ...record, refresh_interval_seconds: 604801 }), options).cards).toHaveLength(0);
  });

  it("uses the configured open age threshold", () => {
    const read = readOf(freshRecord({ created_at: at(-3 * MS_PER_DAY) }));
    expect(build(read, { openAgeFlagDays: 2 }).cards[0].verify_open_age).toBe(true);
    expect(build(read, { openAgeFlagDays: 4 }).cards[0].verify_open_age).toBe(false);
  });
});
