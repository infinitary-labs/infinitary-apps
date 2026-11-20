import { describe, expect, it } from "vitest";
import { windowsRuns } from "../scripts/windows-paths.ts";

// The captain's pick on INF-4243: the Windows installer check runs "On each
// combined batch that touches Windows-relevant files, and on every alpha".
// Each list is a real change on main, read with git diff --name-only
// --no-renames.
describe("whether a combined batch runs the Windows installer check", () => {
  it.each([
    [
      "test(e2e): keep the wait-reason journeys' printed days the same across midnight",
      [
        "release-notes/changes/wait-journeys-across-midnight.json",
        "tests/e2e/task-wait-reason.spec.ts",
      ],
    ],
    [
      "fix(ios): show a task's newest card from its Tasks row",
      [
        "docs/ios.md",
        "ios/Infinitary/InfinitaryApp/PhoneTasks.swift",
        "ios/Infinitary/InfinitaryKit/Sources/InfinitaryKit/PhoneWork.swift",
        "ios/Infinitary/InfinitaryKit/Tests/InfinitaryKitTests/PhoneBoardTests.swift",
        "ios/Infinitary/InfinitaryUITests/PhoneJourney+CardsMerge.swift",
        "release-notes/changes/task-row-cards-phone.json",
      ],
    ],
    [
      "fix(ci): install Chromium for integration test lanes",
      [
        ".github/workflows/ci.yml",
        ".github/workflows/verify.yml",
        "release-notes/changes/chromium-integration-checks.json",
      ],
    ],
    // Only what the Linux packages are made from.
    [
      "a change to the Linux packages' recipes alone",
      [
        "electron-builder.linux.yml",
        "packaging/linux/aur/PKGBUILD.in",
        "packaging/linux/nix/package.nix.in",
        "docs/linux-packages.md",
      ],
    ],
  ])("skips the Windows check for %s", (_subject, paths) => {
    expect(windowsRuns(paths)).toBe(false);
  });

  it.each([
    ["the shared font notice alone", ["ios/Infinitary/InfinitaryApp/Fonts/Font-licenses.txt"]],
    // The app's code is in the installer.
    [
      "fix(diagnostics): send diagnostics to an address on Infinitary's domain",
      [
        "packaging/alpha-notice.txt",
        "release-notes/changes/company-diagnostics-address.json",
        "src/core/telemetry.ts",
        "tests/release-contract.test.ts",
      ],
    ],
    // The task commands ship in the installer and run in Git Bash.
    [
      "a change to the task commands",
      ["resources/axi-bin/infinitary-stops-axi", "src/core/axi/channel.ts"],
    ],
    // The Windows check's own files, though they are tests and workflows.
    ["a change to the Windows check's journey", ["tests/windows/installed-windows.spec.ts"]],
    ["a change to the Windows check's workflow", [".github/workflows/windows.yml"]],
    // What the Windows check runs, though it is a shared action or helper.
    ["a change to the pnpm action the Windows jobs use", [".github/actions/pnpm/action.yml"]],
    ["a change to the installed-app launcher", ["tests/installed/installedApp.ts"]],
    [
      "test(e2e): give a card's page the window's focus before a key it offers back",
      [
        "docs/e2e-contracts.md",
        "release-notes/changes/frame-key-after-page-focus.json",
        "tests/e2e/not-typing-keys.spec.ts",
        "tests/e2e/windowKeys.ts",
      ],
    ],
  ])("runs the Windows check for %s", (_subject, paths) => {
    expect(windowsRuns(paths)).toBe(true);
  });

  it("runs the Windows check when the change could not be read", () => {
    expect(windowsRuns(undefined)).toBe(true);
    expect(windowsRuns([])).toBe(true);
  });
});
