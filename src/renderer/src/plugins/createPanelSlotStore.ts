import {
  CREATE_PANEL_DRAFT,
  CREATE_PANEL_SLOT_ID,
  showsCreatePanelSlot,
} from "@shared/createPanelSlot";
import type { PersonalSnapshot } from "@shared/personal/manifest";
import { isPanelHidden } from "@shared/preferences";
import { useSyncExternalStore } from "react";
import { mainMessageRefusal } from "../app/composer";
import { useShellStore } from "../app/store";
import { railStore, useRailLayout } from "./railStore";

/**
 * The create-your-own-panel slot's window side (docs/first-launch.md "The
 * create-your-own-panel slot"; the rule is src/shared/createPanelSlot.ts).
 * Beside the first-run record and the layout, the slot reads two facts the
 * core pushes elsewhere: the captain's panels switch (the preferences push)
 * and whether a panel of the captain's own exists (the personal snapshot).
 * A plain external store like the rail's; the core never knows the slot is up.
 */
type Facts = { panelsOn: boolean; ownPanel: boolean | null };

let facts: Facts = { panelsOn: true, ownPanel: null };
const listeners = new Set<() => void>();

function write(next: Facts): void {
  if (next.panelsOn === facts.panelsOn && next.ownPanel === facts.ownPanel) return;
  facts = next;
  for (const listener of [...listeners]) listener();
}

export const createPanelSlot = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  facts(): Facts {
    return facts;
  },
  /** The captain's panels switch, from every preferences push. */
  notePanelsOn(panelsOn: boolean): void {
    write({ ...facts, panelsOn });
  },
  /** A panel of the captain's own, from every personal snapshot; an added one is someone else's. */
  noteSnapshot(snapshot: PersonalSnapshot): void {
    write({ ...facts, ownPanel: snapshot.extensions.some((view) => view.source === "yours") });
  },
  /**
   * The slot's click: the message box starts with the ask and focus goes
   * there, with the caret after the words and anything typed kept after
   * them (`beginDraft`). Refused, as Go to the main message is, while the
   * box is held (`mainMessageRefusal`). Returns whether it started.
   */
  startAsk(): boolean {
    const shell = useShellStore.getState();
    if (mainMessageRefusal(shell) !== null) return false;
    shell.beginDraft(CREATE_PANEL_DRAFT);
    return true;
  },
  /** The slot's own Hide: the same record "hide it" to the Firstmate writes. */
  hide(): void {
    railStore.hide(CREATE_PANEL_SLOT_ID);
  },
  /** Tests only: forget what the pushes said. */
  reset(): void {
    write({ panelsOn: true, ownPanel: null });
  },
};

/** Whether the slot shows now, from the four facts as they change. */
export function useCreatePanelSlotShown(): boolean {
  const thirdCrewmateDoneAt = useShellStore((s) => s.firstRun?.thirdCrewmateDoneAt);
  const layout = useRailLayout();
  const { panelsOn, ownPanel } = useSyncExternalStore(
    createPanelSlot.subscribe,
    createPanelSlot.facts,
    createPanelSlot.facts,
  );
  return showsCreatePanelSlot({
    thirdCrewmateDoneAt,
    panelsOn,
    ownPanel,
    hidden: isPanelHidden(layout, CREATE_PANEL_SLOT_ID),
  });
}
