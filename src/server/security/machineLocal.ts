import { isIP } from "node:net";
import { networkInterfaces } from "node:os";

export type MachineInterfaceMap = Record<string, ReadonlyArray<{ address: string }> | undefined>;

function canonicalIpv4Address(address: string): string | undefined {
  if (address.startsWith("169.254.")) return undefined;
  return `ipv4:${address}`;
}

function canonicalAddress(address: string): string | undefined {
  if (isIP(address) === 4) return canonicalIpv4Address(address);
  if (isIP(address) !== 6) return undefined;
  try {
    const normalized = new URL(`http://[${address}]`).hostname.slice(1, -1);
    const firstHextet = Number.parseInt(normalized.split(":")[0], 16);
    if ((firstHextet & 0xffc0) === 0xfe80) return undefined;
    const mapped = normalized.match(/^::ffff:([a-f0-9]+):([a-f0-9]+)$/);
    if (!mapped) return `ipv6:${normalized}`;
    const high = Number.parseInt(mapped[1], 16);
    const low = Number.parseInt(mapped[2], 16);
    return canonicalIpv4Address(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`);
  } catch {
    return undefined;
  }
}

export function isMachineLocalAddress(
  address: string | undefined,
  interfaces?: MachineInterfaceMap
): boolean {
  if (!address) return false;
  const canonical = canonicalAddress(address);
  if (!canonical) return false;
  if (canonical === "ipv6:::1") return true;
  if (canonical.startsWith("ipv4:127.")) return true;

  try {
    const localInterfaces = interfaces || networkInterfaces();
    return Object.values(localInterfaces)
      .flatMap((addresses) => addresses || [])
      .some((candidate) => {
        try {
          return canonicalAddress(candidate.address) === canonical;
        } catch {
          return false;
        }
      });
  } catch {
    return false;
  }
}
