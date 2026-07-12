import { Clipboard } from "lucide-react";

export function PromptDrawer({ prompt, disabled = false }: { prompt: string; disabled?: boolean }) {
  const content = disabled
    ? "PR-batch prompt generation is disabled until claims, heartbeats, batches, and events can be read."
    : prompt;
  return (
    <aside className="prompt-drawer">
      <header>
        <h2>PR-batch Prompt</h2>
        <button
          className="icon-button"
          disabled={disabled}
          onClick={() => navigator.clipboard.writeText(prompt)}
          title="Copy prompt"
          type="button"
        >
          <Clipboard size={16} aria-hidden="true" />
        </button>
      </header>
      <pre>{content}</pre>
    </aside>
  );
}
