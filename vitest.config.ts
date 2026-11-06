import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";
import { PROBE_FILES } from "./scripts/affected-probes.ts";
import { jobCores } from "./scripts/job-cores.ts";
import { FRAME_FOCUS_BLINK_FEATURE } from "./src/shared/plugins/containment.ts";
import { browserCommands } from "./tests/helpers/browserCommands.ts";
import TimeBalancedSequencer from "./tests/helpers/timeBalancedSequencer.ts";

/**
 * The integration cohort (captain's A1, docs/test-cohorts.md) is the list of
 * files the unit cohort's lint fence exempts: the exclusions of the
 * biome.json override that runs tests/lint/unit-cohort.grit. One list, read
 * by both, so a file cannot be fenced as a unit test and run as an
 * integration test or the other way round.
 */
function integrationTests(): string[] {
  const biome = JSON.parse(readFileSync(resolve(__dirname, "biome.json"), "utf8")) as {
    overrides?: { includes?: string[]; plugins?: string[] }[];
  };
  const fence = biome.overrides?.find((override) =>
    override.plugins?.includes("./tests/lint/unit-cohort.grit"),
  );
  if (!fence?.includes) throw new Error("biome.json has no unit-cohort override to read");
  return fence.includes.filter((glob) => glob.startsWith("!")).map((glob) => glob.slice(1));
}

const integration = integrationTests();

// The probes (docs/test-cohorts.md, "Probes"): integration files that can fail
// with no code change. They stay on the integration list, so the unit fence
// still exempts them, and run as their own project: a change runs only the
// probes whose paths it edits (scripts/affected-probes.ts).
for (const file of PROBE_FILES) {
  if (!integration.includes(file)) throw new Error(`probe ${file} is not on the integration list`);
}

// Module mocks, process-state writers and cold-cache fixture guards retain isolation.
const isolatedUnit = [
  "src/core/selfSource/resolveAsync.test.ts",
  "tests/classifier-clock.test.ts",
  "src/core/axi/cli.test.ts",
  "src/core/axi/browserCommands.test.ts",
  "src/core/accounts/claudeAccounts.test.ts",
  "src/core/claude/claudeClassifierSession.test.ts",
  "src/core/claude/claudeFirstmateSession.test.ts",
  "src/core/claude/claudeModelCatalog.test.ts",
  "src/core/claude/claudeSession.contract.test.ts",
  "src/core/claude/claudeSession.test.ts",
  "src/core/claude/claudeStoreLease.test.ts",
  "src/core/helper/sessionHost.test.ts",
  "src/core/helper/sessionHostCardFiles.test.ts",
  "src/core/helper/sessionHostDeadlines.test.ts",
  "src/core/helper/sessionHostJobs.test.ts",
  "src/core/helper/sessionHostRestarts.test.ts",
  "src/core/helper/signIns.test.ts",
  "src/core/models/accountStore.test.ts",
  "src/core/models/catalogReaders.test.ts",
  "src/core/orchestrator/localOrchestrator.test.ts",
  "src/core/pi/accountVault.test.ts",
  "src/core/pi/classifierSession.realSession.test.ts",
  "src/core/pi/codexLogin.integration.test.ts",
  "src/core/pi/codingSession.realSession.test.ts",
  "src/core/pi/crewmateTaskTools.test.ts",
  "src/core/pi/customApiAccounts.test.ts",
  "src/core/pi/customApiPolicy.test.ts",
  "src/core/pi/customApiProtocol.test.ts",
  "src/core/pi/customApiTransport.pin.test.ts",
  "src/core/pi/customApiTransport.test.ts",
  "src/core/pi/firstmateSession.realSession.test.ts",
  "src/core/pi/piAccountBackend.test.ts",
  "src/core/pi/piCatalogCheck.test.ts",
  "src/core/pi/piCatalogProbe.test.ts",
  "src/core/pi/piResources.isolation.test.ts",
  "src/core/pi/sessionFactory.test.ts",
  "src/core/pi/taskTools.override.test.ts",
  "src/core/pi/toolSpec.test.ts",
  "src/core/pi/validationEvidence.test.ts",
  "src/core/placed/placedClaude.contract.test.ts",
  "src/core/placed/placedModelLabel.test.ts",
  // It loads the Claude client's tools, whose import sets an environment variable.
  "src/core/session/answerFiles.test.ts",
  "src/main/host/macUpdates.test.ts",
  "src/main/voice/voiceHelper.test.ts",
  "src/main/voice/voiceProtocol.test.ts",
  "src/main/work.test.ts",
  "src/renderer/src/app/appearance.test.ts",
  "src/renderer/src/app/cardActions.test.ts",
  "src/renderer/src/app/commandRefusals.test.ts",
  "src/renderer/src/app/composer.test.ts",
  "src/renderer/src/app/savedCardAnswers.test.ts",
  "src/renderer/src/app/stack.test.ts",
  "src/renderer/src/app/stackActions.test.ts",
  "src/renderer/src/app/store.minimize.test.ts",
  "src/renderer/src/app/store.reconnect.test.ts",
  "src/renderer/src/app/store.test.ts",
  "src/renderer/src/app/store.voice.test.ts",
  "src/renderer/src/app/voice.test.ts",
  "src/renderer/src/cards/cardTask.test.ts",
  "src/renderer/src/cards/taskLinks.test.ts",
  // Its useCrewBoard mock must reach CrewSummary, which other files load unmocked.
  "src/renderer/src/design/core/TaskFacts.test.tsx",
  "src/renderer/src/plugins/panelCards.test.ts",
  "src/renderer/src/plugins/panelPoint.test.ts",
  "src/renderer/src/plugins/point/openTask.test.ts",
  "src/renderer/src/plugins/point/linePeek.test.ts",
  "src/renderer/src/plugins/railStore.test.ts",
  "src/renderer/src/plugins/reads/appExecutor.test.ts",
  "src/renderer/src/voice/micRecorder.test.ts",
  "src/renderer/src/voice/prepareClip.test.ts",
  "src/renderer/src/voice/voiceController.test.ts",
  "src/renderer/src/voice/whisperClient.test.ts",
  "tests/check-account-models.test.ts",
  "tests/derive-miss-candidates.test.ts",
  "tests/extract-dispatch-corpus.test.ts",
  // Its observer lifecycle checks replace child_process.spawn with owned streams.
  "tests/phone-keyboard.test.ts",
  // Its Photos readiness checks replace child_process.spawn with an owned stream.
  "tests/phone-photos.test.ts",
  "tests/phone-logs.test.ts",
  // Its fixed-clock migration comparison must not inherit a warmed template.
  "tests/helpers/database.test.ts",
  // It loads the Claude SDK through the seat's harness.
  "tests/helpers/claudeSeatHarness.test.ts",
  // It loads the Claude SDK through the Claude tool server it serves an answer from.
  "src/core/session/answerFiles.test.ts",
  // It wraps node:fs's listing to remove an entry the way a running app does.
  "tests/e2e/savedText.test.ts",
];

