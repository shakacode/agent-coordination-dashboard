# Coordination Telemetry Contract

The dashboard is observability-first. Agents and batch runners remain
responsible for writing coordination records that make their work observable.

The exception is an explicit dashboard import action that saves a retained batch
manifest from a pasted launch prompt. That action only writes
`batches/<batch-id>.json` from loopback clients; it must not launch agents or
mutate claims, heartbeats, events, or history.

The second explicit dashboard write is a loopback-only batch stop request. It
appends `batch.stop_requested` to `events/batches/<batch-id>.jsonl`. It is an
audit/control signal only; it must not kill processes, release claims, edit
heartbeats, or spawn replacement workers.

For diagrams of the full data flow, join keys, update cadence, and state-root
layout, see [Coordination Architecture](coordination-architecture.md).

## Required Identity Fields

Every claim, heartbeat, and batch event should include:

- `agent_id`: stable worker/session id.
- `machine_id`: short machine label, such as `workstation-1` or `buildbox-a`.
- `thread_handle`: operator-facing Codex/Claude thread handle or session label.
- `host`: host app or runner surface, such as `codex` or `claude`. Do not use
  this as a machine label; use `machine_id` for machine identity.
- `operator`: human or service operator responsible for the thread.
- `batch_id`: stable batch id when the work belongs to a batch.
- `repo`: `owner/repo`.
- `target`: issue number, PR number, or other repo-scoped target id.
- `branch`: current feature branch when known.
- `pr_url`: pull request URL when known.
- `status`: current phase, such as `queued`, `in_progress`, `blocked`,
  `token_limit_pause`, `continued`, `ready`, or `done`.
- `updated_at`: ISO-8601 timestamp for claims and heartbeats.
- `expires_at`: ISO-8601 timestamp for heartbeats and active claims.

Use a stable `AGENT_COORD_MACHINE_ID` value in batch launch environments so
every worker writes the same machine label consistently.

Compatibility note: older local records may have used `host` for a machine
name. New telemetry should not do that. The dashboard treats `host` as the app
surface and requires `machine_id`, `machine`, or `hostname` for machine
identity; otherwise it reports the existing missing-machine health warning.

## Retained Batch Manifests

Coordinators should create a private retained manifest before spawning workers.
The manifest lives at `batches/<batch-id>.json` under `AGENT_COORD_STATE_ROOT`.
It gives the dashboard enough context to show a batch immediately, before
workers create claims, heartbeats, or history events.

Required fields:

- `schema_version`: `1`.
- `batch_id`: stable batch id copied from the launch prompt.
- `repo`: `owner/repo`.
- `objective`: short operator-facing batch goal.
- `targets`: PR/issue targets represented by the manifest.
- `lanes`: planned lane names, owners, targets, dependencies, and status.
- `created_at`: ISO-8601 timestamp.
- `created_by_machine`: machine id that created the manifest.
- `launch_prompt`: exact original `$pr-batch` launch prompt.

Optional fields:

- `reservations`: deferred or reserved PR/issue targets that were mentioned in
  the prompt but are not active lane targets.

Example:

```json
{
  "schema_version": 1,
  "batch_id": "batch-shakacode-react-on-rails-p93s1v",
  "repo": "shakacode/react_on_rails",
  "objective": "Process selected ready pull requests.",
  "targets": [
    {
      "type": "pull_request",
      "target": "4005",
      "url": "https://github.com/shakacode/react_on_rails/pull/4005",
      "title": "Fix FOUC integration tests"
    },
    {
      "type": "issue",
      "target": "4010",
      "url": "https://github.com/shakacode/react_on_rails/issues/4010",
      "title": "Document flaky installer behavior"
    }
  ],
  "lanes": [
    {
      "name": "tests",
      "owner": "worker-a",
      "targets": ["4005"],
      "depends_on": [],
      "status": "queued",
      "thread_handle": "codex-thread-abc",
      "host": "codex",
      "operator": "justin",
      "branch": "jg-codex/fouc-tests",
      "pr_url": "https://github.com/shakacode/react_on_rails/pull/4005"
    },
    {
      "name": "docs",
      "owner": "worker-b",
      "targets": ["4010"],
      "depends_on": ["batch-shakacode-react-on-rails-p93s1v:tests"],
      "status": "queued",
      "thread_handle": "claude-thread-docs",
      "host": "claude",
      "operator": "justin"
    }
  ],
  "reservations": [
    {
      "type": "pull_request",
      "target": "3999",
      "reason": "Deferred for release owner review."
    }
  ],
  "created_at": "2026-06-20T10:00:00.000Z",
  "created_by_machine": "workstation-1",
  "launch_prompt": "Use $pr-batch to complete this batch with subagents.\n\nRepository: shakacode/react_on_rails\nBatch id: batch-shakacode-react-on-rails-p93s1v\nBatch objective: Process selected ready pull requests.\n..."
}
```

