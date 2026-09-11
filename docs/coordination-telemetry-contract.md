# Human Attention Record Contract

The dashboard consumes Human Attention records. It never writes, refreshes,
resolves, or deletes them.

## Source Scope

Records are read only from the saved `workspace` and target repositories. The
dashboard uses the coordination API when configured and the local state root
otherwise. A source response is reported as `ok`, `empty`, or a visible
degraded state; the dashboard does not repair source data.

## Record Requirements

The vendored attention schema defines the required record shape. Core fields
include:

- `schema_version`, `workspace`, `id`, and `repository`
- `target`, `status`, `kind`, `question`, and `choices`
- `priority_class`, `priority_reason`, and `safe_resume`
- `source`, `source_generation`, `created_at`, and `refreshed_at`

A resolved record also has `resolved_at`. Producers must preserve the schema's
generation and resolution rules. The dashboard only projects schema-valid
records.

## Rendering Contract

The UI reads a fixed allowlist of record fields. It validates a card's target
URL, optional walkthrough URL, and optional provider-native open URI before
rendering a link. Other input is displayed as bounded text and never treated as
instructions.

## Diagnostics

The reader emits diagnostics for invalid JSON, oversized or unreadable files,
schema failures, repository or workspace mismatches, and partial reads. A
diagnostic names the configured repository, workspace, read mode, and a
relative source path. It never exposes an absolute filesystem path.

See [Human Attention Architecture](coordination-architecture.md) for the
read path and operational boundary.
