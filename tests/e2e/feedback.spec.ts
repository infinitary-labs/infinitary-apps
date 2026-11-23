import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { FEEDBACK_DRAFT, FEEDBACK_WORD } from "../../src/shared/feedback";
import * as m from "../../src/shared/i18n/messages.generated";
import { submitFeedbackWords } from "../../src/shared/vocabulary";
import { scratchDir } from "../helpers/scratchDirs";
import { HAS_APP_MENU } from "./desktop";
import { cardBody } from "./frames";
import { type GitHubStub, STUB_LOGIN, seedGitHubSignIn, startGitHubStub } from "./githubStub";
import { type LaunchedApp, launchApp } from "./launch";
import { resizeWindow } from "./layout";
import { heroShot } from "./pictures";
import { promptInput } from "./prompt";
import {
  FEEDBACK_CARD_TITLE,
  FEEDBACK_ISSUE_TITLE,
  FEEDBACK_PROBLEM,
  FEEDBACK_WORDS,
  feedbackReport,
} from "./scenarios/feedbackReport";
import { shownCard } from "./stack";
import { MAC_ONLY_TAG } from "./tags";
import { pressKey, runFromSearch } from "./windowKeys";

/**
 * /feedback, the way a person meets it (docs/feedback.md): Send feedback
 * from command search, or from the Help menu on a Mac, starts the message with /feedback and the message
 * box's hint names it; the first mate starts a crewmate, whose draft comes
 * back as the exact issue on a card; nothing reaches GitHub before the
 * captain's click, and the click publishes exactly the text the card showed,
 * once. GitHub is the local stand-in (`./githubStub.ts`) with the app's
 * sign-in already made; the models are the scripted stand-in.
 */

let launched: LaunchedApp | undefined;
let github: GitHubStub | undefined;

test.afterEach(async () => {
  await launched?.close();
  await github?.close();
  launched = undefined;
  github = undefined;
});

test("a /feedback report shows its exact issue for review and publishes it once on the captain's click", async () => {
  test.setTimeout(180_000);
  const userDataDir = scratchDir("infinitary-feedback-");
  seedGitHubSignIn(userDataDir);
  const stub = await startGitHubStub();
  github = stub;
  launched = await launchApp({
    withMockProvider: true,
    scenarios: [feedbackReport],
    userDataDir,
    env: stub.env,
  });
  const { app, page } = launched;
  const evidence = process.env.INFINITARY_TASK_EVIDENCE_DIR;
  const input = promptInput(page);
  await expect(input).toBeVisible();
  await expect
    .poll(
      () =>
        page.evaluate(async () =>
          (await window.infinitary.forges.list()).signIns.map((signIn) => signIn.state),
        ),
      { timeout: 15_000 },
    )
    .toEqual(["ok"]);

  await test.step("Send feedback starts the message with /feedback, and the hint names it", async () => {
    await runFromSearch(app, page, "feedback.start");
    await expect(input).toBeFocused();
    await expect(input).toHaveValue(FEEDBACK_DRAFT);
    const hint = page.locator('[data-voice-input-hint="command"]');
    await expect(hint).toHaveText(m.composerHintFeedback({ command: FEEDBACK_WORD }));
    if (evidence) {
      await resizeWindow(app, page, { width: 1100, height: 860 });
      // Command search fades out after it closes; the picture waits for the window to settle.
      await page.evaluate(() =>
        Promise.allSettled(
          document
            .getAnimations()
            .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
            .map((animation) => animation.finished),
        ),
      );
      await page.screenshot({ path: join(evidence, "feedback-hint.png") });
    }
  });

  const issues = () => stub.openedIssues();
  await test.step("the draft comes back as the exact issue on a card, and nothing is sent", async () => {
    await input.pressSequentially(FEEDBACK_PROBLEM);
    await input.press("Enter");
    const card = shownCard(page, FEEDBACK_CARD_TITLE);
    await expect(card).toBeVisible({ timeout: 60_000 });
    const strip = cardBody(page, FEEDBACK_CARD_TITLE).locator("[data-inf-call-feedback]");
    await expect(strip.locator("[data-inf-call-title]")).toHaveText(FEEDBACK_ISSUE_TITLE);
    const shown = (await strip.locator("[data-inf-call-body]").textContent()) ?? "";
    // The crewmate's words lead; the host added the diagnostics and its mark beneath.
    expect(shown.startsWith(FEEDBACK_WORDS)).toBe(true);
    expect(shown).toContain("<!-- infinitary-feedback v1 kind=bug");
    await expect(strip).toContainText(m.feedbackStripAccount({ login: STUB_LOGIN }));
    expect(issues()).toEqual([]);
    if (evidence) {
      await page.screenshot({ path: join(evidence, "feedback-review-card.png") });
      writeFileSync(join(evidence, "feedback-shown-body.txt"), shown);
      await heroShot(app, page, {
        region: card,
        anchors: [page.getByRole("button", { name: submitFeedbackWords(), exact: true })],
        name: "feedback-command",
      });
    }

    await test.step("the captain's click publishes exactly what the card showed, once", async () => {
      await pressKey(
        page.getByRole("button", { name: submitFeedbackWords(), exact: true }),
        "Enter",
      );
      await expect.poll(() => issues().length, { timeout: 20_000 }).toBe(1);
      const [opened] = issues();
      expect(opened?.path).toMatch(/^\/repos\/[^/]+\/[^/]+\/issues$/);
      expect(JSON.parse(opened?.body ?? "{}")).toEqual({
        title: FEEDBACK_ISSUE_TITLE,
        body: shown,
      });
      await expect(card).toHaveCount(0, { timeout: 20_000 });
      expect(issues()).toHaveLength(1);
      if (evidence)
        writeFileSync(
          join(evidence, "feedback-requests.txt"),
          `${stub.requests().join("\n")}\n\nOpened:\n${JSON.stringify(issues(), null, 2)}\n`,
        );
    });
  });
});

test("Send Feedback in the Help menu starts the message with /feedback", {
  tag: MAC_ONLY_TAG,
}, async () => {
  test.skip(!HAS_APP_MENU, "a desktop whose window draws its own controls has no Help menu");
  launched = await launchApp({ withMockProvider: true });
  const { app, page } = launched;
  const input = promptInput(page);
  await expect(input).toBeVisible();
  // As a click on the item does: the item sits in the Help menu and runs the window command.
  await app.evaluate(({ Menu }) => {
    const menu = Menu.getApplicationMenu();
    const item = menu?.getMenuItemById("feedback-start");
    const help = menu?.items.find((entry) => entry.role === "help");
    if (!item || !help?.submenu?.items.includes(item))
      throw new Error("No Send Feedback in the Help menu");
    item.click();
  });
  await expect(input).toBeFocused();
  await expect(input).toHaveValue(FEEDBACK_DRAFT);
  await expect(page.locator('[data-voice-input-hint="command"]')).toHaveText(
    m.composerHintFeedback({ command: FEEDBACK_WORD }),
  );
});
