import type { FolderHolder } from "@core/placed/folderHolders";
import { describe, expect, it } from "vitest";
import { endLeftoverPrograms, LEFTOVER_WAIT_MS, type LeftoverSeams } from "./leftovers";

/**
 * A reset ends the programs tasks left running in the data folder (the
 * approved plan: "end leftover programs still running 15 s after the tasks
 * close"), or one holding a file would keep Windows from renaming the folder
 * at the next start.
 */

const SERVER: FolderHolder = { pid: 4242, started: "Mon Nov 23 10:00:00 2026", name: "node" };

function programs(endsBy: number | null, survives = false) {
  let clock = 0;
  const ended: number[] = [];
  const seams: LeftoverSeams = {
    find: async () => ({
      status: "checked",
      holders: endsBy !== null && clock >= endsBy ? [] : ended.length ? [] : [SERVER],
    }),
    end: async (holder) => {
      ended.push(holder.pid);
      return { pid: holder.pid, name: holder.name, outcome: survives ? "survived" : "ended" };
    },
    wait: async (ms) => {
      clock += ms;
    },
    now: () => clock,
  };
  return { ended, seams, clock: () => clock };
}

describe("ending the programs a reset finds in the folder", () => {
  it("lets a program that ends by itself within the wait go", async () => {
    const at = programs(3_000);
    expect(await endLeftoverPrograms("/data", at.seams)).toBe(true);
    expect(at.ended).toEqual([]);
  });

  it("ends a program still running after the wait", async () => {
    const at = programs(null);
    expect(await endLeftoverPrograms("/data", at.seams)).toBe(true);
    expect(at.ended).toEqual([SERVER.pid]);
    expect(at.clock()).toBe(LEFTOVER_WAIT_MS);
  });

  it("answers false for a program that survives, or programs it cannot read", async () => {
    expect(await endLeftoverPrograms("/data", programs(null, true).seams)).toBe(false);
    const unreadable = programs(null);
    unreadable.seams.find = async () => ({ status: "unreadable" });
    expect(await endLeftoverPrograms("/data", unreadable.seams)).toBe(false);
  });
});
