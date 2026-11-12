import type { PanelStep } from "@shared/panelArrangement";

/**
 * The keys that move a panel one place (INF-2344; design skill
 * Panel.prompt.md, "Moving a panel"): ⌥ with an arrow, on a panel's header
 * on the rails or its row in Settings → Panels. Up and down go along the
 * rail, left and right to the other rail. They are a control's own keys,
 * as a list's arrows are, not window commands (docs/keyboard.md).
 */
export function panelStepOf(press: {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): PanelStep | null {
  if (!press.altKey || press.ctrlKey || press.metaKey || press.shiftKey) return null;
  switch (press.key) {
    case "ArrowUp":
      return "up";
    case "ArrowDown":
      return "down";
    case "ArrowLeft":
      return "left";
    case "ArrowRight":
      return "right";
    default:
      return null;
  }
}

/** The same keys as `aria-keyshortcuts` names them. */
// i18n-exempt: not shown (key names)
export const PANEL_MOVE_KEYS = "Alt+ArrowUp Alt+ArrowDown Alt+ArrowLeft Alt+ArrowRight";
