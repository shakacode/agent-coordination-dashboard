import { useState, type FormEvent } from "react";
import { Clipboard, FilePlus, OctagonPause } from "lucide-react";
import { parsePrBatchLaunchPrompt } from "../../shared/batchManifest";
import type { BatchEvent, BatchOperation, BatchRecord } from "../../shared/types";
import { displayAttribution, firstDisplayAttribution } from "../../shared/attribution";
import { StatusBadge } from "./StatusBadge";

function EventRows({ events }: { events: BatchEvent[] }) {
  return (
    <div className="event-list">
      {events.map((event) => (
        <div className="event-row" key={`${event.path}:${event.eventId}`}>
          <strong>{event.type}</strong>
          <span>{firstDisplayAttribution([event.laneName, event.agentId, event.machineId], "batch")}</span>
          <span>{event.status || ""}</span>
          <span>{event.message || ""}</span>
          <time>{event.timestamp ? new Date(event.timestamp).toLocaleString() : event.path}</time>
        </div>
      ))}
    </div>
  );
}

function promptSummary(prompt: string): string {
  return prompt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || "Coordination prompt saved.";
}

function operationKey(input: { repo?: string; batchPath?: string; batchId: string }): string {
  if (input.batchPath) return `path:${input.batchPath}:${input.batchId}`;
  if (input.repo) return `repo:${input.repo}:${input.batchId}`;
  return `batch:${input.batchId}`;
}

function qaSummary(operation: BatchOperation): string {
  const parts = [
    `${operation.qa.passed} passed`,
    operation.qa.failed > 0 ? `${operation.qa.failed} failed` : "",
    operation.qa.inProgress > 0 ? `${operation.qa.inProgress} in progress` : "",
    operation.qa.requested > 0 ? `${operation.qa.requested} requested` : "",
    operation.qa.unknown > 0 ? `${operation.qa.unknown} unknown` : "",
    `${operation.qa.missing} missing`
  ].filter(Boolean);
  return `QA ${parts.join(" / ")}`;
}

function stopRepos(batch: BatchRecord): string[] {
  const repos = new Set((batch.targets || []).map((target) => target.repo).filter((repo): repo is string => Boolean(repo)));
  if (batch.repo) {
    repos.add(batch.repo);
  }
  return Array.from(repos).sort();
}

function BatchOperationPanel({
  batch,
  operation,
  onRequestStop,
  localWritesDisabled = false
}: {
  batch: BatchRecord;
  operation?: BatchOperation;
  onRequestStop?: (input: { batchId: string; repo?: string; reason?: string }) => Promise<void> | void;
  localWritesDisabled?: boolean;
}) {
  const [status, setStatus] = useState<string | null>(null);
  const controlStatus = operation?.controlStatus || "running";
  const stopScopes = stopRepos(batch);
  const displayBatchId = displayAttribution(batch.batchId);

  async function requestStop(repo: string | undefined) {
    if (!onRequestStop) {
      setStatus("Batch stop requests are unavailable.");
      return;
    }
    setStatus(null);
    try {
      await onRequestStop({
        batchId: batch.batchId,
        repo,
        reason: "Stop requested from dashboard so this batch can be restarted."
      });
      setStatus(repo ? `Batch stop requested for ${repo}.` : "Batch stop requested.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Batch stop request failed.");
    }
  }

  return (
    <section className="batch-operation">
      <div className="batch-operation-row">
        <StatusBadge value={controlStatus} />
        <span>{operation ? `${operation.eventCount} events` : "0 events"}</span>
        {operation ? <span>{qaSummary(operation)}</span> : <span>QA 0 passed / 0 missing</span>}
      </div>
      {operation?.latestEventType ? <p>{operation.latestEventType}</p> : null}
      <div className="batch-stop-actions">
        {(stopScopes.length > 0 ? stopScopes : [undefined]).map((repo) => (
          <button
            aria-label={repo ? `Request stop for ${displayBatchId} in ${displayAttribution(repo)}` : `Request stop for ${displayBatchId}`}
            className="secondary-action"
            disabled={localWritesDisabled}
            key={repo || "batch"}
            onClick={() => void requestStop(repo)}
            title="Request batch stop"
            type="button"
          >
            <OctagonPause size={16} aria-hidden="true" />
            {repo && stopScopes.length > 1 ? `Request stop: ${repo}` : "Request stop"}
          </button>
        ))}
      </div>
      {status ? <p className="batch-import-status">{status}</p> : null}
    </section>
  );
}

