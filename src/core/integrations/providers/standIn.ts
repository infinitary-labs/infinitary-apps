import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { IntegrationBinding, IntegrationEventItem, IntegrationEventSpec } from "../binding";

/**
 * A stand-in integration for a development or end-to-end run
 * (docs/automation.md, "Events"): one connection that tells an event each
 * time a line is added to `items.jsonl` in its folder, each line one item
 * as `{"id": ..., "summary": ...}`. Its cursor is how many lines it has
 * read; a cursor past the file's end - the file was cut short - is lost,
 * and the look starts again from now. It has no actions and no sign-in.
 * The composition root connects it only in an unpackaged run that names
 * the folder in `INFINITARY_STAND_IN_INTEGRATION`.
 */

const STAND_IN_ID = "stand-in";

/** The one event the stand-in tells. */
export const STAND_IN_EVENT: IntegrationEventSpec = {
  name: "item_arrived",
  label: "An item arrives",
  description:
    "Each line added to the stand-in's items file; the summary is the line's own summary.",
  every: 1,
};
const ITEMS_FILE = "items.jsonl";

export type StandInIntegrationOptions = {
  /** The folder whose `items.jsonl` it reads. */
  dir: string;
};

export function standInIntegration(options: StandInIntegrationOptions): IntegrationBinding {
  const read = (): IntegrationEventItem[] => {
    let text: string;
    try {
      text = readFileSync(join(options.dir, ITEMS_FILE), "utf8");
    } catch {
      return [];
    }
    return text
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as IntegrationEventItem);
  };
  return {
    kind: "stand-in",
    connections: () => [
      {
        id: STAND_IN_ID,
        account: "stand-in",
        health: "ok",
        actions: [],
        events: [STAND_IN_EVENT],
      },
    ],
    look: async (_id, _event, cursor) => {
      const items = read();
      if (cursor === null) return { cursor: String(items.length), items: [] };
      const from = Number(cursor);
      if (!Number.isInteger(from) || from > items.length)
        return { cursor: String(items.length), items: [], resynced: true };
      return { cursor: String(items.length), items: items.slice(from) };
    },
    check: async () => {},
    remove: () => {},
    call: async () => ({ text: "The stand-in has no actions.", refused: "invalid" }),
  };
}
