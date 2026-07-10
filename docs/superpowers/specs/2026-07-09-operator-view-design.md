# Operator View Design

## Goal

Implement the first #9 dashboard slice as a read-only Operator View. The
Operator tab should answer three operator questions without forcing the default
Overview landing view to become a dense ledger:

- What is running?
- What is stuck?
- Where is PR, issue, branch, or thread handle X?

## Decisions

- API mode is the primary live multi-machine mode.
- Filesystem mode remains a supported fallback/local-inspection mode, not only a
  test seam.
- #9 does not add Worker/API writes, batch registration, launch controls, or new
  coordination mutation from the dashboard.
- Overview remains the default landing view for large coordination roots.
- Operator View is the dense drill-down tab and opens automatically for operator
  query/deep-link parameters.

## Operator Rows

Rows are target-first. When a repo target exists, the row key is `repo + target`
so PR/issue lookup is direct. Rows are enriched with batch, lane, agent, machine,
operator, host, thread handle, branch, PR URL, phase/status, liveness, and health
signals.

If a batch lane has no target yet, or only batch-level telemetry exists, use
`batch_id + lane_name` as the fallback row identity.

## Operator States

Rows derive an operator-facing state:

- `running`: live heartbeat and recent phase/event activity.
- `wedged`: live heartbeat but no phase/event transition for 15 minutes.
- `paused`: token/context limit or intentional continuation pause.
- `blocked`: worker explicitly reports blocked or needs input.
- `stale`: heartbeat expired but not dead.
- `dead`: heartbeat dead/missing while claim or lane appears active.
- `ready`: open target has no current coordination signal.
- `done`: merged, closed, released, or completed terminal signal.
- `unknown`: degraded/missing data prevents a confident classification.

## Search And Deep Links

Search is client-side over loaded Operator rows. It matches target numbers,
`#123`, `PR #123`, `issue #123`, partial branch, thread handle, agent id,
machine, operator, host, and PR URLs. Number collisions show all matching rows,
sorted active/stuck first and then by saved target repository order. Search does
not fetch more data or widen repository scope.

Deep links use query params on the existing route:

- `?batch=<batch_id>&lane=<lane_name>`
- `?target=<target>&repo=<owner/repo>`
- `?q=<search>`

No-match links show a visible no-match state.

## UI Shape

Add an Operator tab to the existing dashboard views. It should be a dense,
work-focused table with compact badges and `UNKNOWN` in missing cells. Missing
thread handle, operator, host, or PR URL is warning-worthy only for active rows.

Keep controls familiar and restrained: search input, status badges, copy/open
links, and compact row styling. Do not add marketing copy or a landing page.

## Docs

Update:

- `CONTEXT.md` with domain terms.
- `README.md` for API-primary and filesystem fallback language.
- `docs/coordination-architecture.md` so Overview is the default landing view
  and Operator View is the dense drill-down.
- `docs/coordination-telemetry-contract.md` with the identity fields that make
  Operator View useful.

No ADR is needed; the decision is a reversible product-scope clarification.

## Validation

Run:

- `npm test`
- `npm run typecheck`
- `npm run build`
