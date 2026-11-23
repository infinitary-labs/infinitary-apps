import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type TaskBrowserFact, taskBrowserFactSchema } from "@shared/taskBrowser";
import { z } from "zod";

/**
 * The page a task's stopped browser was on, kept with the task
 * (docs/task-browser.md, "After a restart"): one owner-only file in the
 * task's own folder on the computer that runs its browser, beside its
 * registered stops, so a restart still reads the browser as stopped and
 * Open again, or a card's Try it, can start it again. It holds the stopped
 * fact - the address, bare when the captain signed in - and the project
 * folder its page served, if any, and the signed-in sites the task may use,
 * by entry id, so its next browser keeps them after a restart
 * (docs/task-browser.md, "Signed-in sites"). The task's close removes it.
 */

export const KEPT_PAGE_FILE_NAME = "browser.json";

type StoppedFact = Extract<TaskBrowserFact, { state: "stopped" }>;

const stoppedFactSchema = taskBrowserFactSchema.options[1];

const keptPageSchema = z.object({
  fact: stoppedFactSchema,
  /** The project folder its page served, so Open again serves it afresh. */
  served: z
    .object({
      folder: z.string().min(1),
      origin: z.string().min(1),
      captains: z.literal(true).optional(),
    })
    .optional(),
  /** The signed-in sites the task may use: site to entry id. */
  saved: z.record(z.string().min(1), z.string().min(1)).optional(),
});

export type KeptPage = {
  fact: StoppedFact;
  served?: z.infer<typeof keptPageSchema>["served"];
  saved?: Record<string, string>;
};

/** Where each task's stopped page is kept; a task with no folder keeps none. */
export type KeptPages = {
  read: (taskId: string) => KeptPage | undefined;
  write: (taskId: string, page: KeptPage) => void;
  remove: (taskId: string) => void;
};

export function keptPagesIn(folderOf: (taskId: string) => string | undefined): KeptPages {
  const fileOf = (taskId: string): string | undefined => {
    const folder = folderOf(taskId);
    return folder ? join(folder, KEPT_PAGE_FILE_NAME) : undefined;
  };
  return {
    read: (taskId) => {
      const path = fileOf(taskId);
      if (!path) return undefined;
      try {
        const parsed = keptPageSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
        if (!parsed.success) return undefined;
        const { fact, served, saved } = parsed.data;
        return { fact, ...(served ? { served } : {}), ...(saved ? { saved } : {}) };
      } catch {
        // A missing or unreadable file keeps no page.
        return undefined;
      }
    },
    write: (taskId, page) => {
      const folder = folderOf(taskId);
      if (!folder) return;
      try {
        mkdirSync(folder, { recursive: true, mode: 0o700 });
        const path = join(folder, KEPT_PAGE_FILE_NAME);
        const next = `${path}.next`;
        writeFileSync(next, `${JSON.stringify(page)}\n`, { mode: 0o600 });
        chmodSync(next, 0o600);
        renameSync(next, path);
      } catch (error) {
        // A page not kept is read as no browser after a restart, as before.
        console.warn(
          `[task-browser] could not keep a stopped page: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
    remove: (taskId) => {
      const path = fileOf(taskId);
      if (!path) return;
      try {
        rmSync(path, { force: true });
      } catch {
        // A file that cannot be removed is read again only as a stopped page.
      }
    },
  };
}
