import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import {
  BITBUCKET,
  FORGE_SECTION_WORDS,
  forgeKeyProblemText,
  forgeKeyScopesText,
} from "../../src/shared/forges";
import { MERGE_WORDS } from "../../src/shared/vocabulary";
import { scratchDir } from "../helpers/scratchDirs";
import { seedDelivery } from "../helpers/taskDelivery";
import {
  DATA_CENTER_HOST,
  DATA_CENTER_KEY,
  DATA_CENTER_LOGIN,
  DATA_CENTER_ORIGIN,
  type DataCenterStub,
  seedDataCenterSignIn,
  startDataCenterStub,
} from "./bitbucketDataCenterStub";
import { launchApp } from "./launch";
import { resizeWindow } from "./layout";
import { heroShot, regionShot } from "./pictures";
import { seedHostedOrigins, seedProject } from "./projectSeed";
import { expandDock, noteLines, putInLine, taskKey } from "./rails";
import { shownCard } from "./stack";
import { pressKey } from "./windowKeys";

/**
 * Bitbucket Data Center (`docs/forge.md`, "Bitbucket Data Center"), for the
 * captain's "adding bitbucket as another forge integration just like github
 * and gitlab, reaching parity as much as possible": the captain signs in to
 * their own Bitbucket Data Center server with an HTTP access token through
 * real Settings and HTTP, where a refused token and a server older than
 * 8.19 are kept nowhere; and the captain's click on a pull request's card
 * merges it at the version the app read, while a push that lands in the
 * moment of the merge makes the server refuse it and nothing goes in.
 *
 * The server is a local stand-in (`./bitbucketDataCenterStub.ts`) the app
 * reaches through its real sign-in and its real Data Center forge; no real
 * server or account is asked.
 */

const git = (...args: string[]) => execFileSync("git", args, { stdio: "pipe" }).toString().trim();

test("signs in to a Bitbucket Data Center server with an HTTP access token, and keeps neither a refused token nor a server older than 8.19", async () => {
  const userDataDir = scratchDir("fm-bitbucket-dc-data-");
  const stub = await startDataCenterStub();
  const launched = await launchApp({
    homeDir: scratchDir("fm-bitbucket-dc-home-"),
    userDataDir,
    withMockProvider: true,
    env: stub.env,
  });
  const evidence = process.env.INFINITARY_BITBUCKET_PICTURES;
  try {
    const { page } = launched;
    await resizeWindow(launched.app, page, { width: 1280, height: 800 });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await pressKey(page.getByRole("tab", { name: "Integrations", exact: true }), "Enter");
    const section = page.locator("[data-integrations]");
    await pressKey(
      section.locator("[data-connect-chips]").getByRole("button", { name: BITBUCKET.name }),
      "Enter",
    );
    const form = section.locator("[data-forge-key-form]");
    const address = form.getByLabel(FORGE_SECTION_WORDS.address);
    const key = form.getByLabel(FORGE_SECTION_WORDS.key);
    // A server's address names its HTTP access token's permissions, never Atlassian's scopes.
    await address.fill(DATA_CENTER_HOST);
    await expect(form.locator("[data-forge-key-scopes]")).toHaveText(
      forgeKeyScopesText("bitbucket", DATA_CENTER_HOST) ?? "",
    );
    await expect(form).not.toContainText("Atlassian");
    await key.fill("BBDC-cmVmdXNlZF90b2tlbl9mb3JfdGhlX3Rlc3Q");
    if (evidence) await regionShot(form, join(evidence, "key-form-dc-address-after.png"));
    if (evidence) {
      await resizeWindow(launched.app, page, { width: 960, height: 800 });
      await heroShot(launched.app, page, {
        region: form,
        anchors: [section.locator('[data-connect-chips="foot"]')],
        name: "bitbucket-data-center",
      });
      await resizeWindow(launched.app, page, { width: 1280, height: 800 });
    }
    await pressKey(key, "Enter");
    await expect(form.getByRole("status")).toHaveText(
      forgeKeyProblemText("refused", DATA_CENTER_HOST, BITBUCKET),
    );
    // A server older than 8.19 is refused with its own words, whatever the token.
    stub.runs("8.18.2");
    await key.fill(DATA_CENTER_KEY);
    await pressKey(key, "Enter");
    await expect(form.getByRole("status")).toHaveText(
      forgeKeyProblemText("not-server", DATA_CENTER_HOST, BITBUCKET),
    );
    if (evidence) await regionShot(form, join(evidence, "key-form-dc-refused-after.png"));
    expect(existsSync(join(userDataDir, "forges", DATA_CENTER_HOST))).toBe(false);
    stub.runs("8.19.4");
    await key.fill(DATA_CENTER_KEY);
    await pressKey(key, "Enter");
    await expect(form).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(() => window.infinitary.forges.list()))
      .toMatchObject({
        signIns: [{ host: DATA_CENTER_HOST, login: DATA_CENTER_LOGIN, state: "ok" }],
      });
    // Git answers the server with the person's own name and the token as the password.
    const kept = JSON.parse(
      readFileSync(join(userDataDir, "forges", DATA_CENTER_HOST, "sign-in.json"), "utf8"),
    ) as { gitUser?: string; kind?: string };
    expect(kept).toMatchObject({ gitUser: DATA_CENTER_LOGIN, kind: "bitbucket" });
    expect(
      JSON.stringify(await page.evaluate(() => window.infinitary.forges.list())),
    ).not.toContain(DATA_CENTER_KEY);
    expect(readFileSync(join(userDataDir, "forges", "health.log"), "utf8")).not.toContain(
      DATA_CENTER_KEY,
    );
    // The repositories the token may read are listed for Add project.
    expect(
      (
        await page.evaluate((host) => window.infinitary.forges.projects(host), DATA_CENTER_HOST)
      ).projects.map((project) => project.fullName),
    ).toEqual(["FLD/field-notes"]);
    if (evidence)
      await regionShot(
        section.locator(`[data-forge-row="${DATA_CENTER_HOST}"]`),
        join(evidence, "integration-row-dc-after.png"),
      );
  } finally {
    await launched.close();
    await stub.close();
  }
});

