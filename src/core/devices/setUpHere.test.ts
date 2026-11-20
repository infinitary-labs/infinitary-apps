import { describe, expect, it } from "vitest";
import { setUpHere } from "./setUpHere";

/**
 * Set up from your first mate's computer, at the first launch (INF-4931's plan, round 3): what
 * this computer reads of itself without an administrator. The address way is offered only where
 * it sets a computer up, the private network address comes first, and Remote Login's state is
 * read from whether this computer's SSH server answers with a key.
 */

/** What `os.type()` and `os.machine()` answer on each system, and an ED25519 key as ssh-keyscan reads it. */
const KEY = {
  type: "ssh-ed25519",
  publicKey: "AAAAC3NzaC1lZDI1NTE5AAAAIK0e7+7n5s0Q3m3v7wq1s9k1o3Yd0V5lqS0nq8o0k0aQ",
  line: "ED25519 SHA256:3Ld3ZbyQh4Gq0n8yY0xV1m2kq3c9tRrJ6Hc5wqv0aXk",
};
const on = async () => KEY;
const names = async () => ["sams-mac-mini.local"];
const addresses = () => [
  { address: "192.168.1.20", network: "local" as const },
  { address: "100.86.12.40", network: "private" as const },
];

describe("setUpHere", () => {
  it("offers the address way on a Mac and an x64 Linux computer only", async () => {
    const read = (system: string, arch: string) =>
      setUpHere({ system, arch, platform: "darwin", hostKey: on, names, addresses });
    expect((await read("Darwin", "arm64")).offered).toBe(true);
    expect((await read("Darwin", "x86_64")).offered).toBe(true);
    expect((await read("Linux", "x86_64")).offered).toBe(true);
    // A Windows PC and an Arm Linux computer keep the two other chips.
    expect(await read("Windows_NT", "x86_64")).toMatchObject({ offered: false, line: null });
    expect((await read("Linux", "aarch64")).offered).toBe(false);
  });

  it("gives the private network address, the local name, and the line to compare", async () => {
    const here = await setUpHere({
      system: "Darwin",
      arch: "arm64",
      platform: "darwin",
      hostKey: on,
      names,
      addresses,
    });
    expect(here).toMatchObject({
      privateAddress: "100.86.12.40",
      localName: "sams-mac-mini.local",
      remoteLogin: "on",
      line: KEY.line,
      opensSharing: true,
    });
  });

  it("says Remote Login is off when nothing answers, and unknown when it cannot tell", async () => {
    const read = (answer: "remote-login-off" | "unreachable") =>
      setUpHere({
        system: "Linux",
        arch: "x86_64",
        platform: "linux",
        hostKey: async () => ({ refusal: answer }),
        names,
        addresses: () => [],
      });
    expect(await read("remote-login-off")).toMatchObject({
      remoteLogin: "off",
      line: null,
      privateAddress: null,
      opensSharing: false,
    });
    expect((await read("unreachable")).remoteLogin).toBe("unknown");
  });
});
