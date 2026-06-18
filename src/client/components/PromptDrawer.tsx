import { Clipboard } from "lucide-react";

export function PromptDrawer({ prompt }: { prompt: string }) {
  return (
    <aside className="prompt-drawer">
      <header>
        <h2>PR-batch Prompt</h2>
        <button className="icon-button" onClick={() => navigator.clipboard.writeText(prompt)} title="Copy prompt" type="button">
          <Clipboard size={16} aria-hidden="true" />
        </button>
      </header>
      <pre>{prompt}</pre>
    </aside>
  );
}

