import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDir } from "./helpers/scratchDirs";

/**
 * INF-800, the captain's approval: "Only the heavy checks: journeys, the
 * phone check and the replay gate". Anyone building Infinitary runs them on
 * their own computer; the git setting infinitary.checks = ci sends them
 * through CI, and inside CI they always run (docs/testing.md, "Where the
 * heavy checks run"). INF-2074's ci-gate fix, the captain's checked words:
 * "Run a change's typecheck, lint and ten unit-file repeats on Linux CI
 * instead of the Mac mini's line, since unit tests need no Mac" added the
 * typecheck and the lint. Each case runs the real command a person types,
 * with a scratch home whose git settings stand in for the person's own.
 */
const scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts as Record<string, string>;

function computer(setting?: string) {
  const home = scratchDir("infinitary-checks-mode-");
  const global = join(home, ".gitconfig");
  writeFileSync(global, setting ? `[infinitary]\n\tchecks = ${setting}\n` : "");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    CFFIXED_USER_HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    GIT_CONFIG_GLOBAL: global,
    GIT_CONFIG_NOSYSTEM: "1",
    CI: "",
    INFINITARY_CHECKS: "",
  };
  const run = (command: string, extra: NodeJS.ProcessEnv = {}) =>
    spawnSync("bash", ["-c", command], { encoding: "utf8", env: { ...env, ...extra } });
  return { home, run };
}

describe("where the heavy checks run", () => {
  it("runs them here by default", () => {
    const { run } = computer();
    for (const check of ["journeys", "phone", "replay-gate", "typecheck", "lint"]) {
      const result = run(`node scripts/checks-mode.ts ${check}`);
      expect(result.status, result.stderr).toBe(0);
    }
  });

  it("refuses the phone check and the replay gate outside CI with the setting on, naming each route", () => {
    const { home, run } = computer("ci");
    const phone = run(`${scripts["test:phone"]} --evidence ${join(home, "evidence")}`);
    expect(phone.status).toBe(1);
    expect(phone.stderr).toContain("phone.yml/dispatches");
    // It refuses before it waits for the Mac check lease.
    expect(existsSync(join(home, "Library/Caches/infinitary-ci"))).toBe(false);
    const replay = run(`${scripts["replay:gate"]} --out ${join(home, "replay-report.json")}`);
    expect(replay.status).toBe(1);
    expect(replay.stderr).toContain("replay.yml/dispatches");
    expect(existsSync(join(home, "replay-report.json"))).toBe(false);
  });

  // Each refuses in its first command, so neither the checker nor a lint starts.
  it("refuses the typecheck and every lint outside CI with the setting on, naming the pull request's check", () => {
    const { run } = computer("ci");
    for (const script of ["typecheck", "check", "lint", "lint:adherence"]) {
      const result = run(scripts[script] ?? "");
      expect(result.status, script).toBe(1);
      expect(result.stderr, script).toContain("typecheck-lint-build");
      expect(result.stderr, script).toContain("ci.yml/dispatches");
      expect(result.stdout + result.stderr, script).not.toMatch(/Checked \d+ files|tsrs/);
    }
  });

  // The real runner boots in about a second.
  it("refuses a committed journey outside CI with the setting on, before setup", () => {
    const { run } = computer("ci");
    const result = run(
      "node node_modules/@playwright/test/cli.js test --no-deps tests/e2e/phase0-guardrails.spec.ts",
    );
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain("journeys.yml/dispatches");
    expect(result.stdout).not.toContain("This run's evidence:");
  }, 30_000);

  it("always runs them inside CI, where the runners read the same git settings", () => {
    const { run } = computer("ci");
    for (const check of ["journeys", "phone", "replay-gate", "typecheck", "lint"]) {
      const result = run(`node scripts/checks-mode.ts ${check}`, { CI: "true" });
      expect(result.status, result.stderr).toBe(0);
    }
  });

  it("lets INFINITARY_CHECKS override the git setting for one run", () => {
    expect(
      computer("ci").run("node scripts/checks-mode.ts phone", { INFINITARY_CHECKS: "local" })
        .status,
    ).toBe(0);
    const on = computer().run("node scripts/checks-mode.ts phone", { INFINITARY_CHECKS: "ci" });
    expect(on.status).toBe(1);
    expect(on.stderr).toContain("phone.yml/dispatches");
  });

  it("refuses a setting it cannot read rather than guess", () => {
    const result = computer("CI").run("node scripts/checks-mode.ts phone");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('infinitary.checks reads "CI"; it takes ci or local.');
  });
});
