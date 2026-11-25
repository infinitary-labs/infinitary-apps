import { feedLineSchema } from "@shared/feed";
import type { PanelRail, PanelSummaryLine, PanelSummaryPart } from "@shared/personal/contracts";
import { useSyncExternalStore } from "react";
import { z } from "zod";

/**
 * A panel on its rail, from its own code (FI3-1014 piece 5; the captain's
 * answer on FI3-1014: "Its own code, in a page kept running while it is
 * collapsed"). A panel's page keeps running while its dock is collapsed,
 * so the panel says what it holds - `rail.summarize`, drawn by the app in
 * its header as its own chrome - and a panel whose presence is
 * `{ "code": true }` decides whether it shows at all (`rail.show`); off its
 * rail, its page runs on out of sight. Host-owned view state, a plain
 * external store like the rail's: the core never knows what a page said.
 */

/** The ids a panel's frame speaks to its rail through (`inf.action`). */
export const PANEL_RAIL_ACTIONS = ["rail.summarize", "rail.show", "rail.refuse"] as const;

/** Why a panel is off its rail, in its own words: at most this many characters. */
export const PANEL_OFF_RAIL_WHY_MAX = 60;

/** `rail.show`'s value from a frame: whether it shows, or that and why it does not. */
const showSchema = z.union([
  z.boolean(),
  z.strictObject({
    shown: z.boolean(),
    why: z.string().min(1).max(PANEL_OFF_RAIL_WHY_MAX).optional(),
  }),
]);

/** `rail.refuse`'s value from a frame: the command's id, and why it cannot run now or null. */
const refuseSchema = z.strictObject({
  command: z.string().min(1),
  why: z.string().min(1).max(PANEL_OFF_RAIL_WHY_MAX).nullable(),
});

/** At most three parts, each at most 32 characters: the header is a rail wide. */
export const PANEL_SUMMARY_PARTS_MAX = 3;
export const PANEL_SUMMARY_TEXT_MAX = 32;
/** A line part's words: the header cuts them, and resting the pointer reads them whole. */
export const PANEL_SUMMARY_LINE_MAX = 500;

const summarySchema = z
  .array(
    z.union([
      z.strictObject({
        text: z.string().min(1).max(PANEL_SUMMARY_TEXT_MAX),
        strong: z.boolean().optional(),
      }),
      z.strictObject({
        line: z.string().min(1).max(PANEL_SUMMARY_LINE_MAX),
        lead: z.string().min(1).max(PANEL_SUMMARY_TEXT_MAX).optional(),
        tone: z.enum(["info", "ok", "warn", "danger", "you"]).optional(),
        feed: feedLineSchema.strict().optional(),
      }),
    ]),
  )
  .max(PANEL_SUMMARY_PARTS_MAX)
  .refine((parts) => parts.filter((part) => "line" in part).length <= 1)
  .nullable();

/** The line a summary holds, if it holds one: it takes the title's place in the header. */
export function summaryLine(summary: readonly PanelSummaryPart[]): PanelSummaryLine | null {
  return summary.find((part): part is PanelSummaryLine => "line" in part) ?? null;
}

export type RailSaid = {
  summary: PanelSummaryPart[] | null;
  /** Whether a panel whose own code decides is on its rail; undefined until it says. */
  shown: boolean | undefined;
  /** Off its rail, why, in its own words; null when it said none. */
  why: string | null;
  /** Its commands that cannot run now, by id, and why, in its own words. */
  refused: Readonly<Record<string, string>>;
};

const NOTHING_SAID: RailSaid = Object.freeze({
  summary: null,
  shown: undefined,
  why: null,
  refused: Object.freeze({}),
});

let said = new Map<string, RailSaid>();
const listeners = new Set<() => void>();

function write(panel: string, patch: Partial<RailSaid>): void {
  const before = said.get(panel) ?? NOTHING_SAID;
  const next = { ...before, ...patch };
  if (JSON.stringify(next) === JSON.stringify(before)) return;
  said = new Map(said).set(panel, next);
  for (const listener of [...listeners]) listener();
}

export const panelRail = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  get(panel: string): RailSaid {
    return said.get(panel) ?? NOTHING_SAID;
  },
  /** What the panel holds, checked like any input from a panel. */
  summarize(panel: string, parts: unknown): void {
    const parsed = summarySchema.safeParse(parts);
    if (!parsed.success) {
      throw new Error(
        `rail.summarize: at most ${PANEL_SUMMARY_PARTS_MAX} parts of at most ${PANEL_SUMMARY_TEXT_MAX} characters, one of them may be a line of at most ${PANEL_SUMMARY_LINE_MAX}, or null`,
      );
    }
    write(panel, { summary: parsed.data });
  },
  /**
   * Shows or hides a panel whose own code decides, and off its rail, why;
   * any other panel is refused. `value` is `shown`, or `{ shown, why }`.
   */
  show(panel: string, value: unknown, decides: boolean): void {
    if (!decides) {
      throw new Error('rail.show: say "presence": { "code": true } in manifest.json to decide');
    }
    const parsed = showSchema.safeParse(value);
    if (!parsed.success) {
      throw new Error(
        `rail.show: true or false, and off the rail a why of at most ${PANEL_OFF_RAIL_WHY_MAX} characters`,
      );
    }
    const { shown, why } =
      typeof parsed.data === "boolean" ? { shown: parsed.data, why: undefined } : parsed.data;
    write(panel, { shown, why: shown ? null : (why ?? null) });
  },
  /** One of its commands cannot run now, and why; null takes the words back. */
  refuse(panel: string, value: unknown): void {
    const parsed = refuseSchema.safeParse(value);
    if (!parsed.success) {
      throw new Error(
        `rail.refuse: a command's id, and why it cannot run in at most ${PANEL_OFF_RAIL_WHY_MAX} characters, or null`,
      );
    }
    const { command, why } = parsed.data;
    const { [command]: _, ...rest } = panelRail.get(panel).refused;
    write(panel, { refused: why === null ? rest : { ...rest, [command]: why } });
  },
  /** Forgets what a panel said: it left the app. */
  forget(panel: string): void {
    if (!said.has(panel)) return;
    said = new Map(said);
    said.delete(panel);
    for (const listener of [...listeners]) listener();
  },
};

export function useRailSaid(panel: string): RailSaid {
  return useSyncExternalStore(
    panelRail.subscribe,
    () => panelRail.get(panel),
    () => panelRail.get(panel),
  );
}

/** `PanelProps.rail` for a panel's own page: whether it is collapsed, and its calls. */
export function railProp(panel: string, collapsed: boolean, decides: boolean): PanelRail {
  return {
    collapsed,
    summarize: (parts) => panelRail.summarize(panel, parts),
    show: (shown, why) =>
      panelRail.show(panel, why === undefined ? shown : { shown, why }, decides),
    refuse: (command, why) => panelRail.refuse(panel, { command, why }),
  };
}

/** The host's answers to a panel frame's `PANEL_RAIL_ACTIONS`: the value is the call's argument. */
export function frameRailAction(
  panel: string,
  decides: boolean,
): (id: string, value: unknown) => Promise<unknown> {
  return async (id, value) => {
    if (id === "rail.summarize") panelRail.summarize(panel, value);
    else if (id === "rail.show") panelRail.show(panel, value, decides);
    else if (id === "rail.refuse") panelRail.refuse(panel, value);
    else throw new Error(`"${id}" is not one of a panel's rail actions`);
    return undefined;
  };
}
