import type { KnowledgeDirectionRow } from "@shared/knowledge";
import type { InboxStore } from "../storage/inboxStore";
import type { TypedWake } from "./wakes";

/** The inbox's name for the one ask, kept with no task (`ref` ""). */
export const DIRECTIONS_TO_CONFIRM_ONCE = "directions-to-confirm";

/**
 * The captain's pick on how to treat the directions saved before heard
 * marks were kept: "Confirm today's directions once, on one card"
 * (docs/knowledge.md, "Heard from the captain"). Until confirmed they are
 * instructions and no yes. At the first start that finds any, the first
 * mate is asked once, ever, to raise that card; a start that finds none
 * records the ask as made, since every later direction carries its own
 * mark. Knowledge that cannot be read asks nothing and records nothing, so
 * a later start asks.
 */
export function askToConfirmDirections(deps: {
  knowledge: {
    directions: {
      unmarked(): Pick<KnowledgeDirectionRow, "id">[] | { state: "unavailable"; reason: string };
    };
  };
  inbox: Pick<InboxStore, "woken" | "recordOnce">;
  notify: (wake: TypedWake) => void;
}): void {
  if (deps.inbox.woken("", DIRECTIONS_TO_CONFIRM_ONCE)) return;
  const unmarked = deps.knowledge.directions.unmarked();
  if (!Array.isArray(unmarked)) return;
  const directions = unmarked.map((row) => `d:${row.id}`);
  if (directions.length === 0) {
    deps.inbox.recordOnce("", DIRECTIONS_TO_CONFIRM_ONCE);
    return;
  }
  deps.notify({
    facts: { kind: "directions-to-confirm", directions },
    once: DIRECTIONS_TO_CONFIRM_ONCE,
  });
}
