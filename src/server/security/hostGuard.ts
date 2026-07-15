import type { RequestHandler } from "express";
import { isLoopbackAddress } from "./loopback";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const LOOPBACK_DIAGNOSTIC_PATHS = new Set(["/api/health", "/api/doctor"]);

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

export function isAllowedHostHeader(
  hostHeader: string | undefined,
  allowedHosts: Iterable<string>,
  remoteAddress?: string,
  requestPath?: string
): boolean {
  const host = parseHostHeader(hostHeader);
  if (!host) {
    return false;
  }

  const allowed = new Set(Array.from(allowedHosts, (item) => item.toLowerCase()));
  const localDiagnostic = LOOPBACK_DIAGNOSTIC_PATHS.has(requestPath || "")
    && LOOPBACK_HOSTS.has(host)
    && isLoopbackAddress(remoteAddress);
  return allowed.has(host) || localDiagnostic;
}

export function createHostGuard(allowedHosts: string[]): RequestHandler {
  return (req, res, next) => {
    if (!isAllowedHostHeader(req.headers.host, allowedHosts, req.socket.remoteAddress, req.path)) {
      res.status(403).json({ error: "Forbidden host" });
      return;
    }

    next();
  };
}
