import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import type { TaskDetail } from "../../src/shared/tasks";
import { scratchDir } from "../helpers/scratchDirs";
import { expandDock, expectRecordBody, openGroup, pressRow, recordFrame } from "./rails";

export const POINTER_TASK = "record-pointer";

/** A real stored report, read through the app before the pointer check. */
export function pointerRecordHome(): string {
  const userDataDir = scratchDir("infinitary-record-pointer-");
  const db = openDatabase(userDataDir);
  try {
    const tasks = new TaskService({ db, strict: true });
    seedTask(tasks, { id: POINTER_TASK, title: "Fix task search", status: "idle" });
    tasks.recordReport(POINTER_TASK, {
      summary: "Task search finds the matching task.",
      text: "Task search finds the matching task.\n\nChecked searching by title and task key. Both open the right task.",
    });
    tasks.close(POINTER_TASK, { status: "done", reason: "merged", actor: "host" });
    tasks.markWorkspaceRemoved(POINTER_TASK);
    return userDataDir;
  } finally {
    db.close();
  }
}

type PointerWindow = typeof window & {
  pushRecord: (value: TaskDetail) => void;
  pushRecordBoard: () => void;
};

/**
 * Native mouse events into sandboxed frames are dropped by hidden Electron
 * windows. Exercise Chromium's real pointer dispatch on the real record
 * document in the isolated top-level window instead (as renderer tests do),
 * retaining its production styles and data. Only the read bridge stands in;
 * no synthetic click, manual toggle, or product hook substitutes for a press.
 */
export async function mountPointerRecord(page: Page): Promise<TaskDetail> {
  const detail = await page.evaluate((id) => window.infinitary.tasks.detail(id), POINTER_TASK);
  await expandDock(page, "now");
  await openGroup(page, "landed");
  await pressRow(page, detail.key);
  await expectRecordBody(page);
  const html = await recordFrame(page)
    .locator("html")
    .evaluate((node) => node.outerHTML);
  await page.goto("about:blank");
  await page.setContent(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, ""));
  await page.evaluate(() => {
    const subscriptions: Record<string, (value: unknown) => void> = {};
    Object.assign(window, {
      pushRecord: (value: unknown) => subscriptions["tasks.detail"]?.(value),
      pushRecordBoard: () => subscriptions["tasks.board"]?.({ tasks: [] }),
      inf: {
        state: { openSections: ["timeline"] },
        onState: () => () => {},
        action: async () => {},
        subscribe: (name: string, _args: unknown, callback: (value: unknown) => void) => {
          subscriptions[name] = callback;
          return { unsubscribe: async () => {} };
        },
      },
    });
  });
  await page.addScriptTag({
    content: readFileSync("src/renderer/src/plugins/builtin/record/record.frame.js", "utf8"),
  });
  await pushPointerRecord(page, detail);
  return detail;
}

export async function pushPointerRecord(page: Page, detail: TaskDetail): Promise<void> {
  await page.evaluate((value) => (window as PointerWindow).pushRecord(value), detail);
}

export async function pushPointerBoard(page: Page): Promise<void> {
  await page.evaluate(() => (window as PointerWindow).pushRecordBoard());
}
