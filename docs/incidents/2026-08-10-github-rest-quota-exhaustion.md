# GitHub REST quota exhaustion — 2026-08-10

- Severity: SEV3
- Status: mitigated in the dashboard runtime; follow-up tracked in
  [issue #109](https://github.com/shakacode/agent-coordination-dashboard/issues/109)
- Affected surface: local dashboard GitHub enrichment and other authenticated
  GitHub workflows sharing the same credential
- Customer data impact: none observed

## Summary

A dashboard connected to the coordination API refreshed every five seconds.
GitHub target records were cached for only 60 seconds, so hundreds of entries
expired together and were reconciled with one authenticated REST request per
target. Approximately 438 synchronized requests per minute could exhaust a
5,000-request core quota in about 11.5 minutes.

The failure affected more than the dashboard. Once the shared credential's REST
quota reached zero, safety preflights and merge workflows could no longer read
required GitHub evidence. `gh auth status` could look like an authentication
failure even though the credential itself had not been revoked.

## Runtime guardrails

The dashboard now separates its local/coordination refresh from GitHub
enrichment:

- coordination API polling remains five seconds by default;
- GitHub results use a separate 15-minute default cadence;
- background, concurrent-client, and foreground refreshes share cached and
  in-flight GitHub work;
- every uncached GitHub cycle uses a process-wide governor with a default
  1,000-request hourly budget and 50-request per-refresh ceiling;
- a representative authenticated `GET /user` probe reads
  `X-RateLimit-Used`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset`;
- GitHub work pauses at or below 500 remaining requests, at zero, when the
  dashboard budget is spent, or when representative quota telemetry is
  unreadable;
- rate-limit pauses are cached until the observed reset time, with a bounded
  fallback cooldown when GitHub does not provide one;
- blocked or failed GitHub reads remain `UNKNOWN`, while coordination state
  continues to refresh.

The guard is deliberately process-local. Other applications using the same
credential are reflected by the representative GitHub headers, but their calls
are not counted by the dashboard's internal hourly counter. Restarting the
dashboard resets its internal counter; it does not reset GitHub's quota. The
remaining-quota safety threshold is therefore the final shared-credential
backstop.

## Detection

The dashboard API exposes a `githubStatus` object on `/api/dashboard` with:

- `state`: `available`, `degraded`, or `paused`;
- `reason`: the active guard or read-failure reason;
- `caller`, `targetCount`, and attempted/executed/blocked request totals;
- remaining hourly dashboard budget;
- observed GitHub used/remaining/reset values when available;
- a pause deadline and operator-facing message when applicable.

The UI displays a full-width GitHub enrichment banner whenever the state is not
`available`. This banner is distinct from coordination-backend degradation: it
explicitly says that coordination data continues to refresh.

For direct confirmation, make one authenticated representative request and
inspect its response headers:

```bash
gh api --include user
```

Treat headers from this representative request as primary evidence. During the
incident, `GET /rate_limit` reported a fresh budget while representative REST
endpoints for the same credential returned 403 with zero remaining.

## Immediate containment

1. Set `GITHUB_REFRESH_MS=0` and restart the dashboard. This disables only
   GitHub enrichment; coordination polling can stay active.
2. If guaranteed containment is required, stop the dashboard server.
3. Avoid repeated GitHub-backed safety or merge commands until the reset time.
4. Preserve the visible `UNKNOWN` state. Do not substitute unauthenticated,
   GraphQL, or cached results for a workflow that requires authenticated REST
   evidence.

`DASHBOARD_REFRESH_MS=0` disables browser polling entirely and is still
available, but it is no longer necessary merely to contain GitHub usage.

## Recovery

1. Read the reset time and remaining count from a representative request or the
   dashboard's `githubStatus` payload.
2. Wait until the reset time. The running dashboard clears the cooldown on the
   next eligible refresh; a restart is not required.
3. Confirm a representative request returns success with a safe remaining
   balance.
4. Restore `GITHUB_REFRESH_MS` to a conservative value (the default is 900000)
   if it was set to zero.
5. Refresh the dashboard once and verify the GitHub banner clears, previously
   unknown fields reconcile, and coordination timestamps continued advancing.
6. Rerun any GitHub-dependent safety or merge workflow from its normal preflight
   rather than resuming from stale evidence.

If representative requests still fail after reset, diagnose authentication or
GitHub availability separately. Do not raise budgets or lower the safety
threshold as an authentication workaround.

## Regression coverage

Automated tests cover a 500-target reconciliation ceiling, shared concurrent
quota probes, hourly and per-refresh budgets, low- and zero-quota pauses,
reset-aware recovery, missing-header fail-closed behavior, disabled enrichment,
continued coordination refresh during cooldown, foreground cache policy, and
the user-visible degradation banner.
