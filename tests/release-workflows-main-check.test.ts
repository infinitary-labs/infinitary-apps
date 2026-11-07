import { posix } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { RELAUNCH_PAIRS_PER_PART, relaunchPairs } from "../scripts/phone-test-plan.ts";
import {
  loadYamlFile,
  read,
  type WorkflowStep as Step,
  workflowString,
  workflowValue,
} from "./helpers/releaseWorkflows";

// INF-2267: portable workflow contracts keep the integration cohort and its isolation;
// native executable and bundle checks remain in the Mac-listed release-contract file.

// Preserve the original release-contract budget; discovery keeps its explicit budget.
vi.setConfig({ testTimeout: 10_000 });

/** The full main check and the package smoke it runs (main.yml, verify.yml). */

describe("local packaging identity (electron-builder.dev.yml)", () => {
  // INF-2267: keep these smoke-workflow assertions separate from the native bundle checks.
  it("checks the dev bundle's git the way the release gate does", () => {
    // The package smoke checks the dev bundle's git the way the release gate does.
    expect(read(".github/workflows/verify.yml")).toContain(
      'scripts/check-bundled-git.sh "dist/mac-universal/Infinitary Dev.app"',
    );
  });

  it("checks the dev bundle's separate data folder in the package smoke", () => {
    expect(read(".github/workflows/verify.yml")).toContain(
      'scripts/check-user-data-dir.sh "dist/mac-universal/Infinitary Dev.app" infinitary-dev',
    );
  });

  /**
   * The app runs work for another Mac with no window (docs/helper.md):
   * scripts/check-helper.sh starts the built app as `<app> work` on the dev
   * bundle in verify.yml and on the signed app in release.yml, and both say
   * how it went.
   */
  it("starts the built app to run work, on the dev bundle and on the signed app", () => {
    expect(read(".github/workflows/verify.yml")).toContain(
      'scripts/check-helper.sh "dist/mac-universal/Infinitary Dev.app"',
    );
    // Each workflow's summary names the stage by its step id.
    expect(read(".github/workflows/verify.yml")).toContain(`helper=\${{ steps.helper.outcome }}`);
    const release = read(".github/workflows/release.yml");
    expect(release).toContain('scripts/check-helper.sh "dist/mac-universal/$APP_NAME"');
    expect(release).toContain(`work-mode=\${{ steps.work-mode.outcome }}`);
  });

  /**
   * electron-builder refuses to sign pull-request builds unless told
   * otherwise, so without the flag the smoke job would build a fuse-flipped
   * app and never re-sign it - the one step that has to work, and the step
   * this overlay exists for.
   */
  it("makes the macOS package smoke really sign, then check what it signed", () => {
    const verify = read(".github/workflows/verify.yml");
    expect(verify).toContain("--config electron-builder.dev.yml");
    expect(verify).toContain('CSC_FOR_PULL_REQUEST: "true"');
    expect(verify).toContain("pnpm codesign:verify");
  });

  /**
   * Captain decision B (2026-09-15, scout fm3000-ci-release-only-s1): the
   * full macOS work is paid for at release time and on demand, never per PR,
   * and never on a schedule. ci.yml is the Linux jobs alone. Decision B was
   * reversed for pull requests in part on 2026-10-08 (FI3-1305) and again by
   * INF-2139, and for main by INF-2146's approved plan (direction B): main.yml
   * is the one workflow that starts the full check on a push, tested below.
   */
  it("keeps the full macOS work out of PR CI and off any schedule", () => {
    const ci = read(".github/workflows/ci.yml");
    expect(ci).not.toMatch(/macos|MAC_RUNNER|test:e2e|electron-builder/);

    const verify = read(".github/workflows/verify.yml");
    expect(verify).toContain("workflow_call:");
    expect(verify).toContain("workflow_dispatch:");
    expect(verify).not.toMatch(/^\s*(schedule|pull_request|push):/m);
    expect(verify).toContain("pnpm exec playwright test");
    expect(verify).toContain("pnpm replay:gate");
    expect(verify).toContain("vars.MAC_RUNNER || 'macos-15'");
  });

  /**
   * INF-2146, the captain's approved plan (direction B, trigger "push"): every
   * push to main runs the full check. INF-2480 (the captain: "old set at the
   * release check only, from the first piece on") leaves the old journey set
   * to the release, so main's check is verify.yml's checks part with only the
   * tests that need a Mac on the Mac. INF-2492 (the captain: "remove phone check from main altogether. we run
   * all phone check parts at release") takes the phone check off it, so the
   * phone release runs every part instead. Runs queue instead of
   * cancelling, so GitHub keeps one running and at most one waiting run.
   * INF-2390: PR #897 also permits an input-free manual start; keep both
   * triggers exact without dropping the push, queue or full-check guarantees.
   */
  it("keeps push and manual starts for the full main check, queued and never cancelled", () => {
    type Call = {
      uses?: string;
      with?: Record<string, unknown>;
      "runs-on"?: string;
      steps?: Step[];
    };
    const main = loadYamlFile(".github/workflows/main.yml") as {
      on: Record<string, { branches?: string[] } | null>;
      concurrency: { group: string; "cancel-in-progress": boolean };
      jobs: Record<string, Call>;
    };
    expect(main.on).toEqual({
      workflow_dispatch: null,
      push: { branches: ["main"], "paths-ignore": expect.any(Array) },
    });
    // One group for every run, so a newer push waits instead of starting beside it.
    expect(main.concurrency.group).not.toContain("${{");
    expect(main.concurrency["cancel-in-progress"]).toBe(false);
    // Each job but the swept batch's sort and its covered mark (INF-2430's
    // plan, piece 3; tests/batch.test.ts holds them) only calls a check, so
    // a full run is exactly those checks.
    const own = Object.entries(main.jobs).filter(([, job]) => !job.uses);
    expect(own.map(([id]) => id).sort()).toEqual(["covered", "sort"]);
    const calls = Object.values(main.jobs)
      .filter((job) => job.uses)
      .map((job) => job.uses);
    expect(
      Object.values(main.jobs).every((job) => !job.uses || (!job.steps && !job["runs-on"])),
    ).toBe(true);
    // INF-2441: the startup fixtures run once per main check, never on a push of their own.
    // INF-2465: the alpha wait comes first, and every check waits for it.
    expect(calls.sort()).toEqual([
      "./.github/workflows/alpha-wait.yml",
      "./.github/workflows/linux-startup.yml",
      "./.github/workflows/verify.yml",
    ]);
    const verify = Object.values(main.jobs).find((job) => job.uses?.endsWith("verify.yml"));
    // The pushed version, with the checks part and only the tagged journeys on the Mac.
    expect(verify?.with).toMatchObject({
      ref: "${{ github.sha }}",
      part: "checks",
      all_journeys: false,
      profile: "stable",
    });
    expect(verify?.with).not.toHaveProperty("installer_only");

    // The phone release calls the phone check at its resolved source and runs
    // every part of both devices before a TestFlight upload, one call per device
    // (INF-2582 direction A, the captain's "A: wait once and trim the soak").
    const phone = loadYamlFile(".github/workflows/phone.yml") as {
      on: Record<string, unknown>;
      jobs: Record<string, { if?: string; steps: Step[] }>;
    };
    expect(Object.keys(phone.on)).toContain("workflow_call");
    const phoneRelease = loadYamlFile(".github/workflows/ios-release.yml") as {
      jobs: Record<
        string,
        {
          uses?: string;
          needs?: string | string[];
          with?: Record<string, string>;
          strategy?: { "fail-fast": boolean; matrix: { device: string[] } };
        }
      >;
    };
    const releaseCall = Object.values(phoneRelease.jobs).find((job) =>
      job.uses?.endsWith("/phone.yml"),
    );
    expect(releaseCall?.with).toEqual({
      trigger: "Requested TestFlight",
      source_commit: "${{ needs.resolve.outputs.source_commit }}",
      device: "${{ matrix.device }}",
    });
    expect(releaseCall?.strategy?.["fail-fast"]).toBe(false);
    expect(releaseCall?.strategy?.matrix.device.toSorted()).toEqual(["ipad", "iphone"]);
    expect(phoneRelease.jobs.testflight?.needs).toContain("phone");
    const source = "6073f484509752eb55ee1b1c85c38b82b4909cc3";
    const released = {
      github: { event_name: "workflow_dispatch", ref: "refs/heads/main" },
      inputs: { source_commit: source, device: "ipad" },
      vars: {},
      env: {},
      matrix: { device: "ipad" },
    };
    const native = phone.jobs["native-phone"];
    expect(workflowValue(native?.if ?? "", released)).toBe(true);
    const scope = native?.steps.find((step) => step.id === "scope");
    const request = native?.steps.find((step) => step.id === "request-select");
    // A crewmate's request chooses parts; the release's call never does.
    expect(workflowValue(request?.if ?? "", released)).toBe(false);
    const selection = {
      ...released,
      steps: { "request-select": { outputs: {} } },
    };
    expect(workflowString(scope?.env?.GATE ?? "", selection)).toBe("true");
    const chosen = {
      ...selection,
      steps: { ...selection.steps, scope: { outputs: { gate: "true" } } },
    };
    const gate = native?.steps.find((step) => step.id === "both");
    expect(workflowValue(gate?.if ?? "", chosen)).toBe(true);
    expect(workflowString(gate?.env?.PHONE_PARTS ?? "", chosen)).toBe("");
    expect(workflowString(gate?.env?.INFINITARY_PHONE_STOP_EARLY ?? "", chosen)).toBe("0");
    // INF-2582 direction A: the release keeps all of INF-1735's relaunch pairs and leaves no part to the iPhone alone.
    expect(
      relaunchPairs(workflowString(gate?.env?.INFINITARY_PHONE_RELAUNCH_PAIRS ?? "", chosen)),
    ).toBe(RELAUNCH_PAIRS_PER_PART);
    expect(workflowString(gate?.env?.PHONE_IPHONE_PARTS ?? "", chosen)).toBe("");
    expect(workflowString(gate?.env?.PHONE_REPEAT_PARTS ?? "", chosen)).toBe("");
  });

  /**
   * INF-2492, the captain's decision on INF-2498's question 1: "Skip pushes
   * that change only the phone app or the docs". Each case is a real squash
   * merge on main with its changed files; GitHub skips the push when every
   * file is ignored, and a later pattern decides over an earlier one.
   */
  it.each([
    [
      "aff06d7cca82",
      false,
      [
        "ios/Infinitary/InfinitaryTests/PhoneShellTests.swift",
        "release-notes/changes/phone-tab-strip-frames-test.json",
      ],
    ],
    ["33631c69d01d", false, ["docs/testing.md"]],
    [
      "7f11512f6b38",
      false,
      [
        "docs/ios.md",
        "ios/Infinitary/InfinitaryApp/PhoneWorkspace.swift",
        "release-notes/changes/ipad-rotation-settles.json",
      ],
    ],
    // Phone check helpers are not the phone app.
    [
      "29ff10079",
      true,
      [
        "docs/ios.md",
        "release-notes/changes/phone-preview-witness-recovery.json",
        "scripts/test-phone.ts",
        "tests/helpers/phoneKeyboard.ts",
        "tests/phone-keyboard.test.ts",
      ],
    ],
    [
      "cb09252ed",
      true,
      [
        "docs/testing.md",
        "release-notes/changes/phone-declaration-selection.json",
        "scripts/affected-phone.ts",
        "tests/fixtures/phone-changes/declaration-consumers.json",
        "tests/phone-chooser.test.ts",
      ],
    ],
    [
      "235b6c4c9",
      true,
      [
        "docs/freeze-recorder.md",
        "release-notes/changes/freeze-journey-crewmate-start.json",
        "tests/e2e/main-thread-freeze.spec.ts",
      ],
    ],
    // The generated contract follows the code, so it is not a doc.
    [
      "a9895d006, its contract and doc files alone",
      true,
      ["docs/contract.json", "docs/inbox.md", "release-notes/changes/crew-responses.json"],
    ],
  ] as const)("main's check for merge %s runs: %s", (_merge, runs, files) => {
    const main = loadYamlFile(".github/workflows/main.yml") as {
      on: { push: { "paths-ignore": string[] } };
    };
    const patterns = main.on.push["paths-ignore"];
    const ignored = (file: string) =>
      patterns.reduce(
        (result, pattern) =>
          pattern.startsWith("!")
            ? posix.matchesGlob(file, pattern.slice(1))
              ? false
              : result
            : posix.matchesGlob(file, pattern)
              ? true
              : result,
        false,
      );
    expect(!files.every(ignored)).toBe(runs);
  });
});