export default defineConfig({
  resolve: {
    alias: {
      "@core": resolve(__dirname, "src/core"),
      "@shared": resolve(__dirname, "src/shared"),
      "@infinitary/ui": resolve(__dirname, "src/renderer/src/design/index.ts"),
      "@infinitary/contracts": resolve(__dirname, "src/shared/plugins/personalPanel.ts"),
      "@firstmate/ui": resolve(__dirname, "src/renderer/src/design/index.ts"),
      "@firstmate/contracts": resolve(__dirname, "src/shared/plugins/personalPanel.ts"),
    },
  },
  test: {
    environment: "node",
    // A test's time limit, and a wait's window, count load time and end by
    // their wall cap; a run that grades budgets keeps the wall clock
    // (tests/helpers/budgets.ts, INF-1083): waitWindow.ts starts the clock
    // and the patched runner and vitest read it.
    // One private TMPDIR per run, required empty at the end (runTempRoot.ts).
    globalSetup: ["./tests/helpers/vitestGlobalSetup.ts"],
    projects: [
      {
        extends: true,
        test: {
          name: "pure",
          maxWorkers: Math.max(2, jobCores() - 1),
          include: ["src/shared/**/*.test.ts"],
          isolate: false,
          setupFiles: [
            "./tests/helpers/pureProject.ts",
            "./tests/helpers/scratchDirCleanup.ts",
            "./tests/helpers/waitWindow.ts",
          ],
        },
      },
      {
        extends: true,
        test: {
          name: "unit",
          maxWorkers: Math.max(2, jobCores() - 1),
          include: ["src/**/*.test.{ts,tsx}", "tests/**/*.test.{ts,tsx}"],
          exclude: ["src/shared/**/*.test.ts", "tests/browser/**", ...integration, ...isolatedUnit],
          isolate: false,
          setupFiles: [
            "./tests/helpers/pureProject.ts",
            "./tests/helpers/statementCheck.ts",
            "./tests/helpers/scratchDirCleanup.ts",
            "./tests/helpers/waitWindow.ts",
          ],
        },
      },
      {
        extends: true,
        test: {
          name: "unit-isolated",
          maxWorkers: Math.max(2, jobCores() - 1),
          include: isolatedUnit,
          isolate: true,
          setupFiles: [
            "./tests/helpers/statementCheck.ts",
            "./tests/helpers/scratchDirCleanup.ts",
            "./tests/helpers/waitWindow.ts",
          ],
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          // The fence also exempts shared process fixtures; they are helpers,
          // not suites. Keep actual tests in the same single-owned cohort list.
          include: integration.filter(
            (path) => /\.test\.tsx?$/.test(path) && !PROBE_FILES.includes(path),
          ),
          isolate: true,
          setupFiles: [
            "./tests/helpers/statementCheck.ts",
            "./tests/helpers/scratchDirCleanup.ts",
            "./tests/helpers/waitWindow.ts",
          ],
          // Real git, pnpm and child processes: eight on Mac, or fewer for a job
          // sized smaller (scripts/job-cores.ts), four elsewhere, after the
          // in-memory cohorts finish, so the suite is not its own load
          // generator. Each file states its own budget; the default stays 5 s.
          maxWorkers: process.platform === "darwin" ? Math.min(8, jobCores(process.env, 8)) : 4,
          sequence: { groupOrder: 1 },
        },
      },
      {
        // The browser layer (docs/testing.md, "The browser layer"): the
        // window's React drawn in a real Chromium page, behind the one shared
        // fake of the window bridge (tests/browser/bridge.ts). Each file
        // starts from a fresh page, as each journey was a fresh app: a
        // session runs its files in one page, so its setup clears what an
        // earlier file kept (tests/browser/freshPage.ts).
        extends: true,
        plugins: [react()],
        test: {
          name: "browser",
          include: ["tests/browser/**/*.test.{ts,tsx}"],
          // One Chromium page per file, in a group of its own after the
          // probes, so a whole run never loads the host with both at once.
          sequence: { groupOrder: 3 },
          // The fresh home's answers, read once per run from a real core.
          globalSetup: [
            "./tests/helpers/vitestGlobalSetup.ts",
            "./tests/helpers/browserFreshHome.ts",
          ],
          setupFiles: ["./tests/browser/freshPageSetup.ts"],
          browser: {
            enabled: true,
            headless: true,
            // The window's Chromium runs with Web Share on, which the shell
            // spends a page's activation through, and with a frame's focus
            // held to a person's gesture (src/main/app.ts); the test page's
            // Chromium runs the same. The window draws scrollbars as its
            // system does - over the content on a Mac by default, beside it
            // on Linux, and beside it wherever a page styles them - where a
            // headless page hides them all, so the page keeps them
            // (tests/browser/card-resize.test.tsx reads a scrollbar's width).
            provider: playwright({
              launchOptions: {
                ignoreDefaultArgs: ["--hide-scrollbars"],
                args: [`--enable-blink-features=WebShare,${FRAME_FOCUS_BLINK_FEATURE}`],
              },
            }),
            instances: [{ browser: "chromium" }],
            commands: browserCommands,
          },
        },
      },
      {
        extends: true,
        test: {
          name: "probe",
          include: [...PROBE_FILES],
          isolate: true,
          setupFiles: [
            "./tests/helpers/statementCheck.ts",
            "./tests/helpers/scratchDirCleanup.ts",
            "./tests/helpers/waitWindow.ts",
          ],
          // The integration cohort's workers, in a group of their own after it,
          // so a whole run never loads the host with both at once.
          maxWorkers: process.platform === "darwin" ? Math.min(8, jobCores(process.env, 8)) : 4,
          sequence: { groupOrder: 2 },
        },
      },
    ],
    // The frame stylesheet imports the design tokens as text (`?raw`);
    // vitest otherwise blanks every .css module, query or not.
    css: true,
    // A run that names a file also writes each test file's time there, as the
    // record scripts/shard-timings.ts balances the unit groups by.
    ...(process.env.INFINITARY_TEST_TIMING_FILE
      ? {
          reporters: ["default", ["json", { outputFile: process.env.INFINITARY_TEST_TIMING_FILE }]],
        }
      : {}),
    // --shard gives each group about the same measured time, not the same count of files.
    sequence: { sequencer: TimeBalancedSequencer },
  },
});
