import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ATTENTION_RECORD_SCHEMA_PATH,
  TIMESTAMP_FIELD_POINTERS,
  validateAttentionRecord,
  type AttentionRecordValidationError,
  type AttentionRecordValidationResult
} from "./validator";

/**
 * SHA-256 of the vendored schema after the single reviewed edit (top-level
 * `additionalProperties: false` removed). Any further edit must be reviewed and this constant
 * updated deliberately; see SCHEMA_SOURCE.md.
 */
const VENDORED_SCHEMA_SHA256 = "a855a78232bc46db7d4c2cdfef70ca8352b7797ad93fd20c2fd5a667f5ec4185";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const VALID_FIXTURES_DIR = join(FIXTURES_DIR, "valid");
const INVALID_FIXTURES_DIR = join(FIXTURES_DIR, "invalid");

/**
 * Keyword each upstream invalid fixture must fail on. The upstream contract test
 * (test/attention_record_contract_test.rb) asserts only that these fixtures are rejected; the
 * reason is fixed by construction: the leap-second and overlong timestamps exercise the
 * `timestamp` pattern and maxLength, the status/resolved_at pairs exercise the `allOf` rule, and
 * the capability value exercises the `capability_state` enum.
 */
const EXPECTED_INVALID_KEYWORDS: Record<string, string> = {
  "attention-leap-second.json": "pattern",
  "attention-open-with-resolved-at.json": "not",
  "attention-overlong-timestamp.json": "maxLength",
  "attention-resolved-without-resolved-at.json": "required",
  "attention-unknown-capability-value.json": "enum"
};

function fixtureNames(directory: string): string[] {
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort();
}

function readFixture(directory: string, name: string): unknown {
  return JSON.parse(readFileSync(join(directory, name), "utf8"));
}

function keywords(errors: AttentionRecordValidationError[]): string[] {
  return errors.map((error) => error.keyword);
}

describe("vendored attention record schema", () => {
  // This pins raw bytes on purpose: a vendored file must not be reformatted without review, so a
  // formatting-only edit trips it too. Re-pin only via the Re-vendoring steps in SCHEMA_SOURCE.md.
  it("matches the reviewed SHA-256 so an unreviewed edit fails", () => {
    const digest = createHash("sha256").update(readFileSync(ATTENTION_RECORD_SCHEMA_PATH)).digest("hex");

    expect(digest).toBe(VENDORED_SCHEMA_SHA256);
  });

  it("vendors every upstream fixture", () => {
    expect(fixtureNames(VALID_FIXTURES_DIR)).toEqual(["attention-open.json", "attention-resolved.json"]);
    expect(fixtureNames(INVALID_FIXTURES_DIR)).toEqual(Object.keys(EXPECTED_INVALID_KEYWORDS).sort());
  });
});

describe("validateAttentionRecord", () => {
  it.each(fixtureNames(VALID_FIXTURES_DIR))("accepts the valid fixture %s", (name) => {
    const record = readFixture(VALID_FIXTURES_DIR, name);
    const result = validateAttentionRecord(record);

    expect(result).toEqual({ ok: true, record });
  });

  it.each(fixtureNames(INVALID_FIXTURES_DIR))("rejects the invalid fixture %s", (name) => {
    const result = validateAttentionRecord(readFixture(INVALID_FIXTURES_DIR, name));

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error(`expected ${name} to be rejected`);
    }
    expect(keywords(result.errors)).toContain(EXPECTED_INVALID_KEYWORDS[name]);
    for (const error of result.errors) {
      expect(JSON.parse(JSON.stringify(error))).toEqual(error);
    }
  });

  it("accepts a v1 record carrying additive optional fields", () => {
    const base = readFixture(VALID_FIXTURES_DIR, "attention-open.json") as Record<string, unknown>;
    const record = {
      ...base,
      what_changes: "The security gate now blocks the exact head",
      unlocks_count: 3,
      refresh_interval_seconds: 60
    };

    expect(validateAttentionRecord(record)).toEqual({ ok: true, record });
  });

  it("still enforces required fields, enums, and bounds on additive records", () => {
    const base = readFixture(VALID_FIXTURES_DIR, "attention-open.json") as Record<string, unknown>;
    const { priority_class: _priorityClass, ...withoutPriorityClass } = base;

    const missingRequired = validateAttentionRecord({ ...withoutPriorityClass, what_changes: "x" });
    expect(missingRequired.ok).toBe(false);
    if (!missingRequired.ok) {
      expect(keywords(missingRequired.errors)).toContain("required");
    }

    const badEnum = validateAttentionRecord({ ...base, status: "snoozed", what_changes: "x" });
    expect(badEnum.ok).toBe(false);
    if (!badEnum.ok) {
      expect(keywords(badEnum.errors)).toContain("enum");
    }

    const overlongChoices = validateAttentionRecord({
      ...base,
      choices: Array.from({ length: 11 }, () => "c")
    });
    expect(overlongChoices.ok).toBe(false);
    if (!overlongChoices.ok) {
      expect(keywords(overlongChoices.errors)).toContain("maxItems");
    }
  });

  it("rejects a non-object value", () => {
    const result = validateAttentionRecord("not a record");

    expect(result.ok).toBe(false);
  });
});

