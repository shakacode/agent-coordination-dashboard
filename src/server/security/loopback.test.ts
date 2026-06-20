import { describe, expect, it } from "vitest";
import { isLoopbackAddress } from "./loopback";

describe("isLoopbackAddress", () => {
  it("allows IPv4, IPv6, and mapped loopback addresses", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
  });

  it("rejects missing and non-loopback addresses", () => {
    expect(isLoopbackAddress(undefined)).toBe(false);
    expect(isLoopbackAddress("192.168.1.20")).toBe(false);
  });
});
