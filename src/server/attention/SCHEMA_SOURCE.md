# Vendored attention record schema

## Source

| Field | Value |
| --- | --- |
| Source repository | [shakacode/agent-coordination](https://github.com/shakacode/agent-coordination) |
| Source path | `schema/state/v1/attention/attention-record.schema.json` |
| Pinned commit | `52d391ff8f5686d66ca9bd865543907d8faee195` (the PR #293 merge commit on `main`) |
| Upstream SHA-256 | `06e086595751ae9fb35bdc307b84a1240c4ffa1e95cc01f1f87e1393d3fc11da` |
| Vendored SHA-256 | `a855a78232bc46db7d4c2cdfef70ca8352b7797ad93fd20c2fd5a667f5ec4185` |

Fetch the unedited upstream file with:

```sh
gh api -H 'Accept: application/vnd.github.raw' \
  'repos/shakacode/agent-coordination/contents/schema/state/v1/attention/attention-record.schema.json?ref=52d391ff8f5686d66ca9bd865543907d8faee195'
```

The seven fixtures under `fixtures/valid` and `fixtures/invalid` are vendored unedited from
`schema/state/v1/attention/fixtures/` at the same commit.

`validator.test.ts` asserts the vendored SHA-256 against a recorded constant, so an unreviewed edit
to the schema fails the test suite.

## The one edit

`additionalProperties: false` is removed from the top-level `$defs.attention_record` object only.
Nested objects (`$defs.source` and `$defs.source.properties.capabilities`) keep theirs, so the
source block stays closed.

Nothing else is changed: required fields, enums, string and array bounds, the timestamp pattern and
`maxLength`, the repository storage grammar, the `source_generation` ceiling, and the
`status`/`resolved_at` rule all still apply exactly as upstream.

### Why

An unknown *optional* top-level field must never reject a record. Upstream
[shakacode/agent-coordination#301](https://github.com/shakacode/agent-coordination/issues/301) adds
further additive fields to the same v1 record; with the top-level object left open, those records
are admitted by this dashboard without a schema re-pin and without a release. A closed top-level
object would instead turn every upstream additive change into a hard rejection of live records.

## Validation

`validator.ts` compiles the schema once at module load with `Ajv2020`
(`import Ajv2020 from "ajv/dist/2020"`) and `validateFormats: false`. Ajv's core installs no format
validators, and under strict mode an uninstalled format is a compile error (`unknown format "uri"
ignored in schema at path "#/properties/open_uri"`), so the schema's two `format` annotations —
`date-time` on `$defs.timestamp` and `uri` on `source.open_uri` — are switched off rather than
strict mode.

Nothing is lost on the timestamp side: the `timestamp` `pattern` is stricter than the `date-time`
format check (it requires an explicit offset and excludes leap-second spellings) and `maxLength`
bounds the string.

URL validation is deliberately not this validator's job. `target` carries no `format` at all, `uri`
on `source.open_uri` is inert with format checks off, and `walkthrough_url` is one of
[shakacode/agent-coordination#301](https://github.com/shakacode/agent-coordination/issues/301)'s
additive optional fields that the open top-level object admits without a definition of its own — so
all three reach consumers as bounded but otherwise arbitrary strings. Turning Ajv's `uri` format on
would not close that gap either, since `javascript:alert(1)` is a well-formed URI. Those fields are
validated one layer up, at the model/render layer, by the shared validators
(`validateAttentionTarget`, `validateWalkthroughUrl`, `validateOpenUri`) that
[shakacode/agent-coordination-dashboard#125](https://github.com/shakacode/agent-coordination-dashboard/issues/125)
adds in `src/shared/attention.ts`, a sibling PR in this batch; that module does not exist at this
commit. A consumer of this validator must therefore treat these values as untrusted, never fetch
`source.open_uri` (the upstream description says so explicitly), and apply its own scheme allowlist
before rendering or opening any of them.

The schema's four `x-` annotation keywords (`x-contract-version`, `x-record-family`,
`x-logical-key`, `x-storage-key`) are contract metadata, not validation keywords. They are
registered with `ajv.addVocabulary` as no-ops so Ajv strict mode stays on for everything else,
rather than being switched off with `strict: false`.

`ajv` is pinned to an exact version (no caret) in `package.json` so the compiled behaviour of the
vendored schema cannot drift on an unrelated install.

## Re-vendoring

1. Pick the new upstream commit SHA and fetch the schema and all fixtures by that SHA.
2. Re-apply the single edit above.
3. Update the pinned commit, both hashes in this file, and `VENDORED_SCHEMA_SHA256` in
   `validator.test.ts`.
4. Run `npm test -- validator` and review the diff of the upstream file itself, not only the hash.
