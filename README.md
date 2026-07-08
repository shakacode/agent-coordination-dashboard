# Agents Coordination Dashboard

Local dashboard for agent coordination state, coordinator triage, machine/lane
visibility, batch prompt planning, batch audit, and QA validation tracking.

## License

This local/protocol dashboard is part of the Agent Coordination MIT License
protocol plane while it remains a local operator view over coordination state.
Future hosted or monetized ShakaStack product-plane dashboards can use a
separate repository and license boundary while consuming the same protocol API.

## Run

```bash
npm install
AGENT_COORD_STATE_ROOT="$HOME/.local/state/agent-coordination" \
npm run dev
```

Open <http://localhost:4317>.

The default `~/.local/state/agent-coordination` path is a safe local sandbox.
If it has not been populated yet, the dashboard shows a setup notice rather
than coordination data. To inspect an existing coordination run, point
`AGENT_COORD_STATE_ROOT` at the data root that already contains `claims/`,
`heartbeats/`, and `batches/`:

```bash
AGENT_COORD_STATE_ROOT="$HOME/Documents/agent-coordination/agent-coordination-pr2" \
npm run dev
```

The server binds to `127.0.0.1` by default because it exposes private local
coordination metadata. Set `HOST=0.0.0.0` only when you intentionally want to
make it reachable from another machine on the network, and set `ALLOWED_HOSTS`
to the exact hostnames or IP addresses you will use in the browser.
Changing target repositories through the UI remains loopback-only.

To read from the HTTP coordination backend instead of the local filesystem
state root, set the same API variables used by `agent-coord`:

```bash
AGENT_COORD_API_URL="https://coord.example.test" \
AGENT_COORD_TOKEN="..." \
npm run dev
```

In API mode the dashboard reads `claims`, `heartbeats`, and `batches` from the
Worker state API and keeps file mode as the fallback when `AGENT_COORD_API_URL`
is unset. Remote dashboard responses label the source as `coordination-api`
instead of echoing the configured backend URL. API mode is read-only in this
slice; batch import and stop-request writes remain local recovery tools for
filesystem mode.

## What It Shows

- **Overview**: needs-attention queue, active/recoverable work, batch repairs,
  QA validation gaps, ready work, and high-level counts.
- **Work**: open GitHub issues and pull requests joined to coordination state,
  grouped as recovery, active, and ready-to-batch queues.
- **Batches**: saved batch plans, inferred batches from `batch_id` claims/heartbeats,
  lanes, dependencies, liveness, blocked-on refs, coordination prompt status, and
  recent history events, stop-request status, audit counts, and QA counts.
- **Machines**: machines, agents, heartbeats, claims, liveness, warnings, and current work.
- **Health**: missing machine IDs, missing heartbeats, missing batch plans,
  missing coordination prompts, prompt/target drift, missing history, and other
  coordination data gaps.
- **Prompt drawer**: copyable `$pr-batch` prompt for checked work items.

Work items show three scheduling states:

- **In process**: an active claim has a live or stale heartbeat.
- **Started, not processing**: a claim or heartbeat exists, but no live/stale
  holder is currently processing the item.
- **Ready for batch**: the item is open in GitHub and has no active scheduling
  signal.

The dashboard does not launch Codex agents, edit code, merge PRs, resolve
reviews, or mutate claims or heartbeats. Coordination-state writes are limited
to explicit loopback-only actions:

- Save an imported batch plan to `batches/<batch-id>.json`.
- Append a `batch.stop_requested` event to `events/batches/<batch-id>.jsonl`.

A stop request is a coordination/audit signal so a batch can be restarted
cleanly; it does not kill processes or release claims by itself.

## Configuration

| Variable | Default |
| --- | --- |
| `PORT` | `4317` |
| `HOST` | `127.0.0.1` |
| `ALLOWED_HOSTS` | `localhost,127.0.0.1,::1` plus non-wildcard `HOST` |
| `AGENT_COORD_STATE_ROOT` | `~/.local/state/agent-coordination` |
| `AGENT_COORD_API_URL` | unset; when set, read coordination state from the HTTP backend |
| `AGENT_COORD_TOKEN` | bearer token for `AGENT_COORD_API_URL` |
| `TARGET_REPOS` | empty first-run fallback |
| `DASHBOARD_SETTINGS_PATH` | `~/.local/state/agents-coordination-dashboard/settings.json` |

Target repositories are edited in the dashboard and persisted across restarts.
`TARGET_REPOS` accepts a comma-separated list only as the first-run fallback
when no settings file exists yet.

GitHub enrichment uses the local `gh` CLI. If `gh` is unavailable or
unauthenticated, local coordination state still renders.

The coordination root is data only. This repo owns the dashboard code; the
coordination data root owns runtime records such as `claims/`, `heartbeats/`,
`batches/`, `events/`, and `history/`.

Local coordination records are scoped to the saved target repositories; records
outside those repos are skipped with count-based warnings.

When no saved `batches/<batch-id>.json` batch plan exists, the dashboard infers
batch cards from scoped claims and heartbeats that include `batch_id`. Inferred
batches are labeled and produce Health warnings because they do not replace a
saved batch plan.

Saved batch plans include the batch id, repository scope, objective, targets,
lanes, reservations, creation metadata, and optional coordination prompt text so
planned batches stay visible before workers write their own telemetry. They are
stored as JSON under `batches/<batch-id>.json`.

The Batches view can import a planned `$pr-batch` run by pasting the coordination
prompt, reviewing the parsed batch plan, and explicitly saving it to
`batches/<batch-id>.json` under the configured coordination root. This write is
accepted only from the machine running the dashboard and does not launch agents
or touch claims, heartbeats, events, or history.

Batch history is read from optional `events/**/*.json`, `events/**/*.jsonl`,
`history/**/*.json`, and `history/**/*.jsonl` files. See
[`docs/coordination-telemetry-contract.md`](docs/coordination-telemetry-contract.md)
for the fields batches should write so the dashboard can show machine ownership,
token-limit pauses, continues, stop requests, QA validation, and reliable
history.

For a system-level map of where coordination data lives, how often it is
updated, how PRs join to claims/heartbeats/batches/machines, and how to view
the diagrams full-size, see
[`docs/coordination-architecture.md`](docs/coordination-architecture.md).

## Data And Tooling Boundary

The coordination root should trend toward data-only: `claims/`, `heartbeats/`,
`batches/`, `events/`, `history/`, and small state metadata. Executable helper
scripts such as `agent-coord` should live in a tool repository, not copied into
every coordination-state root. Keeping scripts in a tool repo and data in the
coordination root makes dashboard scoping, backup, and audit behavior clearer.

The current filesystem JSON/JSONL store is still the simplest fit for local,
append-friendly coordination state. If coordination grows into multi-user
queries, richer retention policies, or stronger transactional semantics, the
next store to evaluate is an embedded append/audit database such as SQLite.
Until then, JSON manifests plus JSONL events keep the state inspectable and easy
for workers to write safely.

## Scripts

```bash
npm test
npm run typecheck
npm run build
npm run dev
```

The npm scripts call package entrypoints through `node` directly for consistent
local execution.
