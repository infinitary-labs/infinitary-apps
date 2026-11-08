import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { baseRef } from "../scripts/check-changed.ts";
import { ciModeRefusal } from "../scripts/checks-mode.ts";
import { scratchDir } from "./helpers/scratchDirs";

/**
 * INF-800, the captain's approval: "Only the heavy checks: journeys, the
 * phone check and the replay gate". Anyone building Infinitary runs them on
 * their own computer; the git setting infinitary.checks = ci sends them
 * through CI, and inside CI they always run (docs/testing.md, "Where the
 * heavy checks run"). INF-2074 added typecheck and lint; INF-2273 leaves
 * every edited unit file's three total rounds local, outside this setting. Each case runs the real command a person types,
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
  // INF-2259's accepted native exception keeps the global setting and all
  // unrelated checks unchanged; the real launcher still validates file filters.
  it("allows only admitted, explicitly Mac-tagged selected journeys in CI mode", () => {
    const env = {
      INFINITARY_CHECKS: "ci",
      INFINITARY_SELECTED_MAC: "1",
      INFINITARY_LOAD_HOLD: "selected-native-proof",
    };
    const args = ["--no-deps", "--grep", "@mac-only", "tests/e2e/devices.spec.ts"];
    expect(ciModeRefusal("journeys", env, process.cwd(), args) === undefined).toBe(
      process.platform === "darwin",
    );
    expect(
      ciModeRefusal("journeys", { ...env, INFINITARY_LOAD_HOLD: "" }, process.cwd(), args),
    ).toContain("journeys.yml");
    expect(ciModeRefusal("journeys", env, process.cwd(), ["tests/e2e/devices.spec.ts"])).toContain(
      "journeys.yml",
    );
    expect(ciModeRefusal("phone", env, process.cwd(), args)).toContain("phone.yml");
    expect(ciModeRefusal("typecheck", env, process.cwd(), args)).toContain("typecheck-lint-build");
  });
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

  // INF-2588 fix 1: a crewmate on a CI-mode computer still lints its changed files before it pushes.
  it("lints changed files and checks generated files in CI mode instead of refusing", () => {
    const { run } = computer("ci");
    const result = run(scripts["check:changed"] ?? "");
    expect(result.stdout).toMatch(/check:changed: \d+ changed file/);
    expect(result.stderr).not.toContain("typecheck-lint-build");
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  // The bug a main check found: its push checkout holds one commit and no main
  // branch, and the quick check took the word HEAD for a commit since main, so
  // it ran the release-notes check on nothing and refused.
  it("takes a checkout with no main branch to have nothing committed since main", () => {
    const { home, run } = computer();
    const repo = join(home, "repo");
    const made = run(
      `git init -q -b work "${repo}" && git -C "${repo}" -c user.name=t -c user.email=t@example.com commit -q --allow-empty -m one`,
    );
    expect(made.status, made.stderr).toBe(0);
    expect(baseRef(repo)).toBe(run(`git -C "${repo}" rev-parse HEAD`).stdout.trim());
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
