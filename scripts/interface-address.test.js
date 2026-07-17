import { describe, expect, it } from "vitest";
import { dashboardHostsForInterfaceAddress } from "../bin/interface-address.js";

describe("dashboardHostsForInterfaceAddress", () => {
  it("treats numeric network-interface family 6 as IPv6", () => {
    expect(dashboardHostsForInterfaceAddress({ address: "::1", family: 6 })).toEqual({
      localAddress: "::1",
      urlHost: "[::1]"
    });
  });
});
