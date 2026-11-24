import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { HOME_ACCOUNT, MAKE_ACCOUNT } from "./farHome";

/**
 * MAKE_ACCOUNT as root runs it after a root sign-in on Linux (docs/devices.md,
 * "Setting the first mate up from a first launch"), under each POSIX shell
 * this computer has. The account tools are stand-ins: `su` runs the command
 * without changing user, so what it proves is which steps run and as whom
 * they are asked to run, never the system's own permission checks.
 */

const SHELLS = ["/bin/sh", "/bin/dash"].filter((shell) => existsSync(shell));
const KEYS = ["ssh-ed25519 AAAAone root@laptop", "ssh-ed25519 AAAAtwo root@phone"];

function computer(accountHome: string) {
  const dir = scratchDir("infinitary-make-account-");
  const bin = join(dir, "bin");
  const root = join(dir, "root");
  mkdirSync(bin);
  mkdirSync(join(root, ".ssh"), { recursive: true });
  writeFileSync(join(root, ".ssh", "authorized_keys"), `${KEYS.join("\n")}\n`);
  const calls = join(dir, "calls");
  const tool = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${calls}"\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  tool("id", "exit 0");
  tool("useradd", "exit 0");
  tool("getent", `printf '%s\\n' "$2:x:1001:1001::${accountHome}:/bin/sh"`);
  tool("loginctl", "exit 0");
  // su -s SHELL USER -c COMMAND ARG0 ARGS..., as util-linux and BusyBox take it.
  tool("su", 'shift 2; shift; shift; exec /bin/sh -c "$@"');
  return { dir, bin, root, calls };
}

function makeAccount(shell: string, at: ReturnType<typeof computer>) {
  return new Promise<{ code: number; stdout: string }>((resolve) => {
    execFile(
      shell,
      ["-c", MAKE_ACCOUNT, "firstmate", HOME_ACCOUNT],
      { env: { PATH: `${at.bin}:/usr/bin:/bin`, HOME: at.root }, timeout: 10_000 },
      (error, stdout) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({ code, stdout });
      },
    );
  });
}

const calls = (at: ReturnType<typeof computer>) =>
  existsSync(at.calls) ? readFileSync(at.calls, "utf8") : "";

describe.each(SHELLS)("making the infinitary account under %s", (shell) => {
  it("stops before writing any key when the account has no home folder", async () => {
    const at = computer("");
    const made = await makeAccount(shell, at);
    expect(made.code).toBe(7);
    expect(made.stdout).not.toContain("infinitary:account=");
    expect(calls(at)).not.toContain("su ");
  });

  it("adds root's keys as the account, once each, and keeps those already there", async () => {
    const home = join(scratchDir("infinitary-account-home-"), "infinitary");
    mkdirSync(join(home, ".ssh"), { recursive: true });
    writeFileSync(join(home, ".ssh", "authorized_keys"), `${KEYS[0]}\nssh-ed25519 AAAAown\n`);
    const at = computer(home);
    expect(await makeAccount(shell, at)).toEqual({
      code: 0,
      stdout: "infinitary:account=infinitary\n",
    });
    expect(await makeAccount(shell, at)).toMatchObject({ code: 0 });
    expect(calls(at)).toContain(`su -s /bin/sh ${HOME_ACCOUNT} -c `);
    expect(readFileSync(join(home, ".ssh", "authorized_keys"), "utf8")).toBe(
      `${KEYS[0]}\nssh-ed25519 AAAAown\n${KEYS[1]}\n`,
    );
    expect(statSync(join(home, ".ssh")).mode & 0o777).toBe(0o700);
    expect(statSync(join(home, ".ssh", "authorized_keys")).mode & 0o777).toBe(0o600);
  });
});
