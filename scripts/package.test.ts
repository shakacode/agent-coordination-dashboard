import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

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
      "!src/**/*.test.ts"
    ]);
    expect(manifest.scripts?.prepack).toBe("npm run build");
    expect(manifest.publishConfig).toEqual({ access: "public" });
    expect(Object.keys(manifest.dependencies || {}).sort()).toEqual(["express", "tsx"]);
    expect(Object.keys(manifest.devDependencies || {})).toEqual(
      expect.arrayContaining(["@vitejs/plugin-react", "lucide-react", "react", "react-dom", "vite"])
    );
  });
});
