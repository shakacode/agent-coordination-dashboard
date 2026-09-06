import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020";
import type { AnySchemaObject, ErrorObject } from "ajv";

/**
 * Annotation keywords carried by the vendored upstream schema. They are contract metadata, not
 * validation keywords, so they are registered as a no-op vocabulary. That keeps Ajv strict mode on
 * for everything else instead of disabling it wholesale.
 */
const VENDOR_ANNOTATION_KEYWORDS = [
  "x-contract-version",
  "x-record-family",
  "x-logical-key",
  "x-storage-key"
];

/**
 * Absolute path of the vendored schema; see SCHEMA_SOURCE.md for the upstream pin.
 *
 * Resolved through `fileURLToPath` rather than `new URL(..., import.meta.url)` because Vite
 * rewrites that literal pattern into an asset URL, which `readFileSync` cannot open under vitest.
 */
export const ATTENTION_RECORD_SCHEMA_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "attention-record.schema.json"
);

/** One Ajv error, reduced to plain JSON-serializable fields. */
export interface AttentionRecordValidationError {
  instancePath: string;
  schemaPath: string;
  keyword: string;
  message: string;
  params: Record<string, unknown>;
}

export type AttentionRecordValidationResult =
  | { ok: true; record: unknown }
  | { ok: false; errors: AttentionRecordValidationError[] };

const schema = JSON.parse(readFileSync(ATTENTION_RECORD_SCHEMA_PATH, "utf8")) as AnySchemaObject;

// Compiled once at module load: compilation is the expensive step, validation is not.
const ajv = new Ajv2020({ validateFormats: false, allErrors: true });
ajv.addVocabulary(VENDOR_ANNOTATION_KEYWORDS);
const validate = ajv.compile(schema);

/** JSON pointer of the schema definition every timestamp-typed field `$ref`s. */
const TIMESTAMP_DEF_POINTER = "#/$defs/timestamp";

/** Subschema keywords that apply to the same instance location as their parent. */
const BRANCH_KEYWORDS = ["if", "then", "else", "not"] as const;
const BRANCH_LIST_KEYWORDS = ["allOf", "anyOf", "oneOf"] as const;

interface TimestampField {
  /** Ajv-style instance pointer, for example `/source/last_seen_at`. */
  pointer: string;
  /** The same location as property names, for reading the value out of a record. */
  path: string[];
}

function resolveLocalPointer(root: AnySchemaObject, pointer: string): unknown {
  return pointer
    .slice(2)
    .split("/")
    .reduce<unknown>((node, segment) => {
      if (node === null || typeof node !== "object") {
        return undefined;
      }
      return (node as Record<string, unknown>)[segment.replace(/~1/g, "/").replace(/~0/g, "~")];
    }, root);
}

/**
 * Walk the schema from its root and record the instance path of every field that resolves to
 * `$defs.timestamp`. Derived from the vendored schema rather than hardcoded, so a re-vendor that
 * adds or moves a timestamp field stays covered without editing this file.
 */
function collectTimestampPaths(root: AnySchemaObject): string[][] {
  const found: string[][] = [];

  const visit = (node: unknown, path: string[], seenRefs: ReadonlySet<string>): void => {
    if (node === null || typeof node !== "object" || Array.isArray(node)) {
      return;
    }
    const subschema = node as Record<string, unknown>;
    const ref = subschema.$ref;
    if (typeof ref === "string") {
      if (ref === TIMESTAMP_DEF_POINTER) {
        found.push(path);
      } else if (ref.startsWith("#/") && !seenRefs.has(ref)) {
        visit(resolveLocalPointer(root, ref), path, new Set([...seenRefs, ref]));
      }
      return;
    }
    const properties = subschema.properties;
    if (properties !== null && typeof properties === "object") {
      for (const [name, sub] of Object.entries(properties as Record<string, unknown>)) {
        visit(sub, [...path, name], seenRefs);
      }
    }
    for (const keyword of BRANCH_KEYWORDS) {
      visit(subschema[keyword], path, seenRefs);
    }
    for (const keyword of BRANCH_LIST_KEYWORDS) {
      const branches = subschema[keyword];
      if (Array.isArray(branches)) {
        for (const branch of branches) {
          visit(branch, path, seenRefs);
        }
      }
    }
  };

  visit(root, [], new Set());
  return found;
}

