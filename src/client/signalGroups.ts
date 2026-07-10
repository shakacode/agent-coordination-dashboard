import type { CoordinationWarning, HealthItem, WarningSeverity } from "../shared/types";

export interface SignalGroup<T> {
  key: string;
  severity: WarningSeverity;
  label: string;
  count: number;
  items: T[];
}

const SEVERITY_RANK: Record<WarningSeverity, number> = { critical: 0, warning: 1, info: 2 };

type CanonicalWarningType = {
  pattern: RegExp;
  label: string | ((match: RegExpMatchArray) => string);
};

const CANONICAL_WARNING_TYPES: CanonicalWarningType[] = [
  {
    pattern: /^Claim holder heartbeat currently points at .+#.+\.$/,
    label: "Claim holder heartbeat points at different work."
  },
  {
    pattern: /^Work has a heartbeat from .+ but the claim is held by .+\.$/,
    label: "Work has a heartbeat from an agent other than the claim holder."
  },
  {
    pattern: /^Work has \d+ heartbeat records for the same target\.$/,
    label: "Work has multiple heartbeat records for the same target."
  },
  {
    pattern: /^Work is already scheduled in batch .+:.+ \((.+)\)\.$/,
    label: (match) => `Work is already scheduled in a batch (${match[1]}).`
  },
  {
    pattern: /^Batch lane .+:.+ is blocked on .+\.$/,
    label: "Batch lane is blocked on dependencies."
  },
  {
    pattern: /^Lane .+ owner heartbeat points at .+#.+\.$/,
    label: "Batch lane owner heartbeat points at different work."
  }
];

/**
 * Return a stable warning-type identity for grouped summaries. Known warning
 * templates receive a descriptive label that omits record-specific values;
 * the exact messages remain available in the expanded items. Unknown messages
 * stay distinct except for an explicit numeric `#target` reference.
 */
function warningIdentity(message: string): { key: string; label: string } {
  const normalizedWhitespace = message.replace(/\s+/g, " ").trim();
  for (const warningType of CANONICAL_WARNING_TYPES) {
    const match = normalizedWhitespace.match(warningType.pattern);
    if (match) {
      const label = typeof warningType.label === "function" ? warningType.label(match) : warningType.label;
      return { key: label.toLowerCase(), label };
    }
  }

  const label = normalizedWhitespace.replace(/#\d+\b/g, "#…");
  return { key: label.toLowerCase(), label };
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
  return collect(warnings, (warning) => {
    const identity = warningIdentity(warning.message);
    return {
      key: `${warning.severity}::${identity.key}`,
      severity: warning.severity,
      label: identity.label
    };
  });
}

export function groupHealthItems(items: HealthItem[]): SignalGroup<HealthItem>[] {
  return collect(items, (item) => ({
    key: `${item.severity}::${item.category}::${item.title}`,
    severity: item.severity,
    label: item.title
  }));
}
