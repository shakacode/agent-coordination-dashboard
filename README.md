# Agent Coordination Dashboard

Local dashboard service for Human Attention records: a detached lifecycle CLI,
machine-local settings boundary, target repository scope, and component
diagnostics over the coordination backend.

[![ShakaCode Agent Workflows — Run AI coding agents in fleets, safely](https://agents.shakacode.com/og.png)](https://agents.shakacode.com)

**[Documentation →](https://agents.shakacode.com)**

The browser page renders a read-only Human Attention view over scoped
agent-coordination attention records. It shows items that need a person, source
status, and diagnostics when a source cannot be read.

## License

This local/protocol dashboard is part of the Agent Coordination MIT License
protocol plane while it remains a local Human Attention view over coordination
state.
Future hosted or monetized ShakaStack product-plane dashboards can use a
separate repository and license boundary while consuming the same protocol API.

## Run

The dashboard requires Node.js 22.12.0 or newer. This repository uses Node 24
for development, but the public package floor follows the runtime requirements
of its current toolchain.

```bash
npm install
AGENT_COORD_STATE_ROOT="$HOME/.local/state/agent-coordination" \
npm run dev
```

Open <http://localhost:4319>.

The future npm package name is `agent-coordination-dashboard`. After that
package is published, normal invocation will start the dashboard server:

```bash
npx agent-coordination-dashboard
```

To try the packaged command before publication, build a local tarball and
install it in a disposable directory:

```bash
npm pack
npm install /path/to/agent-coordination-dashboard-0.1.0.tgz
npx agent-coordination-dashboard
```

This repository is package-ready only: these steps do not publish to npm,
create a Git tag, or change registry state.

## Detached lifecycle commands

The packaged CLI can manage a detached local dashboard on supported macOS and
Linux hosts without tmux, private dotfiles, or an interactive shell:

```bash
npx agent-coordination-dashboard start
npx agent-coordination-dashboard status
npx agent-coordination-dashboard logs
npx agent-coordination-dashboard open
npx agent-coordination-dashboard restart
npx agent-coordination-dashboard stop
```

Each `start` or `restart` reloads the optional protected environment file at
`~/.config/agent-coordination-dashboard/env`. When the file exists, it must be
a regular file owned by the current user with mode `0600`:

```bash
mkdir -p ~/.config/agent-coordination-dashboard
touch ~/.config/agent-coordination-dashboard/env
chmod 600 ~/.config/agent-coordination-dashboard/env
```

Use `--config-env-file <path>` on `start` or `restart` to load another protected
file. The lifecycle CLI deliberately does not call this flag `--env-file`:
current Node.js runtimes reserve that option and may consume it before the
dashboard CLI can validate it.

The child process receives explicit empty values for the coordination API URL
and token variables before values from the protected file are applied. Removing
API settings from the file and restarting therefore returns the dashboard to
filesystem mode instead of inheriting stale credentials. Lifecycle children
always run with `NODE_ENV=production`. Tokens are passed only in the child
environment; they are not stored in lifecycle metadata or command arguments.
Lifecycle metadata and logs live under
`~/.local/state/agent-coordination-dashboard/` with user-only permissions.

Lifecycle `HOST` must be `localhost` or an IPv4 or IPv6 address, including the
`0.0.0.0` and `::` wildcard addresses. A `restart` validates the protected file,
`PORT`, and `HOST` before stopping the running dashboard, so invalid replacement
configuration leaves the existing service intact.
Wildcard `HOST` values require an `ALLOWED_HOSTS` list containing only specific
hostnames or IP addresses; blank and catch-all entries are rejected.

`start`, `stop`, and `restart` are idempotent. The CLI records an instance marker
and verifies the owned process group before signaling it, so a listener it does
not own is reported but never terminated. If the lifecycle wrapper exits while
its marked server remains healthy, status and stop retain safe control of that
group. Mutating lifecycle commands share a
user-only lock, so simultaneous starts cannot race into an unowned listener; a
lock left by a dead command is recovered without signaling that command's
process. Startup probes the configured bind host, including IPv6 loopback, and
waits for `/api/health`; lifecycle status then reuses
`doctor --stack-json --deep` to report coordination health. A healthy server
with degraded coordination remains running and is reported as degraded rather
than being mistaken for a failed start. For a specific IP address assigned to
the local machine, lifecycle diagnostics connect from a loopback source address;
the dashboard's machine-local `/api/doctor` boundary remains unchanged.

Settings writes recognize a same-machine peer from the kernel-reported TCP
source address, not from forwarded headers. Exact non-link-local interface
matching is not application authentication: it cannot compensate for a host or
network that permits source-address spoofing, or for a proxy that makes remote
clients appear local. Keep `HOST` on loopback on shared or untrusted networks.
If a non-loopback bind is required, use host firewall or equivalent access
controls so untrusted traffic cannot reach the dashboard. `/api/doctor` remains
loopback-only.

## Component diagnostics

The installed command owns a read-only machine contract for stack-wide health
aggregation:

```bash
npx agent-coordination-dashboard doctor --stack-json
npx agent-coordination-dashboard doctor --stack-json --deep
npx agent-coordination-dashboard doctor --stack-json --deep \
  --url http://127.0.0.1:4319
```

The default URL is `http://127.0.0.1:4319`. An override must be plain HTTP at
the root of the exact `localhost`, `127.0.0.1`, or `[::1]` host, with no
credentials, query, fragment, or endpoint path. Invalid usage exits `64` before
probing. Requests never follow redirects, share a roughly 10-second total
deadline, and accept at most 256 KiB per response.

`--stack-json` emits schema version `1` with the component id
`agent-coordination-dashboard` and the stable checks `dashboard.package`,
`dashboard.health`, and `dashboard.resources`. Default mode marks the resource
check `skipped`; `--deep` reads fresh `/api/doctor` evidence and exposes only
normalized states for the coordination backend's `claims`, `heartbeats`,
`batches`, and `events` resources. These are diagnostics, not the Human
Attention view's data model. Endpoint configuration, timestamps, unknown
fields, and secret-bearing values are not copied into the contract.

Statuses are `healthy`, `degraded`, and `failed`; individual checks may also be
`skipped`. The process exits `0`, `1`, or `2` to match the aggregate status. A
stopped optional dashboard is `degraded`, while a reachable service with a
malformed or redirected health response is `failed`. The command only observes
the installed package and running service; it does not start the dashboard or
change coordination state.

`/api/doctor` reports backend reachability per resource. In filesystem mode it
counts directory entries for each resource without reading or parsing records: a
populated directory is `ok`, an absent or empty one is `empty`, and an
unreadable one is `unreachable`. In API mode it issues one bounded authenticated
list request per resource: `200` is `ok`, `401` and `403` are `auth_error`, any
other status or a network failure is `unreachable`, and the configured token is
never echoed in the response.

It also reports the attention read scope as `attention`: the read `mode` and
`workspace`, one status per configured repository, and `settings`, which says
whether that scope came from the saved settings file (`saved`), from
`TARGET_REPOS` because no settings file exists yet (`first_run_default`), or
from nowhere because the settings file exists but could not be read
(`unreadable`). Deriving a per-repository status means actually reading, so this
section runs the attention reader and discards the records. The reader bounds
the work with a per-repository entry count and time budget, applied as it walks
the listing, and a per-file size cap. Those are processing limits rather than a
bound on the listing itself: the directory listing, or the API list response, is
materialized in full before they apply, so a very large coordination root still
costs memory here. It reports statuses only:
no record content, target, question, or diagnostic text appears in the report.

The default `~/.local/state/agent-coordination` path is a safe local sandbox.
To read Human Attention records and diagnose an existing coordination run, point
`AGENT_COORD_STATE_ROOT` at its data root:

```bash
AGENT_COORD_STATE_ROOT="$HOME/Documents/agent-coordination/agent-coordination-pr2" \
npm run dev
```

The server binds to `127.0.0.1` by default because it exposes private local
coordination metadata. Set `HOST=0.0.0.0` only when you intentionally want to
make it reachable from another machine on the network, and set `ALLOWED_HOSTS`
to the exact hostnames or IP addresses you will use in the browser.
Changing target repositories uses the same exact same-machine socket-peer
boundary described above; other network peers remain read-only.

To read from the HTTP coordination backend instead of the local filesystem
state root, set the same API variables used by `agent-coord`:

```bash
AGENT_COORD_API_URL="https://coord.example.test" \
AGENT_COORD_API_TOKEN="..." \
npm run dev
```

API mode keeps file mode as the fallback when `AGENT_COORD_API_URL` is unset.
`/api/doctor` reports the configured state root as-is and reports the API URL
with any embedded credentials, query string, and fragment stripped; an
unparseable URL is reported as `UNKNOWN`. The token is never echoed.

## Human attention

`GET /api/attention` answers the one payload the attention view renders: the
cards that need a person, the reporting `dashboard_host`, one source entry per
configured repository, and any diagnostics. It is read-only and served to any
allowed host.

A request builds the payload on demand behind a 60-second cache with an
in-flight guard, so concurrent requests share one read. An hourly server-side
sampler also reads through that cache, including while the dashboard is idle.
It appends aggregate counts to `attention-samples.jsonl` beside the settings
file for the Human Attention kill test. Each row's `ts` is the payload snapshot
time, which can precede the hourly write by the cache's age. Document loads and
loopback foreground GET refreshes count as visits; background polls do not.
Sampling failures produce a server warning without failing a page request.
An unreachable or unauthorized source, unreadable record, partial read, or
truncated diagnostic list skips the sample and retains the previous timestamp
and pending visit count until a readable snapshot is available.
The fixed eight-column sample rows belong to one normalized repository set.
`attention-samples.scope.json` records that set; repository order and letter
case do not change it. A scope change starts a new 336-sample assessment and a
new visit bucket. Before the next successful sample, the prior rows and their
scope metadata are preserved as uniquely named `attention-samples.*.archive`
files. A restart with the same scope continues its period; changed scope or
missing/malformed legacy metadata starts a fresh period without mixing old
history. Failed settings saves leave the period unchanged. Pending work from a
previous scope cannot consume visits collected for the new scope.

A successful `PUT /api/settings`
drops the cached payload immediately, so a scope change is never served from a
stale entry. `X-Dashboard-Refresh: foreground` bypasses an otherwise-valid cache
entry, and only from a loopback address; from anywhere else the header is
ignored. It is a bypass rather than a forced rebuild: a request arriving while a
build is already in flight joins that build, and a request arriving with no
fresh entry starts an ordinary build whether or not it carries the header.

A repository the reader cannot reach or parse is reported inside a `200`, with
its own source status and diagnostics, rather than as an error. That covers the
record and backend problems the reader represents. A failure before any
repository is read — most plainly a settings file that exists but cannot be
parsed — is a `500` carrying no detail at all.

Records name the machine they came from, and the dashboard recognizes the host
identifiers `M5` and `M1`. A record naming any other host is suppressed with a
diagnostic, so records produced on a third machine never become cards.

A dashboard whose own `AGENT_COORD_MACHINE_ID` is unset or unrecognized is a
separate case, and a milder one: every card is still returned. What it loses is
the ability to say which cards are answerable where it is running, so the
payload reports `dashboard_host: "UNKNOWN"`, marks every card `host_matches:
false`, and adds a `dashboard_host_unknown` diagnostic, plus `cross_host_count`
when at least one card renders.

## Configuration

| Variable | Default |
| --- | --- |
| `PORT` | `4319` (avoids the conventional OTLP ports `4317` and `4318`) |
| `HOST` | `127.0.0.1` |
| `ALLOWED_HOSTS` | `localhost,127.0.0.1,::1` plus non-wildcard `HOST` |
| `AGENT_COORD_STATE_ROOT` | `~/.local/state/agent-coordination` |
| `AGENT_COORD_API_URL` | unset; when set, probe the HTTP backend instead of the state root |
| `AGENT_COORD_API_TOKEN` | bearer token for `AGENT_COORD_API_URL` |
| `AGENT_COORD_TOKEN` | fallback bearer token when `AGENT_COORD_API_TOKEN` is unset |
| `AGENT_COORD_MACHINE_ID` | unset; the machine this dashboard runs on (`M5` or `M1`), reported as `dashboard_host`; unset means no card can be marked answerable here |
| `TARGET_REPOS` | empty first-run fallback |
| `DASHBOARD_SETTINGS_PATH` | `~/.local/state/agents-coordination-dashboard/settings.json` |

The protected lifecycle environment file rejects `NODE_OPTIONS`, and detached
lifecycle children do not inherit it from the launching shell. Lifecycle-managed
dashboards do not support Node runtime options through `NODE_OPTIONS`, keeping
restart behavior independent of the caller's working directory.

Target repositories are persisted across restarts in the settings file.
`TARGET_REPOS` accepts a comma-separated list only as the first-run fallback
when no settings file exists yet.

The coordination root is data only. This repo owns the dashboard code; the
coordination data root owns runtime records. The Human Attention view renders
only scoped attention records. Its doctor diagnostics can separately report the
availability of coordination resources such as `claims/`, `heartbeats/`,
`batches/`, `events/`, and `history/`.

## Data And Tooling Boundary

The coordination root should trend toward data-only: attention records,
`claims/`, `heartbeats/`, `batches/`, `events/`, `history/`, and small state
metadata. Executable helper scripts such as `agent-coord` should live in a tool
repository, not copied into every coordination-state root. The dashboard reads
only scoped attention records for its view; it uses the other resources only for
coordination diagnostics. Keeping scripts in a tool repo and data in the
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
npm run demo
```

The npm scripts call package entrypoints through `node` directly for consistent
local execution.

`npm run demo` starts a disposable local dashboard over an empty temporary
coordination state root, so the Human Attention view has no records and
`/api/doctor` reports every coordination resource as `empty`. The installed equivalent is:

```bash
npx agent-coordination-dashboard --demo
```

Demo mode removes coordination API credentials from the child environment,
binds to loopback, writes its settings file inside the temporary root, and
deletes that root when it stops.