function PromptStatus({ batch }: { batch: BatchRecord }) {
  const prompt = batch.launchPrompt || "";
  const status = prompt ? "Coordination prompt saved" : batch.source === "inferred" ? "Batch plan missing" : "Prompt not saved";

  return (
    <div className="batch-prompt">
      <div className="batch-prompt-heading">
        <span className={prompt ? "prompt-status retained" : "prompt-status missing"}>{status}</span>
        {prompt && (
          <button
            aria-label={`Copy coordination prompt for ${displayAttribution(batch.batchId)}`}
            className="icon-button"
            onClick={() => navigator.clipboard.writeText(prompt)}
            title="Copy coordination prompt"
            type="button"
          >
            <Clipboard size={16} aria-hidden="true" />
          </button>
        )}
      </div>
      {batch.objective && <p>{batch.objective}</p>}
      <p>{prompt ? promptSummary(prompt) : "No coordination prompt has been saved for this batch."}</p>
      {prompt && (
        <details>
          <summary>View coordination prompt</summary>
          <pre>{prompt}</pre>
        </details>
      )}
    </div>
  );
}

function parseEditableJson(json: string): Partial<BatchRecord> {
  const parsed = JSON.parse(json) as Partial<BatchRecord>;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Batch plan details must be an object.");
  }
  return parsed;
}

function BatchImportPanel({ onImportBatch, localWritesDisabled = false }: { onImportBatch?: (manifest: Partial<BatchRecord>) => Promise<void> | void; localWritesDisabled?: boolean }) {
  const [launchPrompt, setLaunchPrompt] = useState("");
  const [manifestJson, setManifestJson] = useState("");
  const [batchId, setBatchId] = useState("");
  const [repo, setRepo] = useState("");
  const [objective, setObjective] = useState("");
  const [status, setStatus] = useState<string | null>(null);

  function setEditableManifest(next: Partial<BatchRecord>) {
    setBatchId(next.batchId || "");
    setRepo(next.repo || "");
    setObjective(next.objective || "");
    setManifestJson(JSON.stringify(next, null, 2));
  }

  function patchEditableManifest(patch: Partial<BatchRecord>) {
    try {
      const current = manifestJson ? parseEditableJson(manifestJson) : {};
      setEditableManifest({ ...current, ...patch });
    } catch {
      setEditableManifest(patch);
    }
  }

  function parsePrompt(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus(null);
    try {
      const parsed = parsePrBatchLaunchPrompt(launchPrompt, { now: new Date() });
      setEditableManifest(parsed);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not review coordination prompt.");
    }
  }

  async function saveManifest() {
    setStatus(null);
    try {
      const manifest = parseEditableJson(manifestJson);
      if (!manifest.batchId) {
        throw new Error("Batch id is required.");
      }
      if (!onImportBatch) {
        throw new Error("Batch plan import is unavailable.");
      }
      await onImportBatch(manifest);
      setStatus("Batch plan saved.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not save batch plan.");
    }
  }

  return (
    <article className="panel batch-import-panel">
      <header className="batch-card-header">
        <h2>Import Batch Plan</h2>
        <FilePlus size={16} aria-hidden="true" />
      </header>
      <form className="batch-import-form" onSubmit={parsePrompt}>
        <label>
          Paste coordination prompt
          <textarea
            disabled={localWritesDisabled}
            name="coordinationPrompt"
            onChange={(event) => setLaunchPrompt(event.target.value)}
            value={launchPrompt}
          />
        </label>
        <button disabled={localWritesDisabled} type="submit">Review batch plan</button>
      </form>
      {manifestJson && (
        <div className="manifest-review">
          <label>
            Batch id
            <input
              disabled={localWritesDisabled}
              name="batchId"
              onChange={(event) => {
                setBatchId(event.target.value);
                patchEditableManifest({ batchId: event.target.value });
              }}
              value={batchId}
            />
          </label>
          <label>
            Repo
            <input
              disabled={localWritesDisabled}
              name="repo"
              onChange={(event) => {
                setRepo(event.target.value);
                patchEditableManifest({ repo: event.target.value });
              }}
              value={repo}
            />
          </label>
          <label>
            Objective
            <input
              disabled={localWritesDisabled}
              name="objective"
              onChange={(event) => {
                setObjective(event.target.value);
                patchEditableManifest({ objective: event.target.value });
              }}
              value={objective}
            />
          </label>
          <label>
            Plan details
            <textarea
              aria-label="Plan details"
              disabled={localWritesDisabled}
              name="planDetails"
              onChange={(event) => setManifestJson(event.target.value)}
              value={manifestJson}
            />
          </label>
          <button disabled={localWritesDisabled} onClick={() => void saveManifest()} type="button">
            Save batch plan
          </button>
        </div>
      )}
      {status && <p className="batch-import-status">{status}</p>}
    </article>
  );
}

