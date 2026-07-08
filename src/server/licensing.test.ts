import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function readRepoFile(path: string) {
  return readFileSync(join(root, path), "utf8");
}

describe("licensing", () => {
  it("declares the local dashboard as MIT protocol-plane code", () => {
    const packageJson = JSON.parse(readRepoFile("package.json")) as { license?: string };
    const license = readRepoFile("LICENSE");
    const readme = readRepoFile("README.md");

    expect(packageJson.license).toBe("MIT");
    expect(license).toContain("MIT License");
    expect(license).toContain("Copyright (c) 2026 ShakaCode");
    expect(readme).toContain("## License");
    expect(readme).toContain("MIT License");
    expect(readme).toContain("protocol plane");
  });
});
