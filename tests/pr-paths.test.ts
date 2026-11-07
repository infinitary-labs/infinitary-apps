import { describe, expect, it } from "vitest";
import { prRuns } from "../scripts/pr-paths.ts";

// INF-2915's plan, the captain's direction B with the light profile: a pull
// request version that touches only tests, docs, release notes or the phone
// app skips the build and the critical path, and the browser tests run only
// when it touches the renderer or its browser tests. Each list is a real
// change on main, read with git diff --name-only --no-renames.
describe("what a pull request version's build check runs", () => {
  it.each([
    [
      "test(e2e): repair the two upgrade journeys the alpha found stale",
      [
        "release-notes/changes/alpha-upgrade-journeys.json",
        "tests/e2e/older-profile.spec.ts",
        "tests/e2e/timeline-migration.spec.ts",
      ],
    ],
    [
      "test(crew): pin the crew supervisor's task moves and override words before they move",
      [
        "release-notes/changes/crew-supervisor-moves-and-override-guardrails.json",
        "src/core/orchestrator/crewSupervisor.moves.test.ts",
        "src/core/orchestrator/crewSupervisor.overrides.test.ts",
      ],
    ],
    [
      "docs: put docs/alpha.md back at one sentence per line",
      ["docs/alpha.md", "release-notes/changes/alpha-doc-sentence-lines.json"],
    ],
    [
      "fix(ios): open the crewmate under a tap, not where a drag before it started",
      [
        "docs/ios.md",
        "ios/Infinitary/InfinitaryApp/PhoneSceneTouches.swift",
        "ios/Infinitary/InfinitaryUITests/PhoneJourney+Rest.swift",
        "ios/Infinitary/InfinitaryUITests/PhoneJourney+TalkDrafts.swift",
        "release-notes/changes/phone-tap-after-scroll-opens-tapped-crewmate.json",
      ],
    ],
  ])("skips the build, the critical path and the browser tests for %s", (_subject, paths) => {
    expect(prRuns(paths)).toEqual({ build: false, browser: false });
  });

  it.each([
    // The app's code builds.
    [
      "fix(devices): end a dial's late socket quietly once its link was closed",
      [
        "release-notes/changes/home-link-closed-dial.json",
        "src/core/devices/homeLink.test.ts",
        "src/core/devices/homeLink.ts",
      ],
    ],
    // A dependency or a lint setting is part of the build, beside test paths.
    [
      "fix(deps): update Electron to 43.8.7 for upstream Chromium security fixes",
      ["package.json", "pnpm-lock.yaml", "release-notes/changes/electron-43-8-7.json"],
    ],
    [
      "test(phone): show the stand-in Mac's reading note as a new note once it was read",
      [
        "biome.json",
        "release-notes/changes/phone-check-reading-note.json",
        "tests/helpers/phoneHome.ts",
        "tests/phone-reading-note.test.ts",
      ],
    ],
    // A workflow is not a test.
    [
      "chore(ci): let a manual check request run only the Mac jobs",
      [
        ".github/workflows/verify.yml",
        "docs/forge.md",
        "docs/testing.md",
        "release-notes/changes/verify-mac-only-requests.json",
        "tests/release-workflows-journey-suites.test.ts",
      ],
    ],
  ])("runs the build and the critical path, not the browser tests, for %s", (_subject, paths) => {
    expect(prRuns(paths)).toEqual({ build: true, browser: false });
  });

  it("runs the browser tests and the build for a change to the renderer", () => {
    // fix(accounts): leave no unhandled rejection after a refused add or allowance refresh
    const paths = [
      "release-notes/changes/account-add-unhandled-rejection.json",
      "src/renderer/src/accounts/signInFlight.ts",
      "src/renderer/src/settings/SubscriptionsTab.tsx",
      "tests/browser/card-action-feedback-accounts.test.tsx",
    ];
    expect(prRuns(paths)).toEqual({ build: true, browser: true });
  });

  it("runs the browser tests alone for a change to the browser tests", () => {
    // The browser test file of the change above, on its own.
    const paths = [
      "release-notes/changes/account-add-unhandled-rejection.json",
      "tests/browser/card-action-feedback-accounts.test.tsx",
    ];
    expect(prRuns(paths)).toEqual({ build: false, browser: true });
  });

  it("runs everything when the change cannot be read or lists nothing", () => {
    expect(prRuns(undefined)).toEqual({ build: true, browser: true });
    expect(prRuns([])).toEqual({ build: true, browser: true });
  });
});
