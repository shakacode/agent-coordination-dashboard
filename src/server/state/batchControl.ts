import { appendFile, mkdir } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { assertSafeBatchId } from "./batchManifestImport";

export interface BatchStopRequestInput {
  batchId: string;
  repo?: string;
  reason?: string;
  now?: Date;
}

export interface BatchStopRequestResult {
  event: {
    schema_version: number;
    event_id: string;
    type: "batch.stop_requested";
    batch_id: string;
    repo?: string;
    status: "stop_requested";
    timestamp: string;
    machine_id: string;
    message: string;
  };
  path: string;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export async function writeBatchStopRequest(stateRoot: string, input: BatchStopRequestInput): Promise<BatchStopRequestResult> {
  const batchId = stringValue(input.batchId);
  assertSafeBatchId(batchId);
  const repo = stringValue(input.repo) || undefined;
  const timestamp = (input.now || new Date()).toISOString();
  const message = stringValue(input.reason) || "Stop requested from dashboard so this batch can be restarted.";
  const relativePath = `events/batches/${batchId}.jsonl`;
  const event = {
    schema_version: 1,
    event_id: `${batchId}:stop-requested:${timestamp}`,
    type: "batch.stop_requested" as const,
    batch_id: batchId,
    ...(repo ? { repo } : {}),
    status: "stop_requested" as const,
    timestamp,
    machine_id: hostname(),
    message
  };

  await mkdir(join(stateRoot, "events", "batches"), { recursive: true });
  await appendFile(join(stateRoot, "events", "batches", `${batchId}.jsonl`), `${JSON.stringify(event)}\n`, "utf8");

  return {
    event,
    path: relativePath
  };
}
