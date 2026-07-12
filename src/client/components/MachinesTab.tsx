import { Monitor } from "lucide-react";
import type { AgentSummary, CoordinationResource } from "../../shared/types";
import { StatusBadge } from "./StatusBadge";

export function MachinesTab({
  agents,
  unavailableSources = []
}: {
  agents: AgentSummary[];
  unavailableSources?: CoordinationResource[];
}) {
  if (agents.length === 0) {
    if (unavailableSources.length > 0) {
      return <p className="empty-state">Coordination agent data unavailable: {unavailableSources.join(", ")} could not be read.</p>;
    }
    return <p className="empty-state">No agents or heartbeats found.</p>;
  }

  const agentsByMachine = agents.reduce<Map<string, { label: string; agents: AgentSummary[] }>>((groups, agent) => {
    const state = agent.machineMetadata?.state || (agent.machineId ? "observed" : agent.heartbeat ? "missing" : "not_applicable");
    const label = agent.machineId || (state === "not_applicable" ? "Not applicable" : "UNKNOWN machine");
    const key = `${state}:${label}`;
    const group = groups.get(key) || { label, agents: [] };
    groups.set(key, { ...group, agents: [...group.agents, agent] });
    return groups;
  }, new Map());

  return (
    <>
      {unavailableSources.length > 0 && (
        <p className="warning">Coordination agent data may be incomplete: {unavailableSources.join(", ")} could not be read.</p>
      )}
      <section className="machine-groups">
        {Array.from(agentsByMachine.entries()).map(([machineKey, group]) => (
          <section className="machine-group" key={machineKey}>
          <header className="machine-heading">
            <Monitor size={18} aria-hidden="true" />
            <h2>{group.label}</h2>
            <span>{group.agents.length} agents</span>
          </header>
          <div className="panel-grid">
            {group.agents.map((agent) => (
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
                    <dt>Machine</dt>
                    <dd>
                      <span>{agent.machineId || (agent.machineMetadata?.state === "not_applicable" ? "Not applicable" : "UNKNOWN")}</span>
                      {agent.machineMetadata && (
                        <small className="metadata-provenance-inline">
                          {agent.machineMetadata.state.replace("_", " ")}
                          {agent.machineMetadata.source ? ` from ${agent.machineMetadata.source.replace("_", " ")}` : ""}
                        </small>
                      )}
                    </dd>
                  </div>
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
          </div>
          </section>
        ))}
      </section>
    </>
  );
}
