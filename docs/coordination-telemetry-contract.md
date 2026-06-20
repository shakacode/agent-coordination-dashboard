# Coordination Telemetry Contract

The dashboard is read-only. Agents and batch runners remain responsible for
writing coordination records that make their work observable.

## Required Identity Fields

Every claim, heartbeat, and batch event should include:

- `agent_id`: stable worker/session id.
- `machine_id`: short machine label, such as `m1` or `m5`.
- `batch_id`: stable batch id when the work belongs to a batch.
- `repo`: `owner/repo`.
- `target`: issue number, PR number, or other repo-scoped target id.
- `status`: current phase, such as `queued`, `in_progress`, `blocked`,
  `token_limit_pause`, `continued`, `ready`, or `done`.
- `updated_at`: ISO-8601 timestamp for claims and heartbeats.
- `expires_at`: ISO-8601 timestamp for heartbeats and active claims.

Use `AGENT_COORD_MACHINE_ID=m1` or `AGENT_COORD_MACHINE_ID=m5` in batch launch
environments so every worker writes the same machine label consistently.

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
  "machine_id": "m5",
  "repo": "shakacode/react_on_rails",
  "target": "4010",
  "status": "in_progress",
  "timestamp": "2026-06-19T20:00:00Z",
  "message": "Resumed after token-limit pause."
}
```

Recommended event types:

- `batch.created`
- `lane.started`
- `heartbeat`
- `token_limit_pause`
- `continued`
- `blocked`
- `ready`
- `done`

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
heartbeats, batch lanes have no heartbeat, or batch files have no history
events. Treat those as telemetry bugs in the batch runner or worker prompt, not
as proof the dashboard failed to read the coordination state.
