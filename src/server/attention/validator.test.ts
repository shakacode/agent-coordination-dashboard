import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ATTENTION_RECORD_SCHEMA_PATH,
  validateAttentionRecord,
  type AttentionRecordValidationError
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
