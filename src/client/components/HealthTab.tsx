import { Activity } from "lucide-react";
import type { HealthItem } from "../../shared/types";
import { StatusBadge } from "./StatusBadge";

export function HealthTab({ items }: { items: HealthItem[] }) {
  if (items.length === 0) {
    return <p className="empty-state">No coordination health issues found.</p>;
  }

  return (
    <section className="health-list">
      {items.map((item) => (
        <article className="health-row" key={item.id}>
          <Activity size={18} aria-hidden="true" />
          <div className="health-main">
            <h2>{item.title}</h2>
            <p>{item.detail}</p>
          </div>
          <StatusBadge value={item.severity} />
          <div className="health-meta">
            <span>{item.machineId || "UNKNOWN machine"}</span>
            <span>{item.agentId || item.batchId || item.repo || item.category}</span>
            {item.target ? <span>#{item.target}</span> : null}
          </div>
        </article>
      ))}
    </section>
  );
}
