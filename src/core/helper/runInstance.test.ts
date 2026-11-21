import { describe, expect, it } from "vitest";
import { endRunInstance, type Programs } from "./runInstance";

/**
 * Ending a run by force, by its process and the start it wrote of itself
 * (docs/run.md, "When the command does not answer"; the review of
 * INF-5409): the program under the run's number is the run only while it
 * was born no later than that start, and it is ended, and waited for,
 * through the instance it was opened as.
 */

const RUN = { pid: 4242, startedAt: "2026-10-25T17:00:00.000Z" };
const STARTED = Date.parse(RUN.startedAt);

/** The programs under each process number now, opened as a Windows handle opens one. */
function table(entries: Array<[number, number | undefined]>, refuse = false) {
  const programs = new Map(entries.map(([pid, bornMs]) => [pid, { bornMs }]));
  const ended: number[] = [];
  let taken: number | undefined;
  const open: Programs["open"] = async (pid) => {
    const program = programs.get(pid);
    if (!program) return null;
    return {
      bornMs: program.bornMs,
      end: () => {
        if (refuse) throw new Error("Access is denied.");
        if (programs.get(pid) !== program) return;
        programs.delete(pid);
        ended.push(pid);
        // Another program takes the number as the run goes.
        if (taken !== undefined) programs.set(pid, { bornMs: taken });
      },
      ended: async () => programs.get(pid) !== program,
      close: () => {},
    };
  };
  return {
    programs: { open },
    ended,
    alive: (pid: number) => programs.has(pid),
    takeNumberAs: (bornMs: number) => {
      taken = bornMs;
    },
  };
}

describe("ending a run by force, by its process and start", () => {
  it("ends the run's program, born before it wrote its start", async () => {
    // `ps` reads a start in whole seconds, so a run born in the same second reads as born at it.
    for (const born of [STARTED - 900, STARTED]) {
      const at = table([[RUN.pid, born]]);
      expect(await endRunInstance(RUN, at.programs, 1_000)).toBe("ended");
      expect(at.ended).toEqual([RUN.pid]);
    }
  });

  it("declines a program born after the run's start, or whose birth cannot be read", async () => {
    for (const born of [STARTED + 1, undefined]) {
      const at = table([[RUN.pid, born]]);
      expect(await endRunInstance(RUN, at.programs, 1_000)).toBe("declined");
      expect(at.ended).toEqual([]);
      expect(at.alive(RUN.pid)).toBe(true);
    }
  });

  it("says gone where no program runs under the run's number", async () => {
    expect(await endRunInstance(RUN, table([]).programs, 1_000)).toBe("gone");
  });

  it("counts the run ended once its own program has, though another took its number", async () => {
    const at = table([[RUN.pid, STARTED - 900]]);
    at.takeNumberAs(STARTED + 60_000);
    expect(await endRunInstance(RUN, at.programs, 1_000)).toBe("ended");
    // The program under the number now is the one that took it, still running.
    expect(at.alive(RUN.pid)).toBe(true);
  });

  it("says the run lasts where its program could not be ended in time", async () => {
    const at = table([[RUN.pid, STARTED - 900]], true);
    expect(await endRunInstance(RUN, at.programs, 300)).toBe("lasts");
    expect(at.alive(RUN.pid)).toBe(true);
  });
});
