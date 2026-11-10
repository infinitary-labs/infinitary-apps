import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import {
  createLinuxFreshAuthentication,
  POLKIT_ACTION,
  type PolkitPrograms,
  trustedProgram,
} from "./linuxFreshAuthentication";

// Intent: INF-1105 - fresh system authentication for a human Allow on Linux
// (docs/secrets.md, "Trusted approvals"): only polkit's own yes confirms, and
// nothing the person's agents can write - a program on the search path, a
// bus address in the environment - answers in its place.

/** Records the request, rejects polkit's privileged-only details, then answers with `code`. */
function standIn(dir: string, name: string, code: number): string {
  const path = join(dir, name);
  writeFileSync(
    path,
    // INF-1109's real non-root probe returned 127 before any prompt when the
    // app supplied --detail. Keep that observed refusal in this command fixture.
    `#!/bin/sh\nprintf '%s\\n' "$@" > "${path}.args"\nenv > "${path}.env"\nfor arg in "$@"; do [ "$arg" != --detail ] || exit 127; done\nexit ${code}\n`,
  );
  chmodSync(path, 0o755);
  return path;
}

function polkit(check: number, action = 0): { dir: string; programs: PolkitPrograms } {
  const dir = scratchDir("secrets-polkit-");
  return {
    dir,
    programs: {
      pkcheck: standIn(dir, "pkcheck", check),
      pkaction: standIn(dir, "pkaction", action),
    },
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("polkit commands the app trusts", () => {
  it("trusts root's system program and refuses one this user could change", async () => {
    expect(await trustedProgram("/bin/sh")).toBeDefined();
    const { programs } = polkit(0);
    expect(await trustedProgram(programs.pkcheck)).toBeUndefined();
    expect(await trustedProgram(join(scratchDir("secrets-polkit-"), "missing"))).toBeUndefined();
  });
});

describe.skipIf(process.platform !== "linux")("Linux fresh authentication", () => {
  it("confirms only on polkit's yes, for this one process, with an environment of its own", async () => {
    vi.stubEnv("DBUS_SYSTEM_BUS_ADDRESS", "unix:path=/tmp/an-agents-bus");
    const { programs } = polkit(0);
    const system = createLinuxFreshAuthentication(programs);
    expect(await system?.confirm("Use Staging deploy token for deploy.sh")).toBe(true);
    const args = readFileSync(`${programs.pkcheck}.args`, "utf8").trim().split("\n");
    expect(args).toEqual([
      "--action-id",
      POLKIT_ACTION,
      "--process",
      expect.stringMatching(new RegExp(`^${process.pid},\\d+,${process.getuid?.()}$`)),
      "--allow-user-interaction",
    ]);
    const env = readFileSync(`${programs.pkcheck}.env`, "utf8");
    expect(env).not.toContain("DBUS_SYSTEM_BUS_ADDRESS");
    expect(env).toContain("PATH=/usr/bin:/bin\n");
  });

  // pkcheck's answers: not authorized, no agent to ask, dismissed, and an error.
  it.each([1, 2, 3, 127])("approves nothing when pkcheck answers %i", async (code) => {
    const { programs } = polkit(code);
    expect(await createLinuxFreshAuthentication(programs)?.confirm("Use a secret")).toBe(false);
  });

  it("is available only where polkit knows the app's action", async () => {
    expect(await createLinuxFreshAuthentication(polkit(0, 0).programs)?.available()).toBe(true);
    expect(await createLinuxFreshAuthentication(polkit(0, 1).programs)?.available()).toBe(false);
  });

  it("never runs a polkit command from the person's search path", async () => {
    const { dir, programs } = polkit(0, 0);
    vi.stubEnv("PATH", `${dir}:${process.env.PATH ?? ""}`);
    const system = createLinuxFreshAuthentication();
    // The runner has no policy for the app's action, so the real polkit, where present, says no.
    expect(await system?.confirm("Use a secret")).toBe(false);
    expect(await system?.available()).toBe(false);
    expect(existsSync(`${programs.pkcheck}.args`)).toBe(false);
    expect(existsSync(`${programs.pkaction}.args`)).toBe(false);
  });
});
