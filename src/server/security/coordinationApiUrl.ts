/**
 * The one place `AGENT_COORD_API_URL` is turned into a request URL.
 *
 * `src/server/coordinationApi.ts` and `src/server/doctor.ts` both build
 * `GET /v1/state` requests against the operator-supplied base URL, and both
 * carried their own copy of the parse rules, the loopback host set, and the
 * request timeout. Two copies of a security rule drift: the read client had
 * already grown the query/fragment and userinfo refusals that the doctor's copy
 * never got, so the same misconfiguration was refused in one module and quietly
 * obeyed in the other. The stricter rules are the ones kept here, and both
 * callers now import them (PR #143 review,
 * https://github.com/shakacode/agent-coordination-dashboard/pull/143#discussion_r3944080504).
 *
 * This module lives beside `hostGuard`, `loopback`, and `machineLocal` because
 * it is the same kind of thing: a request-validation helper with no I/O of its
 * own.
 */

/**
 * Bound on one coordination API request.
 *
 * A caller that also reads a response body gives the body its own budget: a
 * stalled stream must not inherit whatever is left of the request's budget.
 */
export const API_FETCH_TIMEOUT_MS = 5000;

/**
 * The hosts a plaintext coordination API URL may name.
 *
 * `URL.hostname` keeps the brackets on IPv6 literals per the WHATWG URL spec,
 * so `[::1]` is deliberate, not a typo.
 */
export const LOOPBACK_API_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Parse the configured coordination API base URL, or throw with the reason.
 *
 * Throwing is the contract: every caller reports an unusable base URL as
 * `unreachable` rather than sending an authenticated request somewhere the
 * operator did not configure. The message is safe to log — it never contains
 * the URL.
 */
export function parseApiBaseUrl(apiUrl: string): URL {
  const url = new URL(apiUrl);
  if (!["http:", "https:"].includes(url.protocol) || !url.host) {
    throw new Error("expected http(s) URL with host");
  }
  if (url.protocol === "http:" && !LOOPBACK_API_HOSTS.has(url.hostname)) {
    throw new Error("HTTP coordination API URLs must use https unless they point at localhost");
  }
  // `apiStateListUrl` appends `/v1/state` to the base as text. A base that
  // already carries a query string or fragment would swallow that suffix into
  // the query (or hash) and send an authenticated request to the origin root
  // instead, so the misconfiguration is refused here rather than misrouted.
  // The test is on the serialized URL, not on `url.search`/`url.hash`: both
  // read as "" for a bare `?` or `#`, which `toString()` still preserves and
  // the concatenation still swallows. A path may only hold `?`/`#`
  // percent-encoded, so this cannot reject an otherwise valid base.
  if (/[?#]/.test(url.toString())) {
    throw new Error("expected an http(s) URL with no query string or fragment");
  }
  // Same reasoning one step further: userinfo in the base would ride along in
  // every state request URL beside the bearer token, so an operator who pasted
  // credentials into AGENT_COORD_API_URL is told rather than quietly obeyed.
  if (url.username || url.password) {
    throw new Error("expected an http(s) URL with no embedded username or password");
  }
  return url;
}

/**
 * `<base>/v1/state?prefix=<prefix>` for a base {@link parseApiBaseUrl} accepted.
 *
 * The prefix is a plain string because the two callers name different things
 * with it: a branded `attention/<workspace>/<owner>/<name>` prefix in the read
 * client, a coordination resource name in the doctor. `searchParams.set`
 * encodes whatever it is given, so neither can inject a second parameter.
 */
export function apiStateListUrl(baseUrl: URL, prefix: string): URL {
  const url = new URL(`${baseUrl.toString().replace(/\/+$/, "")}/v1/state`);
  url.searchParams.set("prefix", prefix);
  return url;
}
