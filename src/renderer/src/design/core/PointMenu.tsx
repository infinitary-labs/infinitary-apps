import type React from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePopoverPresence } from "../motion";
import { EDGE, MENU_ITEMS, MenuPanel, type RowMenuItem, stepMenuFocus } from "./MenuPanel";

export type PointMenuProps = {
  /** The menu's accessible name. */
  label: string;
  items: readonly RowMenuItem[];
  /** Where it opens, in the window's own pixels: the press, or the middle of what is focused. */
  at: { x: number; y: number } | null;
  /** It asks to close: on a pick, `Esc` or a press outside. */
  onClose: () => void;
  /** Above whatever it opens over, such as the picture viewer's surface. */
  zIndex?: number;
};

/**
 * The row menu's right-click opening (design skill RowMenu, "A right-click
 * opening"): the same panel, opened at a point rather than under a kebab,
 * flipped to the left or above where it would run past the window's edge.
 * `Esc` closes it alone: its listener runs at the window's capture, ahead of
 * whatever it opens over, so the surface under it never also sees that key.
 * A press outside closes it and swallows that press's click, so a click
 * beside the menu never also presses what lies under it.
 */
export function PointMenu({ label, items, at, onClose, zIndex = 4 }: PointMenuProps) {
  const open = at !== null;
  const menu = useRef<HTMLDivElement>(null);
  // The press's point, as a box the panel grows from.
  const origin = useRef<HTMLSpanElement>(null);
  const drawn = usePopoverPresence(open, menu, origin);
  const [last, setLast] = useState(at);
  if (at && at !== last) setLast(at);
  const point = at ?? last;
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  const returnTo = useRef<Element | null>(null);
  const closing = useRef(onClose);
  closing.current = onClose;

  useLayoutEffect(() => {
    if (!at) return;
    returnTo.current = document.activeElement;
    const panel = menu.current;
    const width = panel?.offsetWidth ?? 0;
    const height = panel?.offsetHeight ?? 0;
    const left = at.x + width <= window.innerWidth - EDGE ? at.x : Math.max(EDGE, at.x - width);
    const top = at.y + height <= window.innerHeight - EDGE ? at.y : Math.max(EDGE, at.y - height);
    setPlace({ left, top });
  }, [at]);

  // Focus lands on the first item once the panel stands where it opens.
  useEffect(() => {
    if (open && place) menu.current?.querySelector<HTMLElement>(MENU_ITEMS)?.focus();
  }, [open, place]);

  const close = useCallback((giveBack: boolean) => {
    if (giveBack && returnTo.current instanceof HTMLElement) returnTo.current.focus();
    closing.current();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" || event.key === "Tab") {
        event.preventDefault();
        event.stopPropagation();
        close(true);
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.stopPropagation();
        stepMenuFocus(menu.current, event);
      }
    };
    let swallow: ((event: MouseEvent) => void) | undefined;
    const onDown = (event: PointerEvent) => {
      if (menu.current?.contains(event.target as Node)) return;
      close(false);
      if (event.button !== 0) return;
      swallow = (click: MouseEvent) => {
        click.preventDefault();
        click.stopPropagation();
      };
      window.addEventListener("click", swallow, { capture: true, once: true });
      // A press that ends in no click, such as a drag, leaves the next click alone.
      window.addEventListener(
        "pointerup",
        () =>
          window.setTimeout(() => {
            if (swallow) window.removeEventListener("click", swallow, true);
          }, 0),
        { capture: true, once: true },
      );
    };
    const onResize = () => close(false);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open, close]);

  if (!drawn || !point) return null;
  const style: React.CSSProperties = place
    ? { left: place.left, top: place.top, zIndex }
    : { left: point.x, top: point.y, zIndex, visibility: "hidden" };
  return createPortal(
    <>
      <span
        ref={origin}
        aria-hidden="true"
        style={{ position: "fixed", left: point.x, top: point.y, width: 0, height: 0 }}
      />
      <MenuPanel
        ref={menu}
        label={label}
        items={items}
        style={style}
        onPick={(item) => {
          close(true);
          item.onSelect?.();
        }}
      />
    </>,
    document.body,
  );
}
