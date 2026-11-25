import { expect, test } from "@playwright/test";
import { captainTurn, renderWake } from "../../src/core/orchestrator/wakes";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import * as m from "../../src/shared/i18n/messages.generated";
import { scratchDir } from "../helpers/scratchDirs";
import type { ScriptedCall } from "../helpers/scriptedCalls";
import { waitForFirstmateIdle } from "./crew";
import { seedRepo } from "./githubStub";
import { answerDecisionsWithJev, type JevStandIn, startJevStandIn } from "./jevStandIn";
import { type LaunchedApp, launchApp } from "./launch";
import { seedProject } from "./projectSeed";
import { projectLine } from "./projects";
import { promptInput } from "./prompt";
import { served } from "./providerRequest";
import { feedLine } from "./rails";
import { focusOn, pressKey, pressWindowKey, typeInto } from "./windowKeys";

/**
 * The approved tags plan's third piece (docs/task-tags.md, "Automatic
 * tagging" and "Checking existing tasks"): a task filed in a project with
 * tags is tagged in the background by the decision model, here a Jev
 * stand-in (`jevStandIn.ts`) answering every tag of the task in one
 * request; the project's Tags box says so and checks the project's older
 * tasks by keys, saying how many requests it makes first and ending with
 * one Activity line; a tag added later is offered a check of its own.
 * Its data is one disposable project with three backlog tasks filed before
 * the app first started, in the launcher's private home.
 */

const BUG = "Something that worked does not: a crash or a wrong result.";
const DOCS = "Written pages: the project's guides and README.";

/** The requests that asked about tags, each one task's every tag. */
const tagRequests = (stand: JevStandIn) =>
  new Set(stand.asked.filter((q) => /^tag\d+$/.test(q.id)).map((q) => q.request)).size;

/** Jev's answer for one tag of one task: tags are asked `tag1` (bug), `tag2` (docs). */
function judge(id: string, state: Record<string, unknown>): string {
  const title = String(state.title);
  if (id === "tag1") return /crash/i.test(title) ? "yes" : "no";
  return /guide/i.test(title) ? "yes" : "no";
}

async function ask(app: LaunchedApp, words: string, calls: ScriptedCall[]): Promise<string[]> {
  if (!app.mockProvider) throw new Error("Asking Firstmate needs the mock provider");
  await waitForFirstmateIdle(app.page);
  const answer = app.mockProvider.scriptFirstmateTurn(
    served({ kind: "user", origin: "captain", body: renderWake(captainTurn(words, false)) }),
    calls,
  );
  const input = promptInput(app.page);
  await pressWindowKey(app.app, "l", ["meta"]);
  await expect(input).toBeFocused();
  await typeInto(input, words);
  await input.press("Enter");
  await expect
    .poll(answer.outcome, { timeout: 30_000 })
    .toMatchObject({ state: "closed", results: calls.map(() => expect.any(String)) });
  return answer.outcome().results;
}

