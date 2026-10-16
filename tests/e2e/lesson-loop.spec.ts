import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { scratchDir } from "../helpers/scratchDirs";
import { cardBody } from "./frames";
import { askFirstmate } from "./lastTurn";
import { launchApp } from "./launch";
import { resizeWindow } from "./layout";
import {
  chessItems,
  LESSON_CHESS_ASK,
  LESSON_FRACTIONS_ASK,
  LESSON_FRACTIONS_GOAL_TITLE,
  LESSON_GOAL_ANSWER,
  LESSON_GOAL_TITLE,
  LESSON_LEARNER_LINE,
  LESSON_NEXT_GOAL,
  LESSON_REPLY_ANSWER,
  LESSON_REPLY_WORDS,
  LESSON_ROUND_ONE_TITLE,
  LESSON_ROUND_REVIEW_TITLE,
  LESSON_ROUND_TWO_TITLE,
  LESSON_WARM_REFUSAL,
  LESSON_WELCOME_TITLE,
} from "./lessonFixtures";
import { heroShot, regionShot } from "./pictures";
import { readSavedData } from "./savedData";
import { cardReply, clickInBody, expectNoCard, showCard, shownCard, shownEntry } from "./stack";
import { pressKey } from "./windowKeys";

const OTHER = "Another question";
const git = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();

type TaskRow = {
  id: string;
  title: string;
  status: string;
  shape: string | null;
  reason: string | null;
};

/** The tasks the journey started, straight from the saved record. */
function tasksOf(userDataDir: string): TaskRow[] {
  return readSavedData(userDataDir, (db) =>
    db
      .prepare(
        "SELECT id, title, status, shape_json AS shape, closed_reason AS reason FROM tasks WHERE kind = 'work' ORDER BY created_at",
      )
      .all(),
  ) as TaskRow[];
}

/** A footer choice, pressed by keyboard the way the journeys of the card stack do. */
const choose = (page: Page, name: string) =>
  pressKey(page.getByRole("button", { name, exact: true }), "Enter");

/**
 * The whole accepted lesson loop, scripted: the teacher's words are fixed
 * (`lessonFixtures.ts`), so this proves the app's behavior - the teach kind,
 * the card's own answer key, reply continuity, forward arrivals, committed
 * records, the welcome-back card through a restart - and nothing about a
 * model's teaching. One ordered journey with named sections.
 */
