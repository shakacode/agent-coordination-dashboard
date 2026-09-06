/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import attentionModuleSource from "./attention.ts?raw";
import {
  ATTENTION_TEXT_LIMIT,
  ATTENTION_TRUNCATION_MARKER,
  projectAttentionRecord,
  rank,
  renderAllowlist,
  renderSourceAllowlist,
  truncateForRender,
  validateAttentionTarget,
  validateOpenUri,
  validateWalkthroughUrl,
  type AttentionRecord,
  type AttentionSource
} from "./attention";
import {
  acceptedTargetUrls,
  acceptedWalkthroughUrls,
  attentionRecordWithUnknownFields,
  attentionRepository,
  classRankingFixture,
  deskContractAttentionRecord,
  makeAttentionRecord,
  openAttentionRecord,
  openUriCases,
  oversizedRenderText,
  rankingFixtures,
  rejectedLinkProjectionCases,
  rejectedTargetUrls,
  rejectedWalkthroughUrls,
  resolvedAttentionRecord,
  unknownAttentionFields,
  unlocksCountRankingFixture
} from "./attention.fixtures";

describe("attention module hygiene", () => {
  it("has no server, client, node, or React imports", () => {
    const specifiers = [...attentionModuleSource.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*["']([^"']+)["']/g)].map(
      (match) => match[1]
    );

    expect(specifiers).toEqual([]);
    expect(attentionModuleSource).not.toMatch(
      /(?:from|import)\s*\(?\s*["'](?:node:|react|react-dom|[^"']*\/(?:server|client)\/)/
    );
    expect(attentionModuleSource).not.toMatch(/\brequire\s*\(/);
  });
});

describe("validateAttentionTarget", () => {
  for (const accepted of acceptedTargetUrls) {
    it(`accepts ${accepted.label}`, () => {
      expect(validateAttentionTarget(accepted.url, accepted.repository)).toBe(accepted.url);
    });
  }

  for (const rejected of rejectedTargetUrls) {
    it(`rejects ${rejected.label}`, () => {
      expect(validateAttentionTarget(rejected.url, rejected.repository)).toBeNull();
    });
  }

  it("rejects a target longer than the upstream bound", () => {
    const padded = `https://github.com/shakacode/agent-coordination/pull/${"1".repeat(2000)}`;

    expect(validateAttentionTarget(padded, attentionRepository)).toBeNull();
  });

  it("never throws on non-string input", () => {
    expect(validateAttentionTarget(undefined, attentionRepository)).toBeNull();
    expect(validateAttentionTarget(openAttentionRecord.target, undefined)).toBeNull();
    expect(validateAttentionTarget(42, attentionRepository)).toBeNull();
  });
});

describe("validateWalkthroughUrl", () => {
  for (const accepted of acceptedWalkthroughUrls) {
    it(`accepts ${accepted.label}`, () => {
      expect(validateWalkthroughUrl(accepted.url, accepted.repository)).toBe(accepted.url);
    });
  }

  for (const rejected of rejectedWalkthroughUrls) {
    it(`rejects ${rejected.label}`, () => {
      expect(validateWalkthroughUrl(rejected.url, rejected.repository)).toBeNull();
    });
  }

  it("accepts the walkthrough URL carried by the desk contract record", () => {
    expect(
      validateWalkthroughUrl(deskContractAttentionRecord.walkthrough_url, deskContractAttentionRecord.repository)
    ).toBe(deskContractAttentionRecord.walkthrough_url);
  });
});

describe("validateOpenUri", () => {
  for (const openUriCase of openUriCases) {
    it(`${openUriCase.expected === null ? "yields no link for" : "accepts"} ${openUriCase.label}`, () => {
      expect(validateOpenUri(openUriCase.source)).toBe(openUriCase.expected);
    });
  }

  it("never throws on a malformed source", () => {
    const malformed = [
      {},
      { provider: "codex" },
      { provider: "codex", task_id: 7, open_uri: "codex://threads/7" },
      { provider: "codex", task_id: "abc", open_uri: 7 }
    ] as unknown as AttentionSource[];

    for (const source of malformed) {
      expect(validateOpenUri(source)).toBeNull();
    }
  });
});

describe("renderAllowlist", () => {
  it("lists each renderable field once", () => {
    expect(new Set(renderAllowlist).size).toBe(renderAllowlist.length);
    expect(new Set(renderSourceAllowlist).size).toBe(renderSourceAllowlist.length);
  });

  it("projects only allowlisted fields", () => {
    const view = projectAttentionRecord(deskContractAttentionRecord);

    expect(Object.keys(view).every((key) => (renderAllowlist as readonly string[]).includes(key))).toBe(true);
    expect(view.what_changes).toBe(deskContractAttentionRecord.what_changes);
    expect(view.unlocks_count).toBe(2);
    expect(view.walkthrough_mode).toBe("requested");
    expect(view.refresh_interval_seconds).toBe(120);
    expect(view.hil_task_title).toBe("Security gate for the exact head");
    expect(view.choices).toEqual(openAttentionRecord.choices);
  });

  it("never reads unknown fields or fields outside the allowlist", () => {
    const view = projectAttentionRecord(attentionRecordWithUnknownFields) as Record<string, unknown>;

    for (const unknownField of Object.keys(unknownAttentionFields)) {
      expect(view).not.toHaveProperty(unknownField);
    }
    expect(view).not.toHaveProperty("workspace");
    expect(view).not.toHaveProperty("schema_version");
    expect(view).not.toHaveProperty("source_generation");
  });

  it("omits absent fields instead of inventing them", () => {
    const view = projectAttentionRecord(openAttentionRecord);

    expect(view).not.toHaveProperty("resolved_at");
    expect(view).not.toHaveProperty("unlocks_count");
    expect(projectAttentionRecord(resolvedAttentionRecord).resolved_at).toBe("2026-09-03T09:30:00Z");
  });

  it("drops a null walkthrough mode", () => {
    const view = projectAttentionRecord(makeAttentionRecord({ walkthrough_mode: null }));

    expect(view).not.toHaveProperty("walkthrough_mode");
  });

  it("omits a narrow-union value outside its literal set", () => {
    const view = projectAttentionRecord(
      makeAttentionRecord({
        status: "archived",
        priority_class: "brand-new-class",
        walkthrough_mode: "some-new-mode"
      } as unknown as Partial<AttentionRecord>)
    );

    expect(view).not.toHaveProperty("status");
    expect(view).not.toHaveProperty("priority_class");
    expect(view).not.toHaveProperty("walkthrough_mode");
    expect(view.id).toBe(openAttentionRecord.id);
  });

  it("projects narrow-union values inside their literal sets unchanged", () => {
    const view = projectAttentionRecord(deskContractAttentionRecord);

    expect(view.status).toBe("open");
    expect(view.priority_class).toBe("current-head-merge");
    expect(view.walkthrough_mode).toBe("requested");
    expect(projectAttentionRecord(resolvedAttentionRecord).status).toBe("resolved");
  });

  it("caps every text value with a visible truncation marker", () => {
    const view = projectAttentionRecord(
      makeAttentionRecord({ question: oversizedRenderText, choices: [oversizedRenderText, "short"] })
    );

    expect(view.question).toHaveLength(ATTENTION_TEXT_LIMIT);
    expect(view.question?.endsWith(ATTENTION_TRUNCATION_MARKER)).toBe(true);
    expect(view.choices?.[0]).toHaveLength(ATTENTION_TEXT_LIMIT);
    expect(view.choices?.[0]?.endsWith(ATTENTION_TRUNCATION_MARKER)).toBe(true);
    expect(view.choices?.[1]).toBe("short");
  });

  it("omits an array field carrying a non-string entry instead of shifting indices", () => {
    const view = projectAttentionRecord(
      makeAttentionRecord({ choices: ["Acknowledge", 42, "Rebuild"] as unknown as string[] })
    );

    expect(view).not.toHaveProperty("choices");
    expect(view.question).toBe(openAttentionRecord.question);
    expect(projectAttentionRecord(openAttentionRecord).choices).toEqual(openAttentionRecord.choices);
  });

  it("leaves values at the bound untouched", () => {
    const exact = "y".repeat(ATTENTION_TEXT_LIMIT);

    expect(truncateForRender(exact)).toBe(exact);
    expect(truncateForRender("")).toBe("");
  });

  it("never splits a surrogate pair when truncating", () => {
    const truncated = truncateForRender(`a${"🙂".repeat(ATTENTION_TEXT_LIMIT)}`);

    expect(truncated.length).toBeLessThanOrEqual(ATTENTION_TEXT_LIMIT);
    expect(truncated.endsWith(ATTENTION_TRUNCATION_MARKER)).toBe(true);
    expect(truncated).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it("projects the source through its own allowlist", () => {
    const noisySource = {
      ...openAttentionRecord.source,
      prompt: "never rendered",
      capabilities: { native_open: "available", prompt_forwarding: "nonsense" }
    } as unknown as AttentionSource;

    const view = projectAttentionRecord(makeAttentionRecord({ source: noisySource }));

    expect(view.source).toBeDefined();
    expect(view.source).not.toHaveProperty("prompt");
    expect(view.source?.open_uri).toBe(openAttentionRecord.source.open_uri);
    expect(view.source?.capabilities).toEqual({ native_open: "available" });
  });

  it("omits source capabilities when no subfield survives validation", () => {
    const bogus = {
      ...openAttentionRecord.source,
      capabilities: { native_open: "bogus", prompt_forwarding: "bogus" }
    } as unknown as AttentionSource;

    const view = projectAttentionRecord(makeAttentionRecord({ source: bogus }));

    expect(view.source).toBeDefined();
    expect(view.source).not.toHaveProperty("capabilities");
    expect(view.source?.task_id).toBe(openAttentionRecord.source.task_id);
  });

  it("returns an empty view for a non-record value", () => {
    expect(projectAttentionRecord(null as unknown as AttentionRecord)).toEqual({});
    expect(projectAttentionRecord([] as unknown as AttentionRecord)).toEqual({});
  });
});

describe("projectAttentionRecord link validation", () => {
  for (const linkCase of rejectedLinkProjectionCases) {
    it(`projects ${linkCase.label} as null`, () => {
      const view = projectAttentionRecord(linkCase.record);

      if (linkCase.field === "open_uri") {
        expect(view.source?.open_uri).toBeNull();
      } else {
        expect(view[linkCase.field]).toBeNull();
      }

      expect(view.id).toBe(linkCase.record.id);
      expect(view.question).toBe(linkCase.record.question);
      expect(view.choices).toEqual(linkCase.record.choices);
      expect(view.source?.task_id).toBe(linkCase.record.source.task_id);
    });
  }

  it("projects the links of a valid record unchanged", () => {
    const view = projectAttentionRecord(deskContractAttentionRecord);

    expect(view.target).toBe(deskContractAttentionRecord.target);
    expect(view.walkthrough_url).toBe(deskContractAttentionRecord.walkthrough_url);
    expect(view.source?.open_uri).toBe(deskContractAttentionRecord.source.open_uri);
  });

  it("omits an absent link field instead of projecting null", () => {
    const view = projectAttentionRecord(openAttentionRecord);

    expect(view).not.toHaveProperty("walkthrough_url");
    expect(projectAttentionRecord(resolvedAttentionRecord).source).not.toHaveProperty("open_uri");
  });
});

describe("rank", () => {
  for (const fixture of rankingFixtures) {
    it(`orders records by ${fixture.label}`, () => {
      expect(rank(fixture.records).map((record) => record.id)).toEqual(fixture.expectedIds);
    });
  }

  it("puts urgent-risk first in both ranking branches", () => {
    expect(rank(unlocksCountRankingFixture.records)[0]?.priority_class).toBe("urgent-risk");
    expect(rank(classRankingFixture.records)[0]?.priority_class).toBe("urgent-risk");
  });

  it("is pure: it returns a new array and leaves the input untouched", () => {
    const input = [...classRankingFixture.records];
    const inputIds = input.map((record) => record.id);

    const ranked = rank(input);

    expect(ranked).not.toBe(input);
    expect(input.map((record) => record.id)).toEqual(inputIds);
  });

  it("is stable for records with identical ranking keys", () => {
    const first = makeAttentionRecord({ id: "tie", priority_class: "unblocks-work", kind: "first" });
    const second = makeAttentionRecord({ id: "tie", priority_class: "unblocks-work", kind: "second" });

    expect(rank([first, second]).map((record) => record.kind)).toEqual(["first", "second"]);
    expect(rank([second, first]).map((record) => record.kind)).toEqual(["second", "first"]);
  });

  it("ignores every field outside the ranking keys", () => {
    const noisy = classRankingFixture.records.map((record, index) =>
      makeAttentionRecord({
        ...record,
        kind: `kind-${classRankingFixture.records.length - index}`,
        question: `question ${index}`,
        status: index % 2 === 0 ? "open" : "resolved",
        refreshed_at: `2026-09-0${(index % 8) + 1}T23:00:00Z`,
        source_generation: 100 - index,
        target: `https://github.com/shakacode/agent-coordination/pull/${index + 1}`
      })
    );

    expect(rank(noisy).map((record) => record.id)).toEqual(classRankingFixture.expectedIds);
  });

  it("treats an absent unlocks_count as zero without changing the branch", () => {
    const withCount = makeAttentionRecord({ id: "with", priority_class: "product-architecture", unlocks_count: 1 });
    const without = makeAttentionRecord({ id: "without", priority_class: "unblocks-work" });

    expect(rank([without, withCount]).map((record) => record.id)).toEqual(["with", "without"]);
  });

  it("sorts records with an unparseable created_at last and deterministically", () => {
    const broken = makeAttentionRecord({ id: "broken", priority_class: "unblocks-work", created_at: "not-a-date" });
    const alsoBroken = makeAttentionRecord({ id: "also", priority_class: "unblocks-work", created_at: "also-broken" });
    const valid = makeAttentionRecord({ id: "valid", priority_class: "unblocks-work", created_at: "2026-09-03T09:00:00Z" });

    expect(rank([broken, alsoBroken, valid]).map((record) => record.id)).toEqual(["valid", "also", "broken"]);
  });

  it("returns an empty array unchanged", () => {
    expect(rank([])).toEqual([]);
  });
});
