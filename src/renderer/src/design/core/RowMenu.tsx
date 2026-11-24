import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePopoverPresence } from "../motion";
import { Button } from "./Button";
import { IconButton } from "./IconButton";
import { EDGE, MENU_ITEMS, MenuPanel, type RowMenuItem, stepMenuFocus } from "./MenuPanel";

export type { RowMenuItem } from "./MenuPanel";

export type RowMenuProps = {
  /** Accessible name of the kebab, e.g. "Work #2 actions". */
  label: string;
  items: RowMenuItem[];
  /** Kebab size; 28 in a 50px list row. */
  size?: number;
  /**
   * A word in place of the kebab, as a small ghost Button: `More` in a row
   * of chrome where the other controls are words too (a task's browser view).
   */
  word?: string;
  style?: React.CSSProperties;
  className?: string;
  /** The kebab's place in the Tab order: -1 where its row opens it by a key of its own. */
  triggerTabIndex?: number;
  /** Where focus returns when the menu closes on Escape or a pick; the kebab by default. */
  restoreFocus?: () => HTMLElement | null;
  /**
   * The key of the command that opens this menu too (the task board's Move
   * the selected task), drawn after the kebab's words in its label, or
   * inside the word's button; pass `aria-keyshortcuts` with it.
   */
  keys?: string | undefined;
  "aria-keyshortcuts"?: string | undefined;
  /** That command, for the key reminder a mouse click on the trigger shows; pass it with the key. */
  "data-key-command"?: string | undefined;
};

/** Space between the kebab and the panel. */
const GAP = 4;

const kebab = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <circle cx="5" cy="12" r="1.6" />
    <circle cx="12" cy="12" r="1.6" />
    <circle cx="19" cy="12" r="1.6" />
  </svg>
);

/**
 * The ⋯ at the end of a list row (design skill RowMenu): every action the
 * row offers, out of the glance path. Anchored bottom-right, and flipped
 * above the kebab when the panel would run past the window's bottom edge
 * (a row low in the Models list otherwise opened its menu off-screen, where
 * no click could reach it); closes on Escape, an outside click, or a pick
 * of an action. An on/off setting (`checked`) draws a small switch and stays
 * open when picked, focus on it, so the person sees the switch move.
 * Arrow keys walk the items and focus returns to the kebab on close (or
 * where `restoreFocus` says), so the menu is a keyboard citizen. An item
 * that cannot run stays listed, dim, with its `detail` saying why; a pick
 * on it does nothing.
 *
 * The panel portals to `document.body` and is positioned from the kebab's
 * viewport rect, not nested in the row's own DOM: a row inside a scrolling
 * or short-height section (the model list cards) would otherwise clip the
 * menu against that ancestor's `overflow`, cutting it off at the section's
 * edge instead of overlaying the page.
 */
export function RowMenu({
  label,
  items,
  size = 28,
  word,
  style,
  className,
  triggerTabIndex,
  restoreFocus,
  keys,
  "aria-keyshortcuts": ariaKeys,
  "data-key-command": keyCommand,
}: RowMenuProps) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null);
  const wrap = useRef<HTMLSpanElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  // The panel grows from the kebab and fades out as it closes (design skill, Motion).
  const drawn = usePopoverPresence(open, menu, trigger);
  const returnTo = useRef(restoreFocus);
  returnTo.current = restoreFocus;
  const giveBackFocus = useCallback(() => {
    (returnTo.current?.() ?? trigger.current)?.focus();
  }, []);

  const place = useCallback(() => {
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;
    // The layout height: a panel still growing measures as its full self.
    const height = menu.current?.offsetHeight ?? 0;
    const below = rect.bottom + GAP;
    const fits = below + height <= window.innerHeight - EDGE;
    const top = fits ? below : Math.max(EDGE, rect.top - GAP - height);
    const width = menu.current?.offsetWidth ?? 0;
    const right = Math.max(
      EDGE,
      Math.min(window.innerWidth - rect.right, window.innerWidth - width - EDGE),
    );
    setAnchor((prev) => (prev?.top === top && prev.right === right ? prev : { top, right }));
  }, []);

  // The first placement runs before the panel exists, so the flip decision
  // is re-taken the moment it mounts and has a height - in the commit, before
  // paint, so it never shows up in the wrong place. Focus lands on the first
  // item then.
  const mountMenu = useCallback(
    (node: HTMLDivElement | null) => {
      menu.current = node;
      if (!node) return;
      place();
      node.querySelector<HTMLButtonElement>(MENU_ITEMS)?.focus();
    },
    [place],
  );

  useEffect(() => {
    if (!open) return;
    place();
    const isInside = (target: Node) =>
      wrap.current?.contains(target) || menu.current?.contains(target);
    const onDown = (event: PointerEvent) => {
      if (!isInside(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // The menu owns this Escape: the shell's own listener (which would
        // close Settings) must not also see it.
        event.stopPropagation();
        setOpen(false);
        giveBackFocus();
        return;
      }
      stepMenuFocus(menu.current, event);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    // `capture: true` so a scroll inside any ancestor (the model list cards
    // scroll internally) still repositions the menu, not just window scroll.
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, place, giveBackFocus]);

  return (
    <span
      ref={wrap}
      className={className}
      style={{ position: "relative", flexShrink: 0, display: "inline-flex", ...style }}
    >
      {word ? (
        <Button
          ref={trigger}
          variant="ghost"
          size="sm"
          {...(keys ? { keys, "aria-keyshortcuts": ariaKeys, "data-key-command": keyCommand } : {})}
          aria-haspopup="menu"
          aria-expanded={open}
          tabIndex={triggerTabIndex}
          onClick={() => setOpen((value) => !value)}
        >
          {word}
        </Button>
      ) : (
        <IconButton
          ref={trigger}
          label={label}
          keys={keys}
          aria-keyshortcuts={ariaKeys}
          data-key-command={keys ? keyCommand : undefined}
          size={size}
          aria-haspopup="menu"
          aria-expanded={open}
          tabIndex={triggerTabIndex}
          onClick={() => setOpen((value) => !value)}
        >
          {kebab}
        </IconButton>
      )}
      {drawn &&
        anchor &&
        createPortal(
          <MenuPanel
            ref={mountMenu}
            label={label}
            items={items}
            style={{ top: anchor.top, right: anchor.right }}
            onPick={(item) => {
              if (item.checked !== undefined) {
                item.onSelect?.();
                return;
              }
              setOpen(false);
              giveBackFocus();
              item.onSelect?.();
            }}
          />,
          document.body,
        )}
    </span>
  );
}
