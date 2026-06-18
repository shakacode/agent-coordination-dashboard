import type { RequestHandler } from "express";

export function parseHostHeader(hostHeader: string | undefined): string | null {
  if (!hostHeader) {
    return null;
  }

  const host = hostHeader.split(",")[0].trim().toLowerCase();
  if (!host) {
    return null;
  }

  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end > 1 ? host.slice(1, end) : null;
  }

  return host.split(":")[0] || null;
}

export function isAllowedHostHeader(hostHeader: string | undefined, allowedHosts: Iterable<string>): boolean {
  const host = parseHostHeader(hostHeader);
  if (!host) {
    return false;
  }

  const allowed = new Set(Array.from(allowedHosts, (item) => item.toLowerCase()));
  return allowed.has(host);
}

export function createHostGuard(allowedHosts: string[]): RequestHandler {
  return (req, res, next) => {
    if (!isAllowedHostHeader(req.headers.host, allowedHosts)) {
      res.status(403).json({ error: "Forbidden host" });
      return;
    }

    next();
  };
}