export function BatchesTab({
  batches,
  events,
  onImportBatch,
  onRequestStop,
  localWritesDisabled = false,
  operations = []
}: {
  batches: BatchRecord[];
  events: BatchEvent[];
  onImportBatch?: (manifest: Partial<BatchRecord>) => Promise<void> | void;
  onRequestStop?: (input: { batchId: string; repo?: string; reason?: string }) => Promise<void> | void;
  localWritesDisabled?: boolean;
  operations?: BatchOperation[];
}) {
  const hasBatchContent = batches.length > 0 || events.length > 0;
  const unattachedEvents = events.filter((event) => !event.batchPath).slice(0, 10);
  const operationByKey = new Map(operations.map((operation) => [operationKey(operation), operation]));

  return (
    <section className="batches-view">
      {!hasBatchContent ? (
        <>
          <p className="empty-state">No saved batch plans found.</p>
          <BatchImportPanel localWritesDisabled={localWritesDisabled} onImportBatch={onImportBatch} />
        </>
      ) : (
        <>
          <section className="panel-grid">
            {batches.map((batch) => {
            const batchEvents = events
              .filter((event) =>
                event.batchPath
                  ? event.batchPath === batch.path
                  : event.batchId === batch.batchId && Boolean(event.repo && event.repo === batch.repo)
              )
              .slice(0, 20);
            const operation = operationByKey.get(operationKey({ repo: batch.repo, batchPath: batch.path, batchId: batch.batchId }));
            return (
              <article className="panel" key={operationKey({ repo: batch.repo, batchPath: batch.path, batchId: batch.batchId })}>
                <header className="batch-card-header">
                  <h2>{displayAttribution(batch.batchId)}</h2>
                  {batch.source === "inferred" ? <span className="source-badge">Inferred</span> : null}
                </header>
                <p className="batch-scope">{displayAttribution(batch.repo || batch.path)}</p>
                <BatchOperationPanel batch={batch} localWritesDisabled={localWritesDisabled} operation={operation} onRequestStop={onRequestStop} />
                <PromptStatus batch={batch} />
                {batch.lanes.map((lane) => (
                  <div className="lane-row" key={lane.name}>
                    <div>
                      <strong>{displayAttribution(lane.name)}</strong>
                      <p>{lane.targets.map((target) => displayAttribution(target)).join(", ") || "No targets"}</p>
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
                <p className="batch-scope">No saved batch plan</p>
                <EventRows events={unattachedEvents} />
              </article>
            )}
          </section>
          <BatchImportPanel localWritesDisabled={localWritesDisabled} onImportBatch={onImportBatch} />
        </>
      )}
    </section>
  );
}
