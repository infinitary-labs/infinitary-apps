import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { RELEASE_CHECK_LISTED } from "../../src/core/orchestrator/releaseChecks";
import { openDatabase } from "../../src/core/storage/db";
import { TaskStore } from "../../src/core/storage/taskRecords";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { taskReleaseCheckTitle } from "../../src/shared/i18n/messages.generated";
import { scratchDir } from "../helpers/scratchDirs";
import { seedDelivery } from "../helpers/taskDelivery";
import { type LaunchedApp, launchApp, SHORT_TICK } from "./launch";
import { resizeWindow } from "./layout";
import { regionShot } from "./pictures";
import { seedProject } from "./projectSeed";
import { expandDock } from "./rails";
import { readSavedData } from "./savedData";
import {
  RELEASE_CHECK_FIX,
  RELEASE_CHECK_RELEASE,
  RELEASE_CHECK_WAITING_GOAL,
  releaseCheckCrew,
  releaseCheckWaitingCrew,
} from "./scenarios/releaseCheck";

/**
 * The host's release check (docs/task-record.md, "A release check"; INF-7198's
 * approved plan, Part 2, the captain's pick "A short crewmate check, only while
 * a task waits, reading however the project ships").
 *
 * - Promised result: an issue's waiting task, whose moment is the release,
 *   waits on a fix merged a day ago with no first release; the app files and
 *   starts one release check in that project, whose brief names the fix and
 *   its merge commit; the check's crewmate declares the fix's first release,
 *   the record keeps it, the check closes, and the waiting task then starts
 *   with a brief naming that release. Another project whose merged work no
 *   task waits on gets no check.
 * - Data: projects meterlab and quietlab, each a real folder over its own
 *   bare repository here with a tag; the fix seeded merged a day ago with its
 *   merge commit, and quietlab's merged work, as old, with no waiting task.
 * - Completion signal: the task board, the model's requests and the fix's
 *   saved first release.
 * - Not proven here: whether a real model finds a release the way a project
 *   ships; the crew is scripted. The tag hint and the three-hour and daily
 *   cadence are unit-tested over the host's clock (`releaseChecks.test.ts`).
 * - Shared resources: none; the app, its folder and its repositories are this
 *   test's own.
 */

const git = (...args: string[]) => execFileSync("git", args, { stdio: "pipe" }).toString().trim();
const DAY_AND_HOUR = 25 * 60 * 60 * 1000;

let launched: LaunchedApp | undefined;
test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
});

/**
 * A project folder over its own bare origin, its one commit tagged, as a
 * clone of `origin` reads where the project lives: returns the folder and
 * that commit.
 */
function project(userDataDir: string, name: string, origin: string, subject: string) {
  const bare = join(userDataDir, `github-${name}.git`);
  git("init", "--bare", "--initial-branch=main", bare);
  const folder = join(userDataDir, name);
  git("init", "--initial-branch=main", folder);
  git("-C", folder, "config", "user.name", "Test");
  git("-C", folder, "config", "user.email", "test@localhost");
  git("-C", folder, "commit", "--allow-empty", "-m", subject);
  git("-C", folder, "remote", "add", "origin", origin);
  git("-C", folder, "config", `url.${bare}.insteadOf`, origin);
  git("-C", folder, "push", "origin", "HEAD:refs/heads/main");
  const commit = git("-C", folder, "rev-parse", "HEAD");
  git("-C", folder, "push", "origin", `${commit}:refs/tags/v1.4.0`);
  return { folder, commit };
}

/**
 * A fresh folder holding meterlab, its fix merged a day ago, the waiting
 * task, and quietlab, a real project with merged work no task waits on.
 */
function arrange(): { userDataDir: string; mergeCommit: string } {
  const userDataDir = scratchDir("infinitary-release-check-");
  const origins = {
    meterlab: "https://github.com/octo/meterlab.git",
    quietlab: "https://github.com/octo/quietlab.git",
  };
  const meterlab = project(
    userDataDir,
    "meterlab",
    origins.meterlab,
    "fix: stop the meter idling on a cold start",
  );
  const quietlab = project(
    userDataDir,
    "quietlab",
    origins.quietlab,
    "fix: round the quiet reading",
  );
  const mergeCommit = meterlab.commit;
  const db = openDatabase(userDataDir);
  for (const [name, folder] of [
    ["meterlab", meterlab.folder],
    ["quietlab", quietlab.folder],
  ] as const) {
    seedProject(db, {
      id: `repo-${name}`,
      path: folder,
      name,
      setupKind: "clone",
      origin: origins[name],
      runsOn: null,
      delivery: "direct-pr",
      rigor: "quick",
      addedAt: 1,
    });
  }
  const dayAgo = Date.now() - DAY_AND_HOUR;
  const tasks = new TaskService({ db, now: () => dayAgo });
  const merged = (id: string, title: string, repoId: string, mergedSha: string) => {
    seedTask(tasks, { id, title, repoId, status: "queued", startPolicy: "on-request" });
    seedDelivery(tasks, id, { mergedSha });
    tasks.close(id, { status: "done", reason: "merged", actor: "host" });
  };
  merged(RELEASE_CHECK_FIX.id, RELEASE_CHECK_FIX.title, "repo-meterlab", mergeCommit);
  merged("quietfix1", "Round the quiet reading", "repo-quietlab", quietlab.commit);
  seedTask(tasks, {
    id: "thank1",
    title: "Thank the reporter of the cold start issue",
    prompt: RELEASE_CHECK_WAITING_GOAL,
    repoId: "repo-meterlab",
    status: "queued",
    startPolicy: "when-ready",
    blockedBy: [RELEASE_CHECK_FIX.id],
    shape: {
      kind: "chore",
      deliverable: "answer",
      side_effect: true,
      side_effect_moment: "release",
    },
  });
  db.close();
  return { userDataDir, mergeCommit };
}

