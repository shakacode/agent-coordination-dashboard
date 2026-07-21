import type { BatchEvent } from "../../shared/types";
import { displayAttribution, firstDisplayAttribution } from "../../shared/attribution";

export function EventHistoryPanel({ events, limit = 40 }: { events: BatchEvent[]; limit?: number }) {
  if (events.length === 0) {
    return <p className="empty-state">No coordination events recorded.</p>;
  }
  const recent = [...events].slice(-limit).reverse();
  return (
    <div className="event-list">
      {recent.map((event) => (
        <div className="event-row" key={`${event.path}:${event.eventId}`}>
          <strong>{event.type}</strong>
          <span>{displayAttribution(event.repo)}{event.target ? `#${event.target}` : ""}</span>
          <span>{displayAttribution(event.batchId, "unbatched")}</span>
          <span>{firstDisplayAttribution([event.laneName, event.agentId], "")}</span>
          <time>{event.timestamp || event.path}</time>
        </div>
      ))}
    </div>
  );
}
