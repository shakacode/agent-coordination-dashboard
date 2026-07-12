import { useMemo, useState } from "react";
import { CircleDot, GitPullRequest, Search } from "lucide-react";
import type { WorkItem } from "../../shared/types";
import { StatusBadge } from "./StatusBadge";

export function WorkTab({
  items,
  onToggle,
  selectionDisabled = false
}: {
  items: WorkItem[];
  onToggle: (id: string) => void;
  selectionDisabled?: boolean;
}) {
  const [query, setQuery] = useState("");
  const filteredItems = useMemo(() => {
    const value = query.trim().toLowerCase();
    if (!value) {
      return items;
    }
    return items.filter((item) =>
      [item.repo, item.target, item.type, item.github?.title, item.claim?.agentId, item.heartbeat?.agentId, item.batchSignals?.[0]?.batchId]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(value))
    );
  }, [items, query]);

  if (items.length === 0) {
    return <p className="empty-state">No open GitHub items or coordination records found.</p>;
  }

  const sections = [
    {
      title: "Needs Recovery",
      items: filteredItems.filter((item) => item.schedulingState === "started_not_processing")
    },
    {
      title: "Active Now",
      items: filteredItems.filter((item) => item.schedulingState === "in_process")
    },
    {
      title: "Ready To Batch",
      items: filteredItems.filter((item) => item.schedulingState === "ready_for_batch")
    }
  ].filter((section) => section.items.length > 0);

  return (
    <section className="work-queue">
      {selectionDisabled && (
        <p className="warning">Batch selection is unavailable until claims, heartbeats, and batches can be read.</p>
      )}
      <label className="search-field">
        <Search size={16} aria-hidden="true" />
        <input aria-label="Filter work items" onChange={(event) => setQuery(event.target.value)} placeholder="Filter work" value={query} />
      </label>
      {sections.length === 0 ? (
        <p className="empty-state">No work items match the current filter.</p>
      ) : (
        sections.map((section) => (
          <section className="work-section" key={section.title}>
            <header className="work-section-header">
              <h2>{section.title}</h2>
              <span>{section.items.length}</span>
            </header>
            <div className="work-list">
              {section.items.map((item) => {
                const Icon = item.type === "pull_request" ? GitPullRequest : CircleDot;
                const itemKind = item.type === "pull_request" ? "PR" : item.type === "issue" ? "Issue" : "Target";
                const batchSignal = item.batchSignals?.[0];
                const canSelect = !selectionDisabled && item.schedulingState !== "in_process" && !item.batchSignals?.length;

                return (
                  <article className="work-row" key={item.id}>
                    <label
                      className="check-cell"
                      title={selectionDisabled ? "Coordination data unavailable" : canSelect ? "Include in PR-batch prompt" : "Already coordinated"}
                    >
                      <input
                        checked={canSelect ? item.selected : false}
                        disabled={!canSelect}
                        onChange={() => onToggle(item.id)}
                        type="checkbox"
                      />
                    </label>
                    <Icon size={18} aria-hidden="true" />
                    <div className="work-main">
                      <h2>
                        {itemKind} #{item.target}: {item.github?.title || "UNKNOWN title"}
                      </h2>
                      <p>{item.repo}</p>
                      {item.github?.labels.length ? <p className="labels">{item.github.labels.join(", ")}</p> : null}
                    </div>
                    <StatusBadge value={item.schedulingState} />
                    <div className="work-meta">
                      <span>{item.claim?.agentId || item.heartbeat?.agentId || batchSignal?.laneName || "Unclaimed"}</span>
                      <span>{item.heartbeat?.liveness || "no heartbeat"}</span>
                      {batchSignal ? <span>{`${batchSignal.batchId}:${batchSignal.laneName}`}</span> : null}
                      {item.github?.url ? (
                        <a href={item.github.url} rel="noreferrer" target="_blank">
                          Open
                        </a>
                      ) : null}
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        ))
      )}
    </section>
  );
}
