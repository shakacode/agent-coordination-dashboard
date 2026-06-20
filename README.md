# Agents Coordination Dashboard

Local dashboard for the `agent-coordination` state backend.

## Run

```bash
npm install
AGENT_COORD_STATE_ROOT=/Users/justin/Documents/agent-coordination/agent-coordination-pr2 \
npm run dev
```

Open <http://localhost:4317>.

The server binds to `127.0.0.1` by default because it exposes private local
coordination metadata. Set `HOST=0.0.0.0` only when you intentionally want to
make it reachable from another machine on the network, and set `ALLOWED_HOSTS`
to the exact hostnames or IP addresses you will use in the browser.
Changing target repositories through the UI remains loopback-only.

## What It Shows

- **Machines**: machines, agents, heartbeats, claims, liveness, warnings, and current work.
- **Work**: open GitHub issues and pull requests joined to coordination state.
- **Batches**: manifest batches, inferred batches from `batch_id` claims/heartbeats,
  lanes, dependencies, liveness, blocked-on refs, and recent history events.
- **Health**: missing machine IDs, missing heartbeats, missing history, and other coordination data gaps.
- **Prompt drawer**: copyable `$pr-batch` prompt for checked work items.

Work items show three scheduling states:

- **In process**: an active claim has a live or stale heartbeat.
- **Started, not processing**: a claim or heartbeat exists, but no live/stale
  holder is currently processing the item.
- **Ready for batch**: the item is open in GitHub and has no active scheduling
  signal.

The dashboard does not launch Codex agents or edit coordination state.

## Configuration

| Variable | Default |
| --- | --- |
| `PORT` | `4317` |
| `HOST` | `127.0.0.1` |
| `ALLOWED_HOSTS` | `localhost,127.0.0.1,::1` plus non-wildcard `HOST` |
| `AGENT_COORD_STATE_ROOT` | `/Users/justin/Documents/agent-coordination/agent-coordination-pr2` |
| `TARGET_REPOS` | `shakacode/react_on_rails` first-run fallback |
| `DASHBOARD_SETTINGS_PATH` | `~/.local/state/agents-coordination-dashboard/settings.json` |

Target repositories are edited in the dashboard and persisted across restarts.
`TARGET_REPOS` accepts a comma-separated list only as the first-run fallback
when no settings file exists yet.

GitHub enrichment uses the local `gh` CLI. If `gh` is unavailable or
unauthenticated, local coordination state still renders.

Local coordination records are scoped to the saved target repositories; records
outside those repos are skipped with count-based warnings.

When no retained `batches/<batch-id>.json` manifest exists, the dashboard infers
batch cards from scoped claims and heartbeats that include `batch_id`. Inferred
batches are labeled and produce Health warnings because they do not replace real
manifests.

Batch history is read from optional `events/**/*.json`, `events/**/*.jsonl`,
`history/**/*.json`, and `history/**/*.jsonl` files. See
[`docs/coordination-telemetry-contract.md`](docs/coordination-telemetry-contract.md)
for the fields batches should write so the dashboard can show machine ownership,
token-limit pauses, continues, and reliable history.

## Scripts

```bash
npm test
npm run typecheck
npm run build
npm run dev
```

The npm scripts call package entrypoints through `node` directly to avoid local
shell shim issues.
