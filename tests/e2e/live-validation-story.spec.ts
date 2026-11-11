import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { presentationMarkdown } from "../../src/core/forge/presentation";
import { ChangePresentations } from "../../src/core/orchestrator/changePresentations";
import { appPathsFor, crewmateCardPicturesDir } from "../../src/core/paths";
import { stageChangePresentation } from "../../src/core/pi/changePresentation";
import {
  keepValidationEvidence,
  readKeptValidationEvidence,
} from "../../src/core/pi/validationEvidence";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { liveValidationLine } from "../../src/shared/liveValidationSummary";
import { scratchDir } from "../helpers/scratchDirs";
import { seedDelivery } from "../helpers/taskDelivery";
import { cardBody } from "./frames";
import { seedRepo } from "./githubStub";
import { launchApp } from "./launch";
import { resizeWindow } from "./layout";
import { heroShot, regionShot } from "./pictures";
import { expandDock, openGroup, pressRow, recordFrame } from "./rails";
import { MOCK_GITHUB_STORY } from "./scenarios/changeStory";
import { expectNoCard, noteDone, shownCard } from "./stack";
import { pressKey } from "./windowKeys";

/** Accepted live-validation view plan: real saved note readings feed the real evidence keeper,
 * story preparer and completion renderer. The reviewer is a typed stand-in, not an independent
 * judgment of this change. No account, shared service, keychain or running program is borrowed.
 * Completion is the same recorded count on the card, both description formats and task record,
 * with a keyboard-opened transcript containing the actual reopened note reading.
 */
