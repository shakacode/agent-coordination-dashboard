import { describe, expect, it } from "vitest";
import { isMachineLocalAddress } from "./machineLocal";

const interfaces = {
  ethernet: [
    { address: "192.168.7.26" },
    { address: "fd12:3456::1" }
  ]
};

describe("isMachineLocalAddress", () => {
  it.each([
    "127.0.0.1",
    "127.0.0.2",
    "::1",
    "::ffff:127.0.0.1",
    "192.168.7.26",
    "::ffff:192.168.7.26",
    "::ffff:c0a8:71a",
    "fd12:3456:0:0:0:0:0:1"
  ])("accepts the exact machine-local address %s", (address) => {
    expect(isMachineLocalAddress(address, interfaces)).toBe(true);
  });

  it.each([
    undefined,
    "not-an-address",
    "192.168.7.27",
    "::ffff:192.168.7.27",
    "::ffff:c0a8:71b",
    "fd12:3456::2",
    "fe80::1%en0",
    "203.0.113.8"
  ])("rejects the nonlocal peer address %s", (address) => {
    expect(isMachineLocalAddress(address, interfaces)).toBe(false);
  });

  it("ignores an unreadable interface entry and still matches a later exact address", () => {
    const unreadable = Object.defineProperty({}, "address", {
      get() {
        throw new Error("unreadable interface");
      }
    }) as { address: string };

    expect(isMachineLocalAddress("192.168.7.26", {
      broken: [unreadable],
      ethernet: [{ address: "192.168.7.26" }]
    })).toBe(true);
  });

  it.each(["fe80::1", "febf::1"])(
    "rejects link-local IPv6 peer %s even when an interface has the same address",
    (address) => {
      expect(isMachineLocalAddress(address, {
        bridge: [{ address }]
      })).toBe(false);
    }
  );
});
