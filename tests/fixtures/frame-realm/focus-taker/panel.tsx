import type { PanelProps } from "@firstmate/contracts";
import { useEffect, useRef, useState } from "react";

/** How many times the panel tries, and how much taller each try makes it. */
const TRIES = 30;
const STEP_PX = 4;

/**
 * A panel whose own script tries to take the window's focus
 * (tests/e2e/frame-focus.spec.ts): once the theme changes, it calls
 * `focus()` on its field and on its window every 100 ms, thirty times, and
 * grows by STEP_PX with each try so the window can count them without
 * reading inside the frame.
 */
export default function Panel(_props: PanelProps) {
  const field = useRef<HTMLInputElement>(null);
  const [tries, setTries] = useState(0);
  useEffect(() => {
    const root = document.documentElement;
    const start = root.dataset.theme;
    let timer: ReturnType<typeof setInterval> | undefined;
    const observer = new MutationObserver(() => {
      if (timer !== undefined || root.dataset.theme === start) return;
      let count = 0;
      timer = setInterval(() => {
        field.current?.focus();
        window.focus();
        count += 1;
        setTries(count);
        if (count >= TRIES) clearInterval(timer);
      }, 100);
    });
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
      observer.disconnect();
      clearInterval(timer);
    };
  }, []);
  return (
    <div>
      <label>
        Scratch <input ref={field} name="scratch" />
      </label>
      <div data-focus-tries={tries} style={{ height: tries * STEP_PX }} />
    </div>
  );
}
