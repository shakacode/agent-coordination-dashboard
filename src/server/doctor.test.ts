import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readDoctorReport } from "./doctor";

const roots: string[] = [];
const servers: Server[] = [];

async function stateRootWithResourceDirectories(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "coord-doctor-fs-"));
  roots.push(root);
  await Promise.all(
    ["claims", "heartbeats", "batches", "events"].map((resource) => mkdir(join(root, resource), { recursive: true }))
  );
  return root;
}

async function listenCoordinationApi(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler).listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP address for the coordination API fixture.");
  }
  return `http://127.0.0.1:${address.port}`;
}

function respondWith(status: number, body: unknown): Parameters<typeof createServer>[1] {
  return (_req, res) => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  };
}

describe("readDoctorReport", () => {
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
  });

  it("reports every initialized but empty filesystem resource", async () => {
    const stateRoot = await stateRootWithResourceDirectories();
    const checkedAt = new Date("2026-09-05T12:00:00.000Z");

    const report = await readDoctorReport({ stateRoot, now: () => checkedAt });

    expect(report).toEqual({
      apiUrl: null,
      tokenEnvVar: null,
      stateRoot,
      perResource: ["claims", "heartbeats", "batches", "events"].map((resource) => ({
        resource,
        mode: "fs",
        status: "empty",
        checkedAt: checkedAt.toISOString()
      }))
    });
  });

  it("reports a populated filesystem resource without reading its files", async () => {
    const stateRoot = await stateRootWithResourceDirectories();
    await writeFile(join(stateRoot, "claims", "not-json.txt"), "{not-json", "utf8");

    const report = await readDoctorReport({ stateRoot });

    expect(report.perResource).toEqual([
      expect.objectContaining({ resource: "claims", mode: "fs", status: "ok" }),
      expect.objectContaining({ resource: "heartbeats", mode: "fs", status: "empty" }),
      expect.objectContaining({ resource: "batches", mode: "fs", status: "empty" }),
      expect.objectContaining({ resource: "events", mode: "fs", status: "empty" })
    ]);
  });

  it("reports an uninitialized coordination root as empty rather than unreachable", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "coord-doctor-missing-"));
    roots.push(stateRoot);

    const report = await readDoctorReport({ stateRoot });

    expect(report.perResource.every((status) => status.mode === "fs" && status.status === "empty")).toBe(true);
    expect(report.perResource.every((status) => status.httpStatus === undefined)).toBe(true);
  });

  it("reports an unreadable resource directory as unreachable", async () => {
    const stateRoot = await stateRootWithResourceDirectories();
    await writeFile(join(stateRoot, "not-a-directory"), "", "utf8");

    const report = await readDoctorReport({ stateRoot: join(stateRoot, "not-a-directory") });

    expect(report.perResource.every((status) => status.mode === "fs" && status.status === "unreachable")).toBe(true);
  });

  it("classifies a rejected coordination API as an auth error without exposing the token", async () => {
    const apiUrl = await listenCoordinationApi(respondWith(401, { error: "unauthorized" }));

    const report = await readDoctorReport({
      stateRoot: "/unused/state/root",
      apiUrl,
      token: "secret-token-value",
      tokenEnvVar: "AGENT_COORD_API_TOKEN"
    });

    expect(report).toEqual({
      apiUrl: new URL(apiUrl).href,
      tokenEnvVar: "AGENT_COORD_API_TOKEN",
      stateRoot: "/unused/state/root",
      perResource: ["claims", "heartbeats", "batches", "events"].map((resource) =>
        expect.objectContaining({ resource, mode: "api", status: "auth_error", httpStatus: 401 })
      )
    });
    expect(JSON.stringify(report)).not.toContain("secret-token-value");
  });

  it("reports a reachable coordination API as ok and sends the bearer token", async () => {
    const authorizations: string[] = [];
    const prefixes: (string | null)[] = [];
    const apiUrl = await listenCoordinationApi((req, res) => {
      authorizations.push(String(req.headers.authorization));
      prefixes.push(new URL(req.url || "/", "http://127.0.0.1").searchParams.get("prefix"));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ entries: [] }));
    });

    const report = await readDoctorReport({ stateRoot: "/unused/state/root", apiUrl, token: "api-token" });

    expect(report.stateRoot).toBe("/unused/state/root");
    expect(report.perResource).toEqual([
      expect.objectContaining({ resource: "claims", mode: "api", status: "ok", httpStatus: 200 }),
      expect.objectContaining({ resource: "heartbeats", mode: "api", status: "ok", httpStatus: 200 }),
      expect.objectContaining({ resource: "batches", mode: "api", status: "ok", httpStatus: 200 }),
      expect.objectContaining({ resource: "events", mode: "api", status: "ok", httpStatus: 200 })
    ]);
    expect(new Set(authorizations)).toEqual(new Set(["Bearer api-token"]));
    expect(new Set(prefixes)).toEqual(new Set(["claims", "heartbeats", "batches", "events"]));
  });

  it("reports an unexpected coordination API status as unreachable", async () => {
    const apiUrl = await listenCoordinationApi(respondWith(503, { error: "unavailable" }));

    const report = await readDoctorReport({ stateRoot: "/unused/state/root", apiUrl, token: "api-token" });

    expect(report.perResource.every((status) => status.status === "unreachable" && status.httpStatus === 503)).toBe(true);
  });

  it("reports an unreachable coordination API without an HTTP status", async () => {
    const report = await readDoctorReport({
      stateRoot: "/unused/state/root",
      apiUrl: "https://coord.example.test",
      token: "api-token",
      fetchImpl: async () => {
        throw new Error("connection refused");
      }
    });

    expect(report.perResource.every((status) => status.status === "unreachable" && status.httpStatus === undefined)).toBe(true);
  });

  it("reports an unusable API URL as unreachable and a missing token as an auth error", async () => {
    await expect(
      readDoctorReport({ stateRoot: "/unused/state/root", apiUrl: "http://coord.example.test", token: "api-token" })
    ).resolves.toMatchObject({
      stateRoot: "/unused/state/root",
      perResource: [
        expect.objectContaining({ status: "unreachable" }),
        expect.objectContaining({ status: "unreachable" }),
        expect.objectContaining({ status: "unreachable" }),
        expect.objectContaining({ status: "unreachable" })
      ]
    });

    await expect(
      readDoctorReport({ stateRoot: "/unused/state/root", apiUrl: "https://coord.example.test", token: "  " })
    ).resolves.toMatchObject({
      perResource: [
        expect.objectContaining({ status: "auth_error" }),
        expect.objectContaining({ status: "auth_error" }),
        expect.objectContaining({ status: "auth_error" }),
        expect.objectContaining({ status: "auth_error" })
      ]
    });
  });

  it("reports the API URL without credentials, query, or fragment", async () => {
    const report = await readDoctorReport({
      stateRoot: "/unused/state/root",
      apiUrl: "https://user:URLSECRET@coord.example.test/path?token=URLSECRET#frag",
      token: "api-token",
      fetchImpl: async () => new Response("{}", { status: 200 })
    });

    expect(report.apiUrl).toBe("https://coord.example.test/path");
    expect(JSON.stringify(report)).not.toContain("URLSECRET");
    expect(JSON.stringify(report)).not.toContain("user");
    expect(report.perResource.every((status) => status.status === "ok")).toBe(true);
  });

  it("reports an unparseable coordination API URL as UNKNOWN", async () => {
    const report = await readDoctorReport({ stateRoot: "/unused/state/root", apiUrl: "not a url", token: "api-token" });

    expect(report.apiUrl).toBe("UNKNOWN");
    expect(report.perResource.every((status) => status.status === "unreachable")).toBe(true);
  });

  it("treats a blank coordination API URL as filesystem mode", async () => {
    const stateRoot = await stateRootWithResourceDirectories();

    const report = await readDoctorReport({ stateRoot, apiUrl: "   ", token: "api-token" });

    expect(report.apiUrl).toBeNull();
    expect(report.stateRoot).toBe(stateRoot);
    expect(report.perResource.every((status) => status.mode === "fs")).toBe(true);
  });
});
