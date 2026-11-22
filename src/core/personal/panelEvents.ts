import type { PanelIntegrationUse } from "@shared/personal/contracts";
import {
  type PanelEventEntry,
  PERSONAL_STORE_VALUE_MAX_BYTES,
  panelEventKey,
} from "@shared/personal/manifest";
import type { PanelIntegrationsReach } from "../integrations";
import { errorText } from "./errorText";

/**
 * A panel's integration events (docs/integrations.md, "Panels"): for each
 * event a panel's manifest names, the app looks on that event's own cadence,
 * as it does for an Automation rule, writes what arrived since the last look
 * to the panel's store key for it (`panelEventKey`), and hands the same items
 * to its background code (`context.integrations.on`). The drawing hears the
 * key change (`props.integrations.on`).
 *
 * The first look only marks where listening starts: what happened before it
 * is not news. Cursors live in memory, so after a restart the panel listens
 * from then on, the way a new rule does.
 */

/** How often the app checks which panel events are due; each event keeps its own cadence. */
export const PANEL_EVENT_TICK_MS = 60_000;

/** One panel that listens, as its owner hands it over at each tick. */
export type PanelListening = {
  /** Its store slice: its own, or its draft's. */
  slice: string;
  /** What its manifest names, events included. */
  uses: readonly PanelIntegrationUse[];
  reach: PanelIntegrationsReach;
  write: (key: string, entry: PanelEventEntry) => void;
  /** Hand the same arrivals to its background code, when it runs. */
  hand: (integration: string, event: string, items: PanelEventEntry["items"]) => void;
};

type Pending = {
  cursor: string;
  items: PanelEventEntry["items"];
  offset: number;
  resynced?: true;
};
type Listening = {
  cursor: string | null;
  lookedAt: number;
  looking: boolean;
  pending?: Pending;
};

export class PanelEvents {
  private readonly state = new Map<string, Listening>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly options: {
      panels: () => PanelListening[];
      now: () => number;
      log: (message: string) => void;
    },
  ) {}

  start(tickMs = PANEL_EVENT_TICK_MS): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), tickMs);
    this.timer.unref?.();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.state.clear();
  }

  /** Look at every event that is due; one look per event at a time. */
  async tick(): Promise<void> {
    const now = this.options.now();
    const live = new Set<string>();
    const looks: Promise<void>[] = [];
    for (const panel of this.options.panels()) {
      for (const use of panel.uses) {
        for (const event of use.events ?? []) {
          const id = `${panel.slice}\u0000${use.integration}\u0000${event}`;
          live.add(id);
          const every = panel.reach.every(use.integration, event);
          if (every === undefined) continue;
          const state = this.state.get(id);
          if (state && (state.looking || (!state.pending && now - state.lookedAt < every * 60_000)))
            continue;
          looks.push(this.look(id, panel, use.integration, event, state, now));
        }
      }
    }
    for (const id of [...this.state.keys()]) if (!live.has(id)) this.state.delete(id);
    await Promise.all(looks);
  }

  private async look(
    id: string,
    panel: PanelListening,
    integration: string,
    event: string,
    state: Listening | undefined,
    now: number,
  ): Promise<void> {
    const next: Listening = {
      cursor: state?.cursor ?? null,
      lookedAt: now,
      looking: true,
      pending: state?.pending,
    };
    this.state.set(id, next);
    try {
      if (!next.pending) {
        const look = await panel.reach.look(integration, event, next.cursor);
        if (!("cursor" in look)) {
          this.options.log(`panel ${panel.slice}: "${integration}" ${event}: ${look.text}`);
          return;
        }
        if (next.cursor === null) {
          next.cursor = look.cursor;
          return;
        }
        if (look.items.length === 0 && !look.resynced) {
          next.cursor = look.cursor;
          return;
        }
        next.pending = {
          cursor: look.cursor,
          items: look.items.map(({ id, summary }) => ({ id, summary })),
          offset: 0,
          ...(look.resynced ? { resynced: true as const } : {}),
        };
      }
      const pending = next.pending;
      // Measure UTF-8 JSON, including escaping and the actual continuation
      // envelope, exactly as PersonalStore does. Keep packing linear in bytes.
      const items: PanelEventEntry["items"] = [];
      let itemBytes = 0;
      let offset = pending.offset;
      let dropped = 0;
      const envelopeBytes = (remaining: number) =>
        Buffer.byteLength(
          JSON.stringify({
            at: now,
            items: [],
            ...(remaining ? { remaining } : {}),
            ...(pending.resynced ? { resynced: true } : {}),
          }),
        );
      while (offset < pending.items.length) {
        const item = pending.items[offset];
        if (!item) break;
        const size = Buffer.byteLength(JSON.stringify(item));
        const remaining = pending.items.length - offset - 1;
        const addition = size + (items.length ? 1 : 0);
        if (envelopeBytes(remaining) + itemBytes + addition > PERSONAL_STORE_VALUE_MAX_BYTES) {
          // An oversized arrival gets its own loss entry, leaving its neighbors
          // for subsequent ticks. Never drop an arrival just to fill a batch.
          if (!items.length) {
            dropped = 1;
            offset++;
          }
          break;
        }
        items.push(item);
        itemBytes += addition;
        offset++;
      }
      const remaining = pending.items.length - offset;
      panel.write(panelEventKey(integration, event), {
        at: now,
        items,
        ...(remaining ? { remaining } : {}),
        ...(dropped ? { dropped } : {}),
        ...(pending.resynced ? { resynced: true as const } : {}),
      });
      panel.hand(integration, event, items);
      if (dropped) {
        this.options.log(
          `panel ${panel.slice}: "${integration}" ${event}: ${dropped} arrivals exceeded the ${PERSONAL_STORE_VALUE_MAX_BYTES}-byte store value bound and were not delivered; see the event entry's dropped count.`,
        );
      }
      // Commit progress only after delivery. A refused store write leaves the
      // same batch pending, and no new provider look can skip unread arrivals.
      pending.offset = offset;
      delete pending.resynced;
      if (!remaining) {
        next.cursor = pending.cursor;
        delete next.pending;
      }
    } catch (error) {
      this.options.log(`panel ${panel.slice}: "${integration}" ${event}: ${errorText(error)}`);
    } finally {
      next.looking = false;
    }
  }
}
