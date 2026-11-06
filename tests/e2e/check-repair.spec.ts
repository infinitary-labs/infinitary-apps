import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { FIRSTMATE_PERSONA } from "../../src/core/pi/piResources";
import { openDatabase } from "../../src/core/storage/db";
import { DecisionStore } from "../../src/core/storage/decisionStore";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { currentCheckSummary } from "../../src/shared/checkSnapshot";
import { scratchDir } from "../helpers/scratchDirs";
import { cardBody } from "./frames";
import { seedGitHubSignIn, seedRepo, startGitHubStub } from "./githubStub";
import { launchApp } from "./launch";
import { SPAWN_PROMPT_MARKER } from "./mockProvider";
import { seedHostedOrigins, seedProject } from "./projectSeed";
import { promptInput } from "./prompt";
import { expandDock } from "./rails";
import {
  CI_REPAIR_CARD,
  CI_REPAIR_HEADS,
  CI_REPAIR_MARKER,
  CI_REPAIR_OWNER,
  checkRepair,
} from "./scenarios/checkRepair";
import { completionAction, factsStrip } from "./stack";

/** The message texts each request to the Firstmate carried, decoded from the provider bodies. */
function firstmateTexts(bodies: string[]): string[] {
  return bodies
    .filter((body) => body.includes(FIRSTMATE_PERSONA))
    .flatMap((body) =>
      (JSON.parse(body) as { messages: { content: unknown }[] }).messages.flatMap(({ content }) =>
        typeof content === "string"
          ? [content]
          : Array.isArray(content)
            ? content.map((part: { text?: unknown }) => String(part.text ?? ""))
            : [],
      ),
    );
}

