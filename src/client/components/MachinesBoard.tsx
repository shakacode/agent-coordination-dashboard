import { Monitor } from "lucide-react";
import type { AgentCard, MachineCard } from "../coordinationView";
import { StatusBadge } from "./StatusBadge";

function AgentTile({ agent }: { agent: AgentCard }) {
  return (
    <div className="agent-card">
      <div className="agent-card-head">
        <span className="agent-id">{agent.id}</span>
        <StatusBadge value={agent.state} />
      </div>
      <div className="agent-work">{agent.work}</div>
      <div className="agent-beat">{agent.beat}</div>
    </div>
  );
}

export function MachinesBoard({ machines }: { machines: MachineCard[] }) {
  if (machines.length === 0) {
    return <p className="empty-state">No agents or heartbeats found.</p>;
  }

  return (
    <section aria-label="Machines" className="machines">
      <p className="board-intro">
        Grouped by machine. Each machine runs both Codex and Claude; live and stale agents are named, the long tail of dead agents is collapsed to a count.
      </p>
      {machines.map((machine) => (
        <article className="machine-card" key={machine.id}>
          <header className="machine-head">
            <span className="machine-name">
              <Monitor size={15} aria-hidden="true" />
              machine {machine.label}
            </span>
            <span className="tag tag-outline">owner {machine.user}</span>
            <span className="machine-summary">
              <span style={{ color: "var(--ok)" }}>{machine.live} live</span> · {machine.total} agents · {machine.dead} dead
            </span>
          </header>
          <div className="machine-body">
            {machine.hosts.map((host) => (
              <div key={host.name}>
                <div className="machine-host-head">
                  <span className="machine-host-name" style={{ color: host.color }}>
                    <span className="host-dot" style={{ background: host.color }} />
                    {host.name}
                  </span>
                  <span className="machine-host-summary">
                    <span style={{ color: host.color }}>{host.live} live</span> · {host.total} · {host.dead} dead
                  </span>
                </div>
                <div className="agent-cards">
                  {host.agents.map((agent) => (
                    <AgentTile agent={agent} key={agent.id} />
                  ))}
                  {host.dead > 0 && (
                    <div className="agent-dead-tile">＋ {host.dead} dead · no heartbeat</div>
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
