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
 * fields, enums, bounds, and the resolved-at rule are still enforced.
 */
export function validateAttentionRecord(value: unknown): AttentionRecordValidationResult {
  if (validate(value)) {
    return { ok: true, record: value };
  }
  return { ok: false, errors: (validate.errors ?? []).map(toSerializableError) };
}
