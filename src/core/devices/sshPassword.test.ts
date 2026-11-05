import { describe, expect, it } from "vitest";
import { passwordMethods, passwordSshOptions } from "./sshPassword";

/**
 * The password, once (docs/devices.md): which way a Mac takes a password,
 * read from SSH's own note after a refused key, and the one run that types
 * it. The run itself, against a throwaway SSH server, is
 * `remoteLoginPassword.test.ts`.
 */
describe("the password, once", () => {
  it("reads which password methods the Mac offered after it refused the key", () => {
    const said = (methods: string) =>
      `debug1: Authentications that can continue: publickey\ndebug1: Next authentication method: publickey\ndebug1: Authentications that can continue: ${methods}\nsam@mini.local: Permission denied (${methods}).\n`;
    expect(passwordMethods(said("publickey,password,keyboard-interactive"))).toEqual([
      "password",
      "keyboard-interactive",
    ]);
    expect(passwordMethods(said("publickey,keyboard-interactive"))).toEqual([
      "keyboard-interactive",
    ]);
    // A Mac that lets in keys alone takes no password.
    expect(passwordMethods(said("publickey"))).toEqual([]);
    expect(
      passwordMethods("ssh: connect to host mini.local port 22: Connection refused"),
    ).toBeNull();
  });

  it("types it with one method, once, and offers no key or agent, on a connection of its own", () => {
    const options = passwordSshOptions(["password", "keyboard-interactive"]);
    expect(options).toContain("BatchMode=no");
    expect(options).not.toContain("BatchMode=yes");
    for (const narrowed of [
      "PreferredAuthentications=password",
      "NumberOfPasswordPrompts=1",
      "PubkeyAuthentication=no",
      "IdentityAgent=none",
      "ControlPath=none",
      "ProxyJump=none",
      "ProxyCommand=none",
      "ForwardAgent=no",
    ])
      expect(options).toContain(narrowed);
    expect(passwordSshOptions(["keyboard-interactive"])).toContain(
      "PreferredAuthentications=keyboard-interactive",
    );
  });
});
