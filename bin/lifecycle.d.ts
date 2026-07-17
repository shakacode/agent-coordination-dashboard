export function assertSupportedLifecyclePlatform(platform?: string): void;
export function bindHostCoversProbeHost(
  bindHost: string,
  probeHost: string,
  ipv6WildcardCoversIpv4?: boolean
): boolean;
export function probeHostsForBindHost(
  host: string,
  bindAddress?: string,
  ipv6WildcardCoversIpv4?: boolean,
  interfaces?: Record<string, Array<{ address: string; family: string | number }> | undefined>
): string[];
