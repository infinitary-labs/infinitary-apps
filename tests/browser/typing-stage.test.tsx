import { expect, test } from "vitest";
import { cdp, page, userEvent } from "vitest/browser";
import { fakeBridge } from "./bridge";
import { freshHome } from "./freshHome";
import { openWindow } from "./window";

/**
 * INF-1073: the captain still saw keystrokes lag in the message box, and
 * the study found each key rendering the whole stage behind it - the
 * character, its crew and their orbit - once per key. The captain asked for
 * a guard "that doesn't create a flaky test that would fail on busy mac".
 *
 * So this test counts, and never times: the browser's own call counters
 * (precise coverage) say how many times each stage component ran while a
 * sentence was typed. A busy machine changes how long each key takes, not
 * how many times a component runs for it. The first key starts a draft,
 * which the stage does answer, so it is read on its own first: that proves
 * the counters see the stage, and the sentence after it must not.
 */

/** The stage's components, by the names they render under. */
const STAGE = ["HomeMate", "Firstmate"] as const;
type Runs = Record<(typeof STAGE)[number], number>;

type Coverage = {
  result: { functions: { functionName: string; ranges: { count: number }[] }[] }[];
};

/** Two frames, so the render a key started has run. */
function frames(): Promise<void> {
  return new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
}

/** How many times each stage component ran during `act`, read from the browser's call counters. */
async function stageRuns(act: () => Promise<void>): Promise<Runs> {
  const session = cdp();
  // Taking the counts resets them, so only `act` and the frames after it count.
  await session.send("Profiler.takePreciseCoverage");
  await act();
  await frames();
  const { result } = (await session.send("Profiler.takePreciseCoverage")) as Coverage;
  const runs = Object.fromEntries(STAGE.map((name) => [name, [] as number[]]));
  for (const script of result)
    for (const fn of script.functions) {
      // The bundler numbers a name it had to rename (HomeMate2); any other match is a mix-up.
      const name = fn.functionName.replace(/\$?\d+$/, "");
      runs[name]?.push(fn.ranges[0]?.count ?? 0);
    }
  return Object.fromEntries(
    STAGE.map((name) => {
      const found = runs[name] ?? [];
      // The counters leave out a function that did not run at all, so a name
      // is missing when it ran no times; two under one name would mix them up.
      expect(found.length, `at most one ${name} component in the window's code`).toBeLessThan(2);
      return [name, found[0] ?? 0];
    }),
  ) as Runs;
}

/**
 * The message box as the window draws it now, read by its name each time:
 * its hint changes as the window learns how this computer hears dictation,
 * so a locator built from the hint loses it.
 */
function messageBox(): HTMLTextAreaElement | null {
  return document.querySelector<HTMLTextAreaElement>('[name="task-prompt"]');
}

test("typing a sentence in the message box does not render the stage again for each key", async () => {
  const home = freshHome();
  const firstRun = home["inf:app:first-run"];
  if (!firstRun || typeof firstRun === "function")
    throw new Error("A fresh home answers its first run");
  // A home whose person connected a subscription: the message box is open.
  await openWindow(fakeBridge({ ...home, "inf:app:first-run": { ...firstRun, gateOpen: false } }));
  await expect.poll(() => messageBox()?.disabled).toBe(false);
  // The stage HomeMate draws, with the character in it.
  await expect.element(page.getByRole("img", { name: /^First mate - / })).toBeVisible();
  const session = cdp();
  await session.send("Profiler.enable");
  await session.send("Profiler.startPreciseCoverage", { callCount: true, detailed: false });
  messageBox()?.focus();
  await expect.poll(() => document.activeElement === messageBox()).toBe(true);

  // The first key starts a draft: the character turns to listen, so the stage
  // renders, which also proves the counters find each component by its name.
  const draft = await stageRuns(async () => {
    await userEvent.keyboard("p");
    await expect.poll(() => messageBox()?.value).toBe("p");
  });
  expect(draft.HomeMate).toBeGreaterThan(0);
  expect(draft.Firstmate).toBeGreaterThan(0);

  // The rest of the sentence only spins the character, read on its own frames.
  const rest = "lease inspect the current desktop while I type this sentence";
  const typed = await stageRuns(async () => {
    await userEvent.keyboard(rest);
    await expect.poll(() => messageBox()?.value).toBe(`p${rest}`);
  });
  // Before INF-1073 each key rendered both, once per key. Something else on
  // the stage may still move in the meantime, which is a handful of renders
  // at most; a quarter of the keys leaves room for that and none for a
  // render per key.
  for (const name of STAGE)
    expect(typed[name], `${name} renders while ${rest.length} keys are typed`).toBeLessThan(
      rest.length / 4,
    );

  await session.send("Profiler.stopPreciseCoverage");
  await session.send("Profiler.disable");
});
