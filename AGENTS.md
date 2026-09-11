# Agent Instructions

This repository is a local Human Attention dashboard. Keep the dashboard
read-only for coordination state unless the user explicitly asks for a write
feature.

## Commands

```bash
npm install
npm test
npm run typecheck
npm run build
AGENT_COORD_STATE_ROOT="$HOME/.local/state/agent-coordination" \
npm run dev
```

The dev server listens on <http://127.0.0.1:4319> by default. Keep that local
default unless the user explicitly asks to expose the dashboard on the network.
When using `HOST=0.0.0.0`, also require a specific `ALLOWED_HOSTS` value for the
browser hostnames or IP addresses. Settings remain writable only from the
machine running the dashboard so remote viewers stay read-only.

## Product Boundary

- Show read-only Human Attention records, source status, and diagnostics for
  the saved target repositories.
- Do not launch Codex agents from this app.
- Do not edit code, merge pull requests, resolve reviews, or mutate
  coordination records from this app.
- Use `UNKNOWN` or visible warnings when the attention source cannot be read.
- Scope displayed attention records to the saved target repository settings;
  do not expose unrelated repository state from a shared coordination root.

## Implementation Notes

- npm scripts call package entrypoints through `node` directly. Keep this for
  consistent local execution.
- Target repositories and attention-view settings are persisted in
  `~/.local/state/agents-coordination-dashboard/settings.json`.
- `TARGET_REPOS` is only a first-run fallback when settings have not been
  saved.
- The attention reader accepts records from the configured workspace and
  repositories, then reports per-source status and diagnostics without writing
  back to the coordination backend.

## Agent Workflow Configuration

Portable shared skills resolve this repo's commands and policy through:
- **Commands** — run `.agents/bin/<name>` (`setup`, `validate`, `test`, ...); see `.agents/bin/README.md`. A missing script means that capability is n/a here.
- **Policy / config** — `.agents/agent-workflow.yml`.

## Agent Coordination

- Agent workflows use the private `agent-coord` backend selected by
  `.agents/agent-workflow.yml`. From the agent runtime's available-skills
  catalog, select the `pr-batch` skill and set `PR_BATCH_SKILL_DIR` to the
  directory containing its `SKILL.md`, then run these bounded probes before
  coordinated mutations:

  ```bash
  "$PR_BATCH_SKILL_DIR/bin/agent-coord-bounded" --timeout 20 doctor --deep --json
  "$PR_BATCH_SKILL_DIR/bin/agent-coord-bounded" --timeout 20 status \
    --repo OWNER/REPO --target ISSUE_OR_PR_NUMBER --json
  "$PR_BATCH_SKILL_DIR/bin/agent-coord-bounded" --timeout 20 status \
    --batch-id BATCH_ID --json
  ```

  Register the batch and acquire the applicable claims only after these probes
  confirm the configured backend is healthy and the targets are unclaimed.
- Do not downgrade a run to `coordination_backend: n/a` while the configured
  backend is healthy. An unavailable or indeterminate backend is `UNKNOWN` and
  blocks coordinated mutations until it recovers.
- This workflow coordination is performed by external coordination tooling; it
  does not expand the dashboard runtime's read-only product boundary.
