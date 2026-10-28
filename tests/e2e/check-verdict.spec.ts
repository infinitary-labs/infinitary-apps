import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  CHECK_VERDICT_MISSING,
  CHECK_VERDICT_WORDS,
} from "../../src/core/orchestrator/checkVerdicts";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { type Card, SETTLE_FACTS_OPEN } from "../../src/shared/cards";
import { scratchDir } from "../helpers/scratchDirs";
import { seedDelivery } from "../helpers/taskDelivery";
import { cardBody } from "./frames";
import { launchApp } from "./launch";
import { resizeWindow } from "./layout";
import { regionShot } from "./pictures";
import { factsStrip, showCard } from "./stack";
import { pressKey } from "./windowKeys";

/** Nightly session audit finding 3: a failed merge check must carry the
 * crewmate's verdict and evidence, not make the captain ask if it is related.
 * Real saved check_change ledger, isolated Electron, no sign-ins or shared writes.
 * Completion: verdicts visible, evidence opens by keys, live refresh keeps it,
 * and unrelated versions and non-failing readings never show old judgments.
 */
// biome-ignore lint/correctness/noEmptyPattern: Playwright requires the fixture argument before testInfo.
test("failed merge checks carry head-bound verdicts with keyboard-readable evidence", async ({}, testInfo) => {
  const home = scratchDir("infinitary-check-verdict-picture-");
  const db = openDatabase(home);
  const tasks = new TaskService({ db });
  const worktreeDir = join(home, "worktree");
  mkdirSync(worktreeDir);
  seedTask(tasks, {
    id: "check-verdict",
    title: "Fix the meter",
    status: "completed",
    worktreeDir,
  });
  const headSha = "a".repeat(40);
  const diagnoses = Object.keys(CHECK_VERDICT_WORDS).map((classification, index) => ({
    headSha,
    check: ["unit-tests", "integration-tests (1)", "probe-tests", "typecheck-lint-build"][
      index
    ] as string,
    classification: classification as keyof typeof CHECK_VERDICT_WORDS,
    evidence: `The log for ${classification} reports <meter> & a different unit.\nCompared with untouched main.`,
  }));
  seedDelivery(tasks, "check-verdict", {
    mode: "direct-pr",
    prNumber: 58,
    prUrl: "https://github.com/octo/meterlab/pull/58",
    headSha,
    ci: "red",
    ciAt: Date.now(),
    ciRepair: {
      failures: [{ headSha, checks: [...diagnoses.map((d) => d.check), "linux-checks"] }],
      diagnoses: [
        ...diagnoses,
        {
          headSha: "b".repeat(40),
          check: "linux-checks",
          classification: "own-regression",
          evidence: "old diagnosis",
        },
      ],
      repairs: [],
    },
  });
  const card: Card = {
    id: "card-verdict",
    taskId: "check-verdict",
    author: "crewmate",
    meta: "crewmate",
    priority: 30,
    title: "The meter fix is ready",
    body: `<h2>Why</h2><p>The meter read the wrong unit.</p>${SETTLE_FACTS_OPEN}</div>`,
    status: "ready",
    createdAt: Date.now(),
    actions: [
      { id: "merge", label: "Merge", default: true, effect: { kind: "settle", mode: "merge" } },
      { id: "discard", label: "Discard", effect: { kind: "settle", mode: "discard" } },
    ],
  };
  const cards = new CardStore(db);
  cards.upsert(card);
  for (const state of ["green", "stale"] as const) {
    const id = `check-${state}`;
    seedTask(tasks, { id, title: id, status: "completed", worktreeDir });
    const saved = tasks.get("check-verdict")?.delivery;
    if (!saved) throw new Error("The failed check fixture must exist");
    seedDelivery(tasks, id, {
      ...saved,
      ...(state === "green" ? { ci: "green" as const } : { headSha: "d".repeat(40) }),
    });
    cards.upsert({ ...card, id: `card-${state}`, taskId: id, title: `The ${state} reading` });
  }
  db.close();
  const launched = await launchApp({ userDataDir: home, withMockProvider: true });
  try {
    await resizeWindow(launched.app, launched.page, { width: 1280, height: 900 });
    await showCard(launched.page, "The meter fix is ready");
    const strip = factsStrip(cardBody(launched.page, "The meter fix is ready")).strip;
    await regionShot(strip, testInfo.outputPath("verdicts.png"));
    for (const diagnosis of diagnoses) {
      const detail = strip.locator("details").filter({ hasText: diagnosis.check });
      const summary = detail.locator("summary");
      await expect(summary).toContainText(CHECK_VERDICT_WORDS[diagnosis.classification]);
      await expect(detail.locator("p")).not.toBeVisible();
      await pressKey(summary, "Enter");
      await expect(detail.locator("p")).toHaveText(diagnosis.evidence);
      await expect(detail.locator("p")).toBeVisible();
    }
    await expect(strip).toContainText(CHECK_VERDICT_MISSING);
    await expect(strip).not.toContainText("old diagnosis");
    // Refresh exactly as the host pushes live check ages, without reloading the frame.
    const cards = await launched.page.evaluate(() => window.infinitary.cards.list());
    const refreshed = cards.map((card) => ({
      ...card,
      body: card.body.replace("failed</span>", "failed · just read</span>"),
    }));
    await launched.app.evaluate(({ BrowserWindow }, cards) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send("inf:cards", cards);
    }, refreshed);
    await expect(strip).toContainText("just read");
    for (const diagnosis of diagnoses)
      await expect(strip.getByText(diagnosis.evidence, { exact: true })).toBeVisible();
    // A new evidence identity must not inherit the previous disclosure's open state.
    const changed = refreshed.map((card) => ({
      ...card,
      body: card.body.replaceAll(headSha, "c".repeat(40)),
    }));
    await launched.app.evaluate(({ BrowserWindow }, cards) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send("inf:cards", cards);
    }, changed);
    await expect(strip.locator("details[open]")).toHaveCount(0);
    for (const state of ["green", "stale"]) {
      await showCard(launched.page, `The ${state} reading`);
      const other = factsStrip(cardBody(launched.page, `The ${state} reading`)).strip;
      await expect(other.locator("[data-check-verdict]")).toHaveCount(0);
    }
  } finally {
    await launched.close();
  }
});
