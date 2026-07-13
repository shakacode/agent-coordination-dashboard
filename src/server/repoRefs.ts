const SCHEMELESS_GITHUB_REPO_REF_PATTERN = /(?:www\.)?github\.com\/([A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+)/iy;
const OWNER_REPO_REF_PATTERN = /\b([A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+)\b/g;
const OWNER_REPO_REF_AT_PATTERN = /[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+/y;
const OWNER_REPO_ISSUE_REF_PATTERN = /\b([A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+)#\d+\b/g;
const LOCAL_FILE_REF_PATTERN = /\/[^/\s]+\.[A-Za-z0-9]{1,8}$/;
const URL_LABEL_PREFIXES = [
  "blocked", "pr", "status", "phase", "repo", "repository", "waiting", "depends",
  "target", "holder", "branch", "source", "upstream", "owner", "machine", "url",
  "host", "operator", "thread", "thread-handle", "section"
];
const URI_SCHEMES_TO_KEEP = new Set(["http", "https", ...URL_LABEL_PREFIXES]);

function isClearLocalFileReference(ref: string): boolean {
  return LOCAL_FILE_REF_PATTERN.test(ref);
}

function normalizeGithubRepoRef(ref: string): string {
  return ref.replace(/\.+$/, "").replace(/\.git$/i, "").replace(/\.+$/, "");
}

function addGithubRepoRef(refs: Set<string>, rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl.replace(/\.+$/, ""));
    const hostname = url.hostname.toLowerCase();
    const validHost = hostname === "github.com" || hostname === "www.github.com";
    const validPort = (url.protocol === "https:" && (!url.port || url.port === "443")) ||
      (url.protocol === "http:" && (!url.port || url.port === "80"));
    const [owner, repository] = url.pathname.split("/").filter(Boolean);
    if (validHost && validPort && owner && repository && /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(owner) && /^[A-Za-z0-9._-]+$/.test(repository)) {
      refs.add(normalizeGithubRepoRef(`${owner}/${repository}`));
      return true;
    }
  } catch {
    // Ignore malformed URLs; their structured suffix remains visible.
  }
  return false;
}

function schemelessGithubRepoMatchAt(value: string, index: number): RegExpExecArray | null {
  SCHEMELESS_GITHUB_REPO_REF_PATTERN.lastIndex = index;
  return SCHEMELESS_GITHUB_REPO_REF_PATTERN.exec(value);
}

function isHttpUrlAt(value: string, index: number): boolean {
  return value.slice(index, index + 7).toLowerCase() === "http://" || value.slice(index, index + 8).toLowerCase() === "https://";
}

function isRepositoryUrlAt(value: string, index: number): boolean {
  return isHttpUrlAt(value, index) || Boolean(schemelessGithubRepoMatchAt(value, index));
}

function isOwnerRepoRefAt(value: string, index: number): boolean {
  OWNER_REPO_REF_AT_PATTERN.lastIndex = index;
  return Boolean(OWNER_REPO_REF_AT_PATTERN.exec(value));
}

function isValidHttpAuthority(value: string, start: number, end: number): boolean {
  try {
    const url = new URL(value.slice(start, end));
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function hasExplicitUrlLabel(value: string, urlStart: number): boolean {
  return URL_LABEL_PREFIXES.some((label) => {
    const labelStart = urlStart - label.length - 1;
    if (labelStart < 0 || value.slice(labelStart, urlStart).toLowerCase() !== `${label}:`) return false;
    const beforeLabel = value[labelStart - 1] || "";
    return labelStart === 0 || /\s/.test(beforeLabel) || "(<[{'\"`|)]}>,;=!&:?#".includes(beforeLabel);
  });
}

function withoutNonRepositoryUriTokens(value: string): string {
  const output: string[] = [];
  const tokenBoundaries = "(<[{'\"`|)]}>,;=!&:?#";
  let index = 0;
  while (index < value.length) {
    const previous = value[index - 1] || "";
    const tokenBoundary = index === 0 || /\s/.test(previous) || tokenBoundaries.includes(previous);
    if (!tokenBoundary || !/[A-Za-z]/.test(value[index])) {
      output.push(value[index]);
      index += 1;
      continue;
    }

    let schemeEnd = index + 1;
    while (/[A-Za-z0-9+.-]/.test(value[schemeEnd] || "")) schemeEnd += 1;
    const scheme = value.slice(index, schemeEnd).toLowerCase();
    if (value[schemeEnd] !== ":" || URI_SCHEMES_TO_KEEP.has(scheme)) {
      if (value[schemeEnd] === ":" && (scheme === "http" || scheme === "https")) {
        let urlTokenEnd = schemeEnd + 1;
        while (urlTokenEnd < value.length && !/\s/.test(value[urlTokenEnd])) urlTokenEnd += 1;
        const queryIndex = value.slice(index, urlTokenEnd).search(/[?#]/);
        if (queryIndex >= 0) {
          const queryStart = index + queryIndex + 1;
          output.push(value.slice(index, queryStart));
          index = queryStart;
        } else {
          output.push(value.slice(index, urlTokenEnd));
          index = urlTokenEnd;
        }
        continue;
      }
      output.push(value[index]);
      index += 1;
      continue;
    }

    let cursor = schemeEnd + 1;
    const wrapperClosers: string[] = [];
    let quote = "";
    let escaped = false;
    while (cursor < value.length) {
      const character = value[cursor];
      if (!quote && wrapperClosers.length === 0 && /\s/.test(character)) break;
      if (quote) {
        if (escaped) {
          escaped = false;
        } else if (character === "\\") {
          escaped = true;
        } else if (character === quote) {
          quote = "";
        }
        cursor += 1;
        continue;
      }
      if ("'\"`".includes(character)) {
        quote = character;
        cursor += 1;
        continue;
      }
      const openingIndex = "([{<".indexOf(character);
      if (openingIndex >= 0) wrapperClosers.push(")]}>"[openingIndex]);
      if (character === wrapperClosers.at(-1)) wrapperClosers.pop();
      if (character === "|" && wrapperClosers.length === 0) break;
      cursor += 1;
    }
    output.push(" ");
    if (value[cursor] === "|") output.push("| ");
    index = value[cursor] === "|" ? cursor + 1 : cursor;
  }
  return output.join("");
}

function consumeNamedUrlState(value: string, start: number, structuralDelimiters: string, closingDelimiters: string): number {
  const wrapperClosers: string[] = [];
  let quote = "";
  let escaped = false;
  let cursor = start;
  while (cursor < value.length) {
    const character = value[cursor];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = "";
      }
      cursor += 1;
      continue;
    }
    if ("'\"`".includes(character)) {
      const beforeQuote = value[cursor - 1] || "";
      if (cursor === start || "=([{<,:".includes(beforeQuote)) {
        quote = character;
        cursor += 1;
        continue;
      }
      if (wrapperClosers.length === 0) break;
    }
    const openingIndex = "([{<".indexOf(character);
    if (openingIndex >= 0) {
      wrapperClosers.push(")]}>"[openingIndex]);
      cursor += 1;
      continue;
    }
    if (character === wrapperClosers.at(-1)) {
      wrapperClosers.pop();
      cursor += 1;
      continue;
    }
    if (wrapperClosers.length === 0 && (/\s/.test(character) || structuralDelimiters.includes(character) || closingDelimiters.includes(character))) break;
    cursor += 1;
  }
  return cursor;
}

// One forward scan handles both HTTP and schemeless GitHub URLs. `index` and
// every cursor only advance; `forcedBoundary` records a delimiter that was
// consumed while scrubbing so an adjacent repository token can be reconsidered.
function scanHttpText(value: string): { refs: string[]; withoutUrls: string } {
  const refs = new Set<string>();
  const output: string[] = [];
  const openingBoundaries = "(<[{'\"`";
  const structuralDelimiters = "|;=,:!&";
  const closingDelimiters = ")]}>\'\"`";
  let index = 0;
  let forcedBoundary = false;

  while (index < value.length) {
    const isHttp = value.slice(index, index + 7).toLowerCase() === "http://";
    const isHttps = value.slice(index, index + 8).toLowerCase() === "https://";
    const schemelessMatch = schemelessGithubRepoMatchAt(value, index);
    const previous = value[index - 1] || "";
    const validBoundary = index === 0 || forcedBoundary || /\s/.test(previous) || openingBoundaries.includes(previous) || "|;=,!&".includes(previous) ||
      (previous === ":" && hasExplicitUrlLabel(value, index));
    if ((!isHttp && !isHttps && !schemelessMatch) || !validBoundary) {
      output.push(value[index]);
      index += 1;
      forcedBoundary = false;
      continue;
    }

    if (schemelessMatch) {
      refs.add(normalizeGithubRepoRef(schemelessMatch[1]));
      let cursor = index + schemelessMatch[0].length;
      output.push(" ");
      if (value[cursor] === "/") {
        cursor += 1;
        while (cursor < value.length && !/\s/.test(value[cursor]) && !structuralDelimiters.includes(value[cursor]) && !"?#".includes(value[cursor]) && !closingDelimiters.includes(value[cursor])) {
          cursor += 1;
        }
      }
      if ("?#".includes(value[cursor] || "")) {
        const queryDelimiter = value[cursor];
        const queryValueStart = cursor + 1;
        if (isRepositoryUrlAt(value, queryValueStart)) {
          output.push(queryDelimiter, " ");
          index = queryValueStart;
          forcedBoundary = true;
          continue;
        }
        cursor = consumeNamedUrlState(value, queryValueStart, "|;,:!", closingDelimiters);
      }
      if ((structuralDelimiters + closingDelimiters).includes(value[cursor] || "")) {
        output.push(value[cursor], " ");
        index = cursor + 1;
        forcedBoundary = true;
      } else {
        index = cursor;
        forcedBoundary = false;
      }
      continue;
    }

    const schemeEnd = index + (isHttps ? 8 : 7);
    let coarseAuthorityEnd = schemeEnd;
    let lastAt = -1;
    let authorityDelimiter = -1;
    let bracketFallbackDelimiter = -1;
    let bracketDepth = 0;
    let sawBracket = false;
    while (coarseAuthorityEnd < value.length && !/\s/.test(value[coarseAuthorityEnd]) && !"/?#".includes(value[coarseAuthorityEnd])) {
      const character = value[coarseAuthorityEnd];
      if (character === "[") {
        sawBracket = true;
        bracketDepth += 1;
      }
      if (character === "]" && bracketDepth > 0) {
        bracketDepth -= 1;
        coarseAuthorityEnd += 1;
        continue;
      }
      if (character === "@") lastAt = coarseAuthorityEnd;
      if (character === ":" && (isRepositoryUrlAt(value, coarseAuthorityEnd + 1) || isOwnerRepoRefAt(value, coarseAuthorityEnd + 1))) {
        bracketFallbackDelimiter = coarseAuthorityEnd;
      } else if (bracketFallbackDelimiter < 0 && (structuralDelimiters + closingDelimiters).replace(":", "").includes(character)) {
        bracketFallbackDelimiter = coarseAuthorityEnd;
      }
      if (authorityDelimiter < 0 && bracketDepth === 0 && (structuralDelimiters + closingDelimiters).includes(character)) {
        if (character === ":") {
          let portEnd = coarseAuthorityEnd + 1;
          while (/\d/.test(value[portEnd] || "")) portEnd += 1;
          const portBoundary = value[portEnd] || "";
          if (portEnd > coarseAuthorityEnd + 1 && (!portBoundary || portBoundary === "/" || /\s/.test(portBoundary) || structuralDelimiters.includes(portBoundary) || closingDelimiters.includes(portBoundary))) {
            coarseAuthorityEnd = portEnd;
            continue;
          }
        }
        authorityDelimiter = coarseAuthorityEnd;
      }
      coarseAuthorityEnd += 1;
    }
    const delimiterPrefixIsValidAuthority = authorityDelimiter >= 0 && isValidHttpAuthority(value, index, authorityDelimiter);
    if (sawBracket && lastAt >= 0 && !delimiterPrefixIsValidAuthority && isValidHttpAuthority(value, index, coarseAuthorityEnd)) {
      authorityDelimiter = -1;
    } else if (bracketDepth > 0 && authorityDelimiter < 0) {
      authorityDelimiter = bracketFallbackDelimiter;
    }
    let cursor = authorityDelimiter >= 0 ? authorityDelimiter : coarseAuthorityEnd;
    let delimiterIndex = authorityDelimiter >= 0 && (structuralDelimiters + closingDelimiters).includes(value[authorityDelimiter]) ? authorityDelimiter : -1;

    let urlEnd = delimiterIndex >= 0 ? delimiterIndex : cursor;
    if (delimiterIndex < 0 && value[cursor] === "/") {
      cursor += 1;
      while (cursor < value.length && !/\s/.test(value[cursor]) && !structuralDelimiters.includes(value[cursor]) && !"?#".includes(value[cursor]) && !closingDelimiters.includes(value[cursor])) {
        cursor += 1;
      }
      urlEnd = cursor;
      if ((structuralDelimiters + closingDelimiters).includes(value[cursor] || "")) delimiterIndex = cursor;
    }

    if (delimiterIndex < 0 && "?#".includes(value[cursor] || "")) {
      const queryDelimiter = cursor;
      const queryValueStart = cursor + 1;
      if (isRepositoryUrlAt(value, queryValueStart)) {
        delimiterIndex = queryDelimiter;
      } else {
        cursor = consumeNamedUrlState(value, queryValueStart, "|;,:!", closingDelimiters);
        if (("|;,:!" + closingDelimiters).includes(value[cursor] || "")) delimiterIndex = cursor;
      }
    }

    addGithubRepoRef(refs, value.slice(index, urlEnd));
    let canonicalAlternateReplay: string | undefined;
    let canonicalAlternateResume = -1;
    let canonicalAlternateForcesBoundary = false;
    if (authorityDelimiter >= 0 && authorityDelimiter < lastAt) {
      let alternateEnd = coarseAuthorityEnd;
      if (value[alternateEnd] === "/") {
        alternateEnd += 1;
        while (alternateEnd < value.length && !/\s/.test(value[alternateEnd]) && !structuralDelimiters.includes(value[alternateEnd]) && !"?#".includes(value[alternateEnd]) && !closingDelimiters.includes(value[alternateEnd])) {
          alternateEnd += 1;
        }
      }
      if (addGithubRepoRef(refs, value.slice(index, alternateEnd))) {
        canonicalAlternateReplay = value.slice(authorityDelimiter, alternateEnd);
        canonicalAlternateResume = alternateEnd;
        if ("?#".includes(value[canonicalAlternateResume] || "")) {
          const queryDelimiter = value[canonicalAlternateResume];
          const queryValueStart = canonicalAlternateResume + 1;
          if (isRepositoryUrlAt(value, queryValueStart)) {
            canonicalAlternateReplay += `${queryDelimiter} `;
            canonicalAlternateResume = queryValueStart;
            canonicalAlternateForcesBoundary = true;
          } else {
            canonicalAlternateResume = consumeNamedUrlState(value, queryValueStart, "|;,:!", closingDelimiters);
            if ("|;,:!".includes(value[canonicalAlternateResume] || "")) {
              canonicalAlternateReplay += `${value[canonicalAlternateResume]} `;
              canonicalAlternateResume += 1;
              canonicalAlternateForcesBoundary = true;
            }
          }
        }
        if (closingDelimiters.includes(value[canonicalAlternateResume] || "")) {
          canonicalAlternateReplay += `${value[canonicalAlternateResume]} `;
          canonicalAlternateResume += 1;
          canonicalAlternateForcesBoundary = true;
        }
      }
    }

    output.push(" ");
    if (canonicalAlternateReplay !== undefined) {
      output.push(canonicalAlternateReplay);
      index = canonicalAlternateResume;
      forcedBoundary = canonicalAlternateForcesBoundary;
      continue;
    }
    if (delimiterIndex >= 0) {
      output.push(value[delimiterIndex], " ");
      index = delimiterIndex + 1;
      forcedBoundary = true;
    } else {
      index = Math.max(cursor, urlEnd, index + 1);
      forcedBoundary = false;
    }
  }

  return { refs: Array.from(refs), withoutUrls: output.join("") };
}

function githubRepoRefsFromText(value: string): string[] {
  return scanHttpText(withoutNonRepositoryUriTokens(value)).refs;
}

function withoutRepositoryUrls(value: string): string {
  return scanHttpText(withoutNonRepositoryUriTokens(value)).withoutUrls;
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
      const start = match.index || 0;
      const end = start + match[1].length;
      const before = repositoryWithoutGithubUrls[start - 1] || "";
      const after = repositoryWithoutGithubUrls[end] || "";
      if (/[/.]/.test(before) || after === "/") continue;
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
  const textWithoutNonRepositoryUris = withoutNonRepositoryUriTokens(value);
  const refs = new Set<string>();
  for (const ref of githubRepoRefsFromText(textWithoutNonRepositoryUris)) refs.add(ref);
  for (const match of textWithoutNonRepositoryUris.matchAll(OWNER_REPO_ISSUE_REF_PATTERN)) refs.add(match[1]);
  for (const repo of repoRefsFromPromptHeaders(textWithoutNonRepositoryUris)) refs.add(repo);
  const standalone = textWithoutNonRepositoryUris.trim().match(/^([A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+)$/)?.[1];
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

function repoRefsFromStructuredText(structuredText: string): string[] {
  const refs = new Set<string>();
  // Explicit path syntax is the only reliable signal that a slash-shaped
  // value is local. The caller already scrubbed those tokens; bare
  // multi-segment values remain conservative repository candidates.
  const textWithoutRepositoryUrls = withoutRepositoryUrls(structuredText);
  for (const match of textWithoutRepositoryUrls.matchAll(OWNER_REPO_REF_PATTERN)) {
    const start = match.index || 0;
    const before = textWithoutRepositoryUrls[start - 1] || "";
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
  const structuredText = withoutNonRepositoryUriTokens(withoutExplicitStructuredPaths(value));
  const highConfidence = new Set(highConfidenceRepoRefsFromMessage(structuredText));
  const explicitContext = new Set<string>();
  const contextPattern = /\b(?:phase|repo(?:sitory)?|blocked\s+on|waiting\s+on|depends\s+on)\s*:?[ \t]+(?:repo(?:sitory)?[ \t]+)?([A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+)/gi;
  for (const match of structuredText.matchAll(contextPattern)) explicitContext.add(match[1]);

  const candidates = new Set([...repoRefsFromText(structuredText), ...repoRefsFromStructuredText(structuredText), ...highConfidence, ...explicitContext]);
  for (const ref of candidates) {
    // Phrases such as "blocked on owner/repo" are explicit repository
    // evidence and intentionally take precedence over vocabulary exemptions.
    if (highConfidence.has(ref) || explicitContext.has(ref)) {
      refs.add(ref);
      continue;
    }
    if (isStructuredSlashVocabulary(ref) && isCompleteStructuredSlashToken(structuredText, ref)) continue;
    refs.add(ref);
  }
  return Array.from(refs);
}
