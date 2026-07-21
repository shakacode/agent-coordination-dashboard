import { ExternalLink, MessageSquare, X } from "lucide-react";
import type { ModelUsage, WorkItem } from "../../shared/types";
import { displayAttribution } from "../../shared/attribution";
import { ABSENT, aggregateUsage, devToolForHost, formatCost, formatTokens, hostColor, stateColor, targetLabel } from "../coordinationView";
import type { OperatorRow } from "../operatorRows";
import { safeGithubUrl } from "../operatorRows";
import { OperatorActions, type AnnotationAction } from "./OperatorActions";
import { LinkableValue } from "./reportPrimitives";

export interface JobDetailDrawerProps {
  row: OperatorRow;
  workItem?: WorkItem;
  batchTitle?: string;
  /** Resolved batch merge authority ("ask" | "auto"), when the batch card carries one. */
  mergeAuth?: string;
  onClose: () => void;
  onOpenBatch?: (batchId: string) => void;
  onOpenTimeline?: (item: WorkItem) => void;
  onAnnotate?: (annotation: AnnotationAction) => Promise<void> | void;
  onClearAnnotation?: () => Promise<void> | void;
  commandActionsDisabled?: boolean;
}

const NEUTRAL = "var(--color-neutral-200)";

function branchTreeUrl(repo: string, branch: string | undefined): string | undefined {
  if (!branch) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) return undefined;
  return `https://github.com/${repo}/tree/${branch.split("/").map(encodeURIComponent).join("/")}`;
}

