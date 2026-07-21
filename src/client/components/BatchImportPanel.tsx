import { useState, type FormEvent } from "react";
import { parsePrBatchLaunchPrompt } from "../../shared/batchManifest";
import type { BatchRecord } from "../../shared/types";

function parseEditableJson(json: string): Partial<BatchRecord> {
  const parsed = JSON.parse(json) as Partial<BatchRecord>;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Batch plan details must be an object.");
  }
  return parsed;
}

export function BatchImportPanel({
  onImportBatch,
  disabled = false
}: {
  onImportBatch?: (manifest: Partial<BatchRecord>) => Promise<void> | void;
  disabled?: boolean;
}) {
  const [launchPrompt, setLaunchPrompt] = useState("");
  const [manifestJson, setManifestJson] = useState("");
  const [status, setStatus] = useState<string | null>(null);

  function reviewPrompt(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus(null);
    try {
      const parsed = parsePrBatchLaunchPrompt(launchPrompt, { now: new Date() });
      setManifestJson(JSON.stringify(parsed, null, 2));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not review coordination prompt.");
    }
  }

  async function save() {
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
    <div className="import-panel">
      <p className="board-intro" style={{ margin: 0 }}>Paste a $pr-batch launch prompt to save it as a batch plan the dashboard can track.</p>
      <form className="import-form" onSubmit={reviewPrompt}>
        <label className="import-label">
          <span>Launch prompt</span>
          <textarea className="input import-textarea" disabled={disabled} name="coordinationPrompt" onChange={(event) => setLaunchPrompt(event.target.value)} value={launchPrompt} />
        </label>
        <button className="btn btn-secondary" disabled={disabled} type="submit">Review batch plan</button>
      </form>
      {manifestJson && (
        <div className="import-form">
          <label className="import-label">
            <span>Plan details</span>
            <textarea aria-label="Plan details" className="input import-textarea" disabled={disabled} name="planDetails" onChange={(event) => setManifestJson(event.target.value)} value={manifestJson} />
          </label>
          <button className="btn btn-primary" disabled={disabled} onClick={() => void save()} type="button">Save batch plan</button>
        </div>
      )}
      {status && <p className="import-status">{status}</p>}
    </div>
  );
}
