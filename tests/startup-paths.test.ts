import { describe, expect, it } from "vitest";
import { startupReached } from "../scripts/startup-paths.ts";

// INF-2486 cut F, approved by the captain with cuts B to E: the pull
// request's Linux startup fixtures skip only when every changed path is
// docs, primitives, Markdown, release notes or a workflow other than ci.yml.
// Each list is a real change on main, read with git diff --name-only --no-renames.
describe("whether a change reaches the Linux startup fixtures", () => {
  it.each([
    [
      "docs(release): cut each alpha from main's green mark",
      [
        "AGENTS.md",
        "docs/alpha.md",
        "docs/release-notes.md",
        "docs/testing.md",
        "release-notes/changes/alpha-from-main-mark.json",
      ],
    ],
    [
      "fix(ci): run release.yml's phone job on LINUX_RUNNER like every other Linux job",
      [".github/workflows/release.yml", "release-notes/changes/phone-job-on-linux-runner.json"],
    ],
    [
      "chore(release-notes): pin the record of alpha 0.6.2-alpha.47",
      [
        "release-notes/changes/alpha-review-a2c70116.json",
        "release-notes/changes/freeze-recorder.json",
        "release-notes/releases/0.6.2-alpha.47.json",
      ],
    ],
  ])("skips them for %s", (_subject, paths) => {
    expect(startupReached(paths)).toBe(false);
  });

  it.each([
    // The job that runs the fixtures is defined in ci.yml itself.
    [
      "chore(ci): let the PR startup check take a PC queue through its startup kind",
      [
        ".github/workflows/ci.yml",
        "docs/testing.md",
        "release-notes/changes/startup-queue-kind.json",
        "tests/release-workflows.test.ts",
      ],
    ],
    // Any code or test path runs them, even beside other workflows.
    [
      "chore(ci): run the Linux startup check once per main check",
      [
        ".github/workflows/linux-startup.yml",
        ".github/workflows/main.yml",
        "docs/testing.md",
        "release-notes/changes/startup-check-once-per-main-check.json",
        "tests/release-workflows.test.ts",
      ],
    ],
    // The fixture action is not a workflow.
    ["an edit to the fixture action", [".github/actions/linux-startup/action.yml"]],
  ])("runs them for %s", (_subject, paths) => {
    expect(startupReached(paths)).toBe(true);
  });

  it("runs them when the change cannot be read or lists nothing", () => {
    expect(startupReached(undefined)).toBe(true);
    expect(startupReached([])).toBe(true);
  });
});
