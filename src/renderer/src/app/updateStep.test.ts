import * as m from "@shared/i18n/messages.generated";
import type { UpdateStatus } from "@shared/update";
import {
  UPDATE_LATER,
  UPDATE_NOTICES,
  UPDATE_PROBLEMS,
  UPDATE_STEP_WORDS,
  UPDATE_WORDS,
  UPDATE_WORK_WORDS,
} from "@shared/updateWords";
import { describe, expect, it } from "vitest";
import { type UpdateStepPresses, updateStep } from "./updateStep";

// INF-2073, the captain's direction A: the update line says what Check for updates found.
// INF-2670, the captain's direction A: every state names its next step beside the button
// that takes it, in the Version row and the update notice alike.
// INF-3405, the captain's direction B: "we still need to provide the "check for update" button
// because it could be that there's an even newer version" - Check for updates sits beside the
// next step while a version is offered, and the version in the line opens its release page.
const NOW = 1_800_000_000_000;
const STATUS: UpdateStatus = {
  currentVersion: "0.1.30",
  channel: "stable",
  latestVersion: "0.1.30",
  updateAvailable: false,
  releaseUrl: null,
  upgradeCommand: "",
  notice: UPDATE_NOTICES.latest("stable"),
  checkedAt: NOW,
};
const OFFERED: UpdateStatus = {
  ...STATUS,
  latestVersion: "0.1.31",
  updateAvailable: true,
  notice: undefined,
  install: { asksPassword: false, restarts: true },
  channelChoice: true,
  phase: "idle",
};
const PRESSED: UpdateStepPresses = {
  checking: false,
  busy: false,
  problem: null,
  later: null,
  now: NOW,
};
const step = (status: UpdateStatus | null, pressed: Partial<UpdateStepPresses> = {}) =>
  updateStep(status, { ...PRESSED, ...pressed });
/** The step's line and its buttons' labels, the way a person reads it. */
const reads = (status: UpdateStatus | null, pressed: Partial<UpdateStepPresses> = {}) => {
  const found = step(status, pressed);
  return found && [found.line, found.secondary?.label ?? null, found.primary.label];
};

