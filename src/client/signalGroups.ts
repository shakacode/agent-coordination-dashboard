import type { CoordinationWarning, HealthItem, WarningSeverity } from "../shared/types";

export interface SignalGroup<T> {
  key: string;
  severity: WarningSeverity;
  label: string;
  count: number;
  items: T[];
}

const SEVERITY_RANK: Record<WarningSeverity, number> = { critical: 0, warning: 1, info: 2 };

/**
 * Normalize a free-text signal message so records that differ only by an
 * embedded identifier (target number, machine id, status code) collapse into a
 * single group. The human-facing label keeps the first raw message, so the
 * placeholder form is only ever used as a grouping key.
 */
function normalizeMessage(message: string): string {
  return message
    .replace(/\b\d+\b/g, "N")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function sortGroups<T>(groups: SignalGroup<T>[]): SignalGroup<T>[] {
  return groups.sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.count - a.count || a.label.localeCompare(b.label)
  );
}

function collect<T>(
  items: T[],
  keyOf: (item: T) => { key: string; severity: WarningSeverity; label: string }
): SignalGroup<T>[] {
  const groups = new Map<string, SignalGroup<T>>();
  for (const item of items) {
    const { key, severity, label } = keyOf(item);
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      existing.items.push(item);
    } else {
      groups.set(key, { key, severity, label, count: 1, items: [item] });
    }
  }
  return sortGroups(Array.from(groups.values()));
}

export function groupWarnings(warnings: CoordinationWarning[]): SignalGroup<CoordinationWarning>[] {
  return collect(warnings, (warning) => ({
    key: `${warning.severity}::${normalizeMessage(warning.message)}`,
    severity: warning.severity,
    label: warning.message
  }));
}

export function groupHealthItems(items: HealthItem[]): SignalGroup<HealthItem>[] {
  return collect(items, (item) => ({
    key: `${item.severity}::${item.category}::${item.title}`,
    severity: item.severity,
    label: item.title
  }));
}
