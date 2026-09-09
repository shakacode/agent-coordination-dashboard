import { describe, expect, it } from "vitest";
import {
  API_FETCH_TIMEOUT_MS,
  LOOPBACK_API_HOSTS,
  apiStateListUrl,
  parseApiBaseUrl
} from "./coordinationApiUrl";

describe("parseApiBaseUrl", () => {
  it("accepts an https base URL with a path", () => {
    expect(parseApiBaseUrl("https://coord.example.test/base").href).toBe("https://coord.example.test/base");
  });

  it.each([...LOOPBACK_API_HOSTS].map((host) => [host, `http://${host}:8787`] as const))(
    "accepts a plaintext base URL that points at %s",
    (_host, apiUrl) => {
      expect(parseApiBaseUrl(apiUrl).protocol).toBe("http:");
    }
  );

  it("rejects a plaintext base URL that leaves the machine", () => {
    expect(() => parseApiBaseUrl("http://coord.example.test")).toThrow(
      "HTTP coordination API URLs must use https unless they point at localhost"
    );
  });

  it.each([
    ["a websocket scheme", "ws://coord.example.test"],
    ["a file URL", "file:///etc/passwd"]
  ])("rejects %s", (_label, apiUrl) => {
    expect(() => parseApiBaseUrl(apiUrl)).toThrow("expected http(s) URL with host");
  });

  it("rejects a value that is not a URL at all", () => {
    expect(() => parseApiBaseUrl("not a url")).toThrow();
  });

  it.each([
    ["a query string", "https://coord.example.test/?tenant=a"],
    ["a fragment", "https://coord.example.test/#tenant"],
    // A bare `?` or `#` serializes with the marker and reads back as an empty
    // `search`/`hash`, so a check on those properties alone would pass the
    // guard and still fold `/v1/state` into the query or the fragment.
    ["a bare query marker", "https://coord.example.test/?"],
    ["a bare fragment marker", "https://coord.example.test/#"]
  ])("rejects a base URL carrying %s", (_label, apiUrl) => {
    expect(() => parseApiBaseUrl(apiUrl)).toThrow("expected an http(s) URL with no query string or fragment");
  });

  it.each([
    ["a username and password", "https://user:pass@coord.example.test"],
    ["a username alone", "https://user@coord.example.test"]
  ])("rejects a base URL carrying %s", (_label, apiUrl) => {
    expect(() => parseApiBaseUrl(apiUrl)).toThrow("expected an http(s) URL with no embedded username or password");
  });
});

describe("apiStateListUrl", () => {
  it("appends the state path to the base without dropping its own path", () => {
    expect(apiStateListUrl(parseApiBaseUrl("https://coord.example.test/base"), "claims").href).toBe(
      "https://coord.example.test/base/v1/state?prefix=claims"
    );
  });

  it("collapses trailing slashes on the base rather than doubling them", () => {
    expect(apiStateListUrl(parseApiBaseUrl("https://coord.example.test///"), "events").href).toBe(
      "https://coord.example.test/v1/state?prefix=events"
    );
  });

  it("encodes a prefix instead of letting it add a second query parameter", () => {
    const url = apiStateListUrl(
      parseApiBaseUrl("https://coord.example.test"),
      "attention/default/shakacode/agent-coordination&token=leaked"
    );

    expect(url.searchParams.get("prefix")).toBe("attention/default/shakacode/agent-coordination&token=leaked");
    expect([...url.searchParams.keys()]).toEqual(["prefix"]);
  });
});

describe("coordination API request budget", () => {
  it("bounds one request at five seconds", () => {
    expect(API_FETCH_TIMEOUT_MS).toBe(5000);
  });
});