test("a saved story shows its recorded scenarios and opens their kept evidence", async () => {
  const userDataDir = scratchDir("infinitary-validation-story-");
  const { branchHead } = seedRepo(userDataDir);
  const head = branchHead("main");
  const id = "validation-story";
  const title = "feat: keep the check reading visible";
  const note = "The saved reading remains available after reopening the task record.";
  let db = openDatabase(userDataDir);
  let tasks = new TaskService({ db, strict: true });
  seedTask(tasks, { id, title, status: "idle" });
  tasks.note(id, note, { news: false });
  db.close();
  db = openDatabase(userDataDir);
  tasks = new TaskService({ db, strict: true });
  const readings = tasks.timeline(id);
  expect(readings.some((event) => event.text === note)).toBe(true);
  const transcript = join(userDataDir, "saved-readings.json");
  // e2e-fixture: input -- feed actual reopened readings to the real evidence keeper
  writeFileSync(transcript, JSON.stringify(readings, null, 2));
  // e2e-fixture: input -- a real committed app picture exercises the retained image viewer, not the persistence claim
  copyFileSync(
    resolve("release-notes/pictures/action-reply-line-dark.webp"),
    join(userDataDir, "earlier-view.webp"),
  );
  const media = crewmateCardPicturesDir(appPathsFor(userDataDir), id);
  const scenario = {
    id: "reopen-reading",
    source: "Accepted plan: show each scenario with its kept evidence.",
    importance: "required" as const,
    action: "Save a task reading and reopen it",
    expected: "The saved reading is still present.",
    adverse: "An absent reading is not a pass.",
    environment: "Disposable task database",
    signal: "The reopened record contains the saved reading.",
    boundary: "Task storage API",
  };
  tasks.delivery.recordLiveValidation(
    id,
    {
      kind: "plan",
      previousRevision: 0,
      reason: "Exercise retained records for the validation view.",
      scenarios: [scenario],
    },
    { head },
  );
  tasks.delivery.recordLiveValidation(
    id,
    await keepValidationEvidence(
      {
        kind: "run",
        id: "reopened-reading",
        head,
        scenarioRevision: 1,
        completion: "complete",
        verdict: "go",
        reason: "The reopened record contains the actual reading.",
        observations: [
          {
            scenario: scenario.id,
            result: "pass",
            live: true,
            actual: note,
            evidence: ["readings", "picture"],
            standIns: [],
            unproven: [],
            attempted: [],
          },
        ],
        evidence: [
          { id: "readings", path: "saved-readings.json", description: "The reopened task reading" },
          {
            id: "picture",
            path: "earlier-view.webp",
            description: "An earlier app view, not proof of the saved reading",
          },
        ],
      },
      { taskId: id, worktree: userDataDir, dir: media },
    ),
    { head },
  );
  tasks.delivery.recordLiveValidation(
    id,
    {
      kind: "review",
      head,
      revision: 1,
      code: "clear",
      coverage: "complete",
      coverageReason: "The persistence scenario has its reopened reading.",
      effects: [],
      omitted: [],
      verdict: "go",
      reason: "Typed reviewer fixture accepts the persisted reading.",
    },
    {
      head,
      reviewer: "fixture-reviewer",
      assignment: { head, revision: 1, scenarioRevision: 1, effects: [] },
    },
  );
  seedDelivery(tasks, id, { headSha: head, validationHead: head });
  const presentations = new ChangePresentations({
    tasks,
    mediaDir: () => media,
    head: async () => head,
    validationEvidence: (_, evidence) => readKeptValidationEvidence(evidence, media, id),
  });
  const staged = await stageChangePresentation(
    {
      ...MOCK_GITHUB_STORY,
      title,
      base: head,
      head,
      publishable: true,
      validationRows: [{ id: scenario.id, scenario: scenario.action, evidence: note }],
    },
    { taskId: id, worktree: userDataDir, dir: media },
  );
  const revision = await presentations.prepare(id, staged, { kind: "local", project: "sample" });
  const completion = await presentations.completion(id, revision, head);
  const story = tasks.delivery.changePresentation(id)!.revisions.at(-1)!;
  const line = liveValidationLine(story.liveValidation!);
  for (const host of ["github.com", "gitlab.com"]) {
    const description = presentationMarkdown(
      {
        ...story,
        destination: {
          host,
          projectId: 1,
          fullName: "sample/project",
          visibility: "public",
        },
      },
      new Map(),
      "passed",
    );
    expect(description).toContain("| Scenario | Result | Evidence |");
    expect(description).toContain("Passed live");
    expect(description).toContain("1 of 1 scenarios driven live in the product");
    expect(description).not.toContain(transcript);
    const evidence = process.env.INFINITARY_TASK_EVIDENCE_DIR;
    if (evidence) writeFileSync(join(evidence, `${host}-validation.md`), description);
  }
  new CardStore(db).upsert({
    id: "validation-card",
    title,
    body: completion.body,
    pictures: completion.pictures,
    createdAt: Date.now(),
    author: "firstmate",
    meta: "firstmate",
    priority: 50,
    status: "ready",
    taskId: id,
    actions: [],
  });
  tasks.close(id, { status: "done", reason: "merged", actor: "host" });
  db.close();
  const launched = await launchApp({ userDataDir });
  try {
    const { page } = launched;
    await resizeWindow(launched.app, page, { width: 1280, height: 1000 });
    await expect(shownCard(page, title)).toBeVisible();
    const frame = cardBody(page, title);
    const table = frame.locator("[data-live-validation]");
    await expect(table).toContainText(line);
    await expect(table.getByRole("columnheader")).toHaveText(["Scenario", "Result", "Evidence"]);
    const transcriptControl = table.getByText("The reopened task reading", { exact: true });
    await pressKey(transcriptControl, "Enter");
    await expect(table.locator("pre")).toContainText(note);
    expect(
      JSON.parse(readFileSync(transcript, "utf8")).some(
        (event: { text: string }) => event.text === note,
      ),
    ).toBe(true);
    await pressKey(transcriptControl, "Enter");
    const pictureControl = table
      .getByText("An earlier app view, not proof of the saved reading", { exact: true })
      .first();
    await pressKey(pictureControl, "Enter");
    const keptImage = table.locator("img");
    await pressKey(keptImage, "Enter");
    const viewer = page.locator("[data-picture-viewer]");
    await expect(viewer).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(viewer).toBeHidden();
    await pressKey(pictureControl, "Enter");
    const evidence = process.env.INFINITARY_TASK_EVIDENCE_DIR;
    if (evidence) {
      await regionShot(table, join(evidence, "validation-table-after.png"));
      await heroShot(launched.app, page, { region: table, name: "live-validation-table" });
    }
    // A task row first shows an unread outcome card. Read it before opening history.
    await pressKey(noteDone(page), "Enter");
    await expectNoCard(page, title);
    await expandDock(page, "now");
    await openGroup(page, "landed");
    const detail = await page.evaluate((taskId) => window.infinitary.tasks.detail(taskId), id);
    await pressRow(page, detail.key);
    const record = recordFrame(page);
    await pressKey(record.locator('[data-record-section="details"] > summary'), "Enter");
    const validation = record.locator('[data-record-section="validation"]');
    await expect(validation).toContainText(line);
    await expect(validation.getByRole("columnheader")).toHaveText([
      "Scenario",
      "Result",
      "Evidence",
    ]);
    await pressKey(validation.getByText("Open kept evidence", { exact: true }), "Enter");
    await expect(validation.locator("pre")).toContainText(note);
    if (evidence) {
      await pressKey(validation.getByText("Open kept evidence", { exact: true }), "Enter");
      await regionShot(validation, join(evidence, "validation-record-after.png"));
    }
  } finally {
    await launched.close();
  }
});
