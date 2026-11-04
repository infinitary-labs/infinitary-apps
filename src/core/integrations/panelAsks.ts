import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IntegrationAsk } from "@shared/writeAsk";
import { z } from "zod";

/**
 * Each panel's integration asks (docs/integrations.md, "Panels"): one ask
 * per panel and action at a time. A panel's background code may call on a
 * timer, so while the captain's approval card for an action is up, its
 * next calls wait on that card and raise no other; and once the captain
 * chose Not now, its calls are refused without a card until the panel's
 * host line asks again. Approving takes the entry away, so the next call
 * runs under the action's rule.
 *
 * One file, `userData/integrations/panel-asks.json`, 0600 in a 0700
 * folder, written whole. It holds each kept call as the approval card
 * shows it; an unreadable file reads as empty, which only lets a panel ask
 * once more.
 */

const FILE = "panel-asks.json";

/** One open or turned-down ask, as a panel's host line says it. */
export type PanelAskLine = {
  /** The integration's id. */
  integration: string;
  /** Its name when asked. */
  place: string;
  action: string;
  /** The action's few words ("Read from GitHub"). */
  label: string;
  /** The card is up, or the captain chose Not now. */
  state: "asking" | "declined";
};

type Entry = PanelAskLine & {
  panel: string;
  ask: IntegrationAsk;
  /** The approval card while it is up. */
  card?: string;
};

const entrySchema = z.object({
  panel: z.string(),
  integration: z.string(),
  place: z.string(),
  action: z.string(),
  label: z.string(),
  state: z.enum(["asking", "declined"]),
  card: z.string().optional(),
  ask: z.custom<IntegrationAsk>(
    (value) =>
      typeof value === "object" &&
      value !== null &&
      (value as { kind?: unknown }).kind === "integration",
  ),
});

export class PanelAsks {
  private entries: Entry[];
  private readonly listeners = new Set<() => void>();

  constructor(private readonly root: string) {
    this.entries = this.read();
  }

  /** The open or turned-down ask for this panel and action, if any. */
  held(panel: string, integration: string, action: string): Entry | undefined {
    return this.entries.find(
      (entry) =>
        entry.panel === panel && entry.integration === integration && entry.action === action,
    );
  }

  /** The card for this kept panel ask is up. */
  asking(ask: IntegrationAsk, card: string): void {
    const panel = ask.panel?.key;
    if (!panel) return;
    this.entries = [
      ...this.entries.filter(
        (entry) =>
          !(
            entry.panel === panel &&
            entry.integration === ask.integration &&
            entry.action === ask.action
          ),
      ),
      {
        panel,
        integration: ask.integration,
        place: ask.place,
        action: ask.action,
        label: ask.label ?? ask.action,
        state: "asking",
        card,
        ask,
      },
    ];
    this.changed();
  }

  /**
   * What the captain chose on the card of ask `askId`: Not now keeps the
   * entry as turned down; anything else takes it away.
   */
  answered(askId: string, declined: boolean): void {
    const entry = this.entries.find((candidate) => candidate.ask.id === askId);
    if (!entry) return;
    if (declined) {
      entry.state = "declined";
      delete entry.card;
    } else {
      this.entries = this.entries.filter((candidate) => candidate !== entry);
    }
    this.changed();
  }

  /** The lines a panel's host draws: each of its open or turned-down asks. */
  of(panel: string): PanelAskLine[] {
    return this.entries
      .filter((entry) => entry.panel === panel)
      .map(({ integration, place, action, label, state }) => ({
        integration,
        place,
        action,
        label,
        state,
      }));
  }

  /** Forget this panel's asks: it was removed, or one ask is about to be raised again. */
  forget(panel: string, integration?: string, action?: string): void {
    const before = this.entries.length;
    this.entries = this.entries.filter(
      (entry) =>
        !(
          entry.panel === panel &&
          (integration === undefined || entry.integration === integration) &&
          (action === undefined || entry.action === action)
        ),
    );
    if (this.entries.length !== before) this.changed();
  }

  /** Hears every change; returns the unsubscribe. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private changed(): void {
    this.write();
    for (const listener of this.listeners) listener();
  }

  private read(): Entry[] {
    try {
      const parsed = z
        .array(entrySchema)
        .parse(JSON.parse(readFileSync(join(this.root, FILE), "utf8")));
      return parsed.map((entry) => ({ ...entry }) as Entry);
    } catch {
      return [];
    }
  }

  /** Write whole, never readable by anyone else even mid-write. */
  private write(): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const file = join(this.root, FILE);
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(this.entries)}\n`, { mode: 0o600 });
    renameSync(temp, file);
  }
}
