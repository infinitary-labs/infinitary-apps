import type { NetworkInterfaceInfo } from "node:os";
import { describe, expect, it } from "vitest";
import { isThisMachine, LOOPBACK_ADDRESS, listenAddresses, onLocalNetwork } from "./addresses";

const own = (...addresses: string[]): NodeJS.Dict<NetworkInterfaceInfo[]> => ({
  en0: addresses.map((address) => ({
    address,
    netmask: "255.255.255.0",
    family: address.includes(":") ? "IPv6" : "IPv4",
    mac: "00:00:00:00:00:00",
    internal: false,
    cidr: null,
    scopeid: 0,
  })) as NetworkInterfaceInfo[],
});

describe("where the connection listens", () => {
  it("listens on loopback alone until an address is chosen", () => {
    expect(listenAddresses(undefined, own())).toEqual([LOOPBACK_ADDRESS]);
    expect(listenAddresses(LOOPBACK_ADDRESS, own())).toEqual([LOOPBACK_ADDRESS]);
  });

  it("adds one chosen private address that belongs to this Mac", () => {
    for (const address of [
      "192.168.1.20",
      "10.0.0.7",
      "172.20.3.4",
      "100.101.102.103",
      "fd7a:115c:a1e0::1",
    ])
      expect(listenAddresses(address, own(address))).toEqual([LOOPBACK_ADDRESS, address]);
  });

  it("never listens on every address, a public one, a name, or one this Mac lacks", () => {
    expect(() => listenAddresses("0.0.0.0", own("0.0.0.0"))).toThrow("every address");
    expect(() => listenAddresses("::", own("::"))).toThrow("every address");
    expect(() => listenAddresses("8.8.8.8", own("8.8.8.8"))).toThrow("not a private address");
    expect(() => listenAddresses("2001:db8::1", own("2001:db8::1"))).toThrow(
      "not a private address",
    );
    expect(() => listenAddresses("169.254.10.10", own("169.254.10.10"))).toThrow(
      "not a private address",
    );
    expect(() => listenAddresses("mac.local", own("192.168.1.20"))).toThrow("not an address");
    expect(() => listenAddresses("192.168.1.21", own("192.168.1.20"))).toThrow(
      "does not belong to this computer",
    );
  });
});

describe("whether an address is this Mac's own", () => {
  it("counts loopback and this Mac's own interface addresses, as a socket spells them", () => {
    const interfaces = own("192.168.1.20", "fd7a:115c::5", "fe80::8c4:1520:bfba:1909");
    for (const address of [
      "127.0.0.1",
      "127.0.0.2",
      "::1",
      "::ffff:127.0.0.1",
      "192.168.1.20",
      "::ffff:192.168.1.20",
      "fd7a:115c::5",
      "[fd7a:115c::5]",
      // Link-local, with the zone a socket or sshd names and the list does not (review INF-255 S1).
      "fe80::8c4:1520:bfba:1909%en0",
      "fe80::8c4:1520:bfba:1909",
    ])
      expect(isThisMachine(address, interfaces), address).toBe(true);
  });

  it("does not count another Mac's address, a name, or nothing", () => {
    const interfaces = own("192.168.1.20");
    for (const address of ["192.168.1.21", "::ffff:10.0.0.4", "mini.local", "", undefined])
      expect(isThisMachine(address, interfaces), String(address)).toBe(false);
  });
});

describe("whether an address is on the local network", () => {
  it("counts the home and office ranges and link-local, as a socket spells them", () => {
    for (const address of [
      "192.168.4.48",
      "10.0.0.4",
      "172.16.9.1",
      "::ffff:192.168.1.20",
      "169.254.3.4",
      "fd12:3456::5",
      "fe80::1",
    ])
      expect(onLocalNetwork(address), address).toBe(true);
  });

  it("does not count loopback, a private network service's range, a public address or a name", () => {
    for (const address of ["127.0.0.1", "::1", "100.101.7.3", "8.8.8.8", "mini.local", ""])
      expect(onLocalNetwork(address), address).toBe(false);
  });
});
