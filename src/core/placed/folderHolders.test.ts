/**
 * The folder-holder stop signals a program only once its birth reads equal
 * to the one recorded with it (INF-3504, filed from INF-3457's test-run
 * cleanup; docs/leftover-programs.md, "At the close"). A failed read of the
 * process table proves nothing about who holds the number now, so the
 * program is left as it is and counts as surviving, never as ended.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { endHolder, type FolderHolder } from "./folderHolders";
import type { ProcessReading } from "./processResources";

// INF-2570's Nov 3 leftovers: a VM process holding a closed task's folder.
const HOLDER: FolderHolder = {
  pid: 4242,
  started: "Tue Nov  3 21:25:01 2026",
  name: "qemu-system-aarch64",
};
const LISTED: ProcessReading = {
  pid: HOLDER.pid,
  parent: 1,
  group: HOLDER.pid,
  started: HOLDER.started,
  residentBytes: 2_147_483_648,
};

/** Each process table read in turn; null is a read that failed. */
function tableReads(...reads: (ProcessReading[] | null)[]): () => Promise<ProcessReading[] | null> {
  let next = 0;
  return async () => reads[Math.min(next++, reads.length - 1)] ?? null;
}

/** The signals the stop sends, recorded without reaching any program. */
function recordSignals(): (string | number | undefined)[] {
  const sent: (string | number | undefined)[] = [];
  vi.spyOn(process, "kill").mockImplementation((_pid, name) => {
    sent.push(name);
    return true;
  });
  return sent;
}

const noWait = async () => {};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ending a folder holder", () => {
  it("sends no end request while the process table cannot be read", async () => {
    const sent = recordSignals();
    const outcome = await endHolder(HOLDER, {
      processes: tableReads(null),
      graceMs: 0,
      wait: noWait,
    });
    expect(sent).toEqual([]);
    expect(outcome.outcome).toBe("survived");
  });

  it("sends no kill once the table stops reading after the end request", async () => {
    const sent = recordSignals();
    // The first read confirms its birth; the program ignores the end request,
    // and every read after it fails.
    const outcome = await endHolder(HOLDER, {
      processes: tableReads([LISTED], null),
      graceMs: 0,
      wait: noWait,
    });
    expect(sent).toEqual(["SIGTERM"]);
    expect(outcome.outcome).toBe("survived");
  });
});
