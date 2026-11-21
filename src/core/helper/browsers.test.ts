import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "@shared/ipc";
import type { TaskBrowserFact } from "@shared/taskBrowser";
import { afterEach, describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { FakePage, flush } from "../../../tests/helpers/taskBrowserStandIn";
import { keptPagesIn } from "../browser/keptPages";
import type { PageUnanswered } from "../browser/taskBrowsers";
import { PlacedBrowsers } from "../placed/placedBrowsers";
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

// INF-5474's plan, piece 1, point 8: the kept page, the check and the wake
// live on the computer that runs the task, and reach the home. Here a real
// ComputerBrowsers answers a real PlacedBrowsers, with stand-in pages there.
describe('a work computer\'s kept page and outage, heard at the home (docs/task-browser.md, "On another computer")', () => {
  it("reopens the page after that computer restarts, and tells the home of the outage under one name", async () => {
    const folders = scratchDir("infinitary-work-computer-");
    const pages: FakePage[] = [];
    const told: { task: string; unanswered: PageUnanswered }[] = [];
    let computer: ComputerBrowsers | undefined;
    let inReach: ((contact: { contact: "in-reach"; deviceId: string }) => void) | undefined;
    const home = new PlacedBrowsers({
      devices: {
        ask: async (_device, channel, args) => computer?.answer(channel, args),
        onWorkDevice: (listener) => {
          inReach = listener as typeof inReach;
          return () => {};
        },
        version: () => ({
          contract: PROTOCOL_VERSION,
          takesWork: true,
          changes: ["page-unanswered"],
        }),
      },
      deviceOf: () => "work",
      nameOf: () => "Work computer",
      note: () => {},
      onChange: () => {},
      onReturned: () => {},
      onUnanswered: (task, unanswered) => told.push({ task, unanswered }),
      log: () => {},
    });
    const start = async () => {
      const dir = scratchDir("infinitary-work-run-");
      computer = await ComputerBrowsers.open({
        host: {
          open: async (input) => {
            const page = new FakePage(input);
            pages.push(page);
            return page;
          },
        },
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
        heldTasks: () => ["t1"],
        // What reaches the home: each fact as it changes, and each event once.
        tell: async (channel, args) => {
          if (channel !== "inf:work:browser") return;
          const [{ task, fact }] = args as [{ task: string; fact: TaskBrowserFact | null }];
          home.heardFact("work", task, fact);
        },
        ask: async (channel, args) => {
          if (channel !== "inf:work:browser-event") return;
          const [{ task, event }] = args as [
            { task: string; event: Parameters<PlacedBrowsers["heardEvent"]>[2] },
          ];
          home.heardEvent("work", task, event);
        },
        homeChanges: () => ["page-unanswered"],
        log: () => {},
      });
      opened.push(computer);
      return computer;
    };
    // The task's build answers on this computer while its crewmate opens the page.
    const site = createServer((_request, response) => response.end("<title>Build</title>"));
    await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(site.address() as AddressInfo).port}/settings`;
    const first = await start();
    await first.browsers.forTask("t1").navigate({ url });
    // That computer quits for an update, and the build goes with it.
    first.closeAll();
    await new Promise<void>((resolve) => site.close(() => resolve()));
    await start();
    inReach?.({ contact: "in-reach", deviceId: "work" });
    await flush();
    expect(home.fact("t1")).toMatchObject({ state: "stopped", url, quit: true });
    // The captain's Try it: the reopen order reaches that computer and opens the page there.
    expect(await home.reopen("t1")).toEqual({ ok: true });
    expect(pages.at(-1)?.effects).toContain(`load ${url}`);
    for (let i = 0; i < 20 && told.length === 0; i += 1) await flush();
    expect(told).toEqual([
      { task: "t1", unanswered: expect.objectContaining({ url, once: expect.any(String) }) },
    ]);
    expect(home.fact("t1")).toMatchObject({ state: "open", unanswered: true });
    // The captain looks again while it is still down: the same outage, the same name.
    const unwatch = home.watch("t1", () => undefined);
    for (let i = 0; i < 20 && told.length < 2; i += 1) await flush();
    unwatch();
    // A second check ran and reached the home, still under the outage's one name.
    expect(told).toHaveLength(2);
    expect(new Set(told.map((entry) => entry.unanswered.once)).size).toBe(1);
  });
});
