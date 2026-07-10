import type { ReactNode } from "react";
import type { SignalGroup } from "../signalGroups";
import { StatusBadge } from "./StatusBadge";

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