/** Every `$defs.timestamp` reference anywhere in the schema document, walked or not. */
function countTimestampRefs(node: unknown): number {
  if (Array.isArray(node)) {
    return node.reduce<number>((total, item) => total + countTimestampRefs(item), 0);
  }
  if (node === null || typeof node !== "object") {
    return 0;
  }
  return Object.entries(node as Record<string, unknown>).reduce<number>(
    (total, [key, value]) =>
      total + (key === "$ref" && value === TIMESTAMP_DEF_POINTER ? 1 : countTimestampRefs(value)),
    0
  );
}

const collectedTimestampPaths = collectTimestampPaths(schema);

if (collectedTimestampPaths.length !== countTimestampRefs(schema)) {
  throw new Error(
    "vendored schema references $defs.timestamp from a location collectTimestampPaths does not " +
      "walk; extend it so the RFC 3339 check still covers every timestamp (see SCHEMA_SOURCE.md)"
  );
}

const TIMESTAMP_FIELDS: TimestampField[] = collectedTimestampPaths
  .map((path) => ({ pointer: `/${path.join("/")}`, path }))
  .filter(
    (field, index, fields) => fields.findIndex((other) => other.pointer === field.pointer) === index
  );

/** Instance pointers the RFC 3339 check covers; exported so the test can assert the derived set. */
export const TIMESTAMP_FIELD_POINTERS: readonly string[] = TIMESTAMP_FIELDS.map(
  (field) => field.pointer
);

/** Capture groups mirror the schema's `timestamp` pattern; the offset groups are absent for `Z`. */
const RFC_3339_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:[.]\d+)?(?:[Zz]|[+-](\d{2}):(\d{2}))$/;

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function daysInMonth(year: number, month: number): number {
  const isLeapYear = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return month === 2 && isLeapYear ? 29 : DAYS_IN_MONTH[month - 1];
}

/**
 * True when the value is a real RFC 3339 instant.
 *
 * The schema's `date-time` annotation is inert under `validateFormats: false`, and its `pattern`
 * only bounds digit shapes, so `2026-99-99T99:99:00+99:99` satisfies it. This closes that gap by
 * bounding the calendar, the clock, and the offset. It deliberately does not use `Date.parse`,
 * which rolls `2026-02-30` forward into March instead of rejecting it.
 */
function isRfc3339Timestamp(value: string): boolean {
  const match = RFC_3339_PATTERN.exec(value);
  if (!match) {
    return false;
  }
  const [, year, month, day, hour, minute, second, offsetHour, offsetMinute] = match;
  if (Number(month) < 1 || Number(month) > 12) {
    return false;
  }
  if (Number(day) < 1 || Number(day) > daysInMonth(Number(year), Number(month))) {
    return false;
  }
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) {
    return false;
  }
  if (offsetHour === undefined) {
    return true;
  }
  return Number(offsetHour) <= 23 && Number(offsetMinute) <= 59;
}

function readAtPath(record: unknown, path: readonly string[]): unknown {
  return path.reduce<unknown>((node, segment) => {
    if (node === null || typeof node !== "object") {
      return undefined;
    }
    return (node as Record<string, unknown>)[segment];
  }, record);
}

/** One error per malformed timestamp, shaped like Ajv's so consumers see a single error surface. */
function timestampErrors(record: unknown): AttentionRecordValidationError[] {
  const errors: AttentionRecordValidationError[] = [];
  for (const field of TIMESTAMP_FIELDS) {
    const value = readAtPath(record, field.path);
    if (typeof value !== "string" || isRfc3339Timestamp(value)) {
      continue;
    }
    errors.push({
      instancePath: field.pointer,
      schemaPath: `${TIMESTAMP_DEF_POINTER}/format`,
      keyword: "format",
      message: 'must match format "date-time" (RFC 3339 calendar, clock, and offset bounds)',
      params: { format: "date-time" }
    });
  }
  return errors;
}

function toSerializableError(error: ErrorObject): AttentionRecordValidationError {
  return {
    instancePath: error.instancePath,
    schemaPath: error.schemaPath,
    keyword: error.keyword,
    message: error.message ?? "",
    params: { ...error.params }
  };
}

/**
 * Validate one parsed attention record against the vendored v1 schema.
 *
 * Unknown optional top-level fields are admitted on purpose (see SCHEMA_SOURCE.md); required
 * fields, enums, bounds, and the resolved-at rule are still enforced. Records that clear Ajv then
 * face the explicit RFC 3339 check, because Ajv's format checks are off.
 */
export function validateAttentionRecord(value: unknown): AttentionRecordValidationResult {
  if (!validate(value)) {
    return { ok: false, errors: (validate.errors ?? []).map(toSerializableError) };
  }
  const errors = timestampErrors(value);
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, record: value };
}
