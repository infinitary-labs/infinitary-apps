import type { UpdateStatus } from "@shared/update";
import { UPDATE_NOTICES, UPDATE_PROBLEMS, UPDATE_WORDS } from "@shared/updateWords";
import { describe, expect, it } from "vitest";
import { updateLine } from "./UpdateCheck";

// INF-2073, the captain's direction A: the Version row's line says what Check for updates found.
const STATUS: UpdateStatus = {
  currentVersion: "0.1.30",
  channel: "stable",
  latestVersion: "0.1.30",
  updateAvailable: false,
  releaseUrl: null,
  upgradeCommand: "",
  notice: UPDATE_NOTICES.latest,
};

describe("the Version row's update line", () => {
  it("says checking while a press reads, then what the read found", () => {
    expect(updateLine(STATUS, true)).toBe(UPDATE_WORDS.checking);
    expect(updateLine(STATUS, false)).toBe(UPDATE_NOTICES.latest);
    expect(
      updateLine(
        { ...STATUS, latestVersion: "0.1.31", updateAvailable: true, notice: undefined },
        false,
      ),
    ).toBe(UPDATE_NOTICES.available("0.1.31"));
  });

  it("says a failed check failed, even with a notice left over", () => {
    expect(
      updateLine({ ...STATUS, phase: "error", problem: UPDATE_PROBLEMS.checkFailed }, false),
    ).toBe(UPDATE_PROBLEMS.checkFailed);
  });

  it("leaves a copy of unknown installation to its explanation", () => {
    expect(
      updateLine(
        { ...STATUS, notice: undefined, problem: UPDATE_PROBLEMS.unknownInstallation },
        false,
      ),
    ).toBeNull();
    expect(updateLine(null, false)).toBeNull();
  });

  it("says nothing of checking while an update downloads", () => {
    expect(updateLine({ ...STATUS, phase: "downloading", updateAvailable: true }, true)).toBeNull();
  });
});