function TokensByModel({ usage }: { usage: ModelUsage[] }) {
  const totals = aggregateUsage(usage);
  const maxTokens = Math.max(...usage.map((entry) => entry.tokensIn + entry.tokensOut), 1);
  return (
    <div className="drawer-section">
      <div className="token-row-head">
        <span className="drawer-kicker" style={{ margin: 0 }}>Tokens by model</span>
        <span style={{ fontSize: "12px", color: "var(--color-neutral-300)" }}>
          {totals?.tokensTotal ?? ABSENT}{totals?.cost ? ` · ${totals.cost}` : ""}
        </span>
      </div>
      <div className="token-bars">
        {usage.map((entry) => {
          const tokens = entry.tokensIn + entry.tokensOut;
          return (
            <div className="token-bar-row" key={entry.model}>
              <span className="token-bar-model" title={entry.model}>{entry.model}</span>
              <span className="token-bar-track">
                <span className="token-bar-fill" style={{ width: `${Math.max(3, Math.round((tokens / maxTokens) * 100))}%` }} />
              </span>
              <span className="token-bar-value">
                {formatTokens(tokens)}{entry.costUsd !== undefined ? ` · ${formatCost(entry.costUsd)}` : ""}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function JobDetailDrawer({
  row,
  workItem,
  batchTitle,
  mergeAuth,
  onClose,
  onOpenBatch,
  onOpenTimeline,
  onAnnotate,
  onClearAnnotation,
  commandActionsDisabled = false
}: JobDetailDrawerProps) {
  const color = stateColor(row.operatorState);
  const need = workItem?.attention?.label || (row.blockedOn.length > 0 ? `Blocked on ${row.blockedOn.join(", ")}` : "");
  const githubUrl = safeGithubUrl(row.url);
  const where: Array<{ k: string; v: string; color?: string; href?: string }> = [
    { k: "Host", v: displayAttribution(row.host, "UNKNOWN"), color: hostColor(row.host) },
    { k: "Dev tool", v: devToolForHost(row.host) || "UNKNOWN" },
    { k: "Route", v: workItem?.route || ABSENT },
    { k: "Machine", v: displayAttribution(row.machineId, "UNKNOWN") },
    { k: "User", v: displayAttribution(row.operator, "UNKNOWN") },
    { k: "Batch", v: batchTitle || (row.batchId ? displayAttribution(row.batchId) : "unbatched") },
    { k: "Branch", v: displayAttribution(row.branch, "UNKNOWN"), href: branchTreeUrl(row.repo, row.branch) },
    { k: "Phase", v: displayAttribution(row.activityStatus, "UNKNOWN") },
    { k: "Merge auth", v: mergeAuth || ABSENT },
    { k: "Chat handle", v: displayAttribution(row.threadHandle, "UNKNOWN") }
  ];

  return (
    <div className="drawer-layer" role="dialog" aria-modal="true" aria-label={`${targetLabel(row)} detail`}>
      <button className="drawer-scrim" aria-label="Close detail" onClick={onClose} type="button" />
      <div className="drawer">
        <div className="drawer-head">
          <div className="drawer-head-row">
            <span className="drawer-title" style={{ color: row.host ? hostColor(row.host) : NEUTRAL }}>{targetLabel(row)}</span>
            <span className="status-badge" style={{ background: `color-mix(in srgb, ${color} 16%, transparent)`, color, borderColor: `color-mix(in srgb, ${color} 45%, transparent)` }}>{row.operatorState}</span>
            <span className="lane-age">{row.lastActivityAge} in state</span>
            <button aria-label="Close" className="btn btn-secondary btn-icon drawer-close" onClick={onClose} type="button">
              <X size={14} aria-hidden="true" />
            </button>
          </div>
          <div className="drawer-title-line">{row.title}</div>
        </div>

        <div className="drawer-section">
          <div className="drawer-kicker">Where it's worked on</div>
          <div className="where-grid">
            {where.map((entry) => (
              <div key={entry.k} style={{ display: "contents" }}>
                <span className="where-k">{entry.k}</span>
                <LinkableValue className="where-v" href={entry.href} style={{ color: entry.color || (entry.href ? "var(--color-accent)" : NEUTRAL) }} value={entry.v} />
              </div>
            ))}
          </div>
        </div>

        {workItem?.usage && workItem.usage.length > 0 ? (
          <TokensByModel usage={workItem.usage} />
        ) : (
          <div className="drawer-section">
            <div className="token-row-head">
              <span className="drawer-kicker" style={{ margin: 0 }}>Tokens by model</span>
              <span style={{ fontSize: "12px", color: "var(--color-neutral-300)" }}>{ABSENT}</span>
            </div>
            <p style={{ margin: 0, fontSize: "12px", color: "var(--mut)" }}>
              Token and cost accounting is not emitted by the coordination protocol yet.
            </p>
          </div>
        )}

        {need && (
          <div className="need-box" style={{ background: `color-mix(in srgb, ${color} 12%, transparent)`, border: `1px solid color-mix(in srgb, ${color} 45%, transparent)` }}>
            <div className="need-kicker" style={{ color }}>What's needed</div>
            <div className="need-body">{need}</div>
          </div>
        )}

        {workItem && (
          <div className="drawer-section">
            <div className="drawer-kicker">Operator actions</div>
            <OperatorActions
              commandActionsDisabled={commandActionsDisabled}
              item={workItem}
              onAnnotate={onAnnotate}
              onClearAnnotation={onClearAnnotation}
              resumeAvailable={row.operatorState !== "done" && row.operatorState !== "archived"}
              takeoverAvailable={row.operatorState === "dead"}
            />
          </div>
        )}

        <div className="drawer-foot">
          {row.batchId && onOpenBatch && (
            <button className="btn btn-primary" style={{ width: "calc(100% - 40px)", margin: "16px 20px 0", justifyContent: "space-between" }} onClick={() => onOpenBatch(row.batchId!)} type="button">
              <span style={{ display: "flex", alignItems: "center", gap: "8px" }}><MessageSquare size={14} aria-hidden="true" /> Go to batch</span>
              <span style={{ fontFamily: "var(--font-heading)", fontSize: "12px", opacity: 0.85, maxWidth: "210px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{batchTitle || displayAttribution(row.batchId)} ↗</span>
            </button>
          )}
          <div className="drawer-actions">
            {githubUrl ? (
              <a className="btn btn-secondary" href={githubUrl} rel="noreferrer" style={{ flex: 1 }} target="_blank">
                <ExternalLink size={13} aria-hidden="true" /> Open in GitHub
              </a>
            ) : (
              <span className="btn btn-secondary" style={{ flex: 1, opacity: 0.45 }}>GitHub UNKNOWN</span>
            )}
            {workItem && onOpenTimeline ? (
              <button className="btn btn-secondary" onClick={() => onOpenTimeline(workItem)} style={{ flex: 1 }} type="button">Timeline</button>
            ) : (
              <span className="btn btn-secondary" style={{ flex: 1, opacity: 0.45 }}>Timeline UNKNOWN</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
