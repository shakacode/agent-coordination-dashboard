import { BATCH_TIERS, type BatchCard, type BatchTier, type LaneView } from "../coordinationView";
import type { OperatorRow } from "../operatorRows";
import type { WorkItem } from "../../shared/types";

export type BatchFilter = BatchTier | "all";

export interface BatchesBoardProps {
  cards: BatchCard[];
  tierCounts: Record<BatchTier, number>;
  activeFilter: BatchFilter;
  onSetFilter: (filter: BatchFilter) => void;
  onOpenBatch: (card: BatchCard) => void;
  onOpenRow: (row: OperatorRow, workItem?: WorkItem) => void;
  highlightBatchIdentity?: string | null;
}

function LaneRow({ lane, onOpenRow }: { lane: LaneView; onOpenRow: BatchesBoardProps["onOpenRow"] }) {
  const interactive = Boolean(lane.row);
  const content = (
    <>
      <span className="lane-branch">{lane.branch}</span>
      <span className="lane-tag">{lane.tag}</span>
      <div className="lane-main">
        <div className="lane-title-row">
          <span className="lane-target" style={{ color: lane.targetColor }}>{lane.target}</span>
          <span className="lane-title">{lane.title}</span>
        </div>
        <div className="lane-note-row">
          {lane.route && <span className="lane-route">{lane.route}</span>}
          <span className="lane-note" style={{ color: lane.noteColor }}>{lane.note}</span>
        </div>
      </div>
      <span className="lane-where">{lane.where}</span>
      <span className="lane-right">
        <span className="lane-age">{lane.age}</span>
        <span className="status-badge" style={{ background: `color-mix(in srgb, ${lane.stateColor} 16%, transparent)`, color: lane.stateColor, borderColor: `color-mix(in srgb, ${lane.stateColor} 45%, transparent)` }}>
          {lane.state}
        </span>
      </span>
    </>
  );
  if (!interactive) {
    return <div className="lane-row" style={{ cursor: "default" }}>{content}</div>;
  }
  return (
    <button className="lane-row" onClick={() => onOpenRow(lane.row!, lane.workItem)} type="button">
      {content}
    </button>
  );
}

export function BatchesBoard({ cards, tierCounts, activeFilter, onSetFilter, onOpenBatch, onOpenRow, highlightBatchIdentity }: BatchesBoardProps) {
  const filters: Array<{ id: BatchFilter; label: string; hint: string; color: string; pulse: boolean; count: number }> = [
    { id: "all", label: "All batches", hint: "", color: "var(--color-neutral-300)", pulse: false, count: cards.length },
    ...BATCH_TIERS.map((tier) => ({ id: tier.id as BatchFilter, label: tier.label, hint: tier.hint, color: tier.color, pulse: tier.pulse, count: tierCounts[tier.id] }))
  ];
  const visible = activeFilter === "all" ? cards : cards.filter((card) => card.tier === activeFilter);

  return (
    <section aria-label="Batches" className="batches-board">
      <p className="board-intro">
        Each batch is a <strong>supervisor thread</strong> coordinating <strong>subagent lanes</strong>. A lane owns one PR or issue. Watch the supervisor and each lane to see what is running, stuck, or done.
      </p>

      <div className="batch-triage" role="tablist" aria-label="Batch triage">
        {filters.map((filter) => (
          <button
            aria-pressed={activeFilter === filter.id}
            className={`triage-card${activeFilter === filter.id ? " active" : ""}`}
            key={filter.id}
            onClick={() => onSetFilter(activeFilter === filter.id && filter.id !== "all" ? "all" : filter.id)}
            style={{ color: filter.color, borderColor: activeFilter === filter.id ? filter.color : undefined, background: activeFilter === filter.id ? `color-mix(in srgb, ${filter.color} 12%, transparent)` : undefined }}
            type="button"
          >
            <span className="triage-top">
              {filter.id !== "all" && <span className={`bucket-dot${filter.pulse ? " pulse" : ""}`} style={{ background: filter.color }} />}
              <span className="triage-count">{filter.count}</span>
            </span>
            <span className="triage-label">{filter.label}</span>
            {filter.hint && <span className="triage-hint">{filter.hint}</span>}
          </button>
        ))}
      </div>

      {visible.length === 0 ? (
        <p className="empty-state">No batches in this view.</p>
      ) : (
        <div className="batch-list">
          {visible.map((card) => (
            <article className={`batch-card${highlightBatchIdentity === card.identity ? " highlight" : ""}`} id={card.idAttr} key={card.identity}>
              <button className="batch-header" onClick={() => onOpenBatch(card)} type="button">
                <span className={`batch-super-dot${card.superPulse ? " pulse" : ""}`} style={{ background: card.superColor }} title={card.superLabel} />
                <div className="batch-head-main">
                  <div className="batch-head-title">
                    <strong>{card.title}</strong>
                    <span className="batch-head-repo">{card.repo}</span>
                    <span className="batch-head-id">{card.id}</span>
                  </div>
                  <div className="batch-head-meta">
                    {card.host && (
                      <>
                        <span style={{ color: card.hostColor }}>{card.host}</span>
                        <span className="dot-sep">·</span>
                      </>
                    )}
                    {card.machine && (
                      <>
                        <span>{card.machine}</span>
                        <span className="dot-sep">·</span>
                      </>
                    )}
                    <span style={{ color: card.superColor }}>{card.superLabel}</span>
                  </div>
                </div>
                <div className="batch-head-right">
                  <div className="batch-head-tags">
                    <span className="tag" style={{ background: `color-mix(in srgb, ${card.convoColor} 15%, transparent)`, color: card.convoColor }}>{card.convoLabel}</span>
                    <span className="lane-age"><span style={{ color: "var(--ok)" }}>{card.done}</span>/{card.total} done · QA {card.qa}</span>
                    <span style={{ color: "var(--color-accent)", fontSize: "11.5px", fontFamily: "var(--font-heading)" }}>Details ›</span>
                  </div>
                  <div className="batch-progress">
                    <div className="batch-progress-done" style={{ width: card.donePct }} />
                    <div className="batch-progress-run" style={{ width: card.runPct }} />
                  </div>
                </div>
              </button>
              <div className="batch-lanes">
                {card.lanes.map((lane) => (
                  <LaneRow key={lane.id} lane={lane} onOpenRow={onOpenRow} />
                ))}
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
