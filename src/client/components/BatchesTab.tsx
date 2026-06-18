import type { BatchRecord } from "../../shared/types";
import { StatusBadge } from "./StatusBadge";

export function BatchesTab({ batches }: { batches: BatchRecord[] }) {
  if (batches.length === 0) {
    return <p className="empty-state">No batch files found.</p>;
  }

  return (
    <section className="panel-grid">
      {batches.map((batch) => (
        <article className="panel" key={`${batch.repo || batch.path}:${batch.batchId}`}>
          <h2>{batch.batchId}</h2>
          <p className="batch-scope">{batch.repo || batch.path}</p>
          {batch.lanes.map((lane) => (
            <div className="lane-row" key={lane.name}>
              <div>
                <strong>{lane.name}</strong>
                <p>{lane.targets.join(", ") || "No targets"}</p>
              </div>
              <StatusBadge value={lane.status} />
              <StatusBadge value={lane.liveness} />
              <span>{lane.blockedOn.length ? `Blocked on ${lane.blockedOn.join(", ")}` : "Unblocked"}</span>
            </div>
          ))}
        </article>
      ))}
    </section>
  );
}