const CHANGE = { title: "feat: field notes sync", description: "The notes sync on time." };
const READY_CARD_TITLE = "The pull request is ready";

/**
 * One project on a Data Center server with an open pull request for a
 * task's branch, its build passed and its card up; `arrange` changes the
 * server before the captain's click.
 */
async function seededMerge(
  arrange: (stub: DataCenterStub, push: (subject: string) => void) => void,
) {
  const userDataDir = scratchDir("infinitary-bitbucket-dc-merge-");
  const taskId = "notestask";
  const repoDir = join(userDataDir, "repo");
  const worktreeDir = join(userDataDir, "worktree");
  const branch = `inf/sync-notes-${taskId}`;
  git("init", "--initial-branch=main", repoDir);
  git("-C", repoDir, "config", "user.name", "Test");
  git("-C", repoDir, "config", "user.email", "test@localhost");
  git("-C", repoDir, "commit", "--allow-empty", "-m", "chore: seed the notes");
  git("-C", repoDir, "worktree", "add", "-b", branch, worktreeDir);
  // e2e-fixture: input -- Author the real project file this journey commits and merges.
  writeFileSync(join(worktreeDir, "sync.txt"), "The notes sync on time.\n");
  git("-C", worktreeDir, "add", "sync.txt");
  git("-C", worktreeDir, "commit", "-m", CHANGE.title);
  const head = () => git("-C", repoDir, "rev-parse", `refs/heads/${branch}`);
  const push = (subject: string) =>
    git("-C", worktreeDir, "commit", "--allow-empty", "-m", subject);
  const stub = await startDataCenterStub();
  stub.gitOf({
    head: (name) => git("-C", repoDir, "rev-parse", "--verify", `refs/heads/${name}`),
    commit: (rev) => git("-C", repoDir, "rev-parse", "--verify", `${rev}^{commit}`),
  });
  stub.openPullRequest({ branch, ...CHANGE });
  const approved = head();
  arrange(stub, push);
  seedDataCenterSignIn(userDataDir);
  const db = openDatabase(userDataDir);
  seedProject(db, {
    id: "repo-notes",
    path: repoDir,
    name: "field-notes",
    setupKind: "clone",
    origin: DATA_CENTER_ORIGIN,
    runsOn: null,
    delivery: "direct-pr",
  });
  seedHostedOrigins(db, userDataDir);
  const tasks = new TaskService({ db, strict: true });
  seedTask(tasks, {
    id: taskId,
    title: "Sync the notes",
    status: "idle",
    repoId: "repo-notes",
    repoDir,
    worktreeDir,
    branch,
  });
  seedDelivery(tasks, taskId, {
    ciRepair: {
      failures: [],
      diagnoses: [],
      repairs: [],
      declarations: [
        {
          headSha: approved,
          verdict: "ready",
          evidence: "The scripted crew judged the passed build status before the click.",
          at: Date.now(),
        },
      ],
    },
  });
  new CardStore(db).upsert({
    id: `card-${taskId}-1`,
    taskId,
    author: "crewmate",
    priority: 30,
    title: READY_CARD_TITLE,
    meta: "crewmate 1",
    body: "<p>The notes sync on time; the build passed.</p>",
    status: "ready",
    createdAt: Date.now(),
    actions: [
      {
        id: "merge",
        label: MERGE_WORDS["merge-pr"],
        variant: "primary",
        default: true,
        effect: { kind: "merge", after: "close" },
      },
    ],
  });
  db.close();
  const launched = await launchApp({ userDataDir, env: stub.env });
  const { page } = launched;
  await expect(shownCard(page, READY_CARD_TITLE)).toBeVisible();
  await expandDock(page, "activity");
  await page.getByRole("button", { name: MERGE_WORDS["merge-pr"], exact: true }).click();
  const key = await taskKey(page, "Sync the notes");
  const detail = () => page.evaluate((id) => window.infinitary.tasks.detail(id), taskId);
  return {
    page,
    key,
    detail,
    stub,
    approved,
    worktreeDir,
    close: async () => {
      await launched.close();
      await stub.close();
    },
  };
}

