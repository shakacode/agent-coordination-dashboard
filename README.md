# Agents Coordination Dashboard

Local dashboard for the `agent-coordination` state backend.

## Run

```bash
npm install
AGENT_COORD_STATE_ROOT=/Users/justin/Documents/agent-coordination/agent-coordination-pr2 \
TARGET_REPOS=shakacode/react_on_rails \
npm run dev
```

Open <http://localhost:4317>.

## What It Shows

- **Machines**: agents, heartbeats, claims, liveness, warnings, and current work.
- **Work**: open GitHub issues and pull requests joined to coordination state.
- **Batches**: lanes, dependencies, liveness, and blocked-on refs.
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
| `AGENT_COORD_STATE_ROOT` | `/Users/justin/Documents/agent-coordination/agent-coordination-pr2` |
| `TARGET_REPOS` | `shakacode/react_on_rails` |

`TARGET_REPOS` accepts a comma-separated list.

GitHub enrichment uses the local `gh` CLI. If `gh` is unavailable or
unauthenticated, local coordination state still renders.

## Scripts

```bash
npm test
npm run typecheck
npm run build
npm run dev
```

The npm scripts call package entrypoints through `node` directly to avoid local
shell shim issues.

