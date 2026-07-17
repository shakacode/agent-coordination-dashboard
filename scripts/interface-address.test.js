import { describe, expect, it } from "vitest";
import {
  dashboardHostsForInterfaceAddress,
  isNonLinkLocalInterfaceAddress,
  localSourceAddressForDashboardHost
} from "../bin/interface-address.js";

describe("dashboardHostsForInterfaceAddress", () => {
  it.each([6, "IPv6"])("treats network-interface family %s as IPv6", (family) => {
    expect(dashboardHostsForInterfaceAddress({ address: "2001:db8::1", family })).toEqual({
      localAddress: "::1",
      urlHost: "[2001:db8::1]"
    });
  });

  it.each([4, "IPv4"])("treats network-interface family %s as IPv4", (family) => {
    expect(dashboardHostsForInterfaceAddress({ address: "192.0.2.10", family })).toEqual({
      localAddress: "127.0.0.1",
      urlHost: "192.0.2.10"
    });
  });
});

describe("isNonLinkLocalInterfaceAddress", () => {
  it.each([
    "169.254.23.42",
    "fe80::1",
    "febf:ffff::1",
    "::ffff:169.254.23.42"
  ])("rejects link-local interface address %s", (address) => {
    expect(isNonLinkLocalInterfaceAddress(address)).toBe(false);
  });

  it.each([
    "127.0.0.1",
    "192.0.2.10",
    "::1",
    "2001:db8::10"
  ])("accepts non-link-local interface address %s", (address) => {
    expect(isNonLinkLocalInterfaceAddress(address)).toBe(true);
  });
});

describe("localSourceAddressForDashboardHost", () => {
  it("uses the canonical IPv4 loopback source for the full 127/8 range", () => {
    expect(localSourceAddressForDashboardHost("127.0.0.1")).toBe("127.0.0.1");
    expect(localSourceAddressForDashboardHost("127.0.0.2")).toBe("127.0.0.1");
    expect(localSourceAddressForDashboardHost("127.255.255.254")).toBe("127.0.0.1");
    expect(localSourceAddressForDashboardHost("127.1")).toBeNull();
    expect(localSourceAddressForDashboardHost("192.0.2.10")).toBeNull();
  });
});
