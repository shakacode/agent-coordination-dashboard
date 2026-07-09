# Dashboard Domain Context

## Core Terms

### Observability-First Dashboard

The dashboard is an operator view over coordination state. Its primary job is
to answer what is running, what is stuck, and where a referenced PR, issue,
branch, or thread handle is.

It may show coordination records, GitHub work, health warnings, batch history,
machine/agent ownership, and copyable `$pr-batch` prompts. It must not launch
agents, edit code, merge pull requests, resolve reviews, or mutate claims and
heartbeats.

### API Read View

When `AGENT_COORD_API_URL` is configured, the dashboard reads coordination
state from the HTTP coordination backend. This mode is read-only for
coordination records. It may auto-refresh and display degraded/unknown state,
but it does not register batches, stop batches, launch workers, or write
coordination records through the Worker.

API mode is the primary operational mode for live multi-machine coordination.

### Local Recovery Write

A local recovery write is an explicit loopback-only dashboard action that
updates local filesystem state for operator recovery. The allowed local
recovery writes are saving an imported retained batch manifest and appending a
batch stop-request event. These actions remain local recovery tools, not API
mode writes.

### Filesystem Mode

Filesystem mode reads a local coordination state root. It is a supported
fallback and local inspection mode for tests, offline review, recovery, demos,
and older/local coordination roots. It is not the primary live multi-machine
rollout mode, but it remains generally useful and should continue to render the
same Operator View model where possible.

### Batch Registration

Batch registration is the creation of a retained batch record before workers
start so operators can see the planned batch before claims or heartbeats exist.
For the current dashboard scope, batch registration is owned by coordination
tooling or a future explicitly-scoped write milestone, not by the API read view.

### Operator View

The Operator View is the dashboard's canonical first screen for the API read
view. It is a dense, searchable table that answers three questions without
requiring tab navigation: what is running, what is stuck, and where is a
referenced PR, issue, branch, or thread handle.

Existing tabbed views may remain as secondary drill-down surfaces while the
Operator View proves the one-screen workflow. They are supporting views, not
the primary #9 acceptance surface.

### Operator Row

An Operator View row is target-first. When a repo target exists, the row is
keyed by `repo + target` so PR and issue lookup is direct. The row is enriched
with batch, lane, agent, machine, operator, host, thread handle, branch, PR URL,
phase, liveness, and health signals.

If a batch lane has no target yet, or only batch-level telemetry exists, the
fallback row identity is `batch_id + lane_name`.

### Operator State

Operator View rows use operator-facing states derived from coordination and
GitHub signals:

- `running`: live heartbeat and recent phase or event activity.
- `wedged`: live heartbeat but no phase or event transition for the configured
  threshold. The initial threshold is 15 minutes.
- `paused`: token or context limit pause, or another intentional continuation
  pause.
- `blocked`: worker explicitly reports blocked or needing input.
- `stale`: heartbeat expired but is not yet dead.
- `dead`: heartbeat is dead or missing while the claim or lane appears active.
- `ready`: open target has no current coordination signal.
- `done`: terminal merged, closed, released, or completed signal.
- `unknown`: degraded or missing data prevents confident classification.

### Operator Search

Operator Search is client-side search over the loaded Operator View rows. It
matches exact target numbers, GitHub shorthand such as `#123`, `PR #123`, and
`issue #123`, full or partial branches, thread handles, agent ids, machine ids,
operators, hosts, and PR URLs.

When a number matches multiple repositories or both issue and PR rows, the
Operator View shows all matching rows. Results sort active and stuck work first,
then follow the saved target repository order. Search must not fetch additional
data or widen target repository scope.

### Operator Metadata

The first Operator View should expose these metadata groups:

- State: operator state and liveness age.
- Work: repository, PR or issue number, title, and GitHub link.
- Owner: operator, host, and machine.
- Thread: thread handle and agent id.
- Batch: batch id, lane name, and dependency or blocked hint.
- Activity: phase/status and last heartbeat or event age.
- Branch/PR: branch and `pr_url` when present.
- Warnings: compact health or degraded-data badges.

Missing values render as `UNKNOWN`, never as empty cells. Missing
`thread_handle`, `operator`, `host`, or `pr_url` is a visible warning for active
or in-process rows. For completed, ready, or otherwise inactive rows, `UNKNOWN`
can be informational only.

`machine_id` identifies the machine. `host` identifies the app or runner
surface, such as `codex` or `claude`; parsers must not treat `host` as a
machine-id fallback.

### Operator Deep Link

Operator View deep links use query parameters on the existing dashboard route.
The canonical parameters are:

- `?batch=<batch_id>&lane=<lane_name>` to highlight or filter a lane row.
- `?target=<target>&repo=<owner/repo>` to highlight a target row.
- `?q=<search>` to populate Operator Search.

If a deep link does not match any loaded row, the dashboard shows a visible
no-match state. Deep links must not widen target repository scope or fetch
additional coordination data.
