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

const STRUCTURED_SLASH_VOCABULARY = [
  /^read\/write$/i,
  /^frontend\/backend$/i,
  /^ci\/(?:passed|failed|pending|queued|running|skipped|cancelled|canceled|success|successful|complete|completed)$/i,
  /^deploy\/(?:staging|production|prod|qa|canary|preview|development|dev|test)$/i
];

function isStructuredSlashVocabulary(ref: string): boolean {
  return STRUCTURED_SLASH_VOCABULARY.some((pattern) => pattern.test(ref));
}

function withoutExplicitStructuredPaths(value: string): string {
  const withoutQuotedPaths = value.replace(
    /(["'`])(?:\.{1,2}\/|[A-Za-z]:\/|file:(?:\/\/(?:localhost)?\/|\/)|\/)[^\r\n]*?\1/gi,
    ""
  );
  const withoutRelativeDriveOrFilePaths = withoutQuotedPaths.replace(
    /(^|[^\p{L}\p{M}\p{N}\p{So}._/@%+~-])(?:\.{1,2}\/|[A-Za-z]:\/|file:(?:\/\/(?:localhost)?\/|\/))[\p{L}\p{M}\p{N}\p{So}@%+~._/-]+/giu,
    "$1"
  );
  return withoutRelativeDriveOrFilePaths.replace(
    /(^|[^\p{L}\p{M}\p{N}\p{So}._/@%+~:-])\/[\p{L}\p{M}\p{N}\p{So}@%+~._/-]+/gu,
    "$1"
  );
}

function isCompleteStructuredSlashToken(structuredText: string, ref: string): boolean {
  return !structuredText.includes(`${ref}/`);
}

function repoRefsFromStructuredText(value: string): string[] {
  const refs = new Set<string>();
  // Explicit path syntax is the only reliable signal that a slash-shaped
  // value is local. Scrub those tokens first; bare multi-segment values remain
  // conservative repository candidates.
  const textWithoutExplicitPaths = withoutExplicitStructuredPaths(value);
  for (const match of textWithoutExplicitPaths.matchAll(OWNER_REPO_REF_PATTERN)) {
    const start = match.index || 0;
    const before = textWithoutExplicitPaths[start - 1] || "";
    if (/[/.]/.test(before)) continue;
    refs.add(match[1]);
  }
  return Array.from(refs);
}

/**
 * Event type/status fields are structured enough to recognize embedded repo
 * references, but they also use conventional slash vocabulary. High-confidence
 * and explicit-context refs take precedence over that vocabulary; otherwise
 * only known operational terms are exempted and every remaining slash ref is
 * conservatively treated as repository identity evidence.
 */
export function repoRefsFromStructuredEventField(value: string | undefined): string[] {
  if (!value) return [];
  const refs = new Set<string>();
  const structuredText = withoutExplicitStructuredPaths(value);
  const highConfidence = new Set(highConfidenceRepoRefsFromMessage(value));
  const explicitContext = new Set<string>();
  const contextPattern = /\b(?:phase|repo(?:sitory)?|blocked\s+on|waiting\s+on|depends\s+on)\s*:?[ \t]+(?:repo(?:sitory)?[ \t]+)?([A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+)/gi;
  for (const match of value.matchAll(contextPattern)) explicitContext.add(match[1]);

  const candidates = new Set([...repoRefsFromText(value), ...repoRefsFromStructuredText(value), ...highConfidence, ...explicitContext]);
  for (const ref of candidates) {
    if (highConfidence.has(ref) || explicitContext.has(ref)) {
      refs.add(ref);
      continue;
    }
    if (isStructuredSlashVocabulary(ref) && isCompleteStructuredSlashToken(structuredText, ref)) continue;
    refs.add(ref);
  }
  return Array.from(refs);
}
