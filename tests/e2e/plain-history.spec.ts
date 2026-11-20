import { expect, test } from "@playwright/test";
import { CardService } from "../../src/core/orchestrator/cardService";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { TaskTimeline } from "../../src/core/tasks/taskTimeline";
import { scratchDir } from "../helpers/scratchDirs";
import { launchApp } from "./launch";
import { resizeWindow } from "./layout";
import { regionShot } from "./pictures";
import { expandDock, nowFrame, pressRow, recordFrame, recordTab } from "./rails";
import { starterFor } from "./starters";
import { pressKey } from "./windowKeys";

/** Captain's W4 choice on INF-1484: plain history first, exact raw text one click deeper.
 * Actual typed source owners create revised brief, resumed conversation and script choice.
 * Keyboard opens every raw disclosure; exact retained text is the completion signal.
 * The hermetic app has private data and no shared resources or external effects.
 * Platform: desktop Electron only; no real sign-in, native input or device prerequisite.
 */
// biome-ignore lint/correctness/noEmptyPattern: Playwright needs the fixture slot for testInfo; Electron owns the window.
test("plain history and deeper exact sources", async ({}, testInfo) => {
  const userDataDir = scratchDir("infinitary-plain-history-");
  const db = openDatabase(userDataDir);
  const at = Date.now() - 60_000;
  const now = () => at;
  const tasks = new TaskService({ db, strict: true, now });
  const task = seedTask(tasks, {
    id: "plain-history",
    title: "Check the practice release on both computers",
    status: "idle",
    intent: { goal: "The practice release passes.", userWords: "check the practice release" },
    prompt: "Goal: The practice release passes.",
    shape: { kind: "implement" },
  });
  tasks.updateFields(task.id, { goal: "The Mac and Linux checks pass." }, "captain");
  tasks.turns.setSessionFile(task.id, "practice-resume", {
    file: "/work/practice.jsonl",
    computer: "Work computer",
    device_id: "work",
    provider: "openai-codex",
    model: starterFor("openai-codex", "low"),
    account_id: "work-account",
    began: "resume",
  });
  const cardStore = new CardStore(db);
  const cards = new CardService({
    tasks,
    cardStore,
    now,
    syncCaptainGate: () => {},
    closeAnsweredTask: () => false,
    settleFacts: () => undefined,
    followupNotice: () => undefined,
    broadcastCrewCounts: () => {},
    broadcastEvent: () => {},
    broadcastCards: () => {},
    broadcastThread: () => {},
  });
  const id = cards.emitCrewmateCard(
    task.id,
    {
      id: "queue-mode",
      title: "Keep the queue flush",
      body: "<p>The queue flush passes both checks.</p>",
      actions: [{ id: "flush", label: "Keep the queue flush", default: true }],
    },
    "Practice release",
  );
  const card = cards.get(id);
  if (!card) throw new Error("The fixture's script card is missing");
  cards.resolve(card, "script:flush", "flush", undefined, "crewmate", {
    source: "frame",
    frameValue: '{"mode":"flush","checks":["Mac","Linux"]}',
  });
  tasks.close(task.id, { status: "done", reason: "finished", actor: "host" });
  const timeline = new TaskTimeline({ tasks, cards: cardStore });
  const sources = timeline.sources(task.id);
  const readings = timeline.history(task.id);
  const targets = [
    {
      name: "brief",
      reading: sources.find((x) => x.record?.source === "task-event" && x.record.specification),
    },
    {
      name: "conversation",
      reading: sources.find((x) => x.entry.content.kind === "session-observation"),
    },
    {
      name: "script",
      reading: sources.find(
        (x) => x.entry.content.kind === "card-choice" && x.entry.actor?.kind === "frame",
      ),
    },
  ];
  db.close();
  const app = await launchApp({ userDataDir, withMockProvider: true });
  try {
    await resizeWindow(app.app, app.page, { width: 1280, height: 1000 });
    await expandDock(app.page, "now");
    await app.page
      .locator('[data-side-panel="now"] header')
      .getByRole("button", { name: "Search tasks" })
      .click();
    await nowFrame(app.page).locator("[data-now-query]").fill(task.title);
    await pressRow(app.page, task.key);
    const body = recordFrame(app.page);
    await pressKey(recordTab(app.page, "activity"), "Enter");
    const earlier = body.locator("[data-record-earlier]");
    if (await earlier.isVisible()) await pressKey(earlier.locator(":scope > summary"), "Enter");
    const recorded = [];
    for (const target of targets) {
      if (!target.reading) throw new Error(`Missing ${target.name} fixture`);
      const reading = readings.find((x) => x.entry.id === target.reading?.entry.id);
      if (!reading?.details) throw new Error(`Missing exact ${target.name} details`);
      const row = body.locator(`[data-timeline-entry="${reading.entry.id}"]`);
      if (!(await row.evaluate((n) => (n as HTMLDetailsElement).open)))
        await pressKey(row.locator(":scope > summary"), "Enter");
      await expect(row.locator("[data-record-whole]")).toHaveText(reading.text ?? "");
      const raw = row.locator("[data-record-source-details]");
      await expect(raw).not.toHaveAttribute("open", "");
      await expect(raw.locator("pre")).toBeHidden();
      await regionShot(row, testInfo.outputPath(`plain-${target.name}.png`));
      await pressKey(raw.locator(":scope > summary"), "Enter");
      await expect(raw.locator("pre")).toBeVisible();
      await expect(raw.locator("pre")).toHaveText(reading.details);
      await regionShot(row, testInfo.outputPath(`raw-${target.name}.png`));
      recorded.push({ name: target.name, reading, visible: await row.innerText() });
    }
    await testInfo.attach("plain-and-exact-history", {
      body: Buffer.from(JSON.stringify(recorded, null, 2)),
      contentType: "application/json",
    });
  } finally {
    await app.close();
  }
});