/**
 * Values that satisfy the schema's `timestamp` pattern (which only bounds digit shapes) but are not
 * real RFC 3339 instants. Ajv cannot catch them with `validateFormats: false`, so `validator.ts`
 * bounds the calendar, clock, and offset itself.
 */
const IMPOSSIBLE_TIMESTAMPS = [
  "2026-99-99T99:99:00+99:99",
  "2026-02-30T00:00:00Z",
  "2026-04-31T00:00:00Z",
  "2026-01-01T24:00:00Z",
  "2026-01-01T00:60:00Z",
  "2026-01-01T00:00:00+24:00",
  "2026-01-01T00:00:00+00:60",
  "2026-02-29T12:00:00Z"
];

function openFixture(): Record<string, unknown> {
  return readFixture(VALID_FIXTURES_DIR, "attention-open.json") as Record<string, unknown>;
}

function errorsOf(
  result: AttentionRecordValidationResult,
  label: string
): AttentionRecordValidationError[] {
  if (result.ok) {
    throw new Error(`expected ${label} to be rejected`);
  }
  return result.errors;
}

function expectFormatError(
  result: AttentionRecordValidationResult,
  pointer: string,
  label: string
): void {
  const errors = errorsOf(result, label);

  expect(errors).toHaveLength(1);
  expect(errors[0].instancePath).toBe(pointer);
  expect(errors[0].keyword).toBe("format");
  expect(errors[0].message).toContain("RFC 3339");
  expect(JSON.parse(JSON.stringify(errors[0]))).toEqual(errors[0]);
}

describe("RFC 3339 timestamp checking", () => {
  it("covers every timestamp field the schema defines", () => {
    expect([...TIMESTAMP_FIELD_POINTERS].sort()).toEqual([
      "/created_at",
      "/refreshed_at",
      "/resolved_at",
      "/source/last_seen_at"
    ]);
  });

  it.each(IMPOSSIBLE_TIMESTAMPS)("rejects the impossible created_at %s", (timestamp) => {
    expectFormatError(
      validateAttentionRecord({ ...openFixture(), created_at: timestamp }),
      "/created_at",
      timestamp
    );
  });

  it("rejects an impossible nested source.last_seen_at", () => {
    const base = openFixture();
    const source = {
      ...(base.source as Record<string, unknown>),
      last_seen_at: "2026-99-99T99:99:00+99:99"
    };

    expectFormatError(
      validateAttentionRecord({ ...base, source }),
      "/source/last_seen_at",
      "source.last_seen_at"
    );
  });

  it("rejects an impossible optional resolved_at", () => {
    const base = readFixture(VALID_FIXTURES_DIR, "attention-resolved.json") as Record<string, unknown>;

    expectFormatError(
      validateAttentionRecord({ ...base, resolved_at: "2026-04-31T00:00:00Z" }),
      "/resolved_at",
      "resolved_at"
    );
  });

  it("accepts 29 February in a leap year", () => {
    const record = { ...openFixture(), created_at: "2028-02-29T12:00:00Z" };

    expect(validateAttentionRecord(record)).toEqual({ ok: true, record });
  });

  it("accepts fractional seconds and a real negative offset", () => {
    const record = { ...openFixture(), created_at: "2026-01-01T00:00:00.123456-08:30" };

    expect(validateAttentionRecord(record)).toEqual({ ok: true, record });
  });
});
