import { expect, test } from "@playwright/test";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { scratchDir } from "../helpers/scratchDirs";
import { launchApp } from "./launch";
import { pastePictures, promptInput } from "./prompt";
import { expandDock, nowFrame, nowRow, pressRow, recordCard } from "./rails";
import { cardReply, shownEntry } from "./stack";
import { typeInto } from "./windowKeys";

async function launchStack() {
  const userDataDir = scratchDir("infinitary-focus-recovery-");
  const db = openDatabase(userDataDir);
  const tasks = new TaskService({ db, strict: true });
  const task = seedTask(tasks, {
    id: "harbour",
    title: "harbour",
    status: "queued",
    startPolicy: "on-request",
  });
  const cards = new CardStore(db);
  for (const [index, title] of ["Alpha", "Bravo", "Charlie"].entries()) {
    cards.upsert({
      id: title,
      author: "firstmate",
      priority: 25,
      title,
      meta: "firstmate",
      body: `<p>${title} body.</p>`,
      actions: [],
      status: "ready",
      createdAt: 1000 + index,
    });
  }
  db.close();
  return { app: await launchApp({ userDataDir, withMockProvider: true }), key: task.key };
}

test("Escape from a record does not restore a stale card control", async () => {
  const { app, key } = await launchStack();
  try {
    const { page } = app;
    await cardReply(page).field.click();
    await expandDock(page, "now");
    await nowFrame(page)
      .locator('[data-now-group-header="backlog"]')
      .evaluate((el) => (el as HTMLElement).click());
    await pressRow(page, key);
    await expect(recordCard(page)).toHaveAttribute("data-task-record", "harbour");
    await page.mouse.click(5, 120);
    await page.keyboard.press("Escape");
    await expect(recordCard(page)).toHaveCount(0);
    await expect(promptInput(page)).toBeFocused();
    await typeInto(promptInput(page), "Next task");
    await expect(promptInput(page)).toHaveValue("Next task");
  } finally {
    await app.close();
  }
});

test("a stack arrow that becomes disabled returns focus to the main input", async () => {
  const { app } = await launchStack();
  try {
    const { page } = app;
    const next = page.getByRole("button", { name: "Next card", exact: true });
    await next.click();
    await expect(next).toBeFocused();
    await next.click();
    await expect(next).toBeDisabled();
    await expect(promptInput(page)).toBeFocused();
    const prev = page.getByRole("button", { name: "Previous card", exact: true });
    await prev.click();
    await expect(prev).toBeFocused();
    await prev.click();
    await expect(prev).toBeDisabled();
    await expect(promptInput(page)).toBeFocused();
  } finally {
    await app.close();
  }
});

for (const destination of ["main", "reply"] as const) {
  test(`removing a picture from the ${destination} input returns focus to the main input`, async () => {
    const { app } = await launchStack();
    try {
      const { page } = app;
      const field = destination === "main" ? promptInput(page) : cardReply(page).field;
      await pastePictures(field, [{ name: "chart.png" }]);
      const region = destination === "main" ? page : shownEntry(page);
      const remove = region.getByRole("button", { name: "Remove chart.png", exact: true });
      await remove.click();
      await expect(remove).toHaveCount(0);
      await expect(promptInput(page)).toBeFocused();
    } finally {
      await app.close();
    }
  });
}

test("Back from Settings returns focus to the main input without a previous request", async () => {
  const app = await launchApp({ withMockProvider: true });
  try {
    const { page } = app;
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await expect(promptInput(page)).toBeFocused();
  } finally {
    await app.close();
  }
});

// Exercise the shell fallback itself in Chromium, including ancestor changes.
// The real journeys above verify its destinations through the product controls.
test("the shared fallback handles unavailable controls but leaves a live destination alone", async () => {
  const app = await launchApp({ withMockProvider: true });
  try {
    const { page } = app;
    await expect(promptInput(page)).toBeVisible();
    for (const loss of [
      "remove",
      "disable",
      "fieldset",
      "hidden",
      "inert",
      "visibility",
      "display",
    ] as const) {
      await test.step(loss, async () => {
        await page.evaluate((loss) => {
          const parent = document.createElement("fieldset");
          const control = document.createElement("button");
          control.textContent = "Focus recovery fixture";
          parent.append(control);
          document.body.append(parent);
          control.focus();
          if (loss === "remove") parent.remove();
          else if (loss === "disable") control.disabled = true;
          else if (loss === "fieldset") parent.disabled = true;
          else if (loss === "hidden") parent.hidden = true;
          else if (loss === "inert") parent.inert = true;
          else if (loss === "visibility") parent.style.visibility = "hidden";
          else parent.style.display = "none";
        }, loss);
        await expect(promptInput(page)).toBeFocused();
      });
    }
    await page.evaluate(() => {
      const field = document.createElement("textarea");
      field.id = "live-focus-fixture";
      document.body.append(field);
      field.focus();
      field.readOnly = true;
      const unrelated = document.createElement("button");
      document.body.append(unrelated);
      unrelated.remove();
    });
    await expect(page.locator("#live-focus-fixture")).toBeFocused();
  } finally {
    await app.close();
  }
});