The launch prompt should include:

- `Batch id: <stable-id>`.
- A coordinator instruction to create the retained private batch manifest before
  spawning workers.
- A worker instruction to include the same `batch_id` in claims, heartbeats,
  events/history, and final handoff.

## History Events

Append batch history to either `events/*.jsonl` or `history/*.jsonl`. One JSON
object per line is easiest to write safely from multiple batch phases.

```json
{
  "event_id": "batch-20260619-a:lane-a:continued:2026-06-19T20:00:00Z",
  "type": "continued",
  "batch_id": "batch-20260619-a",
  "lane_name": "lane-a",
  "agent_id": "worker-a",
  "machine_id": "workstation-1",
  "thread_handle": "codex-thread-abc",
  "host": "codex",
  "operator": "justin",
  "repo": "owner/repo",
  "target": "4010",
  "branch": "jg-codex/4010-docs",
  "pr_url": "https://github.com/owner/repo/pull/4010",
  "status": "in_progress",
  "timestamp": "2026-06-19T20:00:00Z",
  "message": "Resumed after token-limit pause."
}
```

Recommended event types:

- `batch.created`
- `batch.stop_requested`
- `batch.stopped`
- `lane.started`
- `heartbeat`
- `token_limit_pause`
- `continued`
- `blocked`
- `ready`
- `done`
- `qa.validation_requested`
- `qa.validation_started`
- `qa.validation_passed`
- `qa.validation_failed`

## Batch Stop And Restart

When a coordinator decides a running batch should stop before restart, append a
stop-request event:

```json
{
  "schema_version": 1,
  "event_id": "batch-20260619-a:stop-requested:2026-06-19T20:05:00Z",
  "type": "batch.stop_requested",
  "batch_id": "batch-20260619-a",
  "repo": "owner/repo",
  "status": "stop_requested",
  "timestamp": "2026-06-19T20:05:00Z",
  "machine_id": "workstation-1",
  "thread_handle": "codex-thread-abc",
  "host": "codex",
  "operator": "justin",
  "message": "Restart with smaller lanes."
}
```

Workers that understand stop requests should finish their current safe
checkpoint, write a final heartbeat/event, and stop claiming new lane work for
that batch. Once stopped, append `batch.stopped`. Restarted work should use a
new batch id unless the coordinator intentionally continues the same batch and
records that decision in history.

## Separate QA Validation

QA validation is separate telemetry from GitHub review state and from worker
completion. For every PR that needs a separate validation pass, append a QA
event with the same `batch_id`, `repo`, and `target`:

```json
{
  "event_id": "batch-20260619-a:4010:qa-passed:2026-06-19T21:00:00Z",
  "type": "qa.validation_passed",
  "batch_id": "batch-20260619-a",
  "lane_name": "qa",
  "agent_id": "qa-worker-a",
  "machine_id": "workstation-1",
  "thread_handle": "qa-thread-a",
  "host": "codex",
  "operator": "qa",
  "repo": "owner/repo",
  "target": "4010",
  "branch": "jg-codex/4010-docs",
  "pr_url": "https://github.com/owner/repo/pull/4010",
  "status": "passed",
  "timestamp": "2026-06-19T21:00:00Z",
  "message": "Validated install, smoke tests, and documented manual checks."
}
```

Use `qa.validation_failed` with a message containing blockers when validation
does not pass. The dashboard treats a PR as missing separate QA until a QA or
validation event exists for that repo/target.

## Token Limit Recovery

When a worker hits a token/time limit:

- Write a heartbeat with `status: "token_limit_pause"` before stopping, if
  possible.
- Append a `token_limit_pause` event with the latest known repo, target, lane,
  machine, branch, tests, blockers, and next action.
- On continuation, read the existing batch file and history first.
- Append a `continued` event and resume the same `batch_id`, `lane_name`,
  `agent_id`, and `machine_id` unless intentionally reassigned.
- Heartbeat again immediately after continuation, then at each phase transition.

## Dashboard Health Signals

The Health tab warns when records omit `machine_id`, active claims lack matching
heartbeats, claims or heartbeats mention a missing batch manifest, retained
manifests omit `launch_prompt`, launch prompt targets drift from manifest
targets, batch lanes have no heartbeat, or batch files have no history events.
Treat those as telemetry bugs in the batch runner or worker prompt, not as proof
the dashboard failed to read the coordination state.

The Overview also tracks separate QA validation status for PRs. A PR with no
matching QA/validation event is shown as missing QA, while the latest QA event
sets the displayed status to requested, in progress, passed, failed, or unknown.
