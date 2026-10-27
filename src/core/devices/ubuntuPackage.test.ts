import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { hostEnv } from "../hostEnv";
import { shellWord } from "./shellWord";
import { INSTALL_AS_ROOT, LINGER_OFF_LINE } from "./ubuntuPackage";

/** A real deb archive, with harmless data, for the installer boundary (INF-1571). */
function packageFile(at: string): string {
  const control = join(at, "control");
  const data = join(at, "data");
  mkdirSync(control);
  mkdirSync(data);
  writeFileSync(
    join(control, "control"),
    "Package: infinitary-test\nVersion: 1.0\nArchitecture: all\nMaintainer: Test <test@example.invalid>\nDescription: Installer boundary fixture\n",
  );
  writeFileSync(join(data, "payload"), "Infinitary installer boundary fixture\n");
  writeFileSync(join(at, "debian-binary"), "2.0\n");
  const options = { cwd: at, env: hostEnv() };
  execFileSync("tar", ["-czf", "control.tar.gz", "-C", control, "."], options);
  execFileSync("tar", ["-czf", "data.tar.gz", "-C", data, "."], options);
  execFileSync(
    "ar",
    ["-qcS", "infinitary.deb", "debian-binary", "control.tar.gz", "data.tar.gz"],
    options,
  );
  return join(at, "infinitary.deb");
}

/**
 * Run the production root script without elevating this test. Real copies and hashes;
 * apt records its input, and loginctl records its call. The live Ubuntu proof checks
 * the root/account permission boundary; here the shell owns ordering and cleanup.
 */
function installer(
  options: { swapAfterCheck?: boolean; aptExit?: number; lingerExit?: number } = {},
) {
  const at = scratchDir("infinitary-install-test-");
  const bin = join(at, "bin");
  mkdirSync(bin);
  const src = packageFile(at);
  // An account may make its received file writable by everyone before root copies it.
  chmodSync(src, 0o666);
  const original = readFileSync(src);
  const sum = createHash("sha256").update(original).digest("hex");
  const file = (name: string) => shellWord(join(at, name));
  const tool = (name: string, lines: string[]) =>
    writeFileSync(join(bin, name), ["#!/bin/sh", "set -eu", ...lines, ""].join("\n"), {
      mode: 0o755,
    });
  // Keep every test-owned folder under scratchDir, including root's staging directory.
  tool("mktemp", [
    `d="$(/usr/bin/mktemp -d ${file("root-XXXXXX")})"`,
    `printf '%s' "$d" > ${file("staged")}`,
    'printf "%s\\n" "$d"',
  ]);
  const statMode = process.platform === "darwin" ? "stat -f '%Lp'" : "stat -c '%a'";
  tool("chmod", [
    '/bin/chmod "$@"',
    'if [ -d "$2" ]; then',
    `  ${statMode} "$2"/* > ${file("exposed-modes")}`,
    "fi",
  ]);
  tool("sha256sum", [
    `cat > ${file("check")}`,
    process.platform === "darwin"
      ? `shasum -a 256 -c -s < ${file("check")}`
      : `/usr/bin/sha256sum -c --status < ${file("check")}`,
    ...(options.swapAfterCheck
      ? [`rm -f ${shellWord(src)}`, `printf 'replaced after verification\\n' > ${shellWord(src)}`]
      : []),
  ]);
  tool("apt-get", [
    `printf '%s\\n' "$@" > ${file("apt-args")}`,
    'for arg in "$@"; do deb="$arg"; done',
    `${statMode} "$(dirname "$deb")" "$deb" > ${file("modes")}`,
    `cp "$deb" ${file("installed.deb")}`,
    `exit ${options.aptExit ?? 0}`,
  ]);
  tool("loginctl", [`printf '%s\\n' "$@" > ${file("linger")}`, `exit ${options.lingerExit ?? 0}`]);
  return {
    at,
    src,
    original,
    run: () =>
      spawnSync("/bin/sh", ["-c", `umask 000\n${INSTALL_AS_ROOT}`, "firstmate", src, sum], {
        env: { ...hostEnv(), PATH: `${bin}:/usr/bin:/bin`, SUDO_USER: "sam" },
        encoding: "utf8",
      }),
    staged: () => readFileSync(join(at, "staged"), "utf8"),
  };
}

// INF-1571: address add/update must check and install the same root-owned copy,
// not a file the account can replace between sha256sum and apt-get.
describe("the Ubuntu address install's private copy", () => {
  it("installs the checked bytes even when the account replaces the received package after verification", () => {
    const at = installer({ swapAfterCheck: true });
    const ran = at.run();
    expect(ran.status, ran.stderr).toBe(0);
    expect(readFileSync(join(at.at, "installed.deb"))).toEqual(at.original);
    const args = readFileSync(join(at.at, "apt-args"), "utf8").trim().split("\n");
    expect(args.slice(0, -1)).toEqual(["install", "-y", "--allow-downgrades"]);
    expect(args.at(-1)).not.toBe(at.src);
    expect(readFileSync(join(at.at, "check"), "utf8")).toContain(`  ${args.at(-1)}\n`);
    const modes = readFileSync(join(at.at, "modes"), "utf8")
      .trim()
      .split("\n")
      .map((mode) => Number.parseInt(mode, 8));
    // Neither group nor other can write; apt's unprivileged reader can traverse and read.
    for (const mode of modes) expect(mode & 0o022).toBe(0);
    // The copy must already be protected when root first lets others enter its directory.
    const exposed = Number.parseInt(readFileSync(join(at.at, "exposed-modes"), "utf8"), 8);
    expect(exposed & 0o022).toBe(0);
    expect((modes[0] ?? 0) & 0o005).toBe(0o005);
    expect((modes[1] ?? 0) & 0o004).toBe(0o004);
    expect(existsSync(at.staged())).toBe(false);
    expect(existsSync(at.src)).toBe(false);
  });

  it("refuses a package changed before root copies it and removes the private copy", () => {
    const at = installer();
    writeFileSync(at.src, "replaced while sudo asked\n");
    expect(at.run().status).toBe(65);
    // A source could point at a root-only file: unverified contents must never become readable.
    expect(existsSync(join(at.at, "exposed-modes"))).toBe(false);
    expect(existsSync(join(at.at, "apt-args"))).toBe(false);
    expect(existsSync(join(at.at, "linger"))).toBe(false);
    expect(existsSync(at.staged())).toBe(false);
  });

  it("cleans the private directory when the received package disappeared before copying", () => {
    const at = installer();
    unlinkSync(at.src);
    expect(at.run().status).not.toBe(0);
    expect(existsSync(at.staged())).toBe(false);
    expect(existsSync(join(at.at, "apt-args"))).toBe(false);
  });

  it("keeps apt's failure and removes the private copy without turning on linger", () => {
    const at = installer({ aptExit: 100 });
    expect(at.run().status).toBe(100);
    expect(existsSync(at.staged())).toBe(false);
    expect(existsSync(join(at.at, "linger"))).toBe(false);
  });

  it("still reports missing systemd after a successful install and cleans both copies", () => {
    const at = installer({ lingerExit: 1 });
    const ran = at.run();
    expect(ran.status, ran.stderr).toBe(0);
    expect(ran.stdout.trim()).toBe(LINGER_OFF_LINE);
    expect(readFileSync(join(at.at, "linger"), "utf8")).toBe("enable-linger\nsam\n");
    expect(existsSync(at.staged())).toBe(false);
    expect(existsSync(at.src)).toBe(false);
  });
});
