import { Activity } from "lucide-react";
import type { HealthItem } from "../../shared/types";
import { groupHealthItems } from "../signalGroups";
import { SignalGroupList } from "./SignalGroups";
import { StatusBadge } from "./StatusBadge";

function HealthRow({ item }: { item: HealthItem }) {
  return (
    <article className="health-row">
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
  );
}

export function HealthTab({ items }: { items: HealthItem[] }) {
  if (items.length === 0) {
    return <p className="empty-state">No coordination health issues found.</p>;
  }

  return (
    <section className="health-list">
      <SignalGroupList
        ariaLabel="Coordination health grouped by type"
        groups={groupHealthItems(items)}
        renderItem={(item) => <HealthRow item={item} />}
      />
    </section>
  );
}
