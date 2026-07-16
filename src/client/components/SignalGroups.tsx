import type { ReactNode } from "react";
import type { CoordinationWarning } from "../../shared/types";
import type { SignalGroup } from "../signalGroups";
import { StatusBadge } from "./StatusBadge";

/** One "Skipped N … outside saved target repositories." scope notice, parsed. */
export interface RepoScopeExclusion {
  count: number;
  label: string;
}

// Mirrors appendSkippedWarning in src/server/state/buildDashboardModel.ts. When
// that template changes, update this pattern in the same PR so repo-scope
// exclusion notices keep routing to the target-repositories affordance instead
// of stacking on the warning surfaces.
const REPO_SCOPE_EXCLUSION_PATTERN = /^Skipped (\d+) (.+) outside saved target repositories\.$/;

/**
 * Recognize the fleet-global "records excluded by repository scope" notice.
 * Exclusion is normal steady-state operator scoping, so these render as one
 * compact affordance on the target-repositories row rather than as banners.
 * Anything that does not match the template exactly (including a non-info
 * severity) is not claimed, so unknown signals keep their honest rendering.
 */
export function parseRepoScopeExclusion(warning: CoordinationWarning): RepoScopeExclusion | undefined {
  if (warning.severity !== "info") return undefined;
  const match = warning.message.match(REPO_SCOPE_EXCLUSION_PATTERN);
  if (!match) return undefined;
  return { count: Number(match[1]), label: match[2] };
}

/**
 * Render grouped coordination signals. A group with a single record renders
 * flat so nothing is hidden behind a disclosure; a group with repeats collapses
 * into one counted `<details>` row that expands to every underlying record.
 * Native `<details>`/`<summary>` keeps keyboard and screen-reader support.
 */
export function SignalGroupList<T>({
  groups,
  renderItem,
  ariaLabel
}: {
  groups: SignalGroup<T>[];
  renderItem: (item: T, index: number) => ReactNode;
  ariaLabel?: string;
}) {
  return (
    <ul className="signal-group-list" aria-label={ariaLabel}>
      {groups.map((group) => (
        <li className="signal-group" key={group.key}>
          {group.count === 1 ? (
            <div className="signal-group-single">
              <div className="signal-group-item">{renderItem(group.items[0], 0)}</div>
            </div>
          ) : (
            <details className="signal-group-collapsible">
              <summary className="signal-group-summary">
                <span className="signal-group-count" aria-label={`${group.count} occurrences`}>
                  {group.count}×
                </span>
                <span className="signal-group-label">{group.label}</span>
                <StatusBadge value={group.severity} />
              </summary>
              <div className="signal-group-items">
                {group.items.map((item, index) => (
                  <div className="signal-group-item" key={`${group.key}:${index}`}>
                    {renderItem(item, index)}
                  </div>
                ))}
              </div>
            </details>
          )}
        </li>
      ))}
    </ul>
  );
}
