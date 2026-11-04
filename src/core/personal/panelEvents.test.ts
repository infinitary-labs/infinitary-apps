import {
  PANEL_EVENT_ITEMS_MAX,
  type PanelEventEntry,
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

function fixture() {
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
        summary: `Item ${from + index}`,
      }));
      const resynced = resync;
      resync = false;
      return { cursor: String(total), items, ...(resynced ? { resynced: true } : {}) };
    },
  };
  const written = new Map<string, PanelEventEntry>();
  const handed: { event: string; items: number }[] = [];
  const events = new PanelEvents({
    now: () => now,
    log: () => {},
    panels: () => [
      {
        slice: "items",
        uses: [
          { integration: "stand-in", events: ["item_arrived", "never_told"], why: "Shows items." },
        ],
        reach,
        write: (key, entry) => written.set(key, entry),
        hand: (_integration, event, items) => handed.push({ event, items: items.length }),
      },
    ],
  });
  return {
    events,
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

  it("keeps the newest items of a crowded look and says when the place lost its place", async () => {
    const f = fixture();
    await f.events.tick();
    f.add(PANEL_EVENT_ITEMS_MAX + 5);
    f.resync();
    f.at(2);
    await f.events.tick();
    const entry = f.written.get(panelEventKey("stand-in", "item_arrived"));
    expect(entry?.items).toHaveLength(PANEL_EVENT_ITEMS_MAX);
    expect(entry?.items[0]?.id).toBe("5");
    expect(entry?.resynced).toBe(true);
  });
});
