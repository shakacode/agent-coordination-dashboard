import { type FormEvent, type Ref } from "react";
import { RefreshCw, Search } from "lucide-react";
import type { HostLegendItem } from "../coordinationView";

export interface TopBarProps {
  hostLegend: HostLegendItem[];
  clock: string;
  query: string;
  onQueryChange: (value: string) => void;
  onQuerySubmit: () => void;
  onRefresh: () => void;
  refreshing: boolean;
  warningCount: number;
  warningLabel: string;
  onRevealWarnings: () => void;
  searchInputRef?: Ref<HTMLInputElement>;
}

export function TopBar({
  hostLegend,
  clock,
  query,
  onQueryChange,
  onQuerySubmit,
  onRefresh,
  refreshing,
  warningCount,
  warningLabel,
  onRevealWarnings,
  searchInputRef
}: TopBarProps) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onQuerySubmit();
  }

  return (
    <header className="topbar">
      <div className="topbar-inner">
        <div className="topbar-mark" aria-hidden="true">
          <span className="pulse" />
        </div>
        <div className="topbar-title">Agent Coordination</div>

        {hostLegend.length > 0 && (
          <div className="host-legend" aria-label="Host fleet">
            {hostLegend.map((host) => (
              <div className="host-chip" key={host.name}>
                <span className="host-dot pulse" style={{ background: host.color }} />
                <span className="host-chip-name" style={{ color: host.color }}>{host.name}</span>
                <span className="host-chip-count">{host.live} live · {host.total}</span>
              </div>
            ))}
          </div>
        )}

        <div className="topbar-tools">
          <form className="topbar-search" onSubmit={submit} role="search">
            <Search size={14} aria-hidden="true" />
            <input
              aria-label="Find PR or issue number"
              className="input"
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder="Find PR / issue #"
              ref={searchInputRef}
              value={query}
            />
          </form>
          {warningCount > 0 && (
            <button className="topbar-count" onClick={onRevealWarnings} type="button">
              {warningCount} {warningLabel}
            </button>
          )}
          <span className="topbar-clock">Updated {clock}</span>
          <button
            aria-label="Refresh dashboard"
            className="btn btn-secondary btn-icon"
            disabled={refreshing}
            onClick={onRefresh}
            title="Refresh"
            type="button"
          >
            <RefreshCw size={14} aria-hidden="true" />
          </button>
        </div>
      </div>
    </header>
  );
}
