const LEGACY_UNKNOWN = /^unknown(?:\s+(?:agent|batch|branch|host|lane|machine|operator|repo|target|thread|title|url))?$/i;

export function hasDisplayAttribution(value: string | undefined | null): value is string {
  return Boolean(value?.trim() && !LEGACY_UNKNOWN.test(value.trim()));
}

export function displayAttribution(value: string | undefined | null, fallback = "unattributed"): string {
  return hasDisplayAttribution(value) ? value.trim() : fallback;
}

export function firstDisplayAttribution(values: Array<string | undefined | null>, fallback = "unattributed"): string {
  return displayAttribution(values.find(hasDisplayAttribution), fallback);
}
