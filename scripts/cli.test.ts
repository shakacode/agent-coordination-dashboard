import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

async function unusedPort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP address for the CLI test server.");
  }
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

describe("agent-coordination-dashboard CLI", () => {
  it("documents normal and demo modes", () => {
    const result = spawnSync(process.execPath, ["bin/agent-coordination-dashboard.js", "--help"], {
      cwd: process.cwd(),
      encoding: "utf8"
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("agent-coordination-dashboard [--demo]");
    expect(result.stdout).toContain("Start the dashboard server");
    expect(result.stdout).toContain("synthetic ticking coordination state");
  });

  it("forces an isolated installed server into production mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "coord-dashboard-cli-package-test-"));
    const packageRoot = join(root, "node_modules", "agent-coordination-dashboard");
    const fakeTsxRoot = join(packageRoot, "node_modules", "tsx");
    await Promise.all([
      mkdir(join(packageRoot, "bin"), { recursive: true }),
      mkdir(join(fakeTsxRoot, "dist"), { recursive: true })
    ]);
    await Promise.all([
      copyFile("bin/agent-coordination-dashboard.js", join(packageRoot, "bin", "agent-coordination-dashboard.js")),
      writeFile(join(packageRoot, "package.json"), '{"type":"module"}\n', "utf8"),
      writeFile(
        join(fakeTsxRoot, "package.json"),
        '{"type":"module","exports":{"./cli":"./dist/cli.mjs"}}\n',
        "utf8"
      ),
      writeFile(
        join(fakeTsxRoot, "dist", "cli.mjs"),
        'process.stdout.write(JSON.stringify({ nodeEnv: process.env.NODE_ENV, target: process.argv[2] }));\n',
        "utf8"
      )
    ]);

    try {
      const result = spawnSync(process.execPath, [join(packageRoot, "bin", "agent-coordination-dashboard.js")], {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, NODE_ENV: "development" }
      });

      expect(result.status).toBe(0);
      const output = JSON.parse(result.stdout) as { nodeEnv: string; target: string };
      expect(output.nodeEnv).toBe("production");
      expect(output.target).toMatch(/agent-coordination-dashboard\/src\/server\/index\.ts$/);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("stops the normal server cleanly when the launcher is terminated", async () => {
    const root = await mkdtemp(join(tmpdir(), "coord-dashboard-cli-test-"));
    const port = await unusedPort();
    const child = spawn(process.execPath, ["bin/agent-coordination-dashboard.js"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AGENT_COORD_STATE_ROOT: root,
        DASHBOARD_SETTINGS_PATH: join(root, "settings.json"),
        NODE_ENV: "development",
        PORT: String(port)
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += String(chunk);
    });

    try {
      const deadline = Date.now() + 10_000;
      while (!output.includes(`listening on http://127.0.0.1:${port}`) && Date.now() < deadline) {
        if (child.exitCode !== null) {
          throw new Error(`CLI exited before listening:\n${output}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(output).toContain(`listening on http://127.0.0.1:${port}`);

      child.kill("SIGTERM");
      const [exitCode] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
      expect(exitCode).toBe(0);
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await once(child, "exit");
      }
      await rm(root, { force: true, recursive: true });
    }
  });
});
