import { useState } from "react";
import { Clipboard, OctagonPause, X } from "lucide-react";
import type { BatchRecord } from "../../shared/types";
import { displayAttribution } from "../../shared/attribution";
import { ABSENT, type BatchCard } from "../coordinationView";

export interface BatchDetailDrawerProps {
  card: BatchCard;
  onClose: () => void;
  onRequestStop?: (input: { batchId: string; repo?: string; reason?: string }) => Promise<void> | void;
  localWritesDisabled?: boolean;
}

function stopRepos(batch: BatchRecord): Array<string | undefined> {
  const repos = new Set((batch.targets || []).map((target) => target.repo).filter((repo): repo is string => Boolean(repo)));
  if (batch.repo) repos.add(batch.repo);
  const list = Array.from(repos).sort();
  return list.length > 0 ? list : [undefined];
}

export function BatchDetailDrawer({ card, onClose, onRequestStop, localWritesDisabled = false }: BatchDetailDrawerProps) {
  const [copyLabel, setCopyLabel] = useState("Copy prompt");
  const [stopStatus, setStopStatus] = useState<string | null>(null);
  const stopped = card.operation ? card.operation.controlStatus !== "running" : false;
  const decisions = card.batch.lanes
    .filter((lane) => lane.blockedOn.length > 0)
    .map((lane) => `${displayAttribution(lane.name)}: blocked on ${lane.blockedOn.join(", ")}`);
  if (stopped) decisions.unshift("Batch stop requested — restart the batch to continue.");

  async function copyPrompt() {
    if (!card.launchPrompt) return;
    try {
      await navigator.clipboard?.writeText(card.launchPrompt);
      setCopyLabel("Copied ✓");
    } catch {
      setCopyLabel("Could not copy");
    }
    window.setTimeout(() => setCopyLabel("Copy prompt"), 1800);
  }

  async function requestStop(repo: string | undefined) {
    if (!onRequestStop) {
      setStopStatus("Batch stop requests are unavailable.");
      return;
    }
    setStopStatus(null);
    try {
      await onRequestStop({ batchId: card.batch.batchId, repo, reason: "Stop requested from dashboard so this batch can be restarted." });
      setStopStatus(repo ? `Batch stop requested for ${repo}.` : "Batch stop requested.");
    } catch (error) {
      setStopStatus(error instanceof Error ? error.message : "Batch stop request failed.");
    }
  }

  const stats: Array<{ label: string; value: string }> = [
    { label: "Started", value: card.started },
    { label: "Duration", value: card.duration },
    { label: "Lanes done", value: `${card.done} / ${card.total}` },
    { label: "QA passed", value: card.qa },
    { label: "Tokens", value: card.tokensTotal },
    { label: "Cost", value: card.cost }
  ];

  return (
    <div className="drawer-layer" role="dialog" aria-modal="true" aria-label={`${card.title} detail`} style={{ zIndex: 41 }}>
      <button className="drawer-scrim" aria-label="Close batch detail" onClick={onClose} type="button" />
      <div className="drawer drawer-wide">
        <div className="drawer-head">
          <div className="drawer-head-row">
            <span className={`batch-super-dot${card.superPulse ? " pulse" : ""}`} style={{ background: card.superColor }} />
            <span className="drawer-title">{card.title}</span>
            <button aria-label="Close" className="btn btn-secondary btn-icon drawer-close" onClick={onClose} type="button">
              <X size={14} aria-hidden="true" />
            </button>
          </div>
          <div className="batch-head-tags" style={{ justifyContent: "flex-start", marginTop: "9px" }}>
            <span className="tag tag-outline">{card.id}</span>
            <span className="tag tag-outline">{card.repo}</span>
            <span className="tag tag-outline">coord {card.coordinator}</span>
            <span className="tag tag-outline">merge: {card.mergeAuth}</span>
            {card.thread && <span className="tag tag-outline">{card.thread}</span>}
          </div>
        </div>

        <div className="drawer-section">
          <div className="convo-status" style={{ background: `color-mix(in srgb, ${card.convoColor} 12%, transparent)`, border: `1px solid color-mix(in srgb, ${card.convoColor} 42%, transparent)` }}>
            <span className="host-dot" style={{ background: card.convoColor }} />
            <div className="convo-status-main">
              <div className="convo-status-label" style={{ color: card.convoColor }}>{card.convoLabel}</div>
              <div className="convo-status-hint">{card.convoHint}</div>
            </div>
          </div>
        </div>

        <div className="drawer-section">
          <div className="stat-grid">
            {stats.map((stat) => (
              <div className="stat-tile" key={stat.label}>
                <div className="stat-tile-label">{stat.label}</div>
                <div className="stat-tile-value">{stat.value}</div>
              </div>
            ))}
          </div>
        </div>

        {card.tier === "blocked" && (
          <div className="drawer-section">
            <div className="drawer-kicker" style={{ color: "var(--block)" }}>Blocker · needs your decision</div>
            {decisions.length > 0 ? (
              <div className="decision-list">
                {decisions.map((decision) => (
                  <div key={decision}><span style={{ color: "var(--block)", flex: "none" }}>•</span><span>{decision}</span></div>
                ))}
              </div>
            ) : (
              <p style={{ margin: 0, fontSize: "12.5px", color: "var(--color-neutral-100)" }}>A lane is blocked or its holder is dead. Review the lanes below.</p>
            )}
            <p style={{ marginTop: "10px", fontSize: "11.5px", color: "var(--mut)" }}>
              Structured blocker decisions and a recommended reply are not emitted by the coordination protocol yet.
            </p>
          </div>
        )}

        <div className="drawer-section">
          <div className="drawer-kicker">Completed-batch audit</div>
          <p style={{ margin: 0, fontSize: "12.5px", color: "var(--mut)" }}>
            Audit verdicts, completion reports, and final reports are not emitted by the coordination protocol yet.
          </p>
        </div>

        {card.objective && (
          <div className="drawer-section">
            <div className="drawer-kicker">Objective</div>
            <div className="drawer-objective">{card.objective}</div>
          </div>
        )}

        <div className="drawer-section">
          <div className="drawer-kicker">Batch controls</div>
          <div className="batch-stop-actions" style={{ display: "flex", flexWrap: "wrap", gap: "7px" }}>
            {stopRepos(card.batch).map((repo) => (
              <button
                aria-label={repo ? `Request stop for ${card.id} in ${repo}` : `Request stop for ${card.id}`}
                className="btn btn-secondary"
                disabled={localWritesDisabled}
                key={repo || "batch"}
                onClick={() => void requestStop(repo)}
                type="button"
              >
                <OctagonPause size={14} aria-hidden="true" />
                {repo && stopRepos(card.batch).length > 1 ? `Request stop: ${repo}` : "Request stop"}
              </button>
            ))}
          </div>
          {stopStatus && <p style={{ margin: "8px 0 0", fontSize: "12px", color: "var(--mut)" }}>{stopStatus}</p>}
        </div>

        <div className="drawer-section" style={{ borderBottom: "none" }}>
          <div className="token-row-head">
            <span className="drawer-kicker" style={{ margin: 0 }}>Launch prompt</span>
            {card.launchPrompt && (
              <button className="btn btn-secondary" onClick={() => void copyPrompt()} style={{ fontSize: "11.5px", padding: "4px 11px" }} type="button">
                <Clipboard size={13} aria-hidden="true" /> {copyLabel}
              </button>
            )}
          </div>
          {card.launchPrompt ? (
            <pre className="drawer-pre">{card.launchPrompt}</pre>
          ) : (
            <p style={{ margin: 0, fontSize: "12px", color: "var(--mut)" }}>{card.promptSaved ? "" : "No launch prompt has been saved for this batch."}</p>
          )}
        </div>
      </div>
    </div>
  );
}
