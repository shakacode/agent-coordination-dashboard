# Agent Instructions

This repository is a local dashboard for agent coordination state. Keep the
dashboard read-only for coordination state unless the user explicitly asks for a
write feature.

## Commands

```bash
npm install
npm test
npm run typecheck
npm run build
AGENT_COORD_STATE_ROOT="$HOME/.local/state/agent-coordination" \
npm run dev
```

The dev server listens on <http://127.0.0.1:4317> by default. Keep that local
default unless the user explicitly asks to expose the dashboard on the network.
When using `HOST=0.0.0.0`, also require a specific `ALLOWED_HOSTS` value for the
browser hostnames or IP addresses. Settings, imports, and stop requests must
remain writable only from the machine running the dashboard so remote viewers
stay read-only.

## Product Boundary

- Show machines, claims, heartbeats, open issues, open pull requests, batches,
  history, health warnings, and copyable `$pr-batch` prompts.
- Do not launch Codex agents from this app.
- Do not edit code, merge PRs, resolve reviews, or mutate coordination records
  from this app.
- Use `UNKNOWN` or visible warnings when GitHub or local state cannot be read.
- Scope displayed coordination records to the saved target repository settings;
  do not expose unrelated repo state from a shared coordination root.

## Implementation Notes

- npm scripts call package entrypoints through `node` directly. Keep this for
  consistent local execution.
- Target repositories are persisted in
  `~/.local/state/agents-coordination-dashboard/settings.json`.
  `TARGET_REPOS` is only a first-run fallback when settings have not been saved.
- Coordination history is read from optional `events` and `history` directories;
  prefer JSONL append-only event files for batch telemetry.
- If saved batch plans are missing, the dashboard infers batch cards from scoped
  claim/heartbeat `batch_id` fields and marks them with Health warnings.
- Scheduling states are:
  - `in_process`: active claim with live or stale heartbeat.
  - `started_not_processing`: claim or heartbeat exists but no live/stale holder.
  - `ready_for_batch`: open GitHub item with no current coordination signal.
