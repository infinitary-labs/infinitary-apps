import { describe, expect, it, vi } from "vitest";
import type { BrowserViewer } from "../browser/browserViews";
import { createUpdateHold, crewWorkHeldThere, HOLD_NOT_SAVED } from "./updateHold";
import type { CrewWorkForUpdate } from "./updateWork";

// INF-3660's plan, the captain's answer update=window-installs: "This window installs it for
// the run, while the run holds the crew's saved work" (docs/alpha.md, "Saving work before an
// update"). The hold ends if the window's connection drops.
describe("the crew's saved work, held for the window that installs an update", () => {
  function window() {
    const gone: (() => void)[] = [];
    const viewer: BrowserViewer = { show: () => {}, onGone: (listener) => gone.push(listener) };
    return {
      viewer,
      drop: () => {
        for (const listener of gone.splice(0)) listener();
      },
    };
  }

  /** A crew with one running turn, which saves when the test says so. */
  function crew() {
    let finish: (outcome: "saved" | "withdrawn") => void = () => {};
    const released = vi.fn();
    const work: CrewWorkForUpdate = {
      save: ({ signal, waiting }) =>
        new Promise((resolve) => {
          waiting(["Fix the flaky test"]);
          finish = resolve;
          signal.addEventListener("abort", () => resolve("withdrawn"), { once: true });
        }),
      release: released,
      resuming: () => [],
    };
    return { work, released, saved: () => finish("saved") };
  }

  it("saves the crew's work for the window, and ends the first mate once the copy is replaced", async () => {
    const { work, released, saved } = crew();
    const replaced = vi.fn();
    const hold = createUpdateHold(work, replaced);
    const asker = window();
    const saving = hold("save", asker.viewer);
    // While it saves, the window reads which tasks it waits for.
    expect(await hold("status", asker.viewer)).toEqual({
      saved: false,
      work: { state: "saving", tasks: ["Fix the flaky test"] },
    });
    saved();
    expect(await saving).toEqual({ saved: true });
    expect(await hold("replaced", asker.viewer)).toEqual({ saved: true });
    await vi.waitFor(() => expect(replaced).toHaveBeenCalledTimes(1));
    // The work stays saved for the new copy, whatever the window does next.
    asker.drop();
    expect(released).not.toHaveBeenCalled();
  });

  it("refuses to end the first mate when no work was saved", async () => {
    const { work } = crew();
    const replaced = vi.fn();
    const hold = createUpdateHold(work, replaced);
    await expect(hold("replaced", window().viewer)).rejects.toThrow(HOLD_NOT_SAVED);
    expect(replaced).not.toHaveBeenCalled();
  });

  it("lets the save go on Update later, and the work carries on", async () => {
    const { work, released } = crew();
    const hold = createUpdateHold(work, vi.fn());
    const asker = window();
    const saving = hold("save", asker.viewer);
    expect(await hold("later", asker.viewer)).toEqual({ saved: false });
    expect(await saving).toEqual({ saved: false });
    expect(released).not.toHaveBeenCalled();
  });

  it("carries the work on when the window is killed while it saves", async () => {
    const { work, released, saved } = crew();
    const hold = createUpdateHold(work, vi.fn());
    const asker = window();
    const saving = hold("save", asker.viewer);
    asker.drop();
    expect(await saving).toEqual({ saved: false });
    // A save that finished after the window left holds nothing either.
    const again = window();
    const second = hold("save", again.viewer);
    saved();
    expect(await second).toEqual({ saved: true });
    again.drop();
    expect(released).toHaveBeenCalledTimes(1);
  });

  it("releases work the window saved and then did not replace", async () => {
    const { work, released, saved } = crew();
    const hold = createUpdateHold(work, vi.fn());
    const asker = window();
    const saving = hold("save", asker.viewer);
    saved();
    await saving;
    expect(await hold("release", asker.viewer)).toEqual({ saved: false });
    expect(released).toHaveBeenCalledTimes(1);
  });
});

describe("the same hold, as the window's own update checker asks for it", () => {
  it("saves through the first mate, reading which tasks it waits for", async () => {
    let answer: (hold: { saved: boolean }) => void = () => {};
    const steps: string[] = [];
    const work = crewWorkHeldThere(async (step) => {
      steps.push(step);
      if (step === "save") return new Promise((resolve) => (answer = resolve));
      return { saved: false, work: { state: "saving", tasks: ["Fix the flaky test"] } };
    }, 5);
    const waiting = vi.fn();
    const saving = work.save({ signal: new AbortController().signal, waiting });
    await vi.waitFor(() => expect(waiting).toHaveBeenCalledWith(["Fix the flaky test"]));
    answer({ saved: true });
    expect(await saving).toBe("saved");
    work.release();
    expect(steps.at(-1)).toBe("release");
    expect(work.resuming()).toEqual([]);
  });

  it("tells the first mate Update later, and releases a save that finished meanwhile", async () => {
    let answer: (hold: { saved: boolean }) => void = () => {};
    const steps: string[] = [];
    const work = crewWorkHeldThere(async (step) => {
      steps.push(step);
      if (step === "save") return new Promise((resolve) => (answer = resolve));
      return { saved: false };
    }, 60_000);
    const later = new AbortController();
    const saving = work.save({ signal: later.signal, waiting: () => {} });
    later.abort();
    expect(steps).toEqual(["save", "later"]);
    answer({ saved: true });
    expect(await saving).toBe("withdrawn");
    expect(steps).toEqual(["save", "later", "release"]);
  });
});
