import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { keptPagesIn } from "../browser/keptPages";
import { ComputerBrowsers } from "./browsers";

const opened: ComputerBrowsers[] = [];

afterEach(() => {
  for (const browsers of opened.splice(0)) browsers.closeAll();
});

/** A computer's browsers as `startConversations` opens them; no page opens and no command runs here. */
async function computerBrowsers(folders: string, heldTasks: () => readonly string[]) {
  const dir = scratchDir("infinitary-computer-browsers-");
  const browsers = await ComputerBrowsers.open({
    host: {
      open: async () => {
        throw new Error("No page opens on this computer here.");
      },
    },
    // Never started: no command reaches this channel here.
    spawner: {
      spawn: () => {
        throw new Error("No command runs on this computer here.");
      },
    },
    binDir: join(dir, "bin"),
    version: "9.9.9-test",
    keysDir: join(dir, "task-channel"),
    evidenceDir: (task) => join(folders, task, "evidence"),
    taskFolder: (task) => join(folders, task),
    heldTasks,
    tell: async () => undefined,
    ask: async () => undefined,
    log: () => undefined,
  });
  opened.push(browsers);
  return browsers;
}

// INF-5474's plan, piece 1: Try it opens a page again after the computer
// that runs its task restarts, so the home must hear that page then.
describe('a work computer after its restart (docs/task-browser.md, "After a restart")', () => {
  it("tells the home the page kept with a task it holds, though no browser spoke since the restart", async () => {
    const folders = scratchDir("infinitary-held-tasks-");
    // What the quit before the restart kept with the task.
    keptPagesIn((task) => join(folders, task)).write("t1", {
      fact: {
        state: "stopped",
        site: "localhost:5173",
        url: "http://localhost:5173/settings",
        stopped: "gone",
        quit: true,
        at: 1,
        session: "run-1",
        generation: 1,
      },
    });
    const browsers = await computerBrowsers(folders, () => ["t1", "t2"]);
    expect(await browsers.answer("inf:task-browser:facts", [])).toEqual({
      facts: [
        {
          task: "t1",
          fact: expect.objectContaining({
            state: "stopped",
            url: "http://localhost:5173/settings",
            quit: true,
          }),
        },
      ],
    });
  });
});