test("the captain's click squash-merges a Data Center pull request at the version the app read", async () => {
  const merge = await seededMerge(() => {});
  try {
    const { page, key, detail, stub, approved } = merge;
    await expect(putInLine(page, key)).toBeVisible({ timeout: 30_000 });
    // One squash, naming the version the app read, of the head whose build passed.
    expect(stub.merges()).toEqual([
      expect.objectContaining({ id: 1, version: 0, head: approved, strategy: "squash" }),
    ]);
    expect(stub.merges()[0]?.message.startsWith(CHANGE.title)).toBe(true);
    expect(stub.requests()).toContain("GET /rest/build-status/latest/commits/".concat(approved));
    await expect.poll(detail).toMatchObject({ status: "done", closedReason: "merged" });
  } finally {
    await merge.close();
  }
});

test("a push that lands while the server merges makes it refuse the older version, and nothing is merged", async () => {
  const merge = await seededMerge((stub, push) => {
    let pushed = false;
    stub.onMergeRequest(() => {
      if (pushed) return;
      pushed = true;
      push("feat: a note pushed during the merge");
    });
  });
  try {
    const { page, key, detail, stub } = merge;
    await expect
      .poll(
        () =>
          stub
            .requests()
            .filter((request) => request.endsWith("/merge") && request.startsWith("POST")).length,
        {
          timeout: 30_000,
        },
      )
      .toBe(1);
    await expect(noteLines(page, key)).toHaveCount(1, { timeout: 30_000 });
    expect(stub.merges()).toEqual([]);
    await expect(putInLine(page, key)).toHaveCount(0);
    expect(await detail()).toMatchObject({ status: "active", closedReason: null });
    expect(existsSync(join(merge.worktreeDir, "sync.txt"))).toBe(true);
  } finally {
    await merge.close();
  }
});
