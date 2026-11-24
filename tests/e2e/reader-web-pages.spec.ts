import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { openDatabase } from "../../src/core/storage/db";
import { cardReaderPagesTitle } from "../../src/shared/i18n/messages.generated";
import { INTEGRATION_APPROVAL_WORDS } from "../../src/shared/integrations";
import { scratchDir } from "../helpers/scratchDirs";
import {
  savedWriteAsks,
  UNSAFE_DATA_READER_MARKER,
  UNSAFE_DATA_READER_NAMED_PAGE,
  UNSAFE_DATA_READER_OTHER_PAGE,
  UNSAFE_DATA_READER_PAGE_WORDS,
  UNSAFE_DATA_READER_WEB_MARKER,
} from "./apiWriteCases";
import { cardBody } from "./frames";
import { seedGitHubSignIn, startGitHubStub } from "./githubStub";
import { type LaunchedApp, launchApp } from "./launch";
import { resizeWindow } from "./layout";
import { SPAWN_PROMPT_MARKER } from "./mockProvider";
import { heroShot } from "./pictures";
import { seedProject } from "./projectSeed";
import { promptInput } from "./prompt";
import { unsafeDataReaderWeb } from "./scenarios/unsafeDataReaderWeb";
import { shownCard } from "./stack";
import { startPageStandIn } from "./webPages";
import { pressKey } from "./windowKeys";

const git = (...args: string[]) => execFileSync("git", args, { stdio: "pipe" }).toString().trim();

let launched: LaunchedApp;
let userDataDir: string;
/** Stops what this test started, however it ended. */
let stop: (() => Promise<void>) | undefined;

test.afterEach(async () => {
  await stop?.();
  stop = undefined;
});

/**
 * A fresh app over meterlab, a private project on GitHub whose pushes land on
 * a bare repository here, signed in to a fresh GitHub stand-in, with the
 * named web hosts answered by the local page stand-in at `pages`.
 */
async function arrange(pages: Record<string, string>): Promise<void> {
  userDataDir = scratchDir("infinitary-reader-web-");
  const bare = join(userDataDir, "github-meterlab.git");
  git("init", "--bare", "--initial-branch=main", bare);
  const meterlab = join(userDataDir, "meterlab");
  const origin = "https://github.com/octo/meterlab.git";
  git("init", "--initial-branch=main", meterlab);
  git("-C", meterlab, "config", "user.name", "Test");
  git("-C", meterlab, "config", "user.email", "test@localhost");
  git("-C", meterlab, "commit", "--allow-empty", "-m", "init");
  git("-C", meterlab, "remote", "add", "origin", origin);
  git("-C", meterlab, "config", `url.${bare}.insteadOf`, origin);
  git("-C", meterlab, "push", "origin", "HEAD:refs/heads/main");
  const db = openDatabase(userDataDir);
  seedProject(db, {
    id: "repo-meterlab",
    path: meterlab,
    name: "meterlab",
    setupKind: "clone",
    origin,
    runsOn: null,
    delivery: "direct-pr",
    rigor: "quick",
    addedAt: 1,
  });
  db.close();
  seedGitHubSignIn(userDataDir);
  const github = await startGitHubStub({ host: "github.com" });
  stop = () => github.close();
  github.setProjects([
    { fullName: "octo/meterlab", private: true, updatedAt: "2026-09-22T10:00:00Z" },
  ]);
  github.headOf((branch) => git("-C", bare, "rev-parse", `refs/heads/${branch}`));
  launched = await launchApp({
    withMockProvider: true,
    scenarios: [unsafeDataReaderWeb],
    userDataDir,
    env: { ...github.env, INFINITARY_WEB_READ_HOSTS: JSON.stringify(pages) },
  });
  stop = async () => {
    await launched.close();
    await github.close();
  };
  await expect
    .poll(
      () =>
        launched.page.evaluate(async () =>
          (await window.infinitary.forges.list()).signIns.map((one) => [one.host, one.state]),
        ),
      { timeout: 15_000 },
    )
    .toEqual([["github.com", "ok"]]);
}

async function send(page: Page, text: string) {
  const input = promptInput(page);
  await input.click();
  await input.fill(text);
  await input.press("Enter");
}

/**
 * An unsafe data reader's web pages (docs/agents-reach.md, "Web pages"): its
 * project is private on GitHub, so it holds something of the captain's from the start.
 * The page its brief names opens at once, signed out, its words marked as
 * web-data; another waits as a row on the app's approval card and opens once
 * on the captain's click.
 */
