import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type Ref } from "react";
import { Copy, RefreshCw, Search, X } from "lucide-react";
import type { HostLegendItem } from "../coordinationView";
import type { FindResult } from "../universalFind";

export interface TopBarProps {
  hostLegend: HostLegendItem[];
  activeHost?: string;
  activeMachine?: string;
  onSelectHost: (host?: string) => void;
  onClearFleetFilter: () => void;
  clock: string;
  query: string;
  findResults: FindResult[];
  findOpen: boolean;
  onFindFocus: () => void;
  onFindDismiss: () => void;
  onFindResult: (result: FindResult) => void;
  onQueryChange: (value: string) => void;
  onQuerySubmit: () => void;
  onRefresh: () => void;
  refreshing: boolean;
  warningCount: number;
  warningLabel: string;
  onRevealWarnings: () => void;
  searchInputRef?: Ref<HTMLInputElement>;
}

const FIND_RESULT_LIMIT = 24;

export function TopBar({
  hostLegend,
  activeHost,
  activeMachine,
  onSelectHost,
  onClearFleetFilter,
  clock,
  query,
  findResults,
  findOpen,
  onFindFocus,
  onFindDismiss,
  onFindResult,
  onQueryChange,
  onQuerySubmit,
  onRefresh,
  refreshing,
  warningCount,
  warningLabel,
  onRevealWarnings,
  searchInputRef
}: TopBarProps) {
  const [copied, setCopied] = useState<string | null>(null);
  const [activeResultId, setActiveResultId] = useState<string | null>(null);
  const searchFormRef = useRef<HTMLFormElement>(null);
  const visibleFindResults = useMemo(() => findResults.slice(0, FIND_RESULT_LIMIT), [findResults]);
  const hiddenFindResultCount = findResults.length - visibleFindResults.length;

  useEffect(() => {
    if (!findOpen || !visibleFindResults.some((result) => result.id === activeResultId)) {
      setActiveResultId(null);
    }
  }, [activeResultId, findOpen, visibleFindResults]);

  useEffect(() => {
    if (!findOpen) return;
    function dismissOutside(event: PointerEvent) {
      if (event.target && !searchFormRef.current?.contains(event.target as Node)) {
        onFindDismiss();
      }
    }
    document.addEventListener("pointerdown", dismissOutside);
    return () => document.removeEventListener("pointerdown", dismissOutside);
  }, [findOpen, onFindDismiss]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onQuerySubmit();
  }

  function searchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onFindDismiss();
    }
    if (event.key === "ArrowDown" && visibleFindResults.length > 0) {
      event.preventDefault();
      focusResult(0);
    }
  }

  function focusResult(index: number) {
    const result = visibleFindResults[(index + visibleFindResults.length) % visibleFindResults.length];
    if (!result) return;
    setActiveResultId(result.id);
    document.getElementById(`find-result-${encodeURIComponent(result.id)}`)?.focus();
  }

  function resultKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      focusResult(index + (event.key === "ArrowDown" ? 1 : -1));
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      focusResult(event.key === "Home" ? 0 : visibleFindResults.length - 1);
    } else if (event.key === "Escape") {
      event.preventDefault();
      onFindDismiss();
    }
  }

  async function copyThread(result: FindResult) {
    if (!result.threadHandle || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(result.threadHandle);
      setCopied(result.id);
      window.setTimeout(() => setCopied(null), 1600);
    } catch {
      setCopied(null);
    }
  }

  return (
    <header className="topbar">
      <div className="topbar-inner">
        <div className="topbar-brand">
          <div className="topbar-mark" aria-hidden="true">
            <span className="pulse" />
          </div>
          <div className="topbar-title">Agent Coordination</div>
        </div>

        {hostLegend.length > 0 && (
          <div className="host-legend" aria-label="Host fleet filters">
            {hostLegend.map((host) => (
              <button
                aria-label={`${host.name}, ${host.live} live, ${host.total} total`}
                aria-pressed={activeHost === host.name}
                className="host-chip"
                key={host.name}
                onClick={() => onSelectHost(activeHost === host.name && !activeMachine ? undefined : host.name)}
                type="button"
              >
                <span className="host-dot pulse" style={{ background: host.color }} />
                <span className="host-chip-name" style={{ color: host.color }}>{host.name}</span>
                <span className="host-chip-count">{host.live} live · {host.total}</span>
              </button>
            ))}
            {(activeHost || activeMachine) && (
              <button
                aria-label="Clear fleet filters"
                className="host-filter-clear"
                onClick={onClearFleetFilter}
                title="Clear fleet filters"
                type="button"
              >
                <X size={13} aria-hidden="true" />
                {activeMachine ? activeHost ? `${activeHost} · ${activeMachine}` : activeMachine : activeHost}
              </button>
            )}
          </div>
        )}

        <div className="topbar-tools">
          <form className="topbar-search" onSubmit={submit} ref={searchFormRef} role="search">
            <Search size={14} aria-hidden="true" />
            <input
              aria-controls="universal-find-results"
              aria-expanded={findOpen}
              aria-label="Find jobs, batches, machines, chats, branches, or GitHub items"
              className="input"
              onChange={(event) => onQueryChange(event.target.value)}
              onFocus={onFindFocus}
              onKeyDown={searchKeyDown}
              placeholder="Find anything…"
              ref={searchInputRef}
              role="searchbox"
              value={query}
            />
            {findOpen && (
              <div className="find-popover" id="universal-find-results">
                {!query.trim() ? (
                  <p className="find-state">Type to search jobs, batches, machines, chats, branches, hosts, or GitHub items.</p>
                ) : findResults.length === 0 ? (
                  <p className="find-state" role="status">No matches for &quot;{query.trim()}&quot;</p>
                ) : (
                  <>
                    <div aria-label="Find results" className="find-results" role="listbox">
                      {visibleFindResults.map((result, index) => (
                        <div className="find-result-row" key={result.id} role="presentation">
                          <button
                            aria-selected={activeResultId === result.id}
                            className="find-result"
                            id={`find-result-${encodeURIComponent(result.id)}`}
                            onClick={() => onFindResult(result)}
                            onFocus={() => setActiveResultId(result.id)}
                            onKeyDown={(event) => resultKeyDown(event, index)}
                            role="option"
                            type="button"
                          >
                            <span className="find-result-kind">{result.kind}</span>
                            <span className="find-result-main">
                              <strong>{result.label}</strong>
                              <span>{result.context}</span>
                              <span className="find-result-meta">
                                {result.repo && <span>{result.repo}</span>}
                                <span>{result.machine ? `machine ${result.machine}` : "machine UNKNOWN"}</span>
                                {result.host && <span>{result.host}</span>}
                                {result.threadHandle && <code>{result.threadHandle}</code>}
                              </span>
                            </span>
                          </button>
                          {result.threadHandle && (
                            <button
                              aria-label={`Copy chat ${result.threadHandle}`}
                              className="find-copy"
                              onClick={() => void copyThread(result)}
                              type="button"
                            >
                              <Copy size={13} aria-hidden="true" />
                              {copied === result.id ? "Copied" : "Copy"}
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                    {hiddenFindResultCount > 0 && (
                      <p className="find-state" role="status">
                        {hiddenFindResultCount} more matches. Refine your search to narrow the results.
                      </p>
                    )}
                  </>
                )}
              </div>
            )}
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
