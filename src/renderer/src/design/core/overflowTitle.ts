import { useCallback, useLayoutEffect, useState } from "react";
import { type RestLabelProps, useRestLabel } from "./restLabel";

/** A subpixel can look like overflow; a real cut is wider than that. */
const CLIP_PX = 1;

/**
 * Whether this node's own text is not readable: hidden, or cut by its box.
 * A node that cannot be measured is treated as hidden, so a tooltip fact
 * stays until a real layout shows the words.
 */
export function textIsHidden(node: HTMLElement): boolean {
  if (typeof node.scrollWidth !== "number" || typeof getComputedStyle !== "function") return true;
  const style = getComputedStyle(node);
  if (style.display === "none" || style.visibility === "hidden") return true;
  return (
    node.scrollWidth - node.clientWidth > CLIP_PX || node.scrollHeight - node.clientHeight > CLIP_PX
  );
}

/**
 * The native title for text that is already on screen: absent while every
 * word fits, the text itself while any of it is cut, hidden, or not yet
 * measured. Resize, a live text change, and a keyboard expansion that
 * changes the box are measured again.
 */
export function useOverflowTitle(text: string | undefined): {
  ref: (node: HTMLElement | null) => void;
  title: string | undefined;
  hidden: boolean;
} {
  const [node, setNode] = useState<HTMLElement | null>(null);
  const [hidden, setHidden] = useState(true);
  const ref = useCallback((next: HTMLElement | null) => {
    setNode(next);
  }, []);
  useLayoutEffect(() => {
    if (!text) {
      setHidden(false);
      return;
    }
    if (!node) {
      setHidden(true);
      return;
    }
    const measure = () => setHidden(textIsHidden(node));
    measure();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    observer?.observe(node);
    if (node.parentElement) observer?.observe(node.parentElement);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [node, text]);
  return { ref, title: text && hidden ? text : undefined, hidden: Boolean(text) && hidden };
}

/**
 * Words cut short that a person may need whole from the keyboard - a
 * folder's path, a past card's strip, a record's key: while any of them is
 * cut, the node is a Tab stop of its own and shows them whole in the label
 * the app draws on rest, the pointer's or the keyboard's focus, in place of
 * the native title (docs/keyboard.md, "Facts shown on rest"). Assistive
 * technology reads the node's own text, which is always whole.
 */
export function useCutWords(text: string | undefined): RestLabelProps & { tabIndex?: number } {
  const fit = useOverflowTitle(text);
  const rest = useRestLabel(fit.hidden ? text : undefined, { fact: true });
  const fitRef = fit.ref;
  const restRef = rest.ref;
  const ref = useCallback(
    (node: HTMLElement | null) => {
      fitRef(node);
      restRef(node);
    },
    [fitRef, restRef],
  );
  return { ...rest, ref, ...(fit.hidden ? { tabIndex: 0 } : {}) };
}
