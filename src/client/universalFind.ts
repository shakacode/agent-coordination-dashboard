import { canonicalGithubItemUrl } from "./githubUrls";
import { canonicalHostName, targetLabel, type BatchCard, type CoordinationView, type MachineCard } from "./coordinationView";
import { filterOperatorRows, type OperatorRow } from "./operatorRows";
import type { WorkItem } from "../shared/types";

export type FindResult =
  | {
      id: string;
      kind: "job";
      label: string;
      context: string;
      repo: string;
      machine?: string;
      host?: string;
      threadHandle?: string;
      row: OperatorRow;
      workItem?: WorkItem;
    }
  | {
      id: string;
      kind: "batch";
      label: string;
      context: string;
      repo: string;
      machine?: string;
      host?: string;
      threadHandle?: string;
      card: BatchCard;
    }
  | {
      id: string;
      kind: "machine";
      label: string;
      context: string;
      repo: string;
      machine: string;
      host?: string;
      threadHandle?: string;
      card: MachineCard;
    };

function normalized(value: string | undefined): string {
  return (value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function includesQuery(values: Array<string | undefined>, query: string): boolean {
  const haystack = normalized(values.filter(Boolean).join(" "));
  return haystack.includes(query);
}

function batchMatches(card: BatchCard, query: string): boolean {
  return includesQuery([
    card.id,
    card.title,
    card.repo,
    card.objective,
    card.host,
    card.machine,
    ...card.lanes.flatMap((lane) => [
      lane.tag,
      lane.target,
      lane.title,
      lane.state,
      lane.owner,
      lane.machine,
      lane.host,
      lane.threadHandle,
      lane.branchName,
      lane.prUrl,
      lane.targetUrl
    ])
  ], query);
}

function machineMatches(card: MachineCard, query: string): boolean {
  return includesQuery([
    card.id,
    card.label,
    card.user,
    ...card.hosts.flatMap((host) => [
      host.name,
      canonicalHostName(host.name),
      ...host.agents.flatMap((agent) => [
        agent.id,
        agent.work,
        agent.machine,
        agent.host,
        agent.target,
        agent.batchId,
        agent.threadHandle,
        agent.operator
      ])
    ])
  ], query);
}

function jobExactValues(result: Extract<FindResult, { kind: "job" }>): Array<string | undefined> {
  const custodyPrUrl = canonicalGithubItemUrl(result.row.prUrl);
  return [
    result.row.target,
    result.row.threadHandle,
    result.row.branch,
    result.row.agentId,
    result.row.machineId,
    result.row.repo,
    canonicalGithubItemUrl(result.row.url),
    result.row.implementationPr?.target,
    canonicalGithubItemUrl(result.row.implementationPr?.url),
    custodyPrUrl?.match(/\/pull\/(\d+)$/)?.[1],
    custodyPrUrl
  ];
}

function exactValues(result: FindResult): Array<string | undefined> {
  return result.kind === "job"
    ? jobExactValues(result)
    : result.kind === "batch"
      ? [result.card.id, result.card.title, result.card.repo]
      : [result.card.id, result.card.label];
}

function resultScore(result: FindResult, query: string): number {
  if (exactValues(result).some((value) => normalized(value) === query)) return 0;
  return result.kind === "job" ? 1 : result.kind === "batch" ? 2 : 3;
}

export function exactJobFindResult(results: FindResult[], rawQuery: string): Extract<FindResult, { kind: "job" }> | undefined {
  const query = normalized(canonicalGithubItemUrl(rawQuery) || rawQuery);
  const matches = results.filter((result): result is Extract<FindResult, { kind: "job" }> =>
    result.kind === "job"
    && jobExactValues(result).some((value) => normalized(value) === query)
  );
  return matches.length === 1 ? matches[0] : undefined;
}

export function exactFindResult(results: FindResult[], rawQuery: string): FindResult | undefined {
  const query = normalized(canonicalGithubItemUrl(rawQuery) || rawQuery);
  for (const kind of ["job", "batch", "machine"] as const) {
    const matches = results.filter((result) =>
      result.kind === kind
      && exactValues(result).some((value) => normalized(value) === query)
    );
    if (matches.length === 1) return matches[0];
  }
  return undefined;
}

export function buildFindResults(view: CoordinationView, rawQuery: string): FindResult[] {
  const query = normalized(canonicalGithubItemUrl(rawQuery) || rawQuery);
  if (!query) return [];

  const rowById = new Map(view.jobRows.map((job) => [job.row.id, job]));
  const matchingJobs = new Map(
    filterOperatorRows(view.jobRows.map((job) => job.row), rawQuery)
      .map((row) => [row.id, { row, workItem: rowById.get(row.id)?.workItem }] as const)
  );
  for (const card of view.batchCards) {
    for (const lane of card.lanes) {
      if (!lane.row || !includesQuery([
        lane.tag,
        lane.target,
        lane.title,
        lane.owner,
        lane.machine,
        lane.host,
        lane.threadHandle,
        lane.branchName
      ], query)) continue;
      matchingJobs.set(lane.row.id, { row: lane.row, workItem: lane.workItem });
    }
  }
  const jobs: FindResult[] = Array.from(matchingJobs.values())
    .flatMap(({ row, workItem }) => {
      const job = rowById.get(row.id);
      return [{
        id: `job:${row.id}`,
        kind: "job" as const,
        label: targetLabel(row),
        context: row.title,
        repo: row.repo,
        machine: row.machineId,
        host: canonicalHostName(row.host),
        threadHandle: row.threadHandle,
        row,
        workItem: workItem || job?.workItem
      }];
    });
  const batches: FindResult[] = view.batchCards
    .filter((card) => batchMatches(card, query))
    .map((card) => ({
      id: `batch:${card.identity}`,
      kind: "batch" as const,
      label: card.title,
      context: `batch ${card.id}`,
      repo: card.repo,
      machine: card.machine || card.lanes.find((lane) => lane.machine)?.machine,
      host: canonicalHostName(card.host),
      card
    }));
  const machines: FindResult[] = view.machines
    .filter((card) => machineMatches(card, query))
    .map((card) => ({
      id: `machine:${card.id}`,
      kind: "machine" as const,
      label: `machine ${card.label}`,
      context: `${card.live} live · ${card.total} agents`,
      repo: "",
      machine: card.id,
      card
    }));

  return [...jobs, ...batches, ...machines]
    .sort((left, right) =>
      resultScore(left, query) - resultScore(right, query)
      || left.label.localeCompare(right.label)
      || left.id.localeCompare(right.id)
    );
}
