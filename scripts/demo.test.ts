import { spawn, type ChildProcessByStdio } from "node:child_process";
import { once } from "node:events";
import { access, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import type { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];

async function unusedPort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP address for the demo test server.");
  }
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

type DemoChild = ChildProcessByStdio<null, Readable, Readable>;

function captureOutput(child: DemoChild): { text: string } {
  const output = { text: "" };
  child.stdout.on("data", (chunk) => {
    output.text += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    output.text += String(chunk);
  });
  return output;
}

async function waitForOutput(
  child: DemoChild,
  output: { text: string },
  pattern: RegExp,
  timeoutMs = 15_000
): Promise<RegExpMatchArray> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = output.text.match(pattern);
    if (match) {
      return match;
    }
    if (child.exitCode !== null) {
      throw new Error(`Demo exited with ${child.exitCode} before ${pattern}:\n${output.text}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${pattern}:\n${output.text}`);
}

describe("demo dashboard", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
  });

  it("serves the placeholder over a disposable empty coordination root and removes it on termination", async () => {
    const port = await unusedPort();
    const child = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/demo.ts"], {
      cwd: process.cwd(),
      env: { ...process.env, PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const output = captureOutput(child);
    let root = "";

    try {
      const rootMatch = await waitForOutput(child, output, /Demo coordination state: (.+)\n/);
      root = rootMatch[1].trim();
      roots.push(root);
      expect(root.startsWith(tmpdir())).toBe(true);
      await waitForOutput(child, output, /listening on http:\/\/127\.0\.0\.1:/);

      const health = await fetch(`http://127.0.0.1:${port}/api/health`);
      expect(health.status).toBe(200);
      await expect(health.json()).resolves.toEqual({ ok: true });

      const page = await fetch(`http://127.0.0.1:${port}/`);
      expect(page.status).toBe(200);
      await expect(page.text()).resolves.toContain('<div id="root">');

      const doctor = (await (await fetch(`http://127.0.0.1:${port}/api/doctor`)).json()) as {
        apiUrl: string | null;
        stateRoot: string;
        perResource: Array<{ resource: string; mode: string; status: string }>;
      };
      expect(doctor.apiUrl).toBeNull();
      expect(doctor.stateRoot).toBe(root);
      expect(doctor.perResource).toEqual([
        expect.objectContaining({ resource: "claims", mode: "fs", status: "empty" }),
        expect.objectContaining({ resource: "heartbeats", mode: "fs", status: "empty" }),
        expect.objectContaining({ resource: "batches", mode: "fs", status: "empty" }),
        expect.objectContaining({ resource: "events", mode: "fs", status: "empty" })
      ]);

      child.kill("SIGTERM");
      const [exitCode] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
      expect(exitCode).toBe(0);
      await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await once(child, "exit");
      }
    }
  }, 20_000);
});
