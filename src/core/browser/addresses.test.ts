import { describe, expect, it } from "vitest";
import { isPublicAddress, literalAddress } from "./addresses";

/**
 * Which addresses a task browser may connect to on the internet: public
 * ones, and nothing on this Mac, a private network or a reserved range,
 * however the address is written.
 */
describe("public addresses", () => {
  it("lets public IPv4 and IPv6 addresses through", () => {
    for (const address of [
      "93.184.215.14",
      "8.8.8.8",
      "1.1.1.1",
      "172.32.0.1",
      "100.128.0.1",
      "2606:2800:21f:cb07:6820:80da:af6b:8b2c",
      "2a00:1450:4001:82a::200e",
      "::ffff:93.184.215.14",
      "64:ff9b::808:808",
    ]) {
      expect(isPublicAddress(address), address).toBe(true);
    }
  });

  it("refuses this Mac, private networks, links and every reserved range", () => {
    for (const address of [
      "0.0.0.0",
      "10.1.2.3",
      "100.64.0.1",
      "127.0.0.1",
      "127.8.9.10",
      "169.254.169.254",
      "172.16.0.1",
      "172.31.255.255",
      "192.0.0.8",
      "192.0.2.1",
      "192.88.99.1",
      "192.168.1.1",
      "198.18.0.1",
      "198.51.100.7",
      "203.0.113.9",
      "224.0.0.251",
      "239.255.255.250",
      "255.255.255.255",
      "::",
      "::1",
      "fe80::1",
      "fe80::1%en0",
      "fc00::1",
      "fd12:3456:789a::1",
      "ff02::1",
      "2001:db8::1",
      "2001::1",
      "2002:c0a8:101::1",
      "3fff::1",
      "100::1",
      "::ffff:10.0.0.1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "64:ff9b::a00:1",
      "64:ff9b:1::1",
      "::10.0.0.1",
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
  });

  it("is not an address at all for a name", () => {
    expect(isPublicAddress("example.com")).toBe(false);
    expect(isPublicAddress("")).toBe(false);
  });

  it("reads the address a URL writes out, and nothing for a name", () => {
    expect(literalAddress("10.0.0.1")).toBe("10.0.0.1");
    expect(literalAddress("[::1]")).toBe("::1");
    expect(literalAddress("[fe80::1]")).toBe("fe80::1");
    expect(literalAddress("example.com")).toBeUndefined();
    // URL writes every other form of an IPv4 address in dotted decimal.
    expect(literalAddress(new URL("http://0x7f.1/").hostname)).toBe("127.0.0.1");
    expect(literalAddress(new URL("http://2130706433/").hostname)).toBe("127.0.0.1");
  });
});
