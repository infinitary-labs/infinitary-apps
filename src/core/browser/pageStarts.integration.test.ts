import { readFileSync, realpathSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { answerTarget, probeLoopback } from "./pageAnswers";
import { PAGE_START_FILE_NAME, PAGE_START_LOG, type PageStart, PageStarts } from "./pageStarts";

/**
 * A page's saved start run for real (docs/task-browser.md, "Starting a
 * page again"): the kept file, a real shell starting a real loopback
 * server, the wait for it to answer, a start that fails, and the stop.
 */

// Each case's real work is under a second, except the wait that proves a
// stopped start never answers (3.5 s); a 15 s budget covers a slow runner.
vi.setConfig({ testTimeout: 15_000 });

const started: PageStarts[] = [];

afterEach(() => {
  for (const starts of started.splice(0)) starts.stopAll();
});

function startsIn(folders: string): PageStarts {
  const starts = new PageStarts({ folderOf: (taskId) => join(folders, taskId) });
  started.push(starts);
  return starts;
}

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

/** A command that serves the port after a short build, as a project's server does. */
function serverCommand(port: number): string {
  const script = `setTimeout(() => require("http").createServer((q, s) => s.end("ok")).listen(${port}, "127.0.0.1", () => console.log("listening")), 300)`;
  return `echo building; ${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
}

function startFor(port: number, command: string, withinMs: number, folder: string): PageStart {
  return { command, folder, origin: `http://127.0.0.1:${port}`, withinMs };
}

describe("a page's saved start", () => {
  it("is kept owner-only in its task's folder, the newest replacing the last, and read again after a restart", () => {
    const folders = scratchDir("infinitary-page-starts-");
    const starts = startsIn(folders);
    const first = startFor(5173, "pnpm dev", 30_000, folders);
    starts.keep("t1", first);
    starts.keep("t1", { ...first, command: "pnpm dev --port 5173" });
    const file = join(folders, "t1", PAGE_START_FILE_NAME);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    // A new run reads the start kept with the task.
    const after = startsIn(folders);
    expect(after.kept("t1", "http://127.0.0.1:5173")?.command).toBe("pnpm dev --port 5173");
    expect(after.kept("t1", "http://127.0.0.1:8080")).toBeUndefined();
    after.forget("t1");
    expect(after.kept("t1", "http://127.0.0.1:5173")).toBeUndefined();
  });

  it("starts the server in the saved folder, answers once it listens, and stops it on request", async () => {
    const folders = scratchDir("infinitary-page-starts-");
    const starts = startsIn(folders);
    const port = await freePort();
    const target = answerTarget(`http://127.0.0.1:${port}/`);
    if (!target) throw new Error("no target");
    const outcome = await starts.run(
      "t1",
      startFor(port, `pwd; ${serverCommand(port)}`, 20_000, folders),
      target,
    );
    expect(outcome).toEqual({ kind: "answered", log: join(folders, "t1", PAGE_START_LOG) });
    expect(starts.starting("t1")).toBe(false);
    expect(await probeLoopback("127.0.0.1", port)).toBe("answered");
    const log = readFileSync(join(folders, "t1", PAGE_START_LOG), "utf8");
    expect(log).toContain("building");
    expect(log).toContain("listening");
    expect(log.split("\n")[0]).toBe(realpathSync(folders));
    starts.stop("t1");
    await expect.poll(() => probeLoopback("127.0.0.1", port), { timeout: 5_000 }).toBe("refused");
  });

  it("lives through its crewmate's turn when its browser stops, and stops at the turn's end", async () => {
    const folders = scratchDir("infinitary-page-starts-");
    const starts = startsIn(folders);
    const port = await freePort();
    const target = answerTarget(`http://127.0.0.1:${port}/`);
    if (!target) throw new Error("no target");
    const start = startFor(port, serverCommand(port), 20_000, folders);
    expect((await starts.run("t1", start, target)).kind).toBe("answered");
    // The browser stops while a turn runs: the build is left alone.
    starts.turn("t1", true, true);
    starts.stopWithBrowser("t1");
    expect(await probeLoopback("127.0.0.1", port)).toBe("answered");
    // The browser opened again before the turn ended: the build keeps running.
    starts.turn("t1", false, true);
    expect(await probeLoopback("127.0.0.1", port)).toBe("answered");
    // Stopped again during the next turn, and still stopped at its end: it stops then.
    starts.turn("t1", true, true);
    starts.stopWithBrowser("t1");
    expect(await probeLoopback("127.0.0.1", port)).toBe("answered");
    starts.turn("t1", false, false);
    await expect.poll(() => probeLoopback("127.0.0.1", port), { timeout: 5_000 }).toBe("refused");
  });

  it("stops at once when its browser stops with no turn running, or when its task closes mid-turn", async () => {
    const folders = scratchDir("infinitary-page-starts-");
    const starts = startsIn(folders);
    const port = await freePort();
    const target = answerTarget(`http://127.0.0.1:${port}/`);
    if (!target) throw new Error("no target");
    const start = startFor(port, serverCommand(port), 20_000, folders);
    expect((await starts.run("t1", start, target)).kind).toBe("answered");
    starts.stopWithBrowser("t1");
    await expect.poll(() => probeLoopback("127.0.0.1", port), { timeout: 5_000 }).toBe("refused");
    expect((await starts.run("t1", start, target)).kind).toBe("answered");
    starts.turn("t1", true, true);
    starts.forget("t1");
    await expect.poll(() => probeLoopback("127.0.0.1", port), { timeout: 5_000 }).toBe("refused");
  });

  it("fails with the exit code when the program ends before anything answers", async () => {
    const folders = scratchDir("infinitary-page-starts-");
    const starts = startsIn(folders);
    const port = await freePort();
    const target = answerTarget(`http://127.0.0.1:${port}/`);
    if (!target) throw new Error("no target");
    const outcome = await starts.run(
      "t1",
      startFor(port, "echo cannot build; exit 3", 20_000, folders),
      target,
    );
    expect(outcome).toEqual({
      kind: "failed",
      exit: 3,
      log: join(folders, "t1", PAGE_START_LOG),
    });
    expect(readFileSync(join(folders, "t1", PAGE_START_LOG), "utf8")).toContain("cannot build");
  });

  it("fails at once, saying why, when its folder is gone, and starts again once it is fixed", async () => {
    const folders = scratchDir("infinitary-page-starts-");
    const starts = startsIn(folders);
    const port = await freePort();
    const target = answerTarget(`http://127.0.0.1:${port}/`);
    if (!target) throw new Error("no target");
    const gone = startFor(port, serverCommand(port), 20_000, join(folders, "removed"));
    const outcome = await starts.run("t1", gone, target);
    expect(outcome).toEqual({
      kind: "failed",
      exit: null,
      log: join(folders, "t1", PAGE_START_LOG),
    });
    expect(starts.starting("t1")).toBe(false);
    expect(readFileSync(join(folders, "t1", PAGE_START_LOG), "utf8")).toContain("ENOENT");
    // The crewmate's corrected start runs, rather than the failure coming back.
    const fixed = await starts.run("t1", { ...gone, folder: folders }, target);
    expect(fixed.kind).toBe("answered");
  });

  it("stops the program and fails when its wait runs out", async () => {
    const folders = scratchDir("infinitary-page-starts-");
    const starts = startsIn(folders);
    const port = await freePort();
    const target = answerTarget(`http://127.0.0.1:${port}/`);
    if (!target) throw new Error("no target");
    // It would answer only after the wait the crewmate gave.
    const slow = `sleep 2; ${serverCommand(port)}`;
    const outcome = await starts.run("t1", startFor(port, slow, 500, folders), target);
    expect(outcome).toEqual({
      kind: "failed",
      ranOut: true,
      log: join(folders, "t1", PAGE_START_LOG),
    });
    expect(starts.starting("t1")).toBe(false);
    // Its group was stopped, so the server never comes up.
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(await probeLoopback("127.0.0.1", port)).toBe("refused");
  });
});
