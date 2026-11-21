import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "@shared/ipc";
import type { TaskBrowserFact } from "@shared/taskBrowser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { FakePage } from "../../../tests/helpers/taskBrowserStandIn";
import { probeLoopback } from "../browser/pageAnswers";
import type { PageUnanswered } from "../browser/taskBrowsers";
import { PlacedBrowsers } from "../placed/placedBrowsers";
import { ComputerBrowsers } from "./browsers";

/**
 * A page's saved start on a computer that runs work (docs/task-browser.md,
 * "Starting a page again"; INF-5474's plan, piece 2, point 10): the start is
 * kept and run on the computer that holds the task, the view at the home
 * reads that it is starting, and only a start that failed reaches the
 * crewmate's wake at the home, with how it failed. A real ComputerBrowsers
 * answers a real PlacedBrowsers, with stand-in pages and a real program
 * started by a real shell.
 */

// Each step waits for a real shell and server, well under a second each; a
// 20 s budget covers a slow runner.
vi.setConfig({ testTimeout: 20_000 });

const opened: ComputerBrowsers[] = [];

afterEach(() => {
  for (const browsers of opened.splice(0)) browsers.closeAll();
});

/** A loopback port nothing listens on now. */
async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}

/**
 * The project's build: it fails while a `fail` file is in its folder, and
 * otherwise serves its port once a `gate` file is there, so each step
 * follows the test's order, never a clock.
 */
function buildCommand(port: number): string {
  const serve = `require("http").createServer((q, s) => s.end("<title>Build</title>")).listen(${port}, "127.0.0.1")`;
  return `if [ -f fail ]; then echo cannot build; exit 4; fi; while [ ! -f gate ]; do sleep 0.05; done; exec '${process.execPath}' -e '${serve}'`;
}

describe("a page's saved start on a computer that runs work", () => {
  it("runs there, reads as starting at the home, and wakes the crewmate only when it fails", async () => {
    const folders = scratchDir("infinitary-work-starts-");
    const project = join(folders, "project");
    mkdirSync(project);
    const told: { task: string; unanswered: PageUnanswered }[] = [];
    let computer: ComputerBrowsers | undefined;
    const home = new PlacedBrowsers({
      devices: {
        ask: async (_device, channel, args) => computer?.answer(channel, args),
        onWorkDevice: () => () => {},
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
    const dir = scratchDir("infinitary-work-run-");
    computer = await ComputerBrowsers.open({
      host: { open: async (input) => new FakePage(input) },
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
    const port = await freePort();
    const url = `http://127.0.0.1:${port}/settings`;
    const answers = () => probeLoopback("127.0.0.1", port);

    // The crewmate opens its page with --start while nothing answers: it runs there.
    writeFileSync(join(project, "gate"), "");
    const open = await computer.browsers.forTask("t1").navigate({
      url,
      start: { command: buildCommand(port), withinSeconds: 15, cwd: project },
    });
    expect(open.next?.[0]).toContain(`Infinitary ran your --start command in ${project}`);
    expect(await answers()).toBe("answered");
    expect(home.fact("t1")).toMatchObject({ state: "open", url });

    // The captain's Stop browser at the home stops the build on that computer.
    expect(await home.stopByCaptain("t1")).toEqual({ ok: true });
    await expect.poll(answers, { timeout: 5_000 }).toBe("refused");

    // The captain's Try it: the build starts again there, and the home reads it starting.
    rmSync(join(project, "gate"));
    expect(await home.reopen("t1")).toEqual({ ok: true });
    await expect
      .poll(() => home.fact("t1"), { timeout: 5_000 })
      .toMatchObject({ state: "open", unanswered: true, starting: true });
    writeFileSync(join(project, "gate"), "");
    await expect
      .poll(
        () => {
          const fact = home.fact("t1");
          return fact?.state === "open" && !("unanswered" in fact);
        },
        { timeout: 5_000 },
      )
      .toBe(true);
    expect(home.fact("t1")).not.toHaveProperty("starting");
    expect(told).toEqual([]);

    // The build breaks: the next press's start fails, and the crewmate hears how, at the home.
    expect(await home.stopByCaptain("t1")).toEqual({ ok: true });
    await expect.poll(answers, { timeout: 5_000 }).toBe("refused");
    writeFileSync(join(project, "fail"), "");
    expect(await home.reopen("t1")).toEqual({ ok: true });
    await expect.poll(() => told.length, { timeout: 5_000 }).toBe(1);
    expect(told[0]).toEqual({
      task: "t1",
      unanswered: {
        site: `127.0.0.1:${port}`,
        url,
        once: expect.any(String),
        start: {
          command: buildCommand(port),
          exit: 4,
          log: join(folders, "t1", "temp", "page-start.log"),
        },
      },
    });
    expect(home.fact("t1")).toMatchObject({ unanswered: true });
    expect(home.fact("t1")).not.toHaveProperty("starting");
  });
});
