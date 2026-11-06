import { describe, expect, it, vi } from "vitest";
import { heavyRunWords } from "../scripts/heavy-run-place";
import { computerLines, declared, start } from "./helpers/heavyRunLine";
import { scratchDir } from "./helpers/scratchDirs";

/**
 * INF-1621 piece 3 (INF-1664): a local `pnpm test:phone` gate declares its
 * needs in the load line of the computer it runs on before it builds
 * anything, and a gate stopped while it waits leaves the line. The gate needs
 * Xcode on a Mac (scripts/test-phone.ts), so this case is apart from the
 * other heavy runs' (`heavy-run-place.test.ts`, which Linux runs) and its file
 * is on the Mac lane's list (scripts/mac-unit-tests.ts).
 * Fixture: the real task channel, command processes and native wrappers over
 * a disposable line with no reading, so the gate never leaves the line's wait.
 * Failure: a gate that skips the line, declares other needs, starts building
 * before admission, or keeps its place after its group is stopped fails here.
 */
// The line looks for ended groups on its two-second cadence; the budget
// covers that boundary and the channel's start.
vi.setConfig({ testTimeout: 25_000 });

describe.runIf(process.platform === "darwin")(
  "a local heavy run in this computer's load line",
  () => {
    const computerLine = computerLines();

    it("a local phone gate asks with its declared needs before it builds anything, and leaves the line when stopped while it waits", async () => {
      const { shell, runs } = await computerLine();
      const evidence = scratchDir("infinitary-heavy-phone-evidence-");
      // A shell's job: the gate leads a process group of its own.
      const gate = start(
        process.execPath,
        ["scripts/test-phone.ts", "--both", "--evidence", evidence],
        { ...shell("phone"), INFINITARY_CHECKS: "local" },
        true,
      );
      const group = -(gate.child.pid as number);
      try {
        await expect
          .poll(runs)
          .toEqual([{ taskId: "phone", state: "waiting", demand: declared("phone") }]);
        // The whole group stops with no chance to close its place, as when the app quits.
        process.kill(group, "SIGKILL");
        await gate.exited;
        await expect.poll(runs).toEqual([]);
        expect(gate.output()).toContain(heavyRunWords.asking("phone"));
        expect(gate.output()).not.toContain("xcodebuild");
      } finally {
        try {
          process.kill(group, "SIGKILL");
        } catch {}
      }
    });
  },
);
