import { describe, expect, it } from "vitest";
import {
  checkLine,
  hostAlias,
  hostTrustSshOptions,
  knownHostsLine,
  preferHostKey,
  sameHostKey,
  sha256Fingerprint,
  sshPathWord,
} from "./hostTrust";

describe("host trust", () => {
  it("prints a check line from the key, and prefers ed25519", () => {
    const chosen = preferHostKey([
      { type: "ssh-rsa", publicKey: "QQ==" },
      { type: "ssh-ed25519", publicKey: "AQID" },
    ]);
    expect(chosen?.type).toBe("ssh-ed25519");
    expect(chosen?.line).toBe(`ED25519 SHA256:${sha256Fingerprint("AQID")}`);
    expect(checkLine("ssh-ed25519", "AQID")).toBe(chosen?.line);
    expect(chosen && sameHostKey(chosen, { ...chosen })).toBe(true);
    expect(chosen && sameHostKey(chosen, { ...chosen, publicKey: "AQIE" })).toBe(false);
    expect(preferHostKey([])).toBeNull();
  });

  it("names the remembered key so SSH never reads the captain's settings", () => {
    const key = preferHostKey([{ type: "ssh-ed25519", publicKey: "AQID" }]);
    expect(key).not.toBeNull();
    if (!key) return;
    const alias = hostAlias("sam@mini.local");
    expect(alias.startsWith("-")).toBe(false);
    expect(alias).toMatch(/^fm[0-9a-f]{32}$/);
    expect(knownHostsLine("sam@mini.local", key)).toBe(`${alias} ssh-ed25519 AQID`);
    const options = hostTrustSshOptions("/tmp/fm-known_hosts", "sam@mini.local", key);
    expect(options).toContain("StrictHostKeyChecking=yes");
    expect(options).toContain("UpdateHostKeys=no");
    expect(options).toContain("GlobalKnownHostsFile=/dev/null");
    expect(options.join(" ")).not.toContain(".ssh");
    // No command may answer for known hosts in the remembered key's place.
    expect(options).toContain("KnownHostsCommand=none");
    expect(options).toContain("HostKeyAlgorithms=ssh-ed25519");
  });

  it("uses SHA-2 signatures for the same remembered RSA key", () => {
    const address = "sam@worker.example";
    const key = { type: "ssh-rsa", publicKey: "QQ==", line: checkLine("ssh-rsa", "QQ==") };
    const options = hostTrustSshOptions("/tmp/fm-known_hosts", address, key);
    expect(options.filter((option) => option.startsWith("HostKeyAlgorithms="))).toEqual([
      "HostKeyAlgorithms=rsa-sha2-512,rsa-sha2-256",
    ]);
    expect(options).toContain("StrictHostKeyChecking=yes");
    expect(options).toContain(`HostKeyAlias=${hostAlias(address)}`);
    expect(knownHostsLine(address, key)).toBe(`${hostAlias(address)} ssh-rsa QQ==`);
  });

  it("keeps a folder with a space in it one file for SSH, as Application Support is", () => {
    const key = preferHostKey([{ type: "ssh-ed25519", publicKey: "AQID" }]);
    if (!key) throw new Error("No key.");
    const options = hostTrustSshOptions(
      "/Users/sam/Library/Application Support/firstmate-3000/devices/known_hosts",
      "sam@mini.local",
      key,
    );
    expect(options).toContain(
      'UserKnownHostsFile="/Users/sam/Library/Application Support/firstmate-3000/devices/known_hosts"',
    );
    expect(() => sshPathWord('/a "b"/known_hosts')).toThrow();
  });

  // INF-4260 piece 9: Windows' own ssh.exe reads its settings' paths with forward slashes.
  it("names a Windows PC's remembered key with forward slashes, which Windows' own SSH reads", () => {
    expect(
      sshPathWord(
        "C:\\Users\\Kun Chen\\AppData\\Roaming\\infinitary\\devices\\known_hosts",
        "win32",
      ),
    ).toBe('"C:/Users/Kun Chen/AppData/Roaming/infinitary/devices/known_hosts"');
  });
});
