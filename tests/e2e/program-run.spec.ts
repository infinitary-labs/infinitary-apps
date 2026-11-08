import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { openDatabase } from "../../src/core/storage/db";
import { DecisionStore } from "../../src/core/storage/decisionStore";
import { TaskService } from "../../src/core/tasks/taskService";
import { scratchDir } from "../helpers/scratchDirs";
import { waitForFirstmateIdle } from "./crew";
import { launchApp } from "./launch";
import { promptInput } from "./prompt";
import {
  CAP_INTELLIGENCE,
  CAP_PROMPT,
  CREW_REPORT,
  CREW_TITLE,
  capped,
  FILES,
  FIND_INTELLIGENCE,
  FIND_PROMPT,
  PROGRAM_RUN_PROMPT,
  PROGRAM_TITLE,
  programRun,
} from "./scenarios/programRun";

/**
 * A program runs to its result in the launched app (INF-799 piece 2; the
 * captain chose "Keep it held for a journey" on INF-812's missing in-app
 * proof; INF-3022, only a crewmate starts one). The first mate spawns one
 * crewmate in a project, nudged to use start_program; that crewmate starts
 * the program, found on its task, which waits on it; the app runs its
 * script in the program process it bundles, files each task() call as a
 * child task, hands the finder's typed result to the two parts after it,
 * closes the program done with the script's returned value, and steers the
 * crewmate, which reports. The served words are the unit tests' to own.
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

test("a crewmate's program files its parts as child tasks, hands each result on, closes done with its result and steers the crewmate", async () => {
  const userDataDir = scratchDir("infinitary-program-run-");
  const db = openDatabase(userDataDir);
  // TaskService performs boot recovery in its constructor, so construct it
  // only before launch. Reconstructing it in a poll writes over live turns.
  const tasks = new TaskService({ db });
  const decisions = new DecisionStore(db);
  const evidence = (name: string) => test.info().outputPath(name);
  // Enforce read-only observation on this connection while the app owns writes.
  db.pragma("query_only = ON");
  const app = await launchApp({ withMockProvider: true, userDataDir, scenarios: [programRun] });
  const { page } = app;
  let programId = "";
  let crewId = "";
  try {
    // Section 1: the captain asks, the first mate spawns a crewmate, and it starts the program in the captain's project.
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
    crewId = tasks.list().find((task) => task.title === CREW_TITLE)?.id ?? "";
    expect(tasks.crewFilingOrigin(programId)?.id).toBe(crewId);
    expect(tasks.get(programId)?.parentId).toBeNull();
    expect(tasks.graph.blockers(crewId).map((row) => row.id)).toEqual([programId]);

    // Section 2: the script's three task() calls run as child tasks, the
    // finder first and both parts after it on its result.
    await expect.poll(() => tasks.get(programId)?.status, { timeout: 90_000 }).toBe("done");
    const parts = tasks.graph.children(programId);
    const finder = parts.find((part) => part.title === FIND_PROMPT);
    expect(finder?.shape).toMatchObject({ internal_step: true, program_part: { call: 0 } });
    // INF-974: the running app persists the script's choice and routes with it.
    expect(finder?.shape?.program_part?.intelligence).toBe(FIND_INTELLIGENCE);
    expect(decisions.routing({ taskIds: [finder?.id ?? ""] }).at(-1)).toMatchObject({
      rule: "R11",
      bucket: FIND_INTELLIGENCE,
    });
    expect(tasks.latestResult(finder?.id ?? "")?.value).toEqual({ files: FILES });
    const caps = FILES.map((file) => parts.find((part) => part.title === `${CAP_PROMPT} ${file}.`));
    for (const part of caps) {
      expect(part?.status).toBe("done");
      expect(part?.shape?.program_part?.intelligence).toBe(CAP_INTELLIGENCE);
      expect(decisions.routing({ taskIds: [part?.id ?? ""] }).at(-1)).toMatchObject({
        rule: "R11",
        bucket: CAP_INTELLIGENCE,
      });
      expect(tasks.graph.blockers(part?.id ?? "").map((row) => row.id)).toEqual([finder?.id]);
    }
    expect(parts.map((part) => part.status)).toEqual(["done", "done", "done"]);
    expect(parts.map((part) => part.shape?.program_part?.call).sort()).toEqual([0, 1, 2]);

    // Section 3: the program closed done with the value its script returned.
    expect(tasks.latestResult(programId)?.value).toEqual({
      files: FILES,
      capped: FILES.map(capped),
    });
    // Keep the observed result in successful CI logs too; journey files are uploaded only on failure.
    console.info(
      "Program intelligence record",
      JSON.stringify({
        status: tasks.get(programId)?.status,
        result: tasks.latestResult(programId)?.value,
        parts: parts.map((part) => ({
          label: part.shape?.program_part?.label,
          intelligence: part.shape?.program_part?.intelligence,
          status: part.status,
          routing: decisions
            .routing({ taskIds: [part.id] })
            .map(({ rule, bucket, served }) => ({ rule, bucket, served })),
        })),
      }),
    );
    // Section 4: the program's end steers the crewmate that started it, which reports.
    await expect
      .poll(() => tasks.reportEntries(crewId).map((entry) => entry.text), { timeout: 30_000 })
      .toContain(CREW_REPORT);
    // INF-1137 friction 8: live part updates occupy one program row,
    // while the parts and their full timelines still exist above.
    const feed = await page.evaluate(() => window.infinitary.feed.recent());
    const programKey = tasks.get(programId)?.key;
    const partKeys = new Set(parts.map((part) => part.key));
    expect(feed.filter((line) => line.taskKey === programKey)).toHaveLength(1);
    expect(feed.some((line) => line.taskKey && partKeys.has(line.taskKey))).toBe(false);
    expect(feed.find((line) => line.taskKey === programKey)?.text).toContain(
      `${parts.length}/${parts.length} parts done`,
    );
    await waitForFirstmateIdle(page);
  } finally {
    writeFileSync(
      evidence("program-run-record.json"),
      JSON.stringify(
        {
          crewmate: crewId ? tasks.get(crewId) : null,
          crewmateTimeline: crewId ? tasks.timeline(crewId) : [],
          program: programId ? tasks.get(programId) : null,
          timeline: programId ? tasks.timeline(programId) : [],
          parts: programId ? tasks.graph.children(programId) : [],
          routing: programId
            ? decisions.routing({ taskIds: tasks.graph.children(programId).map((part) => part.id) })
            : [],
        },
        null,
        2,
      ),
    );
    await app.close();
    db.close();
  }
});
