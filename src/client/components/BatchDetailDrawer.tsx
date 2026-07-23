import { useState } from "react";
import { Clipboard, OctagonPause, Search, X } from "lucide-react";
import type { BatchCompletionReport, BatchRecord, WorkItem } from "../../shared/types";
import { displayAttribution } from "../../shared/attribution";
import { ABSENT, metric, type BatchCard } from "../coordinationView";
import { canonicalGithubItemUrl, canonicalPullRequestUrl, githubBranchUrl } from "../githubUrls";
import type { OperatorRow } from "../operatorRows";
import { LinkableValue, LinkChips } from "./reportPrimitives";

function verdictColor(verdict: string): string {
  const normalized = verdict.trim().toLowerCase();
  if (normalized.includes("clean") || normalized.includes("pass")) return "var(--ok)";
  if (normalized.includes("finding") || normalized.includes("fail")) return "var(--bad)";
  return "var(--info)";
}

function CompletionSection({ completion }: { completion: BatchCompletionReport }) {
  const audit = completion.audit;
  const auditColor = verdictColor(audit?.verdict || "");
  const receipts = completion.receipts || [];
  const outcomes = completion.outcomes || [];
  const baseline = completion.baseline;
  const entries: Array<{ k: string; v: string; href?: string; mono?: boolean }> = [
    { k: "State", v: `live ${completion.state?.live ?? ABSENT} · replay ${metric(completion.state?.replay)}` },
    { k: "Usage", v: metric(completion.usage) },
    ...(baseline ? [{ k: "Baseline", v: baseline.path || baseline.label || ABSENT, href: baseline.href, mono: true }] : []),
    ...(completion.meta || [])
  ];

  return (
    <div className="drawer-section">
      <div className="drawer-kicker">Completed-batch audit</div>
      <div className="convo-status" style={{ background: `color-mix(in srgb, ${auditColor} 12%, transparent)`, border: `1px solid color-mix(in srgb, ${auditColor} 42%, transparent)` }}>
        <span className="status-badge" style={{ background: `color-mix(in srgb, ${auditColor} 18%, transparent)`, color: auditColor, borderColor: `color-mix(in srgb, ${auditColor} 45%, transparent)` }}>audit {audit?.verdict || ABSENT}</span>
        <div className="convo-status-main">
          <div className="convo-status-hint">by {audit?.author || ABSENT}</div>
          {audit?.note && <div className="need-body" style={{ marginTop: "6px" }}>{audit.note}</div>}
        </div>
      </div>

      <div className="where-grid" style={{ marginTop: "12px" }}>
        {entries.map((entry) => (
          <div key={entry.k} style={{ display: "contents" }}>
            <span className="where-k">{entry.k}</span>
            <LinkableValue className={entry.mono ? "where-v mono" : "where-v"} href={entry.href} value={entry.v} />
          </div>
        ))}
      </div>

      {receipts.length > 0 && (
        <>
          <div className="drawer-kicker" style={{ margin: "12px 0 6px" }}>Receipts</div>
          <div className="receipt-list">
            {receipts.map((receipt, index) => (
              <div className="receipt-row" key={`${receipt.label}:${index}`}>
                <LinkableValue className="where-v" href={receipt.href} value={receipt.label} />
                {receipt.detail && <span className="convo-status-hint">{receipt.detail}</span>}
              </div>
            ))}
          </div>
        </>
      )}

      {outcomes.length > 0 && (
        <>
          <div className="drawer-kicker" style={{ margin: "12px 0 6px" }}>Outcomes</div>
          <table className="table">
            <thead><tr><th>Lane</th><th>Route</th><th>Result</th></tr></thead>
            <tbody>
              {outcomes.map((outcome, index) => (
                <tr key={`${outcome.lane}:${index}`}>
                  <td className="mono">{outcome.lane}</td>
                  <td>{outcome.route || ABSENT}</td>
                  <td>{outcome.result || ""}{outcome.links && outcome.links.length > 0 ? <> <LinkChips links={outcome.links} /></> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {completion.headline && <p className="need-body" style={{ marginTop: "10px" }}>{completion.headline}</p>}
      {completion.gates && <p className="convo-status-hint" style={{ marginTop: "8px" }}>{completion.gates}</p>}

      {completion.finalReport && (
        <>
          <div className="drawer-kicker" style={{ margin: "12px 0 6px" }}>Final report</div>
          <pre className="drawer-pre">{completion.finalReport}</pre>
        </>
      )}
    </div>
  );
}

export interface BatchDetailDrawerProps {
  card: BatchCard;
  onClose: () => void;
  onRequestStop?: (input: { batchId: string; repo?: string; reason?: string }) => Promise<void> | void;
  onOpenRow?: (row: OperatorRow, workItem?: WorkItem) => void;
  onFind?: (query: string) => void;
  localWritesDisabled?: boolean;
}

function stopRepos(batch: BatchRecord): Array<string | undefined> {
  const repos = new Set((batch.targets || []).map((target) => target.repo).filter((repo): repo is string => Boolean(repo)));
  if (batch.repo) repos.add(batch.repo);
  const list = Array.from(repos).sort();
  return list.length > 0 ? list : [undefined];
}

export function BatchDetailDrawer({
  card,
  onClose,
  onRequestStop,
  onOpenRow,
  onFind,
  localWritesDisabled = false
}: BatchDetailDrawerProps) {
  const [copyLabel, setCopyLabel] = useState("Copy prompt");
  const [replyLabel, setReplyLabel] = useState("Approve recommended");
  const [copiedChat, setCopiedChat] = useState<string | null>(null);
  const [stopStatus, setStopStatus] = useState<string | null>(null);
  const stopped = card.operation ? card.operation.controlStatus !== "running" : false;
  const blocker = card.batch.blocker;
  const decisions = card.batch.lanes
    .filter((lane) => lane.blockedOn.length > 0)
    .map((lane) => `${displayAttribution(lane.name)}: blocked on ${lane.blockedOn.join(", ")}`);
  if (stopped) decisions.unshift("Batch stop requested — restart the batch to continue.");

  async function copyPrompt() {
    if (!card.launchPrompt) return;
    if (!navigator.clipboard) {
      setCopyLabel("Copy unavailable");
      window.setTimeout(() => setCopyLabel("Copy prompt"), 1800);
      return;
    }
    try {
      await navigator.clipboard.writeText(card.launchPrompt);
      setCopyLabel("Copied ✓");
    } catch {
      setCopyLabel("Could not copy");
    }
    window.setTimeout(() => setCopyLabel("Copy prompt"), 1800);
  }

  async function copyReply(reply: string) {
    if (!navigator.clipboard) {
      setReplyLabel("Copy unavailable");
      window.setTimeout(() => setReplyLabel("Approve recommended"), 1800);
      return;
    }
    try {
      await navigator.clipboard.writeText(reply);
      setReplyLabel("Copied ✓");
    } catch {
      setReplyLabel("Could not copy");
    }
    window.setTimeout(() => setReplyLabel("Approve recommended"), 1800);
  }

  async function copyChat(handle: string) {
    if (!navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(handle);
      setCopiedChat(handle);
      window.setTimeout(() => setCopiedChat(null), 1600);
    } catch {
      setCopiedChat(null);
    }
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

        <div className="drawer-section">
          <div className="drawer-kicker">Execution ownership</div>
          <div className="where-grid">
            <span className="where-k">Creator machine</span>
            <span className="where-v">{card.machine || "UNKNOWN"}</span>
            <span className="where-k">Coordinator thread</span>
            <span className="where-v">{card.thread || "UNKNOWN"}</span>
          </div>
        </div>

        <div className="drawer-section batch-lane-map">
          <div className="drawer-kicker">Lane execution map</div>
          <div className="batch-lane-table-wrap">
            <table aria-label="Batch lane execution map" className="table batch-lane-table">
              <thead>
                <tr>
                  <th>Lane / target</th>
                  <th>Custody</th>
                  <th>Activity</th>
                  <th>Links</th>
                  <th>Chat fallback</th>
                </tr>
              </thead>
              <tbody>
                {card.lanes.map((lane) => {
                  const targetUrl = canonicalGithubItemUrl(lane.targetUrl);
                  const prUrl = lane.prUrl ? canonicalPullRequestUrl(lane.prUrl) : undefined;
                  const prTarget = prUrl?.match(/\/pull\/(\d+)$/)?.[1];
                  const branchUrl = githubBranchUrl(lane.row?.repo || card.repo, lane.branchName);
                  return (
                    <tr key={lane.id}>
                      <td>
                        <strong className="mono">{lane.tag}</strong>
                        <LinkableValue
                          className="lane-map-target"
                          href={targetUrl}
                          value={lane.target}
                        />
                        {lane.row && onOpenRow && (
                          <button
                            aria-label={`Open ${lane.tag} job`}
                            className="lane-map-action"
                            onClick={() => onOpenRow(lane.row!, lane.workItem)}
                            type="button"
                          >
                            Open job
                          </button>
                        )}
                      </td>
                      <td>
                        <span>{lane.owner || "owner UNKNOWN"}</span>
                        <span>{lane.host || "host UNKNOWN"}</span>
                        <span>{lane.machine ? `machine ${lane.machine}` : "machine UNKNOWN"}</span>
                      </td>
                      <td>
                        <span>{lane.state}</span>
                        <span>{lane.age === ABSENT ? "last activity UNKNOWN" : `${lane.age} ago`}</span>
                        {lane.note && <span style={{ color: lane.noteColor }}>{lane.note}</span>}
                      </td>
                      <td>
                        {prUrl && prUrl !== targetUrl && (
                          <LinkableValue className="lane-map-link" href={prUrl} value={prTarget ? `PR #${prTarget}` : "Open PR"} />
                        )}
                        {branchUrl && lane.branchName && (
                          <LinkableValue className="lane-map-link" href={branchUrl} value={lane.branchName} />
                        )}
                        {!targetUrl && !prUrl && !branchUrl && <span>links UNKNOWN</span>}
                      </td>
                      <td>
                        {lane.threadHandle ? (
                          <>
                            <code>{lane.threadHandle}</code>
                            <span className="lane-map-chat-actions">
                              <button
                                aria-label={`Copy chat ${lane.threadHandle}`}
                                className="lane-map-action"
                                onClick={() => void copyChat(lane.threadHandle!)}
                                type="button"
                              >
                                <Clipboard size={12} aria-hidden="true" />
                                {copiedChat === lane.threadHandle ? "Copied" : "Copy"}
                              </button>
                              {onFind && (
                                <button
                                  aria-label={`Find chat ${lane.threadHandle}`}
                                  className="lane-map-action"
                                  onClick={() => onFind(lane.threadHandle!)}
                                  type="button"
                                >
                                  <Search size={12} aria-hidden="true" />
                                  Find
                                </button>
                              )}
                            </span>
                          </>
                        ) : (
                          <span>chat UNKNOWN</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {card.tier === "blocked" && (
          <div className="drawer-section">
            <div className="drawer-kicker" style={{ color: "var(--block)" }}>Blocker · needs your decision</div>
            {blocker ? (
              <>
                <p className="need-body" style={{ margin: "0 0 10px" }}>{blocker.message}</p>
                {blocker.decisions.length > 0 && (
                  <div className="decision-list">
                    {blocker.decisions.map((decision, index) => (
                      <div key={`${index}-${decision}`}><span style={{ color: "var(--block)", flex: "none" }}>•</span><span>{decision}</span></div>
                    ))}
                  </div>
                )}
                {blocker.recommendedReply && (
                  <div className="recommended-reply">
                    <div className="token-row-head">
                      <span className="drawer-kicker" style={{ margin: "12px 0 6px" }}>Recommended reply</span>
                      <button
                        className="btn btn-secondary"
                        onClick={() => void copyReply(blocker.recommendedReply!)}
                        style={{ fontSize: "11.5px", padding: "4px 11px" }}
                        type="button"
                      >
                        <Clipboard size={13} aria-hidden="true" /> {replyLabel}
                      </button>
                    </div>
                    <pre className="drawer-pre">{blocker.recommendedReply}</pre>
                  </div>
                )}
              </>
            ) : (
              <>
                {decisions.length > 0 ? (
                  <div className="decision-list">
                    {decisions.map((decision) => (
                      <div key={decision}><span style={{ color: "var(--block)", flex: "none" }}>•</span><span>{decision}</span></div>
                    ))}
                  </div>
                ) : (
                  <p style={{ margin: 0, fontSize: "12.5px", color: "var(--color-neutral-100)" }}>A lane is blocked or its holder is dead. Lane ownership and navigation are listed in the execution map above.</p>
                )}
                <p style={{ marginTop: "10px", fontSize: "11.5px", color: "var(--mut)" }}>
                  Structured blocker decisions and a recommended reply are not emitted by the coordination protocol yet.
                </p>
              </>
            )}
          </div>
        )}

        {card.completion ? (
          <CompletionSection completion={card.completion} />
        ) : (
          <div className="drawer-section">
            <div className="drawer-kicker">Completed-batch audit</div>
            <p style={{ margin: 0, fontSize: "12.5px", color: "var(--mut)" }}>
              Audit verdicts, completion reports, and final reports are not emitted by the coordination protocol yet.
            </p>
          </div>
        )}

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
