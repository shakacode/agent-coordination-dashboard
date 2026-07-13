const GITHUB_REPO_REF_PATTERN = /github\.com\/([^/\s)]+\/[^/\s)]+)/gi;
const OWNER_REPO_REF_PATTERN = /\b([A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+)\b/g;
const OWNER_REPO_ISSUE_REF_PATTERN = /\b([A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+)#\d+\b/g;
const LOCAL_FILE_REF_PATTERN = /\/[^/\s]+\.[A-Za-z0-9]{1,8}$/;

function isClearLocalFileReference(ref: string): boolean {
  return LOCAL_FILE_REF_PATTERN.test(ref);
}

export function repoRefsFromText(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  const refs = new Set<string>();
  for (const match of value.matchAll(GITHUB_REPO_REF_PATTERN)) {
    refs.add(match[1]);
  }
  const textWithoutGithubUrls = value.replace(/https:\/\/github\.com\/[^\s)]+/gi, "");
  for (const match of textWithoutGithubUrls.matchAll(OWNER_REPO_REF_PATTERN)) {
    const start = match.index || 0;
    const end = start + match[1].length;
    const before = textWithoutGithubUrls[start - 1] || "";
    const after = textWithoutGithubUrls[end] || "";
    if (/[/.]/.test(before) || after === "/" || isClearLocalFileReference(match[1])) {
      continue;
    }
    refs.add(match[1]);
  }
  return Array.from(refs);
}

export function repoRefsFromBranch(value: string | undefined): string[] {
  return value && (/github\.com\//i.test(value) || /\s/.test(value)) ? repoRefsFromText(value) : [];
}

export function repoRefsFromPromptHeaders(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  const refs = new Set<string>();
  for (const line of value.split(/\r?\n/)) {
    const repository = line.trim().match(/^Repository:\s*(.+)$/i)?.[1] || "";
    for (const match of repository.matchAll(OWNER_REPO_REF_PATTERN)) {
      refs.add(match[1]);
    }
  }
  return Array.from(refs);
}

/**
 * Free-form telemetry messages commonly contain harmless slash prose. Only
 * treat explicit GitHub URLs, owner/repo#number references, prompt repository
 * headers, and a standalone owner/repo value as repository identity evidence.
 */
export function highConfidenceRepoRefsFromMessage(value: string | undefined): string[] {
  if (!value) return [];
  const refs = new Set<string>();
  for (const match of value.matchAll(GITHUB_REPO_REF_PATTERN)) refs.add(match[1]);
  for (const match of value.matchAll(OWNER_REPO_ISSUE_REF_PATTERN)) refs.add(match[1]);
  for (const repo of repoRefsFromPromptHeaders(value)) refs.add(repo);
  const standalone = value.trim().match(/^([A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+)$/)?.[1];
  if (standalone) refs.add(standalone);
  return Array.from(refs);
}
