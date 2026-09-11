# Dashboard Domain Context

## Human Attention View

The dashboard is a read-only Human Attention view. It shows the decisions that
need a person, the source status for each saved repository, and diagnostics
when a source cannot be read.

The view does not launch agents, edit code, merge pull requests, resolve
reviews, or change coordination records.

## Attention Records

An attention record identifies a repository and target, states the question or
decision needed, and includes safe resume context. The reader accepts records
only from the configured workspace and saved target repositories. It validates
the stored record before the UI projects it into an attention card.

Open records appear as cards. Resolved records remain part of the source audit
state and are not treated as open work.

## Sources And Diagnostics

The reader uses the coordination API when it is configured; otherwise it reads
the local coordination state root. Both modes are read-only. Each repository
reports a source status, and malformed, unreadable, oversized, or out-of-scope
records produce diagnostics instead of a dashboard write.

Missing or degraded data is visible as `UNKNOWN`. The dashboard never expands
the saved repository scope to fill a gap.

## Settings And Refresh

Saved settings define target repositories, the attention workspace, source
interval, and age thresholds. `TARGET_REPOS` is a first-run fallback only.

The server builds an attention payload on demand behind a bounded cache and an
in-flight guard. A loopback foreground refresh can bypass a fresh cache entry;
other viewers receive the current cached snapshot.

## Safe Links

Cards render only validated repository pull-request URLs, walkthrough URLs,
and provider-native open URIs. Record text and links are input data, not
instructions for the dashboard or its operators.
