import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { openDatabase } from "../../src/core/storage/db";
import { TaskService } from "../../src/core/tasks/taskService";
import { scratchDir } from "../helpers/scratchDirs";
import { waitForFirstmateIdle } from "./crew";
import { launchApp } from "./launch";
import { promptInput } from "./prompt";
import {
  CAP_PROMPT,
  capped,
  FILES,
  FIND_PROMPT,
  PROGRAM_RUN_PROMPT,
  PROGRAM_TITLE,
  programRun,
} from "./scenarios/programRun";

/**
 * A program runs to its result in the launched app (INF-799 piece 2; the
 * captain chose "Keep it held for a journey" on INF-812's missing in-app
 * proof). The first mate files one program in a project; the app runs its
 * script in the program process it bundles, files each task() call as a
 * child task, hands the finder's typed result to the two parts after it,
 * and closes the program done with the script's returned value. The served
 * words are the unit tests' to own.
 */

/** A project with one commit on main, the folder the app adopts. */
function project(): string {
  const dir = join(scratchDir("infinitary-e2e-program-"), "meterlab");
  const git = (args: string[]) => execFileSync("git", args, { cwd: dir });
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", dir]);
  writeFileSync(join(dir, "README.md"), "# meterlab\n");
  git(["add", "-A"]);
  git(["-c", "user.name=E2E", "-c", "user.email=e2e@localhost", "commit", "-qm", "start"]);
  return dir;
}

test("a program files its parts as child tasks, hands each result on, and closes done with its result", async () => {
  const userDataDir = scratchDir("infinitary-program-run-");
  const db = openDatabase(userDataDir);
  // TaskService performs boot recovery in its constructor, so construct it
  // only before launch. Reconstructing it in a poll writes over live turns.
  const tasks = new TaskService({ db });
  const evidence = (name: string) => test.info().outputPath(name);
  // Enforce read-only observation on this connection while the app owns writes.
  db.pragma("query_only = ON");
  const app = await launchApp({ withMockProvider: true, userDataDir, scenarios: [programRun] });
  const { page } = app;
  let programId = "";
  try {
    // Section 1: the captain asks, and the first mate files the program in the captain's project.
    const path = project();
    const { repo } = await page.evaluate(
      (path) => window.infinitary.repos.setup({ kind: "adopt", path, name: "meterlab" }),
      path,
    );
    const input = promptInput(page);
    await input.fill(`${PROGRAM_RUN_PROMPT} in project ${repo.id}`);
    await input.press("Enter");
    await expect
      .poll(
        () => {
          programId = tasks.list().find((task) => task.title === PROGRAM_TITLE)?.id ?? "";
          return programId;
        },
        { timeout: 30_000 },
      )
      .not.toBe("");

    // Section 2: the script's three task() calls run as child tasks, the
    // finder first and both parts after it on its result.
    await expect.poll(() => tasks.get(programId)?.status, { timeout: 90_000 }).toBe("done");
    const parts = tasks.children(programId);
    const finder = parts.find((part) => part.title === FIND_PROMPT);
    expect(finder?.shape).toMatchObject({ internal_step: true, program_part: { call: 0 } });
    expect(finder?.delivery?.result?.value).toEqual({ files: FILES });
    const caps = FILES.map((file) => parts.find((part) => part.title === `${CAP_PROMPT} ${file}.`));
    for (const part of caps) {
      expect(part?.status).toBe("done");
      expect(tasks.blockers(part?.id ?? "").map((row) => row.id)).toEqual([finder?.id]);
    }
    expect(parts.map((part) => part.status)).toEqual(["done", "done", "done"]);
    expect(parts.map((part) => part.shape?.program_part?.call).sort()).toEqual([0, 1, 2]);

    // Section 3: the program closed done with the value its script returned.
    expect(tasks.get(programId)?.delivery?.result?.value).toEqual({
      files: FILES,
      capped: FILES.map(capped),
    });
    await waitForFirstmateIdle(page);
  } finally {
    writeFileSync(
      evidence("program-run-record.json"),
      JSON.stringify(
        {
          program: programId ? tasks.get(programId) : null,
          timeline: programId ? tasks.timeline(programId) : [],
          parts: programId ? tasks.children(programId) : [],
        },
        null,
        2,
      ),
    );
    await app.close();
    db.close();
  }
});
