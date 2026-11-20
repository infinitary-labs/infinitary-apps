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
/** This computer's SSH server, answering the same key at every address. */
const on = async (_host: string) => KEY;
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
    const asked: string[] = [];
    const here = await setUpHere({
      system: "Darwin",
      arch: "arm64",
      platform: "darwin",
      hostKey: async (host) => {
        asked.push(host);
        return KEY;
      },
      names,
      addresses,
      user: "sam",
    });
    expect(here).toMatchObject({
      user: "sam",
      privateAddress: "100.86.12.40",
      localName: "sams-mac-mini.local",
      remoteLogin: "on",
      line: KEY.line,
      lineAt: "100.86.12.40",
      opensSharing: true,
    });
    // Remote Login is read on this computer's own loopback; the line at the address it names.
    expect(asked.sort()).toEqual(["100.86.12.40", "127.0.0.1"]);
  });

  it("gives no line when the address shown answers with no key, though Remote Login is on", async () => {
    const here = await setUpHere({
      system: "Darwin",
      arch: "arm64",
      platform: "darwin",
      hostKey: async (host) => (host === "127.0.0.1" ? KEY : { refusal: "unreachable" }),
      names,
      addresses,
      user: "sam",
    });
    expect(here).toMatchObject({ remoteLogin: "on", line: null, lineAt: null });
  });

  it("names the local network address on Linux, where no Bonjour name may be announced", async () => {
    const here = await setUpHere({
      system: "Linux",
      arch: "x86_64",
      platform: "linux",
      hostKey: on,
      names,
      addresses: () => [{ address: "192.168.1.20", network: "local" as const }],
      user: "sam",
    });
    expect(here).toMatchObject({
      privateAddress: null,
      localName: "192.168.1.20",
      lineAt: "192.168.1.20",
    });
  });

  it("shows no account or address the address rules refuse", async () => {
    const here = await setUpHere({
      system: "Darwin",
      arch: "arm64",
      platform: "darwin",
      hostKey: on,
      names: async () => ["-oProxyCommand=x"],
      addresses,
      user: "Sam Lee",
    });
    expect(here.user).toBeNull();
    expect(here.localName).toBeNull();
  });

  it("reads nothing but the system when only asked whether the way is offered", async () => {
    const here = await setUpHere({
      system: "Darwin",
      arch: "arm64",
      platform: "darwin",
      hostKey: async () => {
        throw new Error("read a key");
      },
      names: async () => {
        throw new Error("read a name");
      },
      addresses: () => {
        throw new Error("read an address");
      },
      eligibilityOnly: true,
    });
    expect(here).toMatchObject({ offered: true, user: null, privateAddress: null, line: null });
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
