# Operator View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only Operator View that answers what is running, what is stuck, and where a PR/issue/branch/thread is.

**Architecture:** Build Operator rows from the existing `DashboardModel` on the client so API mode and filesystem mode share one view. Keep Overview as the default landing view, add Operator as the dense drill-down, and keep dashboard writes unchanged.

**Tech Stack:** React, TypeScript, Vitest, Testing Library, Vite, Express.

---

### Task 1: Shared Operator Row Model

**Files:**
- Create: `src/client/operatorRows.ts`
- Test: `src/client/operatorRows.test.ts`

- [ ] Add `OperatorRow`, `OperatorState`, `buildOperatorRows`, and `filterOperatorRows`.
- [ ] Derive target-first rows from `workItems`.
- [ ] Add fallback rows for batch lanes with no matching target row.
- [ ] Classify `running`, `wedged`, `paused`, `blocked`, `stale`, `dead`, `ready`, `done`, and `unknown`.
- [ ] Search target numbers, GitHub shorthand, branch, thread handle, agent, machine, operator, host, and URL.
- [ ] Run `npm test -- src/client/operatorRows.test.ts`.

### Task 2: Operator View Component

**Files:**
- Create: `src/client/components/OperatorView.tsx`
- Test: `src/client/components/OperatorView.test.tsx`
- Modify: `src/client/styles.css`

- [ ] Render a dense table with state, work, owner, thread, batch, activity, branch/PR, and warnings columns.
- [ ] Use `UNKNOWN` for missing values.
- [ ] Render compact warning badges for active rows missing thread/owner/host/PR URL.
- [ ] Add a search field and visible no-match state.
- [ ] Run `npm test -- src/client/components/OperatorView.test.tsx`.

### Task 3: App Integration And Deep Links

**Files:**
- Modify: `src/client/App.tsx`
- Test: `src/client/App.test.tsx`

- [ ] Add Operator View as a tab and open it automatically for operator search/deep-link params.
- [ ] Parse `?q=`, `?batch=&lane=`, and `?target=&repo=` on load.
- [ ] Use query params to seed search/highlight state without fetching more data.
- [ ] Keep existing tab views and write actions unchanged.
- [ ] Run `npm test -- src/client/App.test.tsx`.

### Task 4: Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/coordination-architecture.md`
- Modify: `docs/coordination-telemetry-contract.md`

- [ ] Document API mode as the primary live mode and filesystem mode as fallback/local inspection.
- [ ] Document Overview as the default landing view and Operator View as the dense drill-down.
- [ ] Document useful telemetry fields: thread handle/name, host, operator, branch, PR URL, and phase/event timestamps.

### Task 5: Full Verification And PR

**Files:**
- All changed files

- [ ] Run `npm test`.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm run build`.
- [ ] Run `git diff --check`.
- [ ] Commit implementation.
- [ ] Push branch and open PR for #9.
- [ ] Poll checks/reviews; fix must-fix feedback; merge when gates pass.
