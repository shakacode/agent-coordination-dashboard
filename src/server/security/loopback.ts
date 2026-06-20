const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export function isLoopbackAddress(address: string | undefined): boolean {
  return Boolean(address && LOOPBACK_ADDRESSES.has(address));
}
