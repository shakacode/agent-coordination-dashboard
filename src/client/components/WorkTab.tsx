import { CircleDot, GitPullRequest } from "lucide-react";
import type { WorkItem } from "../../shared/types";
import { StatusBadge } from "./StatusBadge";

export function WorkTab({ items, onToggle }: { items: WorkItem[]; onToggle: (id: string) => void }) {
  if (items.length === 0) {
    return <p className="empty-state">No open GitHub items or coordination records found.</p>;
  }

  return (
    <section className="work-list">
      {items.map((item) => {
        const Icon = item.type === "pull_request" ? GitPullRequest : CircleDot;
        const itemKind = item.type === "pull_request" ? "PR" : item.type === "issue" ? "Issue" : "Target";

        return (
          <article className="work-row" key={item.id}>
            <label className="check-cell" title="Include in PR-batch prompt">
              <input checked={item.selected} onChange={() => onToggle(item.id)} type="checkbox" />
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
              <span>{item.claim?.agentId || "Unclaimed"}</span>
              <span>{item.heartbeat?.liveness || "no heartbeat"}</span>
              {item.github?.url ? (
                <a href={item.github.url} rel="noreferrer" target="_blank">
                  Open
                </a>
              ) : null}
            </div>
          </article>
        );
      })}
    </section>
  );
}

