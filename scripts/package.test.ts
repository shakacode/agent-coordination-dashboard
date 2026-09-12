import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

interface PackageManifest {
  name: string;
  private?: boolean;
  bin?: Record<string, string>;
  engines?: Record<string, string>;
  files?: string[];
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  publishConfig?: Record<string, string>;
}

describe("public package manifest", () => {
  it("defines the canonical install contract and minimal runtime surface", async () => {
    const manifest = JSON.parse(await readFile("package.json", "utf8")) as PackageManifest;

    expect(manifest.name).toBe("agent-coordination-dashboard");
    expect(manifest.private).not.toBe(true);
    expect(manifest.engines?.node).toBe(">=22.12.0");
    expect(manifest.bin).toEqual({ "agent-coordination-dashboard": "bin/agent-coordination-dashboard.js" });
    expect(manifest.files).toEqual([
      "bin",
      "dist",
      "scripts/demo.ts",
      "src/server",
      "src/shared",
      "!src/**/*.test.ts",
      "!src/**/fixtures/**",
      "!src/**/*.fixtures.ts"
    ]);
    expect(manifest.scripts?.prepack).toBe("npm run build");
    expect(manifest.publishConfig).toEqual({ access: "public" });
    expect(Object.keys(manifest.dependencies || {}).sort()).toEqual(["ajv", "express", "tsx"]);
    // The vendored attention schema is compiled against a pinned Ajv; a caret range would let the
    // validator's behaviour drift on an unrelated install.
    expect(manifest.dependencies?.ajv).toMatch(/^\d+\.\d+\.\d+$/);
    expect(Object.keys(manifest.devDependencies || {})).toEqual(
      expect.arrayContaining(["@vitejs/plugin-react", "react", "react-dom", "vite"])
    );
  });

  it("publishes runtime schema artifacts without attention fixtures", async () => {
    const { stdout } = await execFileAsync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      maxBuffer: 1024 * 1024,
    });
    const packResult = JSON.parse(stdout) as Array<{ files: Array<{ path: string }> }>;
    const paths = packResult[0]?.files.map(({ path }) => path) ?? [];

    expect(paths.some((path) => path.includes("fixtures"))).toBe(false);
    expect(paths.some((path) => path.endsWith("src/shared/attention.fixtures.ts"))).toBe(false);
    expect(paths).toContain("src/server/attention/attention-record.schema.json");
    expect(paths).toContain("src/server/attention/SCHEMA_SOURCE.md");
  });
});