/** The first crewmate request carrying these words, as the provider received it. */
function crewRequest(words: string): string {
  return (
    (launched?.mockProvider?.requestBodies() ?? []).find(
      (body) => body.includes("You are a crewmate") && body.includes(words),
    ) ?? ""
  );
}

const briefText = (request: string) => JSON.stringify(JSON.parse(request || "{}"));

async function board(page: Page) {
  return (await page.evaluate(() => window.infinitary.tasks.board())).tasks;
}

test("a release-moment task's merged wait gets a release check, whose declared release starts the task", async () => {
  test.setTimeout(3 * 60_000);
  const { userDataDir, mergeCommit } = arrange();
  launched = await launchApp({
    withMockProvider: true,
    scenarios: [releaseCheckCrew, releaseCheckWaitingCrew],
    userDataDir,
    env: SHORT_TICK,
  });
  const { app, page } = launched;
  const checkTitle = taskReleaseCheckTitle();

  // The host's look files the check within a few short ticks, and it starts.
  let checkId = "";
  await expect
    .poll(
      async () => {
        checkId = (await board(page)).find((row) => row.title === checkTitle)?.id ?? "";
        return checkId;
      },
      { timeout: 60_000 },
    )
    .not.toBe("");
  const fixKey = (await board(page)).find((row) => row.id === RELEASE_CHECK_FIX.id)?.key ?? "";
  await expect
    .poll(() => crewRequest(RELEASE_CHECK_LISTED), {
      timeout: 45_000,
    })
    .not.toBe("");
  const checkBrief = briefText(crewRequest(RELEASE_CHECK_LISTED));
  expect(checkBrief).toContain(`- ${fixKey} \\"${RELEASE_CHECK_FIX.title}\\": merged`);
  expect(checkBrief).toContain(`merge commit ${mergeCommit}`);

  // Its declared release closes it, and the waiting task starts naming that release.
  await expect
    .poll(async () => (await board(page)).find((row) => row.id === checkId)?.status, {
      timeout: 45_000,
    })
    .toBe("done");
  await expect
    .poll(() => crewRequest(RELEASE_CHECK_WAITING_GOAL), { timeout: 45_000 })
    .not.toBe("");
  const waitingBrief = briefText(crewRequest(RELEASE_CHECK_WAITING_GOAL));
  expect(waitingBrief).toContain(
    `merged; first shipped in release ${RELEASE_CHECK_RELEASE.version} (${RELEASE_CHECK_RELEASE.url})`,
  );

  // One check stood, and none for the project whose merged work no task waits on.
  const rows = await board(page);
  expect(rows.filter((row) => row.title === checkTitle).map((row) => row.id)).toEqual([checkId]);

  const evidence = process.env.INFINITARY_TASK_EVIDENCE_DIR;
  if (evidence) {
    await resizeWindow(app, page, { width: 1280, height: 860 });
    await expandDock(page, "now");
    await expect
      .poll(async () => (await board(page)).find((row) => row.id === "thank1")?.status, {
        timeout: 45_000,
      })
      .not.toBe("open");
    await regionShot(page.locator('[data-side-panel="now"]'), join(evidence, "now-list-after.png"));
    writeFileSync(
      join(evidence, "release-check.txt"),
      `Check brief:\n${checkBrief}\n\nWaiting task brief:\n${waitingBrief}\n\nBoard:\n${rows
        .map((row) => `${row.key} ${row.title} ${row.status}`)
        .join("\n")}\n`,
    );
  }
  // What the record kept, read without writing while the app still runs.
  const saved = readSavedData(userDataDir, (db) => {
    const store = new TaskStore(db);
    return {
      release: store.get(RELEASE_CHECK_FIX.id)?.delivery?.firstRelease,
      quietRelease: store.get("quietfix1")?.delivery?.firstRelease,
      quietChecks: store
        .list()
        .filter((row) => row.repoId === "repo-quietlab" && row.shape?.in_place).length,
    };
  });
  expect(saved.release).toMatchObject({
    version: RELEASE_CHECK_RELEASE.version,
    url: RELEASE_CHECK_RELEASE.url,
  });
  expect(saved.quietRelease).toBeUndefined();
  expect(saved.quietChecks).toBe(0);
});