test("an unsafe data reader opens the page its brief names and waits on the captain for another", async () => {
  const pages = await startPageStandIn({
    "docs.meterlab.example": {
      "/cold-start": `<html><head><title>Cold start</title></head><body><nav>Docs home</nav><p>${UNSAFE_DATA_READER_PAGE_WORDS.named}</p><script>document.title = "ran"</script></body></html>`,
    },
    "forum.meterlab.example": {
      "/t/idle": `<html><head><title>Idle thread</title></head><body><p>${UNSAFE_DATA_READER_PAGE_WORDS.other}</p></body></html>`,
    },
  });
  try {
    await arrange({
      "docs.meterlab.example": pages.origin,
      "forum.meterlab.example": pages.origin,
    });
    const { page } = launched;
    const title = `meterlab ${UNSAFE_DATA_READER_MARKER} ${UNSAFE_DATA_READER_WEB_MARKER} ${UNSAFE_DATA_READER_NAMED_PAGE}`;
    await send(page, `${SPAWN_PROMPT_MARKER} ${title}`);
    const cardTitle = cardReaderPagesTitle();
    const card = shownCard(page, cardTitle);
    await expect(card).toBeVisible({ timeout: 45_000 });
    const rows = cardBody(page, cardTitle).locator("[data-inf-ask-row]");
    await expect(rows).toHaveCount(1);
    await expect(rows.nth(0)).toContainText(`GET ${UNSAFE_DATA_READER_OTHER_PAGE}`);
    await expect(rows.nth(0).getByRole("checkbox")).toBeChecked();
    const shown = (await page.evaluate(() => window.infinitary.cards.list())).filter(
      (one) => one.meta === "Integration approval",
    );
    expect(shown.map((one) => one.author)).toEqual(["host"]);
    expect(shown[0]?.actions.map((action) => action.label)).toEqual([
      INTEGRATION_APPROVAL_WORDS.deny,
      INTEGRATION_APPROVAL_WORDS.once,
    ]);
    const id = shown[0]?.taskId ?? "";
    const outcome = async () =>
      (await page.evaluate((taskId) => window.infinitary.tasks.detail(taskId), id))?.outcome ?? "";
    await expect.poll(outcome, { timeout: 45_000 }).toContain("Kept as ask");
    const firstReport = await outcome();
    // The named page was read signed out and its words came marked; the
    // other was never asked for before the click.
    expect(pages.requests()).toEqual([
      {
        host: "docs.meterlab.example",
        path: "/cold-start",
        cookie: undefined,
        authorization: undefined,
      },
    ]);
    expect(firstReport).toMatch(
      new RegExp(
        `\\[\\[web-data fence=[0-9a-f]{16}[^\\]]*\\]\\][\\s\\S]*${UNSAFE_DATA_READER_PAGE_WORDS.named}`,
      ),
    );
    expect(firstReport).toContain("Title: Cold start");
    expect(firstReport).not.toContain("document.title");
    expect(firstReport).toContain(`GET ${UNSAFE_DATA_READER_OTHER_PAGE}`);
    expect(firstReport).not.toContain(UNSAFE_DATA_READER_PAGE_WORDS.other);
    const evidence = process.env.INFINITARY_TASK_EVIDENCE_DIR;
    const shot = "unsafe-data-reader-web";
    if (evidence) {
      await resizeWindow(launched.app, page, { width: 1100, height: 860 });
      await page.screenshot({ path: join(evidence, `${shot}-card.png`) });
      await heroShot(launched.app, page, {
        region: card,
        anchors: [card.getByRole("button", { name: INTEGRATION_APPROVAL_WORDS.once, exact: true })],
        name: shot,
      });
    }
    await pressKey(
      card.getByRole("button", { name: INTEGRATION_APPROVAL_WORDS.once, exact: true }),
      "Enter",
    );
    await expect
      .poll(() => pages.requests().map((one) => one.host), { timeout: 20_000 })
      .toEqual(["docs.meterlab.example", "forum.meterlab.example"]);
    await expect.poll(outcome, { timeout: 45_000 }).toContain("Opened:");
    const opened = await outcome();
    expect(opened).toMatch(
      new RegExp(
        `\\[\\[web-data fence=[0-9a-f]{16}[^\\]]*\\]\\][\\s\\S]*${UNSAFE_DATA_READER_PAGE_WORDS.other}`,
      ),
    );
    expect(pages.requests()[1]).toEqual({
      host: "forum.meterlab.example",
      path: "/t/idle?from=12",
      cookie: undefined,
      authorization: undefined,
    });
    const saved = savedWriteAsks(userDataDir, id);
    expect(saved).toEqual([
      expect.objectContaining({
        kind: "web",
        url: UNSAFE_DATA_READER_OTHER_PAGE,
        sentAt: expect.any(Number),
        outcome: expect.objectContaining({ kind: "answered", status: 200 }),
      }),
    ]);
    await expect(card).toBeHidden();
    const transcript = `First report:\n${firstReport}\n\nAfter the click:\n${opened}\n\nSaved asks:\n${JSON.stringify(saved, null, 2)}\n\nPage requests:\n${JSON.stringify(pages.requests(), null, 2)}`;
    await test.info().attach(shot, { body: transcript, contentType: "text/plain" });
    if (evidence) {
      await page.screenshot({ path: join(evidence, `${shot}-after-click.png`) });
      writeFileSync(join(evidence, `${shot}.txt`), transcript);
    }
  } finally {
    await pages.close();
  }
});