describe("the update ladder", () => {
  it("says checking while a press reads, then what the read found and when", () => {
    expect(reads(STATUS, { checking: true })).toEqual([
      UPDATE_WORDS.checking,
      null,
      UPDATE_WORDS.checkingButton,
    ]);
    expect(reads(STATUS)).toEqual([
      "Up to date on Stable. Checked just now.",
      null,
      UPDATE_WORDS.check,
    ]);
    expect(step(STATUS, { now: NOW + 5 * 60_000 })?.line).toBe(
      "Up to date on Stable. Checked 5m ago.",
    );
    expect(
      step({ ...STATUS, channel: "alpha", notice: UPDATE_NOTICES.latest("alpha") })?.line,
    ).toBe("Up to date on Alpha. Checked just now.");
  });

  it("offers Try again and the releases page after a failed check, even with a notice left over", () => {
    expect(reads({ ...STATUS, phase: "error", problem: UPDATE_PROBLEMS.checkFailed })).toEqual([
      UPDATE_PROBLEMS.checkFailed,
      UPDATE_WORDS.releasesPage,
      UPDATE_WORDS.retry,
    ]);
  });

  it("keeps an offered version after a failed check, saying the check failed", () => {
    const failed = step({ ...OFFERED, phase: "error", problem: UPDATE_PROBLEMS.checkFailed });
    expect(failed).toMatchObject({
      state: "available",
      line: `${UPDATE_PROBLEMS.checkFailed} ${UPDATE_NOTICES.stillAvailable("0.1.31")} ${UPDATE_STEP_WORDS.restarts}`,
      problem: true,
      version: "0.1.31",
      primary: { action: "install", label: UPDATE_WORDS.restart },
      secondary: { action: "check", label: UPDATE_WORDS.check },
    });
  });

  it("holds the offer still while a check reads, with only its button saying so", () => {
    const offered = step(OFFERED);
    for (const reading of [
      step(OFFERED, { checking: true }),
      step({ ...OFFERED, phase: "checking" }),
    ])
      expect(reading).toEqual({
        ...offered,
        secondary: { action: "check", label: UPDATE_WORDS.checkingButton, disabled: false },
      });
    // Update and restart reads first; while it does, Check for updates waits.
    expect(step({ ...OFFERED, phase: "checking" }, { busy: true })).toMatchObject({
      primary: { action: "install", pending: UPDATE_WORDS.installing },
      secondary: { action: "check", disabled: true },
    });
  });

  it("offers a copy of unknown installation the releases page, with its explanation", () => {
    const unknown = step({
      ...STATUS,
      notice: undefined,
      problem: UPDATE_PROBLEMS.unknownInstallation,
    });
    expect(unknown).toMatchObject({
      state: "unknown",
      line: UPDATE_PROBLEMS.unknownInstallation,
      problem: true,
      primary: { action: "release", label: UPDATE_WORDS.releasesPage },
    });
    expect(unknown?.secondary).toBeUndefined();
    expect(step(null)).toBeNull();
  });

  it("offers Update and restart beside Check for updates, or Install where Linux asks for a password", () => {
    expect(reads(OFFERED)).toEqual([
      `${UPDATE_NOTICES.available("0.1.31")} Checked just now. ${UPDATE_STEP_WORDS.restarts}`,
      UPDATE_WORDS.check,
      UPDATE_WORDS.restart,
    ]);
    expect(step(OFFERED, { now: NOW + 3 * 60 * 60_000 })?.line).toBe(
      `${UPDATE_NOTICES.available("0.1.31")} Checked 3h ago. ${UPDATE_STEP_WORDS.restarts}`,
    );
    expect(step(OFFERED)?.version).toBe("0.1.31");
    expect(reads({ ...OFFERED, install: { asksPassword: true }, checkedAt: undefined })).toEqual([
      `${UPDATE_NOTICES.available("0.1.31")} ${UPDATE_STEP_WORDS.asksPassword}`,
      UPDATE_WORDS.check,
      "Install",
    ]);
  });

  it("offers Check for updates alone where nothing installs here, beside the version's link", () => {
    expect(step({ ...OFFERED, install: undefined })).toMatchObject({
      state: "available",
      line: `${UPDATE_NOTICES.available("0.1.31")} Checked just now.`,
      version: "0.1.31",
      primary: { action: "check", label: UPDATE_WORDS.check },
    });
    expect(step({ ...OFFERED, install: undefined })?.secondary).toBeUndefined();
  });

  it("shows a package manager's command with Copy command", () => {
    const command = "brew update && brew upgrade --cask infinitary";
    const homebrew = step({ ...OFFERED, install: undefined, upgradeCommand: command });
    expect(homebrew).toMatchObject({
      state: "command",
      line: `${UPDATE_NOTICES.available("0.1.31")} Checked just now. ${UPDATE_STEP_WORDS.command}`,
      command,
      version: "0.1.31",
      primary: { action: "copy", label: UPDATE_WORDS.copy },
      secondary: { action: "check", label: UPDATE_WORDS.check },
    });
  });

  it("says nothing of checking while an update downloads, and shows how far it is", () => {
    const downloading = step({ ...OFFERED, phase: "downloading", percent: 42 }, { checking: true });
    expect(downloading).toMatchObject({
      state: "downloading",
      line: UPDATE_STEP_WORDS.downloading("0.1.31"),
      percent: 42,
      primary: { pending: UPDATE_WORDS.downloading },
    });
    // A started update offers no check: it installs the version it is downloading.
    expect(downloading?.secondary).toBeUndefined();
  });

  // INF-2245: the crew's work around this computer's update, saved then resumed.
  it("says the update saves work, then updates, then resumes the work it paused", () => {
    expect(
      step({
        ...OFFERED,
        phase: "installing",
        work: { state: "saving", tasks: ["Release notes"] },
      }),
    ).toMatchObject({
      line: UPDATE_WORK_WORDS.saving,
      waiting: ["Release notes"],
      primary: { pending: UPDATE_WORDS.saving },
      secondary: { action: "later", label: UPDATE_WORDS.later },
    });
    expect(step({ ...OFFERED, phase: "installing" })).toMatchObject({
      line: UPDATE_WORK_WORDS.updating,
      primary: { pending: UPDATE_WORDS.updating },
    });
    expect(step({ ...OFFERED, phase: "installing" })?.secondary).toBeUndefined();
    expect(
      step({ ...STATUS, work: { state: "resuming", tasks: ["Release notes", "Docs"] } }),
    ).toMatchObject({
      line: UPDATE_WORK_WORDS.resuming(2),
      primary: { action: "check", disabled: true },
    });
  });

  it("says the update waits after Update later, and offers it again", () => {
    expect(reads(OFFERED, { later: UPDATE_LATER })).toEqual([
      `${UPDATE_NOTICES.available("0.1.31")} Checked just now. ${UPDATE_LATER}`,
      UPDATE_WORDS.check,
      UPDATE_WORDS.restart,
    ]);
  });

  it("offers Restart for a staged update, with the problem when restarting did not finish", () => {
    expect(reads({ ...OFFERED, phase: "ready" })).toEqual([
      UPDATE_STEP_WORDS.ready,
      null,
      UPDATE_WORDS.ready,
    ]);
    expect(step({ ...OFFERED, phase: "ready", problem: UPDATE_PROBLEMS.staged })).toMatchObject({
      line: UPDATE_PROBLEMS.staged,
      problem: true,
      primary: { action: "install", label: UPDATE_WORDS.ready },
    });
  });

  it("offers Try again after a failure that can pass, and only the releases page after one it cannot", () => {
    const stopped = "The update could not be installed, so nothing changed.";
    expect(reads({ ...OFFERED, phase: "error" }, { problem: stopped })).toEqual([
      `${stopped} ${UPDATE_NOTICES.stillAvailable("0.1.31")}`,
      UPDATE_WORDS.check,
      UPDATE_WORDS.retry,
    ]);
    // The core withdraws installing for a problem it cannot fix on this copy.
    const blocked = step({
      ...OFFERED,
      install: undefined,
      problem: UPDATE_PROBLEMS.unwritable,
    });
    expect(blocked).toMatchObject({
      state: "blocked",
      line: UPDATE_PROBLEMS.unwritable,
      problem: true,
      primary: { action: "release", label: UPDATE_WORDS.releasesPage },
    });
    expect(blocked?.secondary).toBeUndefined();
  });

  // INF-5635's approved plan, piece 2: a copy run by pnpm dev names main's newer
  // commits, offers Update and restart when it can move forward to them, and
  // says why when it cannot.
  it("names a source copy's newer commits, or why it cannot move forward to them", () => {
    const source: UpdateStatus = {
      ...OFFERED,
      currentVersion: "1a2b3c4",
      latestVersion: "5d6e7f8",
      releaseUrl: null,
      channelChoice: undefined,
      source: { branch: "main", behind: 3 },
    };
    expect(reads(source)).toEqual([
      `${m.updateSourceAvailable({ branch: "main", count: 3, commit: "5d6e7f8" })} Checked just now. ${UPDATE_STEP_WORDS.restarts}`,
      UPDATE_WORDS.check,
      UPDATE_WORDS.restart,
    ]);
    expect(step({ ...source, phase: "error", problem: UPDATE_PROBLEMS.checkFailed })?.line).toBe(
      `${UPDATE_PROBLEMS.checkFailed} ${m.updateSourceStillAvailable({ branch: "main", count: 3, commit: "5d6e7f8" })} ${UPDATE_STEP_WORDS.restarts}`,
    );
    const held = { ...source, install: undefined };
    expect(reads({ ...held, source: { branch: "main", behind: 1, held: "edited" } })).toEqual([
      `${m.updateSourceAvailable({ branch: "main", count: 1, commit: "5d6e7f8" })} Checked just now. ${m.updateSourceEdited()}`,
      null,
      UPDATE_WORDS.check,
    ]);
    expect(step({ ...held, source: { branch: "main", behind: 1, held: "ahead" } })?.line).toBe(
      `${m.updateSourceAvailable({ branch: "main", count: 1, commit: "5d6e7f8" })} Checked just now. ${m.updateSourceAhead({ branch: "main" })}`,
    );
  });

  // INF-5635's approved plan, piece 2, review finding f-source-release-link: a copy run
  // from source has no releases page, so no control offers one, and its offered commit
  // opens only a page comparing the two commits where the project's host has one.
  it("gives a source copy only controls that do something", () => {
    const source: UpdateStatus = {
      ...OFFERED,
      currentVersion: "1a2b3c4",
      latestVersion: "5d6e7f8",
      releaseUrl: null,
      channelChoice: undefined,
      source: { branch: "main", behind: 1 },
    };
    expect(step(source)?.version).toBeUndefined();
    expect(
      step({ ...source, releaseUrl: "https://github.com/o/p/compare/1a2b3c4...5d6e7f8" })?.version,
    ).toBe("5d6e7f8");
    const upToDate = { ...source, updateAvailable: false, source: { branch: "main", behind: 0 } };
    expect(reads({ ...upToDate, phase: "error", problem: UPDATE_PROBLEMS.checkFailed })).toEqual([
      UPDATE_PROBLEMS.checkFailed,
      null,
      UPDATE_WORDS.retry,
    ]);
    const wentBack = m.updateSourceBuildFailed({ from: "1a2b3c4", to: "5d6e7f8" });
    const held = { ...source, install: undefined, problem: wentBack };
    expect(step({ ...held, source: { branch: "main", behind: 1, held: "edited" } })).toMatchObject({
      state: "blocked",
      line: wentBack,
      primary: { action: "check", label: UPDATE_WORDS.check },
    });
  });
});
