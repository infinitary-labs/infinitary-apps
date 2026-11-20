import {
  type PanelEventEntry,
  PERSONAL_STORE_VALUE_MAX_BYTES,
  panelEventKey,
} from "@shared/personal/manifest";
import { describe, expect, it } from "vitest";
import type { PanelIntegrationsReach } from "../integrations";
import { PanelEvents } from "./panelEvents";

/**
 * INF-2334 piece 1, the captain's "events in this build": for each event a
 * panel's manifest names, the app looks on the event's own cadence, writes
 * what arrived to the panel's store key and hands it to its background code.
 * The first look only marks where listening starts.
 */

function fixture(summary = (id: number) => `Item ${id}`) {
  let now = 0;
  let total = 0;
  let resync = false;
  const looks: (string | null)[] = [];
  const reach: PanelIntegrationsReach = {
    list: () => [],
    show: () => ({ text: "unused", refused: "invalid" }),
    call: async () => ({ text: "unused", refused: "invalid" }),
    every: (_name, event) => (event === "item_arrived" ? 2 : undefined),
    look: async (_name, _event, cursor) => {
      looks.push(cursor);
      const from = cursor === null ? total : Number(cursor);
      const items = Array.from({ length: total - from }, (_, index) => ({
        id: String(from + index),
        summary: summary(from + index),
      }));
      const resynced = resync;
      resync = false;
      return { cursor: String(total), items, ...(resynced ? { resynced: true } : {}) };
    },
  };
  const written = new Map<string, PanelEventEntry>();
  const logs: string[] = [];
  const entries: PanelEventEntry[] = [];
  let refuseWrite = false;
  const delivered: string[] = [];
  const handed: { event: string; items: number }[] = [];
  const events = new PanelEvents({
    now: () => now,
    log: (message) => logs.push(message),
    panels: () => [
      {
        slice: "items",
        uses: [
          { integration: "stand-in", events: ["item_arrived", "never_told"], why: "Shows items." },
        ],
        reach,
        write: (key, entry) => {
          if (refuseWrite) throw new Error("store full");
          expect(Buffer.byteLength(JSON.stringify(entry))).toBeLessThanOrEqual(
            PERSONAL_STORE_VALUE_MAX_BYTES,
          );
          written.set(key, entry);
          entries.push(entry);
        },
        hand: (_integration, event, items) => {
          delivered.push(...items.map((item) => item.id));
          handed.push({ event, items: items.length });
        },
      },
    ],
  });
  return {
    events,
    logs,
    entries,
    delivered,
    refuse: (value: boolean) => {
      refuseWrite = value;
    },
    looks,
    written,
    handed,
    add: (count: number) => {
      total += count;
    },
    resync: () => {
      resync = true;
    },
    at: (minutes: number) => {
      now = minutes * 60_000;
    },
  };
}

describe("PanelEvents", () => {
  it("marks where listening starts, then writes and hands what arrived on the event's own cadence", async () => {
    const f = fixture();
    f.add(3);
    await f.events.tick();
    // What happened before the first look is not news.
    expect(f.written.size).toBe(0);
    f.add(2);
    f.at(1);
    await f.events.tick();
    // Its cadence is two minutes: nothing looked a minute on.
    expect(f.looks).toEqual([null]);
    f.at(2);
    await f.events.tick();
    const key = panelEventKey("stand-in", "item_arrived");
    expect(f.written.get(key)).toEqual({
      at: 2 * 60_000,
      items: [
        { id: "3", summary: "Item 3" },
        { id: "4", summary: "Item 4" },
      ],
    });
    expect(f.handed).toEqual([{ event: "item_arrived", items: 2 }]);
    // A look with nothing new writes nothing.
    f.at(4);
    await f.events.tick();
    expect(f.handed).toHaveLength(1);
  });

  it("preserves all 51 arrivals and says when the place lost its place", async () => {
    const f = fixture();
    await f.events.tick();
    // Approved reach audit: no arbitrary count cutoff below the byte bound.
    f.add(51);
    f.resync();
    f.at(2);
    await f.events.tick();
    const entry = f.written.get(panelEventKey("stand-in", "item_arrived"));
    expect(entry?.items).toHaveLength(51);
    expect(entry?.items[0]?.id).toBe("0");
    f.at(4);
    await f.events.tick();
    expect(f.delivered).toEqual(Array.from({ length: 51 }, (_, id) => String(id)));
    expect(entry?.resynced).toBe(true);
  });
  it("continues byte-bounded arrivals before looking again, including UTF-8 and JSON escaping", async () => {
    // The audit asks that larger batches never advance past unread arrivals.
    const f = fixture((id) => `Mail ${id}: ${'会議\n"'.repeat(8000)}`);
    await f.events.tick();
    f.add(7);
    f.at(2);
    await f.events.tick();
    expect(f.entries[0]?.remaining).toBeGreaterThan(0);
    f.add(1);
    while (f.entries.at(-1)?.remaining) {
      await f.events.tick();
      expect(f.looks).toEqual([null, "0"]);
    }
    expect(f.delivered).toEqual(Array.from({ length: 7 }, (_, id) => String(id)));
    f.at(4);
    await f.events.tick();
    expect(f.looks.at(-1)).toBe("7");
    expect(f.delivered).toEqual(Array.from({ length: 8 }, (_, id) => String(id)));
  });

  it("reports an individually oversized arrival without losing its deliverable neighbors", async () => {
    // Approved loss reporting when a single arrival cannot fit the physical store bound.
    const f = fixture((id) =>
      id === 1 ? "郵".repeat(PERSONAL_STORE_VALUE_MAX_BYTES) : `Mail ${id}`,
    );
    await f.events.tick();
    f.add(3);
    f.at(2);
    await f.events.tick();
    while (f.entries.at(-1)?.remaining) await f.events.tick();
    expect(f.delivered).toEqual(["0", "2"]);
    expect(f.entries.find((entry) => entry.dropped)?.dropped).toBe(1);
    expect(f.logs).toHaveLength(1);
    expect(f.logs[0]).toContain("1 arrivals exceeded");
    f.at(4);
    await f.events.tick();
    expect(f.looks.at(-1)).toBe("3");
    expect(f.delivered).toEqual(["0", "2"]);
  });

  it("retains unread arrivals when the store refuses a batch", async () => {
    const f = fixture();
    await f.events.tick();
    f.add(51);
    f.refuse(true);
    f.at(2);
    await f.events.tick();
    expect(f.delivered).toEqual([]);
    f.refuse(false);
    await f.events.tick();
    expect(f.looks).toEqual([null, "0"]);
    expect(f.delivered).toEqual(Array.from({ length: 51 }, (_, id) => String(id)));
  });
});
