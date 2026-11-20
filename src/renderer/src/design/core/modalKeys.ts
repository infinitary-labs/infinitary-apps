import { type RefObject, useEffect, useRef } from "react";

const CONTROLS =
  'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], summary, [tabindex="0"]';

/**
 * The keys of a dialog over the window (`ConsentDialog`, the custom API
 * dialog): focus starts on its first control; Tab and
 * ⇧Tab stay inside it; Escape closes it alone, never Settings around it; and
 * closing gives focus back to what had it before it opened.
 */
export function useModalKeys(root: RefObject<HTMLElement | null>, onClose: () => void): void {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const controls = () => [...(root.current?.querySelectorAll<HTMLElement>(CONTROLS) ?? [])];
    controls()[0]?.focus();
    const keys = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = controls();
      const head = items[0];
      const tail = items.at(-1);
      if (event.shiftKey && document.activeElement === head) {
        event.preventDefault();
        tail?.focus();
      } else if (!event.shiftKey && document.activeElement === tail) {
        event.preventDefault();
        head?.focus();
      }
    };
    document.addEventListener("keydown", keys);
    return () => {
      document.removeEventListener("keydown", keys);
      previous?.focus();
    };
  }, [root]);
}
