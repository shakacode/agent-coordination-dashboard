const HTTP_URL_SCAN_PATTERN = /(^|[\s(<\[{'"`])https?:\/\/[^\s)]+/gim;
const HTTP_URL_TEXT_PATTERN = /(^|[\s(<\[{'"`])https?:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:\/[^\s)\]}>,'"`|;=&#?!:]*)?/gim;
const SCHEMELESS_GITHUB_REPO_REF_PATTERN = /(^|[\s(<\[{'"`])(?:www\.)?github\.com\/([A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+)/gimu;
const SCHEMELESS_GITHUB_URL_TEXT_PATTERN = /(^|[\s(<\[{'"`])(?:www\.)?github\.com\/[^\s)\]}>,'"`|;=&#?!:]+/gimu;
const OWNER_REPO_REF_PATTERN = /\b([A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+)\b/g;
const OWNER_REPO_ISSUE_REF_PATTERN = /\b([A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+)#\d+\b/g;
const LOCAL_FILE_REF_PATTERN = /\/[^/\s]+\.[A-Za-z0-9]{1,8}$/;

function isClearLocalFileReference(ref: string): boolean {
  return LOCAL_FILE_REF_PATTERN.test(ref);
}

function normalizeGithubRepoRef(ref: string): string {
  return ref.replace(/\.+$/, "").replace(/\.git$/i, "").replace(/\.+$/, "");
}

function githubRepoRefsFromText(value: string): string[] {
  const refs = new Set<string>();
  for (const match of value.matchAll(HTTP_URL_SCAN_PATTERN)) {
    const rawUrl = match[0].slice(match[1].length).replace(/[>\],.'"`]+$/, "");
    try {
      const url = new URL(rawUrl);
      const hostname = url.hostname.toLowerCase();
      if (hostname !== "github.com" && hostname !== "www.github.com") continue;
      if (url.protocol === "https:" && url.port && url.port !== "443") continue;
      if (url.protocol === "http:" && url.port && url.port !== "80") continue;
      if (url.protocol !== "https:" && url.protocol !== "http:") continue;
      const [owner, rawRepository] = url.pathname.split("/").filter(Boolean);
      const repository = rawRepository?.split(/[|;=&#?,:!]/, 1)[0];
      if (!owner || !repository || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(repository)) continue;
      refs.add(normalizeGithubRepoRef(`${owner}/${repository}`));
    } catch {
      // Ignore malformed URLs and continue with explicit schemeless refs.
    }
  }
  const withoutHttpUrls = value.replace(HTTP_URL_TEXT_PATTERN, "$1");
  for (const match of withoutHttpUrls.matchAll(SCHEMELESS_GITHUB_REPO_REF_PATTERN)) {
    refs.add(normalizeGithubRepoRef(match[2]));
  }
  return Array.from(refs);
}

function withoutRepositoryUrls(value: string): string {
  return value
    .replace(HTTP_URL_TEXT_PATTERN, "$1")
    .replace(SCHEMELESS_GITHUB_URL_TEXT_PATTERN, "$1");
}

export function repoRefsFromText(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  const refs = new Set<string>();
  for (const ref of githubRepoRefsFromText(value)) refs.add(ref);
  const textWithoutGithubUrls = withoutRepositoryUrls(value);
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
    for (const ref of githubRepoRefsFromText(repository)) refs.add(ref);
    const repositoryWithoutGithubUrls = withoutRepositoryUrls(repository);
    for (const match of repositoryWithoutGithubUrls.matchAll(OWNER_REPO_REF_PATTERN)) {
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
  for (const ref of githubRepoRefsFromText(value)) refs.add(ref);
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
  const explicitPathPrefix = String.raw`(?:\.{1,2}\/|[A-Za-z]:\/|file:(?:\/\/(?:localhost)?\/|\/)|\/)`;
  const quotedPathPatterns = [
    new RegExp(`(?<!\\\\)((?:\\\\\\\\)*)"${explicitPathPrefix}(?:\\\\[^\\u0000-\\u001F\\u007F-\\u009F\\u200B\\u2028\\u2029]|[^"\\\\\\u0000-\\u001F\\u007F-\\u009F\\u200B\\u2028\\u2029])*"`, "gi"),
    new RegExp(`(?<!\\\\)((?:\\\\\\\\)*)'${explicitPathPrefix}(?:\\\\[^\\u0000-\\u001F\\u007F-\\u009F\\u200B\\u2028\\u2029]|[^'\\\\\\u0000-\\u001F\\u007F-\\u009F\\u200B\\u2028\\u2029])*'`, "gi"),
    new RegExp(`(?<!\\\\)((?:\\\\\\\\)*)\`${explicitPathPrefix}(?:\\\\[^\\u0000-\\u001F\\u007F-\\u009F\\u200B\\u2028\\u2029]|[^\`\\\\\\u0000-\\u001F\\u007F-\\u009F\\u200B\\u2028\\u2029])*\``, "gi")
  ];
  const withoutQuotedPaths = quotedPathPatterns.reduce(
    (text, pattern) => text.replace(pattern, (_match, evenBackslashes: string) => `${evenBackslashes} `),
    value
  );
  const withoutRelativeDriveOrFilePaths = withoutQuotedPaths.replace(
    /(^|[^\p{L}\p{M}\p{N}\p{So}\p{Sk}\u200D._/@%+~-])(?:\.{1,2}\/|[A-Za-z]:\/|file:(?:\/\/(?:localhost)?\/|\/))[\p{L}\p{M}\p{N}\p{So}\p{Sk}\u200D@%+~._/-]+/giu,
    "$1"
  );
  return withoutRelativeDriveOrFilePaths.replace(
    /(^|[^\p{L}\p{M}\p{N}\p{So}\p{Sk}\u200D._/@%+~:-])\/[\p{L}\p{M}\p{N}\p{So}\p{Sk}\u200D@%+~._/-]+/gu,
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
  const textWithoutExplicitPaths = withoutRepositoryUrls(withoutExplicitStructuredPaths(value));
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
  const highConfidence = new Set(highConfidenceRepoRefsFromMessage(structuredText));
  const explicitContext = new Set<string>();
  const contextPattern = /\b(?:phase|repo(?:sitory)?|blocked\s+on|waiting\s+on|depends\s+on)\s*:?[ \t]+(?:repo(?:sitory)?[ \t]+)?([A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+)/gi;
  for (const match of structuredText.matchAll(contextPattern)) explicitContext.add(match[1]);

  const candidates = new Set([...repoRefsFromText(structuredText), ...repoRefsFromStructuredText(structuredText), ...highConfidence, ...explicitContext]);
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
