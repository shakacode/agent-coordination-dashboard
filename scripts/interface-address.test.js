import { describe, expect, it } from "vitest";
import {
  dashboardHostsForInterfaceAddress,
  localSourceAddressForDashboardHost
} from "../bin/interface-address.js";

describe("dashboardHostsForInterfaceAddress", () => {
  it("treats numeric network-interface family 6 as IPv6", () => {
    expect(dashboardHostsForInterfaceAddress({ address: "::1", family: 6 })).toEqual({
      localAddress: "::1",
      urlHost: "[::1]"
    });
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
