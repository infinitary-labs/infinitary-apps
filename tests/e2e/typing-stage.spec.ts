import { type CDPSession, expect, type Page, test } from "@playwright/test";
import { type LaunchedApp, launchApp } from "./launch";
import { promptInput } from "./prompt";
import { focusOn, typeInto } from "./windowKeys";

/**
 * INF-1073: the captain still saw keystrokes lag in the message box, and
 * the study found each key rendering the whole stage behind it - the
 * character, its crew and their orbit - once per key. The captain asked for
 * a guard "that doesn't create a flaky test that would fail on busy mac".
 *
 * So this journey counts, and never times: the browser's own call counters
 * (precise coverage) say how many times each stage component ran while a
 * sentence was typed. A busy machine changes how long each key takes, not
 * how many times a component runs for it. The first key starts a draft,
 * which the stage does answer, so it is read on its own first: that proves
 * the counters see the stage, and the sentence after it must not.
 */

let launched: LaunchedApp;

test.beforeAll(async () => {
  launched = await launchApp({ withMockProvider: true });
});

test.afterAll(async () => {
  await launched?.close();
});

/** The stage's components, by the names they render under. */
const STAGE = ["HomeMate", "Firstmate"] as const;

/** How many times each stage component ran during `act`, read from the browser's call counters. */
async function stageRuns(
  cdp: CDPSession,
  page: Page,
  act: () => Promise<void>,
): Promise<Record<(typeof STAGE)[number], number>> {
  // Taking the counts resets them, so only `act` and the frame after it count.
  await cdp.send("Profiler.takePreciseCoverage");
  await act();
  await page.evaluate(
    () =>
      new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
  );
  const { result } = await cdp.send("Profiler.takePreciseCoverage");
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
      expect(found.length, `at most one ${name} component in the renderer's code`).toBeLessThan(2);
      return [name, found[0] ?? 0];
    }),
  ) as Record<(typeof STAGE)[number], number>;
}

test("typing a sentence in the message box does not render the stage again for each key", async () => {
  const { page } = launched;
  const input = promptInput(page);
  await expect(input).toBeEnabled();
  // The stage HomeMate draws, with the character in it.
  const stage = page.locator("[data-character-frame]");
  await expect(stage.getByRole("img", { name: /^First mate - / })).toBeVisible();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.startPreciseCoverage", { callCount: true, detailed: false });
  await focusOn(input);

  // The first key starts a draft: the character turns to listen, so the stage
  // renders, which also proves the counters find each component by its name.
  const draft = await stageRuns(cdp, page, async () => {
    await typeInto(input, "p");
    await expect(input).toHaveValue("p");
  });
  expect(draft.HomeMate).toBeGreaterThan(0);
  expect(draft.Firstmate).toBeGreaterThan(0);

  // The rest of the sentence only spins the character, read on its own frames.
  const rest = "lease inspect the current desktop while I type this sentence";
  const typed = await stageRuns(cdp, page, async () => {
    await typeInto(input, rest);
    await expect(input).toHaveValue(`p${rest}`);
  });
  const line = `draft ${JSON.stringify(draft)}; ${rest.length} keys ${JSON.stringify(typed)}`;
  test.info().annotations.push({ type: "stage renders", description: line });
  console.log(`[stage renders] ${line}`);
  // Before INF-1073 each key rendered both, once per key. Something else on
  // the stage may still move in the meantime, which is a handful of renders
  // at most; a quarter of the keys leaves room for that and none for a
  // render per key.
  for (const name of STAGE)
    expect(typed[name], `${name} renders while ${rest.length} keys are typed`).toBeLessThan(
      rest.length / 4,
    );

  await cdp.send("Profiler.stopPreciseCoverage");
  await cdp.send("Profiler.disable");
  await cdp.detach();
});
