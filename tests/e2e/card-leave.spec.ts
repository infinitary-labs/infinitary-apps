import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { TaskStore } from "../../src/core/storage/taskStore";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { CARD_LEAVE, type CardLeaveKind } from "../../src/shared/cardLeave";
import { scratchDir } from "../helpers/scratchDirs";
import { cardBody } from "./frames";
import { seedRepo } from "./githubStub";
import { launchApp } from "./launch";
import { expandDock, nowFrame, pressRow, recordCard } from "./rails";
import { readSavedData } from "./savedData";
import { clickInBody, showCard, shownCard, shownEntry } from "./stack";
import { boardCard } from "./taskBoard";
import { pressKey, runFromSearch } from "./windowKeys";

/** INF-1879 approved plan: the corner never answers, refuses consent, or ends a task.
 * Data: realistic launch plan, marked answer, host consent, record and task board in a private home.
 * Signal: saved task status unchanged, drafts and choices live on return; only Done closes answered.
 * Prerequisites/resources: hidden Electron + mock provider, no Mac-only resource, sign-in or real data.
 */
test("each registered corner puts away without ending work; only Done receipts the answer", async () => {
  const home = scratchDir("card-leave-");
  const { repoDir } = seedRepo(home);
  const db = openDatabase(home);
  const tasks = new TaskService({ db, strict: true });
  const store = new CardStore(db);
  const keys: Record<string, string> = {};
  for (const kind of ["decision", "note", "attention"] as const) {
    const worktreeDir = join(home, `work-${kind}`);
    const branch = `fm/task-${kind}`;
    execFileSync("git", ["-C", repoDir, "worktree", "add", "-b", branch, worktreeDir], {
      stdio: "pipe",
    });
    keys[kind] = seedTask(tasks, {
      id: kind,
      title: `Review the launch ${kind}`,
      status: "idle",
      repoDir,
      worktreeDir,
      branch,
      shape: { kind: "plan", kind_source: "classifier:test", deliverable: "answer" },
    }).key;
    store.upsert({
      id: `card-${kind}-launch`,
      taskId: kind,
      author: kind === "attention" ? "host" : "crewmate",
      title: `Launch ${kind}`,
      body:
        kind === "decision"
          ? '<p>Keep the review beside the checklist.</p><fieldset><legend>When should we launch?</legend><label><input type="radio" name="day" value="friday"> Friday</label><label><input type="radio" name="day" value="other" data-inf-write-in>Something else</label></fieldset>'
          : "<p>The review stays beside the launch checklist.</p>",
      meta: "crew",
      status: "ready",
      priority: 10,
      createdAt: Date.now(),
      ...(kind === "note" ? { answering: true } : {}),
      actions:
        kind === "note"
          ? []
          : [
              {
                id: "wait",
                label: "Not now",
                default: true,
                ...(kind === "attention"
                  ? {
                      effect: {
                        kind: "host" as const,
                        op: "decline-project" as const,
                        arg: "launch",
                      },
                    }
                  : {}),
              },
            ],
    });
  }
  keys.question = tasks.fileDecision({
    id: "firstmate-question",
    title: "Choose when to review",
    cardId: "card-fm-launch-question",
  }).key;
  store.upsert({
    id: "card-fm-launch-question",
    author: "firstmate",
    title: "Choose when to review",
    body: "<p>Keep the review beside the launch.</p>",
    meta: "firstmate",
    status: "ready",
    priority: 10,
    createdAt: Date.now(),
    actions: [
      { id: "review", label: "Review now", default: true },
      { id: "later", label: "Not now" },
    ],
  });
  db.close();
  const app = await launchApp({ userDataDir: home, withMockProvider: true });
  const { page } = app;
  const status = (id: string) => readSavedData(home, (db) => new TaskStore(db).get(id)?.status);
  const leave = () => shownEntry(page).locator("[data-card-leave]");
  try {
    const rows = {
      decision: async () => {
        await showCard(page, "Launch decision");
        const picked = cardBody(page, "Launch decision").getByRole("radio", {
          name: "Friday",
          exact: true,
        });
        await clickInBody(picked);
        await pressKey(leave(), "Enter");
        await expect(shownCard(page, "Launch decision")).toBeHidden();
        await expandDock(page, "now");
        await pressRow(page, keys.decision!);
        await expect(picked).toBeChecked();
        await expect(
          shownEntry(page).getByRole("button", { name: "Not now", exact: false }),
        ).toBeEnabled();
        await showCard(page, "Choose when to review");
        await pressKey(leave(), "Enter");
        expect(status("firstmate-question")).toBe("open");
        await pressRow(page, keys.question!);
        await expect(shownCard(page, "Choose when to review")).toBeVisible();
        await shownEntry(page).locator("[data-task-key]").first().click();
        await expect(recordCard(page)).toBeVisible();
        await expect(
          shownEntry(page).getByRole("button", { name: "Show the card", exact: true }),
        ).toBeVisible();
        await pressKey(
          shownEntry(page).getByRole("button", { name: "Dismiss", exact: true }),
          "Enter",
        );
        await expect.poll(() => status("firstmate-question")).toBe("dropped");
        // The saved receipt precedes the record's update. Wait for its dismissed
        // question bar to leave before focusing the next control (INF-1879).
        await expect(shownEntry(page).locator('[data-record-end="dismiss-question"]')).toHaveCount(
          0,
        );
        await pressKey(leave(), "Enter");
      },
      note: async () => {
        await showCard(page, "Launch note");
        await expect(
          shownEntry(page).getByRole("button", { name: "Done", exact: true }),
        ).toBeVisible();
        await pressKey(leave(), "Enter");
        await expect(shownCard(page, "Launch note")).toBeHidden();
        await expandDock(page, "now");
        await expect(nowFrame(page).locator(`[data-now-key="${keys.note}"]`)).toBeVisible();
        await pressRow(page, keys.note!);
        await expect(recordCard(page)).toBeVisible();
        await expect(
          shownEntry(page).getByRole("button", { name: "Done", exact: true }),
        ).toBeVisible();
        await pressKey(leave(), "Enter");
      },
      attention: async () => {
        await showCard(page, "Launch attention");
        await pressKey(leave(), "Enter");
        await expect(shownCard(page, "Launch attention")).toBeHidden();
        const card = (await page.evaluate(() => window.infinitary.cards.list())).find(
          (c) => c.id === "card-attention-launch",
        );
        expect(card).toMatchObject({ minimized: true, status: "ready" });
      },
      record: async () => {
        await showCard(page, "Launch decision");
        await shownEntry(page).locator("[data-task-key]").first().click();
        await expect(recordCard(page)).toBeVisible();
        await pressKey(leave(), "Enter");
        await expect(shownCard(page, "Launch decision")).toBeVisible();
      },
      "window-panel": async () => {
        await runFromSearch(app.app, page, "panel:now/board");
        await expect(boardCard(page)).toBeVisible();
        await pressKey(leave(), "Enter");
        await expect(boardCard(page)).toBeHidden();
      },
    } satisfies Record<CardLeaveKind, () => Promise<void>>;
    for (const kind of Object.keys(CARD_LEAVE) as CardLeaveKind[]) {
      await test.step(kind, rows[kind]);
      for (const id of ["decision", "note", "attention"]) expect(status(id)).toBe("active");
    }
    await test.step("Done is an explicit host receipt, even after the answer was put away", async () => {
      await expandDock(page, "now");
      await pressRow(page, keys.note!);
      await runFromSearch(app.app, page, "cards.done");
      await expect.poll(() => status("note")).toBe("done");
      expect(readSavedData(home, (db) => new TaskStore(db).get("note")?.closedReason)).toBe(
        "answered",
      );
    });
  } finally {
    await app.close();
  }
});
