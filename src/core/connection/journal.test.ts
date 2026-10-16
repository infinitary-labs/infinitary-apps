import { describe, expect, it } from "vitest";
import { EventJournal } from "./journal";

const frame = (size: number) => (seq: number) => `${seq}`.padEnd(size, ".");

describe("the connection's numbering", () => {
  it("numbers pushes from 1 and hands back exactly those after a cursor", () => {
    const journal = new EventJournal();
    expect(journal.seq).toBe(0);
    for (let i = 0; i < 5; i++) journal.record(frame(4));
    expect(journal.seq).toBe(5);
    expect(journal.since({ epoch: journal.epoch, seq: 2 })?.map((entry) => entry.seq)).toEqual([
      3, 4, 5,
    ]);
    expect(journal.since({ epoch: journal.epoch, seq: 5 })).toEqual([]);
    expect(journal.since({ epoch: journal.epoch, seq: 0 })?.length).toBe(5);
  });

  it("asks for a reload from another run, from ahead of it, or from older than it keeps", () => {
    const journal = new EventJournal({ entries: 3, bytes: 1_000 });
    for (let i = 0; i < 6; i++) journal.record(frame(4));
    expect(journal.since({ epoch: "another-run", seq: 6 })).toBeNull();
    expect(journal.since({ epoch: journal.epoch, seq: 7 })).toBeNull();
    // Pushes 4 to 6 are kept, so a device that saw 3 still catches up.
    expect(journal.since({ epoch: journal.epoch, seq: 3 })?.map((entry) => entry.seq)).toEqual([
      4, 5, 6,
    ]);
    expect(journal.since({ epoch: journal.epoch, seq: 2 })).toBeNull();
    expect(new EventJournal().epoch).not.toBe(journal.epoch);
  });

  it("keeps the newest push even when it alone is over the byte bound", () => {
    const journal = new EventJournal({ entries: 100, bytes: 10 });
    journal.record(frame(4));
    journal.record(frame(4));
    expect(journal.since({ epoch: journal.epoch, seq: 0 })?.length).toBe(2);
    journal.record(frame(50));
    expect(journal.since({ epoch: journal.epoch, seq: 2 })?.map((entry) => entry.seq)).toEqual([3]);
    expect(journal.since({ epoch: journal.epoch, seq: 1 })).toBeNull();
  });
});
