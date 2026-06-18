import { describe, expect, it } from "vitest";
import { isAllowedHostHeader, parseHostHeader } from "./hostGuard";

describe("host guard", () => {
  it("normalizes host headers before matching", () => {
    expect(parseHostHeader("LOCALHOST:4317")).toBe("localhost");
    expect(parseHostHeader("127.0.0.1:4317")).toBe("127.0.0.1");
    expect(parseHostHeader("[::1]:4317")).toBe("::1");
  });

  it("rejects missing or unlisted hosts", () => {
    const allowed = ["localhost", "127.0.0.1", "::1"];

    expect(isAllowedHostHeader(undefined, allowed)).toBe(false);
    expect(isAllowedHostHeader("attacker.example:4317", allowed)).toBe(false);
    expect(isAllowedHostHeader("localhost:4317", allowed)).toBe(true);
  });
});
