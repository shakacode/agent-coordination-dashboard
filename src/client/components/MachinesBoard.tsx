import { useState } from "react";
import { Monitor } from "lucide-react";
import type { WorkItem } from "../../shared/types";
import type { AgentCard, MachineCard } from "../coordinationView";
import type { OperatorRow } from "../operatorRows";
import { StatusBadge } from "./StatusBadge";

export interface MachineFilter {
  host?: string;
  machine?: string;
}

export interface MachinesBoardProps {
  machines: MachineCard[];
  onOpenRow?: (row: OperatorRow, workItem?: WorkItem) => void;
  onOpenBatch?: (batchId: string, batchPath?: string, repo?: string) => void;
  onFilter?: (filter: MachineFilter) => void;
  onFind?: (query: string) => void;
}

function AgentTile({
  agent,
  onOpenRow,
  onOpenBatch,
  onFind
}: {
  agent: AgentCard;
  onOpenRow?: MachinesBoardProps["onOpenRow"];
  onOpenBatch?: MachinesBoardProps["onOpenBatch"];
  onFind?: MachinesBoardProps["onFind"];
}) {
  const [copied, setCopied] = useState(false);
  async function copyChat() {
    if (!agent.threadHandle || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(agent.threadHandle);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }
  const details = (
    <>
      <div className="agent-card-head">
        <span className="agent-id">{agent.id}</span>
        <StatusBadge value={agent.state} />
      </div>
      <div className="agent-work">{agent.work}</div>
      <dl className="agent-custody">
        <div><dt>machine</dt><dd>{agent.machine || "UNKNOWN"}</dd></div>
        <div><dt>host</dt><dd>{agent.host || "UNKNOWN"}</dd></div>
        <div><dt>thread</dt><dd>{agent.threadHandle || "UNKNOWN"}</dd></div>
      </dl>
      <div className="agent-beat">{agent.beat}</div>
    </>
  );

  return (
    <div className="agent-card">
      {agent.row && onOpenRow ? (
        <button
          aria-label={`Open ${agent.id} job`}
          className="agent-card-open"
          onClick={() => onOpenRow(agent.row!, agent.workItem)}
          type="button"
        >
          {details}
        </button>
      ) : (
        <div className="agent-card-static">{details}</div>
      )}
      {agent.batchId && onOpenBatch && (
        <button
          aria-label={`Open batch ${agent.batchId}`}
          className="agent-batch-link"
          onClick={() => onOpenBatch(agent.batchId!, agent.batchPath, agent.repo || agent.row?.repo)}
          type="button"
        >
          Batch {agent.batchId}
        </button>
      )}
      {agent.threadHandle && (
        <div className="agent-chat-actions">
          <button
            aria-label={`Copy chat ${agent.threadHandle}`}
            onClick={() => void copyChat()}
            type="button"
          >
            {copied ? "Copied" : "Copy chat"}
          </button>
          {onFind && (
            <button
              aria-label={`Find chat ${agent.threadHandle}`}
              onClick={() => onFind(agent.threadHandle!)}
              type="button"
            >
              Find chat
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function MachinesBoard({ machines, onOpenRow, onOpenBatch, onFilter, onFind }: MachinesBoardProps) {
  if (machines.length === 0) {
    return <p className="empty-state">No agents or heartbeats found.</p>;
  }

  return (
    <section aria-label="Machines" className="machines">
      <p className="board-intro">
        Grouped by machine and host family. Open a live or stale agent to inspect its job, or use a machine/host summary to filter the operator boards.
      </p>
      {machines.map((machine) => (
        <article className="machine-card" key={machine.id}>
          <header className="machine-head">
            {onFilter ? (
              <button
                aria-label={`Filter jobs to machine ${machine.label}`}
                className="machine-filter"
                onClick={() => onFilter({ machine: machine.id })}
                type="button"
              >
                <Monitor size={15} aria-hidden="true" />
                machine {machine.label}
              </button>
            ) : (
              <span className="machine-name">
                <Monitor size={15} aria-hidden="true" />
                machine {machine.label}
              </span>
            )}
            <span className="tag tag-outline">owner {machine.user}</span>
            <span className="machine-summary">
              <span style={{ color: "var(--ok)" }}>{machine.live} live</span> · {machine.total} agents · {machine.dead} dead
            </span>
          </header>
          <div className="machine-body">
            {machine.hosts.map((host) => (
              <div key={host.name}>
                <div className="machine-host-head">
                  {onFilter ? (
                    <button
                      aria-label={`Filter jobs to ${host.name} on ${machine.label}`}
                      className="machine-host-filter"
                      onClick={() => onFilter({ host: host.name, machine: machine.id })}
                      style={{ color: host.color }}
                      type="button"
                    >
                      <span className="host-dot" style={{ background: host.color }} />
                      {host.name}
                    </button>
                  ) : (
                    <span className="machine-host-name" style={{ color: host.color }}>
                      <span className="host-dot" style={{ background: host.color }} />
                      {host.name}
                    </span>
                  )}
                  <span className="machine-host-summary">
                    <span style={{ color: host.color }}>{host.live} live</span> · {host.total} · {host.dead} dead
                  </span>
                </div>
                <div className="agent-cards">
                  {host.agents.map((agent) => (
                    <AgentTile agent={agent} key={agent.id} onFind={onFind} onOpenBatch={onOpenBatch} onOpenRow={onOpenRow} />
                  ))}
                  {host.dead > 0 && (
                    <div
                      aria-label={`${host.dead} dead ${host.name} agents`}
                      className="agent-dead-tile"
                      role="note"
                    >
                      {host.dead} dead · no heartbeat
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </article>
      ))}
    </section>
  );
}
