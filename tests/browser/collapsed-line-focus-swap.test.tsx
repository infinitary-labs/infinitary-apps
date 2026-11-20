import type { PanelSummaryLine } from "@shared/personal/contracts";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { SaidLine } from "../../src/renderer/src/plugins/SaidLine";

// INF-4638: Shift+Tab from Expand Activity lost focus to the main message
// box while the collapse's own line replaced the line the collapsed header
// showed. The swap decided whether the newer line takes focus when its
// timer ran, and React drew it a task later; a Shift+Tab that landed on the
// old line in between lost focus as the old line left. The lines are the
// ones the built app's collapsed Activity header showed in that moment.

/** The line the header showed as Activity collapsed. */
const SHOWN: PanelSummaryLine = {
  lead: "SCR-1",
  line: "Updated: returned to the queue - the start did not finish",
  tone: "info",
};
/** The collapse's own line, which replaces it. */
const COLLAPSED: PanelSummaryLine = { line: "Captain · activity collapsed", tone: "info" };

/** The collapsed header as the rail draws it: the line, then the chevron that expands it. */
function Header({ line }: { line: PanelSummaryLine }) {
  return (
    <section aria-label="Activity">
      <SaidLine line={line} panelTitle="Activity" onOpen={() => {}} />
      <button type="button" aria-label="Expand Activity" />
    </section>
  );
}

test("focus that lands on the collapsed line after its swap is decided, before it draws, stays on the line (INF-4638)", async () => {
  const mount = document.createElement("div");
  document.body.append(mount);
  const root = createRoot(mount);
  const line = () => mount.querySelector<HTMLElement>("[data-panel-summary-line]");
  try {
    flushSync(() => root.render(<Header line={SHOWN} />));
    mount.querySelector<HTMLElement>('[aria-label="Expand Activity"]')?.focus();

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      // The collapse's line arrives, and the swap waits for its turn.
      flushSync(() => root.render(<Header line={COLLAPSED} />));
      expect(vi.getTimerCount()).toBe(1);
      // Its turn: the swap is decided, and React draws it in a later task.
      vi.runOnlyPendingTimers();
    } finally {
      vi.useRealTimers();
    }
    const shown = line();
    expect(shown?.getAttribute("aria-description")).toBe(`${SHOWN.lead} ${SHOWN.line}`);
    // Where Shift+Tab from Expand Activity lands in that gap. A key goes
    // through the browser and arrives after the draw, so it is placed here.
    shown?.focus();

    await expect.poll(() => line()?.getAttribute("aria-description")).toBe(COLLAPSED.line);
    expect(line()).not.toBe(shown);
    expect(document.activeElement).toBe(line());
  } finally {
    root.unmount();
    mount.remove();
  }
});
