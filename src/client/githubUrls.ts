/** Accept a safe GitHub PR page and return its original URL. */
export function safePullRequestUrl(value: string): string | undefined {
  try {
    const authority = value.match(/^https:\/\/([^/?#]+)/i)?.[1];
    if (!authority || authority.slice(authority.lastIndexOf("@") + 1).includes(":")) return undefined;
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com" || url.username || url.password || url.port) return undefined;
    return /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+(?:\/(?:files|checks|commits)(?:\/[^/]*)*)?\/?$/.test(url.pathname)
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

/** Strip safe PR subpages, query parameters, and fragments for action links. */
export function canonicalPullRequestUrl(value: string): string | undefined {
  const safe = safePullRequestUrl(value);
  if (!safe) return undefined;
  const match = new URL(safe).pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  return match ? `https://github.com/${match[1]}/${match[2]}/pull/${match[3]}` : undefined;
}