test("a lesson plays in one card, keeps its records and welcomes the learner back", async () => {
  test.setTimeout(300_000);
  const userDataDir = scratchDir("infinitary-lessons-");
  const workspace = join(userDataDir, "fleet", "personal");
  const evidence = process.env.INFINITARY_LESSON_EVIDENCE;
  if (evidence) mkdirSync(evidence, { recursive: true });
  const db = openDatabase(userDataDir);
  new CardStore(db).upsert({
    id: "another-card",
    author: "firstmate",
    priority: 25,
    title: OTHER,
    meta: "firstmate",
    body: "<p>Another question can wait here.</p>",
    actions: [],
    status: "ready",
    createdAt: 1000,
  });
  db.close();
  let launched = await launchApp({ userDataDir, withMockProvider: true });
  const teacherRequests = () =>
    (launched.mockProvider?.requestBodies() ?? []).filter((body) =>
      body.includes(LESSON_CHESS_ASK),
    );
  try {
    await test.step("a teach request starts one teacher, which asks the goal first", async () => {
      const { app, page } = launched;
      // Tall enough that a whole round shows without scrolling the card.
      await resizeWindow(app, page, { width: 1280, height: 900 });
      await expect(shownCard(page, OTHER)).toBeVisible();
      await askFirstmate(page, LESSON_CHESS_ASK);
      await expect(shownCard(page, LESSON_GOAL_TITLE)).toBeVisible({ timeout: 60_000 });
      const chess = tasksOf(userDataDir).filter((task) => task.title === "Teach chess");
      expect(chess).toHaveLength(1);
      const shape = JSON.parse(chess[0]?.shape ?? "{}");
      expect(shape).toMatchObject({ kind: "teach", deliverable: "change" });
      const routing = readSavedData(userDataDir, (saved) =>
        saved
          .prepare("SELECT rule, bucket FROM routing_decisions WHERE task_id = ?")
          .all(chess[0]?.id),
      );
      expect(routing.at(-1)).toMatchObject({ rule: "R2", bucket: "high" });
      // The first card asks for the goal, in the warm voice a lesson card may use.
      await expect(
        cardBody(page, LESSON_GOAL_TITLE).getByLabel("What do you want to be able to do?"),
      ).toBeVisible();
      if (evidence) await regionShot(shownEntry(page), join(evidence, "goal.png"));
    });

    await test.step("a choice closes the goal card and the first round comes forward over another card", async () => {
      const { page } = launched;
      await showCard(page, LESSON_GOAL_TITLE);
      await cardBody(page, LESSON_GOAL_TITLE)
        .getByLabel("What do you want to be able to do?")
        .evaluate((field: HTMLInputElement, value) => {
          field.value = value;
          field.dispatchEvent(new Event("input", { bubbles: true }));
        }, LESSON_GOAL_ANSWER);
      await choose(page, "Let's start");
      await expect(shownCard(page, LESSON_ROUND_ONE_TITLE)).toBeVisible({ timeout: 60_000 });
      expect(readFileSync(join(workspace, "lessons", "learner.md"), "utf8")).toContain(
        LESSON_LEARNER_LINE,
      );
      // Nothing is learned on the first day.
      expect(readFileSync(join(workspace, "lessons", "chess", "progress.md"), "utf8")).not.toMatch(
        /\| learned/,
      );
    });

    await test.step("answers, hints and a worked example are judged in the card with no model turn", async () => {
      const { page } = launched;
      const body = cardBody(page, LESSON_ROUND_ONE_TITLE);
      const before = launched.mockProvider?.requestBodies().length ?? 0;
      const items = chessItems(1);
      const positions: number[] = [];
      for (const [index, item] of items.entries()) {
        await expect(body.locator("#prompt")).toHaveText(item.q);
        await expect(body.locator("#count")).toHaveText(`${index + 1} of ${items.length}`);
        const options = await body.locator("#choices button").allTextContents();
        positions.push(options.indexOf(item.correct));
        // Fair choices: equal length, and the right answer is never in one spot.
        expect(
          Math.max(...options.map((o) => o.length)) - Math.min(...options.map((o) => o.length)),
        ).toBeLessThanOrEqual(1);
        const choice = (text: string) => body.locator("#choices button", { hasText: text });
        if (index === 0) {
          await clickInBody(choice(item.wrong[0] as string));
          await expect(body.locator("#feedback")).toContainText("Not quite");
        }
        if (index === 1) {
          await clickInBody(choice(item.wrong[0] as string));
          await clickInBody(choice(item.wrong[1] as string));
          await expect(body.locator("#feedback")).toContainText(item.worked);
          await expect(body.locator("#advance")).toBeVisible();
          await clickInBody(body.locator("#advance"));
          continue;
        }
        if (index === 2) {
          await clickInBody(body.locator("#hint"));
          await expect(body.locator("#feedback")).toHaveText(item.hints[0] as string);
        }
        if (evidence && index === 3)
          await regionShot(shownEntry(page), join(evidence, "round-midway.png"));
        if (process.env.INFINITARY_LESSON_HERO === "1" && index === 3)
          await heroShot(page, { name: "lessons-in-one-card", region: shownEntry(page) });
        await clickInBody(choice(item.correct));
        await expect(body.locator("#feedback")).not.toHaveText("");
        await clickInBody(body.locator("#advance"));
      }
      expect(new Set(positions).size).toBe(3);
      expect(positions.every((position, i) => i === 0 || position !== positions[i - 1])).toBe(true);
      // Five of eight were right with no miss and no hint.
      await expect(body.locator("#main")).toBeHidden();
      await expect(body.locator("#finish")).toContainText(/\b5 of 8\b/);
      await expect(body.locator("#finish")).toContainText(LESSON_NEXT_GOAL);
      expect(launched.mockProvider?.requestBodies().length ?? 0).toBe(before);
      if (evidence) await regionShot(shownEntry(page), join(evidence, "finish.png"));
    });

    await test.step("a reply keeps the lesson card shown, and the teacher answers in its thread", async () => {
      const { page } = launched;
      const reply = cardReply(page).field;
      await reply.fill(LESSON_REPLY_WORDS);
      await pressKey(reply, "Enter");
      await expect(shownEntry(page).getByText(LESSON_REPLY_ANSWER)).toBeVisible({
        timeout: 60_000,
      });
      await expect(shownCard(page, LESSON_ROUND_ONE_TITLE)).toBeVisible();
      await expect(cardBody(page, LESSON_ROUND_ONE_TITLE).locator("#finish")).toContainText(
        /\b5 of 8\b/,
      );
    });

    await test.step("Next round closes the card at once and the next round comes forward, carrying the result", async () => {
      const { page } = launched;
      await choose(page, "Next round");
      await expect(shownCard(page, LESSON_ROUND_TWO_TITLE)).toBeVisible({ timeout: 60_000 });
      await expectNoCard(page, LESSON_ROUND_ONE_TITLE);
      const sent = teacherRequests().some(
        (body) => /chose \\"Next round\\"/.test(body) && /firstTry\\+":5/.test(body),
      );
      expect(sent).toBe(true);
    });

    await test.step("Stop for today saves committed progress and leaves a welcome-back card", async () => {
      const { page } = launched;
      await choose(page, "Stop for today");
      await expect(shownCard(page, LESSON_WELCOME_TITLE)).toBeVisible({ timeout: 60_000 });
      // The host commits the turn when it ends: the committed file is the saved one.
      await expect
        .poll(() => git(workspace, "show", "HEAD:lessons/chess/progress.md"))
        .toBe(readFileSync(join(workspace, "lessons", "chess", "progress.md"), "utf8").trim());
      await expect.poll(() => git(workspace, "status", "--porcelain")).toBe("");
      const progress = readFileSync(join(workspace, "lessons", "chess", "progress.md"), "utf8");
      expect(progress).toContain("Goal: beat my dad at chess");
      expect(progress).not.toMatch(/\| learned/);
      expect(existsSync(join(workspace, "lessons", "manifest.json"))).toBe(false);
      if (evidence) await regionShot(shownEntry(page), join(evidence, "welcome-back.png"));
    });

    await test.step("the welcome-back card and the task survive a restart with no nudge", async () => {
      const homeDir = launched.homeDir;
      await launched.close();
      launched = await launchApp({ userDataDir, homeDir, withMockProvider: true });
      const { page } = launched;
      await showCard(page, LESSON_WELCOME_TITLE);
      const titles = await page.evaluate(async () =>
        (await window.infinitary.cards.list()).map((card) => card.title).sort(),
      );
      expect(titles).toEqual([LESSON_WELCOME_TITLE, OTHER].sort());
      const chess = tasksOf(userDataDir).find((task) => task.title === "Teach chess");
      expect(chess?.status).toBe("active");
      await page.waitForTimeout(2_000);
      expect(teacherRequests()).toHaveLength(0);
    });

    await test.step("a second subject gets its own task and folder and reads the shared learner file", async () => {
      const { page } = launched;
      await askFirstmate(page, LESSON_FRACTIONS_ASK);
      await expect(shownCard(page, LESSON_FRACTIONS_GOAL_TITLE)).toBeVisible({ timeout: 60_000 });
      const taught = tasksOf(userDataDir).filter((task) => /^Teach /.test(task.title));
      expect(taught.map((task) => task.title)).toEqual(["Teach chess", "Teach fractions"]);
      expect(new Set(taught.map((task) => task.id)).size).toBe(2);
      expect(existsSync(join(workspace, "lessons", "fractions", "progress.md"))).toBe(true);
      expect(existsSync(join(workspace, "lessons", "chess", "progress.md"))).toBe(true);
      // An ordinary card keeps the calm voice: the unmarked goal card was refused first.
      expect(
        (launched.mockProvider?.requestBodies() ?? []).some((body) =>
          body.includes(LESSON_WARM_REFUSAL),
        ),
      ).toBe(true);
      expect(readFileSync(join(workspace, "lessons", "learner.md"), "utf8")).toContain(
        LESSON_LEARNER_LINE,
      );
    });

    await test.step("Start today's lesson reviews, and Stop these lessons closes the task and keeps the records", async () => {
      const { page } = launched;
      await showCard(page, LESSON_WELCOME_TITLE);
      await choose(page, "Start today's lesson");
      await expect(shownCard(page, LESSON_ROUND_REVIEW_TITLE)).toBeVisible({ timeout: 60_000 });
      await choose(page, "Stop for today");
      await expect(shownCard(page, LESSON_WELCOME_TITLE)).toBeVisible({ timeout: 60_000 });
      await choose(page, "Stop these lessons");
      await expect
        .poll(() => tasksOf(userDataDir).find((task) => task.title === "Teach chess")?.status, {
          timeout: 60_000,
        })
        .toBe("done");
      expect(existsSync(join(workspace, "lessons", "chess", "progress.md"))).toBe(true);
      await expect.poll(() => git(workspace, "status", "--porcelain")).toBe("");
    });
  } finally {
    await launched.close();
    if (evidence)
      writeFileSync(join(evidence, "tasks.json"), JSON.stringify(tasksOf(userDataDir), null, 2));
  }
});
