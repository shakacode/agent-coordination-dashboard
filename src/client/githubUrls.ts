/** Validate a GitHub issue/PR URL before normalization can erase authority details. */
export function canonicalGithubItemUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const authority = value.match(/^https:\/\/([^/?#]+)/i)?.[1];
    if (!authority || authority.slice(authority.lastIndexOf("@") + 1).includes(":")) return undefined;
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com" || url.username || url.password || url.port) return undefined;
    const match = url.pathname.match(/^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(issues|pull)\/(\d+)(.*)$/);
    if (!match) return undefined;
    const suffix = match[5].replace(/\/$/, "");
    if (match[3] === "issues" ? suffix !== "" : !/^(?:|\/(?:files|checks|commits)(?:\/[^/]*)*)$/.test(suffix)) return undefined;
    return `https://github.com/${match[1]}/${match[2]}/${match[3]}/${match[4]}`;
  } catch {
    return undefined;
  }
}

export function safePullRequestUrl(value: string): string | undefined {
  return canonicalPullRequestUrl(value);
}

/** Strip safe PR subpages, query parameters, and fragments for action links. */
export function canonicalPullRequestUrl(value: string | undefined): string | undefined {
  const canonical = canonicalGithubItemUrl(value);
  if (!canonical) return undefined;
  return new URL(canonical).pathname.split("/").filter(Boolean)[2] === "pull" ? canonical : undefined;
}

/** Build a GitHub branch URL only from a repository slug and branch-shaped text. */
export function githubBranchUrl(repo: string, branch: string | undefined): string | undefined {
  if (!branch) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) return undefined;
  return `https://github.com/${repo}/tree/${branch.split("/").map(encodeURIComponent).join("/")}`;
}
