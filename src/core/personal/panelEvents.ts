import type { PanelIntegrationUse } from "@shared/personal/contracts";
import {
  PANEL_EVENT_ITEMS_MAX,
  type PanelEventEntry,
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
  /** Write one event's arrivals to its store. */
  write: (key: string, entry: PanelEventEntry) => void;
  /** Hand the same arrivals to its background code, when it runs. */
  hand: (integration: string, event: string, items: PanelEventEntry["items"]) => void;
};

type Listening = { cursor: string | null; lookedAt: number; looking: boolean };

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
          if (state && (state.looking || now - state.lookedAt < every * 60_000)) continue;
          looks.push(this.look(id, panel, use.integration, event, state, now));
        }
      }
    }
    // A panel that stopped naming an event, or went, stops listening to it.
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
    };
    this.state.set(id, next);
    try {
      const look = await panel.reach.look(integration, event, next.cursor);
      if (!("cursor" in look)) {
        this.options.log(`panel ${panel.slice}: "${integration}" ${event}: ${look.text}`);
        return;
      }
      const first = next.cursor === null;
      next.cursor = look.cursor;
      if (first || (look.items.length === 0 && !look.resynced)) return;
      const items = look.items
        .slice(-PANEL_EVENT_ITEMS_MAX)
        .map(({ id: itemId, summary }) => ({ id: itemId, summary }));
      panel.write(panelEventKey(integration, event), {
        at: now,
        items,
        ...(look.resynced ? { resynced: true as const } : {}),
      });
      panel.hand(integration, event, items);
    } catch (error) {
      this.options.log(`panel ${panel.slice}: "${integration}" ${event}: ${errorText(error)}`);
    } finally {
      next.looking = false;
    }
  }
}
