import { expect, test } from "@playwright/test";
import { askFirstmate } from "./lastTurn";
import { type LaunchedApp, launchApp } from "./launch";
import { ANSWER_PROMPT_MARKER, MOCK_ANSWER_TITLE } from "./mockProvider";
import { promptInput } from "./prompt";
import { latestContext } from "./providerRequest";
import { FORGET_PROMPT_MARKER, MOCK_NOTE, notes, REMEMBER_PROMPT_MARKER } from "./scenarios/notes";
import { shownCard } from "./stack";

let launched: LaunchedApp;

test.beforeAll(async () => {
  launched = await launchApp({ withMockProvider: true, scenarios: [notes] });
});

test.afterAll(async () => {
  await launched.close();
});

test("remember records a direction in Knowledge, the next turn carries it, and forget retires it", async () => {
  const { page, mockProvider } = launched;
  const input = promptInput(page);
  await test.step("remember records a direction and the next turn carries it", async () => {
    await askFirstmate(page, REMEMBER_PROMPT_MARKER);
    const direction = await page.evaluate(
      (id) => window.infinitary.plugins.read("knowledge.direction", { id }),
      MOCK_NOTE.id,
    );
    expect(direction).toMatchObject({
      state: "ready",
      direction: { text: MOCK_NOTE.content, authority: "instruction" },
    });

    const before = mockProvider?.requestBodies().length ?? 0;
    await input.click();
    await input.fill(ANSWER_PROMPT_MARKER);
    await input.press("Enter");
    await expect(shownCard(page, MOCK_ANSWER_TITLE)).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => (mockProvider?.requestBodies().length ?? 0) > before).toBe(true);
    const context = latestContext((mockProvider?.requestBodies() ?? [])[before] ?? "");
    expect(context?.directions).toContain(MOCK_NOTE.content);
  });

  await test.step("forget removes the direction from active influence", async () => {
    await input.click();
    await input.fill(FORGET_PROMPT_MARKER);
    await input.press("Enter");
    await expect
      .poll(async () => {
        const read = await page.evaluate(
          (id) => window.infinitary.plugins.read("knowledge.direction", { id }),
          MOCK_NOTE.id,
        );
        return read.state === "ready" && read.direction.retired;
      })
      .toBe(true);
  });
});
