import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { FIRSTMATE_PERSONA } from "../../src/core/pi/piResources";
import { launchClaudeCrew } from "./claudeCrew";
import type { LaunchedApp } from "./launch";
import { promptInput } from "./prompt";
import {
  SEQ_BUG_YES,
  SEQ_BUG_YES_ASK,
  SEQ_CLAUDE_STEP_MARKER,
  SEQ_REPRODUCED_YES,
  seqGoal,
  sequences,
} from "./scenarios/sequences";

// The Pi journey lives in sequences.spec.ts. This exercises the same
// cardless hand-off on a client-side backend, through real typed state.
let launched: LaunchedApp;
test.beforeAll(async () => {
  launched = await launchClaudeCrew({ scenarios: [sequences] });
});
test.afterAll(async () => {
  await launched.close();
});

test("a cardless reproduction on Claude starts its fix without a captain turn", async () => {
  const { page, mockProvider } = launched;
  const input = promptInput(page);
  await expect(input).toBeEnabled();
  await input.fill(`${SEQ_BUG_YES_ASK} ${SEQ_CLAUDE_STEP_MARKER}`);
  await input.press("Enter");
  const taskNamed = (title: string) =>
    page.evaluate(
      async (name) =>
        (await window.infinitary.tasks.board()).tasks.find((task) => task.title === name),
      title,
    );
  await expect.poll(() => taskNamed(SEQ_BUG_YES.fix), { timeout: 30_000 }).toBeDefined();
  const reproduce = await taskNamed(SEQ_BUG_YES.reproduce);
  const fix = await taskNamed(SEQ_BUG_YES.fix);
  if (!reproduce || !fix) throw new Error("The scripted bugfix must file both tasks.");
  const detail = (id: string) =>
    page.evaluate((taskId) => window.infinitary.tasks.detail(taskId), id);
  await expect.poll(() => detail(fix.id), { timeout: 30_000 }).toMatchObject({ status: "active" });
  await expect
    .poll(() => detail(reproduce.id), { timeout: 30_000 })
    .toMatchObject({
      deliverable: "answer",
      status: "done",
      closedReason: "answered",
    });
  // Active means dispatched, not that the new client's first request has
  // arrived. Wait for the consumer to receive the grounded brief.
  const fixBriefReceived = () =>
    (mockProvider?.requestBodies() ?? []).find(
      (body) => !body.includes(FIRSTMATE_PERSONA) && body.includes(seqGoal(SEQ_BUG_YES.fix)),
    );
  await expect.poll(fixBriefReceived, { timeout: 30_000 }).toBeDefined();
  const bodies = mockProvider?.requestBodies() ?? [];
  const crewBrief = bodies.find(
    (body) => !body.includes(FIRSTMATE_PERSONA) && body.includes(seqGoal(SEQ_BUG_YES.reproduce)),
  );
  expect(crewBrief).toMatch(/"model"\s*:\s*"claude-/);
  expect(
    bodies.some((body) => body.includes(FIRSTMATE_PERSONA) && body.includes(SEQ_REPRODUCED_YES)),
  ).toBe(true);
  const fixBrief = fixBriefReceived();
  expect(fixBrief).toContain(SEQ_REPRODUCED_YES);
  expect(fixBrief).toContain(`grounded in ${reproduce.key}`);
  const cards = await page.evaluate(() => window.infinitary.cards.list());
  expect(cards.filter((card) => card.taskId === reproduce.id)).toHaveLength(0);
  writeFileSync(
    test.info().outputPath("handoff.json"),
    JSON.stringify(
      {
        reproduce: await detail(reproduce.id),
        fix: await detail(fix.id),
        crewBrief,
        fixBrief,
      },
      null,
      2,
    ),
  );
  await page.screenshot({ path: test.info().outputPath("claude-handoff.png") });
});
