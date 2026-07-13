import { useState } from "react";
import { resumeCommandPrompt, takeoverCommand } from "../../shared/commands";
import type { WorkItem } from "../../shared/types";
import { effectiveCustody } from "../../shared/effectiveCustody";
import { canonicalPullRequestUrl } from "../githubUrls";

export interface AnnotationAction {
  kind: "dismiss" | "snooze";
  until?: string;
}

function pullRequestUrl(item: WorkItem): string | undefined {
  const { claim, heartbeat } = effectiveCustody(item);
  const values = [item.github?.type === "pull_request" ? item.github.url : undefined, claim?.prUrl, heartbeat?.prUrl];
  return values.flatMap((value) => value ? [canonicalPullRequestUrl(value)] : []).find(Boolean);
}

function branchUrl(item: WorkItem): string | undefined {
  const { claim, heartbeat } = effectiveCustody(item);
  const branch = claim?.branch || heartbeat?.branch || (item.github?.loadState === "loaded" ? item.github.branch : undefined);
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch || "") || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(item.repo)) return undefined;
  return `https://github.com/${item.repo}/tree/${encodeURIComponent(branch!)}`;
}

function batchId(item: WorkItem): string | undefined {
  const { claim, heartbeat } = effectiveCustody(item);
  const value = claim?.batchId || heartbeat?.batchId || item.batchSignals?.[0]?.batchId;
  return /^[A-Za-z0-9][A-Za-z0-9._:@+-]*$/.test(value || "") ? value : undefined;
}

export function OperatorActions({
  item,
  takeoverAvailable = false,
  resumeAvailable = true,
  now = () => new Date(),
  onAnnotate,
  onClearAnnotation
}: {
  item: WorkItem;
  takeoverAvailable?: boolean;
  resumeAvailable?: boolean;
  now?: () => Date;
  onAnnotate?: (annotation: AnnotationAction) => Promise<void> | void;
  onClearAnnotation?: () => Promise<void> | void;
}) {
  const [confirmation, setConfirmation] = useState("");
  const [annotationChoice, setAnnotationChoice] = useState("");
  const pr = pullRequestUrl(item);
  const branch = branchUrl(item);
  const batch = batchId(item);

  async function copy(value: string, label: string) {
    if (!navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(value);
      setConfirmation(`${label} copied`);
    } catch {
      setConfirmation(`Could not copy ${label.toLowerCase()}`);
    }
  }

  async function chooseAnnotation(value: string) {
    setAnnotationChoice(value);
    try {
      if (value === "dismiss") await onAnnotate?.({ kind: "dismiss" });
      if (value === "snooze-1h" || value === "snooze-1d") {
        const duration = value === "snooze-1h" ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
        await onAnnotate?.({ kind: "snooze", until: new Date(now().getTime() + duration).toISOString() });
      }
      if (value) setConfirmation("Presentation preference saved");
    } catch {
      setConfirmation("Could not save presentation preference");
    } finally {
      setAnnotationChoice("");
    }
  }

  async function clearAnnotation() {
    try {
      await onClearAnnotation?.();
      setConfirmation("Presentation preference cleared");
    } catch {
      setConfirmation("Could not clear presentation preference");
    }
  }

  return <div className="operator-actions">
    {resumeAvailable ? <button onClick={() => void copy(resumeCommandPrompt(item), "Resume prompt")} type="button">Copy resume prompt</button> : null}
    {takeoverAvailable ? <button onClick={() => void copy(takeoverCommand(item), "Takeover command")} type="button">Copy takeover command</button> : null}
    {pr ? <a href={pr} rel="noreferrer" target="_blank">Open PR</a> : null}
    {branch ? <a href={branch} rel="noreferrer" target="_blank">Open branch</a> : null}
    {batch ? <a href={`/?batch=${encodeURIComponent(batch)}`}>Open batch</a> : null}
    {onAnnotate ? <label className="annotation-choice">
      <span className="sr-only">Dismiss or snooze</span>
      <select aria-label="Dismiss or snooze" onChange={(event) => void chooseAnnotation(event.target.value)} value={annotationChoice}>
        <option value="">Dismiss / snooze…</option>
        <option value="snooze-1h">Snooze 1 hour</option>
        <option value="snooze-1d">Snooze 1 day</option>
        <option value="dismiss">Dismiss forever</option>
      </select>
    </label> : null}
    {item.annotation && onClearAnnotation ? <button onClick={() => void clearAnnotation()} type="button">Clear {item.annotation.kind === "snooze" ? "snooze" : "dismissal"}</button> : null}
    {confirmation ? <span aria-live="polite" className="action-confirmation" role="status">{confirmation}</span> : null}
  </div>;
}
