import { isIP } from "node:net";

export function isNonLinkLocalInterfaceAddress(address) {
  if (isIP(address) === 4) return !address.startsWith("169.254.");
  if (isIP(address) !== 6) return false;
  try {
    const normalized = new URL(`http://[${address}]`).hostname.slice(1, -1);
    const mapped = normalized.match(/^::ffff:([a-f0-9]+):([a-f0-9]+)$/);
    if (mapped) {
      const high = Number.parseInt(mapped[1], 16);
      const low = Number.parseInt(mapped[2], 16);
      return isNonLinkLocalInterfaceAddress(
        `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`
      );
    }
    const firstHextet = Number.parseInt(normalized.split(":")[0], 16);
    return (firstHextet & 0xffc0) !== 0xfe80;
  } catch {
    return false;
  }
}

export function dashboardHostsForInterfaceAddress(address) {
  const isIpv6 = address.family === "IPv6" || address.family === 6;
  return {
    localAddress: isIpv6 ? "::1" : "127.0.0.1",
    urlHost: isIpv6 ? `[${address.address}]` : address.address
  };
}

export function localSourceAddressForDashboardHost(host) {
  return isIP(host) === 4 && host.startsWith("127.") ? "127.0.0.1" : null;
}
