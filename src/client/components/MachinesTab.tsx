import { Monitor } from "lucide-react";
import type { AgentSummary } from "../../shared/types";
import { StatusBadge } from "./StatusBadge";

export function MachinesTab({ agents }: { agents: AgentSummary[] }) {
  if (agents.length === 0) {
    return <p className="empty-state">No agents or heartbeats found.</p>;
  }

  return (
    <section className="panel-grid">
      {agents.map((agent) => (
        <article className="panel" key={agent.agentId}>
          <header className="panel-header">
            <Monitor size={18} aria-hidden="true" />
            <div>
              <h2>{agent.agentId}</h2>
              <StatusBadge value={agent.liveness} />
            </div>
          </header>
          <dl className="detail-list">
            <div>
              <dt>Claims</dt>
              <dd>{agent.claims.length}</dd>
            </div>
            <div>
              <dt>Current work</dt>
              <dd>{agent.currentWork.map((item) => `${item.repo}#${item.target}`).join(", ") || "None"}</dd>
            </div>
          </dl>
          {agent.warnings.map((warning) => (
            <p className="warning" key={warning.message}>
              {warning.message}
            </p>
          ))}
        </article>
      ))}
    </section>
  );
}

