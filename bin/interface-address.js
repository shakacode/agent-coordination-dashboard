export function dashboardHostsForInterfaceAddress(address) {
  const isIpv6 = address.family === "IPv6" || address.family === 6;
  return {
    localAddress: isIpv6 ? "::1" : "127.0.0.1",
    urlHost: isIpv6 ? `[${address.address}]` : address.address
  };
}