/** Real app/forge/tool/card journey; only the model and check server are scripted. */
test("two baseline failures and one flake request diagnosis without a captain card, even after restart", async () => {
  const userDataDir = scratchDir("infinitary-check-repair-");
  const repo = seedRepo(userDataDir);
  const github = await startGitHubStub();
  // The checks are read at named heads the script moves through; nothing
  // here is put in, so no head has to be a commit.
  github.servePull({ number: 57, title: "fix: repair the checks", headSha: CI_REPAIR_HEADS[0] });
  github.setChecks([{ name: "linux-checks", status: "completed", conclusion: "failure" }]);
  seedGitHubSignIn(userDataDir);
  const db = openDatabase(userDataDir);
  const tasks = new TaskService({ db });
  seedProject(db, {
    id: "repo-meterlab",
    path: repo.repoDir,
    name: "meterlab",
    setupKind: "clone",
    origin: "https://github.com/o/meterlab.git",
    runsOn: null,
    delivery: "direct-pr",
    rigor: "standard",
  });
  seedHostedOrigins(db, userDataDir);
  seedTask(tasks, {
    id: CI_REPAIR_OWNER,
    title: "Fix the separately owned baseline",
    prompt: "Confirmed reproduction on untouched main, log attached",
    repoId: "repo-meterlab",
    status: "queued",
    startPolicy: "on-request",
  });
  let app = await launchApp({
    withMockProvider: true,
    scenarios: [checkRepair],
    userDataDir,
    env: github.env,
  });
  const title = `meterlab ${CI_REPAIR_MARKER}`;
  let taskId = "";
  const ledger = () => tasks.get(taskId)?.delivery;
  const send = async (words: string) => {
    const input = promptInput(app.page);
    await input.fill(words);
    await input.press("Enter");
  };
  try {
    await send(`${SPAWN_PROMPT_MARKER} ${title}`);
    await expect
      .poll(
        async () => {
          const board = await app.page.evaluate(() => window.infinitary.tasks.board());
          taskId = board.tasks.find((t) => t.title === title)?.id ?? "";
          return taskId;
        },
        { timeout: 30000 },
      )
      .not.toBe("");
    for (let i = 0; i < CI_REPAIR_HEADS.length; i++) {
      if (i) {
        github.setHead(CI_REPAIR_HEADS[i] ?? "missing");
        await send(`${CI_REPAIR_MARKER} read`);
      }
      await expect.poll(() => ledger()?.ciRepair?.diagnoses.length, { timeout: 30000 }).toBe(i + 1);
      if (i === 0) {
        // FI3-671: nobody has started the owner the wait names, so the
        // report wakes the Firstmate with that owner named, and it starts it.
        const owner = tasks.get(CI_REPAIR_OWNER);
        await expect
          .poll(
            () =>
              new DecisionStore(db)
                .recent(100)
                .find((row) => row.taskId === taskId && row.model === "rule:waits-unstarted")
                ?.facts,
            { timeout: 30000 },
          )
          .toMatchObject({ kind: "report", waits: [{ key: owner?.key, state: "not-started" }] });
        await expect
          .poll(() => tasks.get(CI_REPAIR_OWNER)?.status, { timeout: 30000 })
          .toBe("active");
      }
      if (i === 2)
        await expect
          .poll(() => ledger()?.ciRepair?.rerun?.headSha, { timeout: 30000 })
          .toBe(CI_REPAIR_HEADS[2]);
      expect(ledger()?.ciRounds ?? 0).toBe(0);
      expect(ledger()?.ciCapAt).toBeUndefined();
      expect(await app.page.evaluate(() => window.infinitary.cards.list())).toEqual([]);
      if (i === 1) {
        // FI3-250: the owner is underway now, so the wait's report wakes
        // nobody - the crewmate resumes when that work closes.
        await expect
          .poll(
            () =>
              new DecisionStore(db)
                .recent(100)
                .some((row) => row.taskId === taskId && row.model === "rule:still-moving"),
            { timeout: 30000 },
          )
          .toBe(true);
        // A real process restart preserves the two diagnoses, not a fresh allowance.
        await app.close();
        app = await launchApp({
          withMockProvider: true,
          scenarios: [checkRepair],
          userDataDir,
          env: github.env,
        });
        expect(ledger()?.ciRepair?.diagnoses).toHaveLength(2);
      }
    }
    await expect
      .poll(
        () =>
          tasks
            .timeline(taskId)
            .some((e) => e.kind === "report" && e.text.includes("completion correctly refused")),
        { timeout: 30000 },
      )
      .toBe(true);
    expect(await app.page.evaluate(() => window.infinitary.cards.list())).toEqual([]);
    // FI3-401: the refused completion card is a fact on the record, and the
    // report wake the Firstmate is served carries it - the card and the
    // moment the record holds - beside the report's own words. The wake's
    // wording is the unit test's to own.
    const refusal = ledger()?.cardRefusal;
    // Captain INF-1555 F12 removes the separate check-readiness prerequisite;
    // FI3-401 now observes a malformed completion story's real shape refusal.
    expect(refusal).toMatchObject({ title: CI_REPAIR_CARD, reason: "shape" });
    const refusedAt = new Date(refusal?.at ?? 0).toISOString();
    await expect
      .poll(
        () =>
          firstmateTexts(app.mockProvider?.requestBodies() ?? []).some(
            (text) =>
              text.includes(`reported on task ${taskId}`) &&
              text.includes("completion correctly refused") &&
              text.includes(CI_REPAIR_CARD) &&
              text.includes(refusedAt),
          ),
        { timeout: 30000 },
      )
      .toBe(true);
    await expandDock(app.page, "activity");
    await app.page.screenshot({ path: test.info().outputPath("check-repair-no-interruption.png") });
    writeFileSync(
      test.info().outputPath("check-repair-evidence.json"),
      JSON.stringify(
        {
          delivery: ledger(),
          timeline: tasks.timeline(taskId),
          cards: await app.page.evaluate(() => window.infinitary.cards.list()),
        },
        null,
        2,
      ),
    );
    // The reservation itself is not green; a successful result publishes completion.
    github.setChecks([
      { name: "linux-checks", status: "completed", conclusion: "success" },
      { name: "deploy-preview", status: "completed", conclusion: "skipped" },
    ]);
    await send(`${CI_REPAIR_MARKER} finish`);
    await expect
      .poll(
        async () =>
          (await app.page.evaluate(() => window.infinitary.cards.list())).map((c) => c.title),
        { timeout: 30000 },
      )
      .toEqual([CI_REPAIR_CARD]);
    await expect(await completionAction(app.page, CI_REPAIR_CARD)).toBeVisible();
    // The crewmate declared the merge alone, without a label, as it is told;
    // the host attached its own pair in its place (FI3-249), and, at Default
    // care, Review carefully with no effect of its own (INF-562).
    const completion = (await app.page.evaluate(() => window.infinitary.cards.list())).find(
      (card) => card.title === CI_REPAIR_CARD,
    );
    expect(new Map(completion?.actions.map((action) => [action.id, action.effect]))).toEqual(
      new Map([
        ["merge", { kind: "settle", mode: "merge" }],
        ["discard", { kind: "settle", mode: "discard" }],
        ["review-carefully", undefined],
      ]),
    );
    const frame = cardBody(app.page, CI_REPAIR_CARD);
    await expect(factsStrip(frame).checks).toHaveText(
      currentCheckSummary(ledger() ?? {})?.words ?? "missing check reading",
    );
    await app.page.screenshot({ path: test.info().outputPath("check-repair-completion.png") });
    expect(await factsStrip(frame).facts()).not.toContain("crew-verdict");
    expect(ledger()?.ci).toBe("green");
    // The completion card went up, so the refusal no longer stands.
    expect(ledger()?.cardRefusal).toBeUndefined();
    // This is a served-instruction replay, not proof of a live model's judgment.
    const bodies = app.mockProvider?.requestBodies() ?? [];
    expect(bodies.some((b) => b.includes("No captain card for these moves"))).toBe(true);
  } finally {
    writeFileSync(
      test.info().outputPath("check-repair-requests.json"),
      JSON.stringify(app.mockProvider?.requestBodies() ?? [], null, 2),
    );
    await app.close();
    await github.close();
    db.close();
  }
});
