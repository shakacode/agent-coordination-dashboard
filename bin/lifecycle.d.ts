export function assertSupportedLifecyclePlatform(platform?: string): void;
export interface LifecycleLogWriteStream {
  fd: number;
  write: (...args: unknown[]) => boolean;
}
export function installLifecycleLogWriter(
  stdout?: LifecycleLogWriteStream,
  stderr?: LifecycleLogWriteStream,
  maxBytes?: number
): () => void;
export function bindHostCoversProbeHost(
  bindHost: string,
  probeHost: string,
  ipv6WildcardCoversIpv4?: boolean
): boolean;
export function ownedEndpointCoversCandidateBind(
  currentEndpoint: {
    address: string;
    ipv6WildcardCoversIpv4: boolean;
    port: number;
  } | null,
  preparedStart: { bindAddress: string; port: number }
): boolean;
export function probeHostsForBindHost(
  host: string,
  bindAddress?: string,
  ipv6WildcardCoversIpv4?: boolean,
  interfaces?: Record<string, Array<{ address: string; family: string | number }> | undefined>
): string[];
export function readLifecycleLogTail(
  handle: {
    stat: () => Promise<{ size: number }>;
    read: (
      buffer: Buffer,
      offset: number,
      length: number,
      position: number
    ) => Promise<{ bytesRead: number }>;
  },
  maxBytes?: number
): Promise<{ contents: Buffer; truncated: boolean }>;
export function processGroupInventoryHasLiveProcesses(states: string[] | null): boolean;
export function resolvedLocalhostIsLoopback(address: string): boolean;
