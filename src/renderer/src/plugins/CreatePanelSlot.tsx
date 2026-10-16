import { CREATE_PANEL_SLOT_HINT, CREATE_PANEL_SLOT_TITLE } from "@shared/createPanelSlot";
import { IconButton } from "../design";
import { createPanelSlot, useCreatePanelSlotShown } from "./createPanelSlotStore";

const plusIcon = (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    strokeLinecap="round"
    aria-hidden="true"
  >
    <path d="M12 5v14M5 12h14" />
  </svg>
);

const closeIcon = (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M18 6 6 18M6 6l12 12" />
  </svg>
);

/**
 * The create-your-own-panel slot (docs/first-launch.md): an empty outline
 * at the top of the left rail, the app's own chrome with no title row,
 * chevron or attribution. A click starts the ask in the message box; Hide
 * takes it away for good, as "hide it" to the Firstmate does. It docks the
 * rail like a panel (design/styles.css) and is one of the window's parts
 * F6 moves between (app/regions.ts). Its look lives in design/styles.css,
 * keyed on the data attributes set here.
 */
export function CreatePanelSlot() {
  const shown = useCreatePanelSlotShown();
  if (!shown) return null;
  return (
    <section
      data-create-panel-slot=""
      data-window-region="panel"
      aria-label={CREATE_PANEL_SLOT_TITLE}
    >
      <button
        type="button"
        data-create-panel-slot-ask=""
        onClick={() => createPanelSlot.startAsk()}
      >
        <span style={{ display: "inline-flex", color: "var(--fg-3)" }}>{plusIcon}</span>
        <span style={{ fontSize: "var(--text-sm)", color: "var(--fg-2)" }}>
          {CREATE_PANEL_SLOT_TITLE}
        </span>
        <span style={{ fontSize: "var(--text-xs)", color: "var(--fg-3)" }}>
          {CREATE_PANEL_SLOT_HINT}
        </span>
      </button>
      <span data-create-panel-slot-hide="">
        <IconButton
          label="Hide"
          size={24}
          onClick={() => createPanelSlot.hide()}
          style={{ color: "var(--fg-3)" }}
        >
          {closeIcon}
        </IconButton>
      </span>
    </section>
  );
}
