/**
 * The create-your-own-panel slot (captain, 2026-10-06; docs/first-launch.md
 * "The create-your-own-panel slot"): an empty outline at the top of the
 * left rail, shown once three of the captain's crewmates have finished
 * their tasks (captain, 2026-10-12), that teaches panels can be made. A
 * click starts the ask in the message box; the panel built from it lands
 * where the slot was (`DEFAULT_PERSONAL_PLACEMENT`).
 *
 * The slot is the app's own chrome, not a panel: it takes no rail slot,
 * wears no title row, and is listed among the captain's surfaces by its id
 * only so "hide it" reaches it like any app panel (`hiddenPanels`).
 */

/** Its surface id: what `app_change panel` and the slot's own Hide write in `hiddenPanels`. */
export const CREATE_PANEL_SLOT_ID = "create-panel";

/** What the slot says, and its name in the captain's surfaces. */
export const CREATE_PANEL_SLOT_TITLE = "Create your own panel";
export const CREATE_PANEL_SLOT_HINT = "Tell your first mate what this should show";

/** The words a click puts at the head of the message box, for the captain to finish. */
export const CREATE_PANEL_DRAFT = "Make me a panel that shows ";

/** Where the slot sits: always the top of the left rail; it is never moved. */
export const CREATE_PANEL_SLOT_PLACEMENT = { x: "left", y: "top" } as const;

/** The typed facts the slot reads; none of them is a flag the app sets for it. */
export type CreatePanelSlotFacts = {
  /** When the third of the captain's crewmates finished its task (the first-run record); absent = not yet. */
  thirdCrewmateDoneAt: number | undefined;
  /** The captain's panels switch in Settings, off in safe mode too. */
  panelsOn: boolean;
  /** Whether a panel of the captain's own exists; null until the first snapshot arrives. */
  ownPanel: boolean | null;
  /** Hidden by the captain's word or the slot's own Hide. */
  hidden: boolean;
};

/** The slot shows while all four facts hold, and leaves when any one fails. */
export function showsCreatePanelSlot(facts: CreatePanelSlotFacts): boolean {
  return (
    facts.thirdCrewmateDoneAt !== undefined &&
    facts.panelsOn &&
    facts.ownPanel === false &&
    !facts.hidden
  );
}
