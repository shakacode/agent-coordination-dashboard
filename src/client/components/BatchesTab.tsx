import type { BatchEvent, BatchRecord } from "../../shared/types";
import { StatusBadge } from "./StatusBadge";

function EventRows({ events }: { events: BatchEvent[] }) {
  return (
    <div className="event-list">
      {events.map((event) => (
        <div className="event-row" key={event.eventId}>
          <strong>{event.type}</strong>
          <span>{event.laneName || event.agentId || event.machineId || "batch"}</span>
          <span>{event.status || ""}</span>
          <span>{event.message || ""}</span>
          <time>{event.timestamp ? new Date(event.timestamp).toLocaleString() : event.path}</time>
        </div>
      ))}
    </div>
  );
}

export function BatchesTab({ batches, events }: { batches: BatchRecord[]; events: BatchEvent[] }) {
  if (batches.length === 0 && events.length === 0) {
    return <p className="empty-state">No batch files found.</p>;
  }

  const unattachedEvents = events.filter((event) => !event.batchPath).slice(0, 10);

  return (
    <section className="panel-grid">
      {batches.map((batch) => {
        const batchEvents = events
          .filter((event) =>
            event.batchPath
              ? event.batchPath === batch.path
              : event.batchId === batch.batchId && Boolean(event.repo && event.repo === batch.repo)
          )
          .slice(0, 5);
        return (
          <article className="panel" key={`${batch.repo || batch.path}:${batch.batchId}`}>
            <header className="batch-card-header">
              <h2>{batch.batchId}</h2>
              {batch.source === "inferred" ? <span className="source-badge">Inferred</span> : null}
            </header>
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
            {batchEvents.length > 0 && <EventRows events={batchEvents} />}
          </article>
        );
      })}
      {unattachedEvents.length > 0 && (
        <article className="panel">
          <h2>Recent history</h2>
          <p className="batch-scope">No retained batch file</p>
          <EventRows events={unattachedEvents} />
        </article>
      )}
    </section>
  );
}