test("a new task is tagged in the background, and Check existing tasks tags older ones by keys", async () => {
  test.setTimeout(240_000);
  const userDataDir = scratchDir("infinitary-task-tag-check-");
  const { repoDir } = seedRepo(userDataDir);
  const db = openDatabase(userDataDir);
  seedProject(db, { id: "repo-harbour", path: repoDir, name: "harbour", key: "HAR", runsOn: null });
  const service = new TaskService({ db, strict: true });
  const projectId = service.projects.forRepo("repo-harbour")?.id as string;
  service.changeProjectTags({ op: "add", projectId, name: "bug", description: BUG });
  service.changeProjectTags({ op: "add", projectId, name: "docs", description: DOCS });
  const older = [
    ["old-crash", "Export crashes on an empty ledger"],
    ["old-guide", "Write the setup guide"],
    ["old-other", "Rename the settings field"],
  ].map(([id, title]) =>
    seedTask(service, {
      id: id as string,
      repoId: "repo-harbour",
      title: title as string,
      goal: `${title}, done.`,
      status: "queued",
      startPolicy: "on-request",
    }),
  );
  db.close();

  let jev: JevStandIn | undefined;
  let launched: LaunchedApp | undefined;
  try {
    jev = await startJevStandIn((id, _options, state) => judge(id, state));
    const stand = jev;
    launched = await launchApp({
      withMockProvider: true,
      userDataDir,
      env: { INFINITARY_JEV_URL: stand.url },
    });
    const run = launched;
    const { app, page } = run;
    await answerDecisionsWithJev(page);
    const tagsOf = async (id: string) =>
      ((await page.evaluate((task) => window.infinitary.tasks.detail(task), id)).tags ?? []).map(
        (tag) => `${tag.name}:${tag.by}`,
      );

    await test.step("a task filed in a project with tags gets the tags it fits, in one request", async () => {
      const [planned] = await ask(run, "File the sign-in crash.", [
        {
          name: "create_task",
          args: {
            title: "The app crashes when signing in",
            goal: "Signing in no longer crashes the app.",
            user_words: "file the sign-in crash",
            repo_id: "repo-harbour",
            start_policy: "on-request",
          },
        },
      ]);
      const [, id] = /\(task_id ([^)]+)\)/.exec(planned ?? "") ?? [];
      if (!id) throw new Error(`No task was filed: ${planned}`);
      await expect.poll(() => tagsOf(id), { timeout: 30_000 }).toEqual(["bug:decision"]);
      const asked = stand.asked.filter((q) => q.state.title === "The app crashes when signing in");
      expect(asked.map((q) => q.id)).toEqual(["tag1", "tag2"]);
      expect(new Set(asked.map((q) => q.request)).size).toBe(1);
      expect(tagRequests(stand)).toBe(1);
      // Tasks filed before the app first started wait for Check existing tasks.
      for (const task of older) expect(await tagsOf(task.id)).toEqual([]);
    });

    const tagsBox = page.locator("[data-project-tags]");
    const check = tagsBox.locator("[data-tag-check]");
    await test.step("the Tags box says new tasks are tagged, and how many requests a check makes", async () => {
      await pressWindowKey(app, ",", ["meta"]);
      const projectsTab = page.locator('[role="tab"][id$="-tab-projects"]');
      await focusOn(projectsTab);
      await pressKey(projectsTab, "Enter");
      await pressKey(projectLine(page, "repo-harbour").getByRole("button"), "Enter");
      await expect(check.locator("[data-tag-auto]")).toHaveText(
        m.settingsProjectsTagsAutoOn({ answerer: "Jev" }),
      );
      await expect(check).toContainText(m.settingsProjectsTagsCheck());
      await expect(check.locator("[data-tag-check-cost]")).toHaveText(
        m.settingsProjectsTagsCheckCost({ count: 3, answerer: "Jev" }),
      );
    });

    await test.step("Start, by keys, checks the older tasks and ends with one Activity line", async () => {
      const reach = check.locator("[data-tag-check-reach]");
      await focusOn(reach);
      await expect(reach).toHaveValue("open");
      await pressKey(reach, "Tab");
      const start = check.locator("[data-tag-check-start]");
      await expect(start).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(check.locator("[data-tag-check-cost]")).toHaveText(
        m.settingsProjectsTagsCheckNone(),
        { timeout: 30_000 },
      );
      expect(await tagsOf("old-crash")).toEqual(["bug:decision"]);
      expect(await tagsOf("old-guide")).toEqual(["docs:decision"]);
      expect(await tagsOf("old-other")).toEqual([]);
      expect(tagRequests(stand)).toBe(4);
      await pressWindowKey(app, "Escape");
      await pressWindowKey(app, "Escape");
      await expect(
        feedLine(page, m.feedTagCheckFinished({ project: "harbour", count: 3 })),
      ).toHaveCount(1);
    });

    await test.step("a tag added later is offered a check of its own, and Not now puts the offer away", async () => {
      await pressWindowKey(app, ",", ["meta"]);
      const projectsTab = page.locator('[role="tab"][id$="-tab-projects"]');
      await focusOn(projectsTab);
      await pressKey(projectsTab, "Enter");
      await pressKey(projectLine(page, "repo-harbour").getByRole("button"), "Enter");
      await pressKey(tagsBox.locator("[data-tag-add]"), "Enter");
      const form = tagsBox.locator("[data-project-tag-form]");
      const name = form.getByLabel(m.settingsProjectsTagsName(), { exact: true });
      await expect(name).toBeFocused();
      await typeInto(name, "ux");
      await pressKey(name, "Tab");
      const description = form.getByLabel(m.settingsProjectsTagsDescription(), { exact: true });
      await typeInto(description, "How a screen looks and reads.");
      await pressKey(description, "Enter");
      await expect(check).toContainText(m.settingsProjectsTagsCheckNamed({ name: "ux" }));
      await expect(check.locator("[data-tag-check-cost]")).toHaveText(
        m.settingsProjectsTagsCheckCost({ count: 4, answerer: "Jev" }),
      );
      const notNow = check.getByRole("button", { name: m.settingsProjectsTagsCheckNotNow() });
      await focusOn(notNow);
      await page.keyboard.press("Enter");
      await expect(check).not.toContainText(m.settingsProjectsTagsCheckNamed({ name: "ux" }));
      await expect(check.locator("[data-tag-check-cost]")).toHaveText(
        m.settingsProjectsTagsCheckCost({ count: 4, answerer: "Jev" }),
      );
      expect(tagRequests(stand)).toBe(4);
    });
  } finally {
    await launched?.close();
    await jev?.close();
  }
});
