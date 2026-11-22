import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { presentationCommitMessage, presentationRegionMarkers } from "../../src/core/forge";
import { presentationMarkdownText } from "../../src/core/forge/presentation";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { checkSnapshotState } from "../../src/shared/checkSnapshot";
import { englishOf, said } from "../../src/shared/i18n/said";
import type { TaskDetail } from "../../src/shared/tasks";
import { MERGE_WORDS } from "../../src/shared/vocabulary";
import { BUNDLED_NAMING } from "../helpers/namingRunbook";
import { scratchDir } from "../helpers/scratchDirs";
import { seedDelivery } from "../helpers/taskDelivery";
import {
  BITBUCKET_STUB_PROJECT,
  type BitbucketStub,
  seedBitbucketSignIn,
  startBitbucketStub,
} from "./bitbucketStub";
import { cardBody } from "./frames";
import { launchApp } from "./launch";
import { resizeWindow } from "./layout";
import { SPAWN_PROMPT_MARKER } from "./mockProvider";
import { heroShot, regionShot } from "./pictures";
import { seedHostedOrigins, seedProject } from "./projectSeed";
import { addedProjects } from "./projects";
import { promptInput } from "./prompt";
import { expandDock, noteLines, putInLine, taskKey } from "./rails";
import { MOCK_GITHUB_STORY } from "./scenarios/changeStory";
import {
  GITHUB_CHANGE_PROMPT_MARKER,
  githubChange,
  MOCK_GITHUB_CHANGE,
  MOCK_GITHUB_CHANGE_CARD_TITLE,
} from "./scenarios/githubChange";
import { factsStrip, shownCard } from "./stack";

/**
 * Bitbucket delivery (`docs/forge.md`, "Bitbucket pull requests"), INF-5193
 * for the captain's "adding bitbucket as another forge integration just
 * like github and gitlab, reaching parity as much as possible": a crewmate
 * pushes its branch and opens a pull request on bitbucket.org with its own
 * tools, the build statuses on its version read as the card's checks, and
 * the captain's click squash-merges the version those checks read - while a
 * branch that moved, a conflict, a rule wanting an approval, a draft, a
 * failed, running or stopped build each stop the click with nothing merged,
 * a merge Bitbucket has not finished is never sent twice, and a push that
 * lands in the moment Bitbucket merges is merged and told: Bitbucket's merge
 * names no version to hold it to.
 *
 * Bitbucket is a local stand-in (`./bitbucketStub.ts`) the app reaches
 * through its kept key sign-in, its real Bitbucket forge and its real git;
 * every push goes to a bare repository on this computer through git's own
 * `insteadOf`, so the project's recorded address is a real Bitbucket one.
 * No real account is asked.
 */

const git = (...args: string[]) => execFileSync("git", args, { stdio: "pipe" }).toString().trim();

const ORIGIN = `https://bitbucket.org/${BITBUCKET_STUB_PROJECT}.git`;
const API_PROJECT = `/2.0/repositories/${BITBUCKET_STUB_PROJECT}`;

/** Bitbucket's branches and commits, read from the repository where the project lives. */
function gitIn(dir: string) {
  return {
    head: (branch: string) => git("-C", dir, "rev-parse", "--verify", `refs/heads/${branch}`),
    commit: (rev: string) => git("-C", dir, "rev-parse", "--verify", `${rev}^{commit}`),
  };
}

async function send(page: Page, text: string) {
  const input = promptInput(page);
  await input.click();
  await input.fill(text);
  await input.press("Enter");
}

/**
 * A crewmate's task on bitbucket.org whose pull request is open and whose
 * merge card is up, published by the app once the build statuses passed, so
 * the captain's click carries a kept merge approval: Bitbucket's merge names
 * no version to hold it to, so only such an approval's merge is sent
 * (`docs/forge.md`, "Bitbucket pull requests").
 */
async function openedOnBitbucket() {
  const userDataDir = scratchDir("infinitary-bitbucket-delivery-");
  const bare = join(userDataDir, "bitbucket-field-notes.git");
  git("init", "--bare", "--initial-branch=main", bare);
  const dir = join(userDataDir, "field-notes");
  git("init", "--initial-branch=main", dir);
  git("-C", dir, "config", "user.name", "Test");
  git("-C", dir, "config", "user.email", "test@localhost");
  git("-C", dir, "commit", "--allow-empty", "-m", "chore: seed the notes");
  git("-C", dir, "remote", "add", "origin", ORIGIN);
  git("-C", dir, "config", `url.${bare}.insteadOf`, ORIGIN);
  git("-C", dir, "push", "origin", "HEAD:refs/heads/main");
  git("-C", dir, "fetch", "origin");
  const db = openDatabase(userDataDir);
  seedProject(db, {
    id: "repo-notes",
    path: dir,
    name: "field-notes",
    setupKind: "clone",
    origin: ORIGIN,
    runsOn: null,
    delivery: "direct-pr",
    rigor: "quick",
    addedAt: 1,
  });
  seedHostedOrigins(db, userDataDir);
  db.close();
  seedBitbucketSignIn(userDataDir);
  const bitbucket = await startBitbucketStub();
  bitbucket.gitOf(gitIn(bare));
  const launched = await launchApp({
    withMockProvider: true,
    scenarios: [githubChange],
    userDataDir,
    env: bitbucket.env,
  });
  try {
    const { page } = launched;
    await resizeWindow(launched.app, page, { width: 1280, height: 800 });
    await expect
      .poll(async () => (await addedProjects(page))[0]?.host)
      .toEqual({ kind: "bitbucket", name: "bitbucket.org" });
    const title = `field-notes ${GITHUB_CHANGE_PROMPT_MARKER}`;
    await send(page, `${SPAWN_PROMPT_MARKER} ${title}`);
    const card = shownCard(page, MOCK_GITHUB_CHANGE_CARD_TITLE);
    await expect(card).toBeVisible({ timeout: 45_000 });
    const task = (await page.evaluate(() => window.infinitary.tasks.board())).tasks.find(
      (row) => row.title === title,
    );
    if (!task) throw new Error("The crewmate's task is missing");
    const branch = task.repo?.branch ?? "";
    expect(branch).not.toBe("");
    const detail = () => page.evaluate((id) => window.infinitary.tasks.detail(id), task.id);
    return {
      launched,
      page,
      bitbucket,
      bare,
      worktreeDir: join(userDataDir, "worktrees", task.id),
      card,
      task,
      branch,
      detail,
      /** Push one more commit to the task's branch where the project lives, as another computer would. */
      push: (subject: string) => {
        const tree = git("-C", bare, "rev-parse", `refs/heads/${branch}^{tree}`);
        const next = git(
          "-C",
          bare,
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@localhost",
          "commit-tree",
          tree,
          "-p",
          `refs/heads/${branch}`,
          "-m",
          subject,
        );
        git("-C", bare, "update-ref", `refs/heads/${branch}`, next);
        return next;
      },
      close: async () => {
        await launched.close();
        await bitbucket.close();
      },
    };
  } catch (caught) {
    await launched.close();
    await bitbucket.close();
    throw caught;
  }
}

test("a crewmate opens a pull request on bitbucket.org, its build statuses read as the checks, and the captain's click squash-merges that version", async () => {
  const opened = await openedOnBitbucket();
  const { launched, page, bitbucket, bare, card, task, branch } = opened;
  const cardTitle = MOCK_GITHUB_CHANGE_CARD_TITLE;
  const pictures = process.env.INFINITARY_BITBUCKET_PICTURES;
  try {
    const sentUp = git("-C", bare, "rev-parse", `refs/heads/${branch}`);
    expect(bitbucket.requests()).toContain(`POST ${API_PROJECT}/pullrequests`);
    expect(bitbucket.requests()).toContain(`GET ${API_PROJECT}/commit/${sentUp}/statuses`);
    const webUrl = `https://bitbucket.org/${BITBUCKET_STUB_PROJECT}/pull-requests/1`;
    const facts = factsStrip(cardBody(page, cardTitle));
    await expect(facts.change.locator(`a[href="${webUrl}"]`)).toHaveText("#1");
    const reading = task.delivery?.checks;
    // The cell says the reading's state, then when it finished, as Bitbucket dates each status.
    await expect(facts.checks).toContainText(
      reading ? checkSnapshotState(reading) : "missing check reading",
    );
    expect(await page.evaluate((id) => window.infinitary.tasks.detail(id), task.id)).toMatchObject({
      delivery: { changeLabel: "#1", prNumber: 1, prUrl: webUrl, ci: "green", headSha: sentUp },
    });
    if (pictures) {
      await regionShot(card, join(pictures, "bitbucket-completion-card-after.png"));
      await regionShot(
        card.locator("[data-card-facts]"),
        join(pictures, "bitbucket-completion-facts-after.png"),
      );
      await heroShot(launched.app, page, { region: card, name: "bitbucket-pull-requests" });
    }

    // The description is the story's generated region, in Markdown Bitbucket shows:
    // its folds are plain sections, since Bitbucket shows no HTML.
    const description = bitbucket.descriptions().get(1) ?? "";
    const { start, end } = presentationRegionMarkers(task.id);
    expect(description.startsWith(start)).toBe(true);
    expect(description.endsWith(end)).toBe(true);
    expect(description).toContain("## Why");
    expect(description).toContain(presentationMarkdownText(MOCK_GITHUB_STORY.noPicture ?? ""));
    expect(description).not.toContain("<details>");
    if (pictures)
      writeFileSync(join(pictures, "bitbucket-pull-request-description.md"), description);

    await page.getByRole("button", { name: MERGE_WORDS["merge-pr"], exact: true }).click();
    await expect(putInLine(page, task.key)).toBeVisible({ timeout: 30_000 });
    expect(bitbucket.merges()).toEqual([
      {
        id: 1,
        head: sentUp,
        strategy: "squash",
        message: `${MOCK_GITHUB_CHANGE.title}\n\n${presentationCommitMessage(MOCK_GITHUB_STORY, BUNDLED_NAMING)}`,
      },
    ]);
    await expect
      .poll(() => page.evaluate((id) => window.infinitary.tasks.detail(id), task.id))
      .toMatchObject({ status: "done", closedReason: "merged" });
  } finally {
    await opened.close();
  }
});

function stopOf(task: TaskDetail | null): {
  notes: string;
  problem: string;
  ci: string | undefined;
} {
  const notes = (task?.events ?? []).filter((event) => event.kind === "note");
  return {
    notes: notes.map((event) => event.text).join("\n"),
    problem: notes.map((event) => String(event.data?.problem ?? "")).join("\n"),
    ci: task?.delivery?.ci,
  };
}

/** A pull request someone opened for the task's branch, whose completion card is up. */
const CHANGE = { title: "feat: field notes sync", description: "The notes sync on time." };
const READY_CARD_TITLE = "The pull request is ready";

type Repo = { branch: string; push: (subject: string) => void; head: () => string };

/**
 * One project on bitbucket.org with an open pull request for a task's
 * branch and its completion card up, as the journey above leaves it: what
 * `arrange` changes where the project lives decides whether the click merges.
 */
async function seededMerge(
  arrange: (bitbucket: BitbucketStub, repo: Repo) => void,
  crewVerdict?: "ready" | "red",
  signedIn = true,
) {
  const userDataDir = scratchDir("infinitary-bitbucket-merge-");
  const taskId = "notestask";
  const repoDir = join(userDataDir, "repo");
  const worktreeDir = join(userDataDir, "worktree");
  const branch = `fm/task-${taskId}`;
  git("init", "--initial-branch=main", repoDir);
  git("-C", repoDir, "config", "user.name", "Test");
  git("-C", repoDir, "config", "user.email", "test@localhost");
  git("-C", repoDir, "commit", "--allow-empty", "-m", "chore: seed the notes");
  git("-C", repoDir, "worktree", "add", "-b", branch, worktreeDir);
  // e2e-fixture: input -- Author the real project files this journey commits, preserves or merges.
  writeFileSync(join(worktreeDir, "sync.txt"), "The notes sync on time.\n");
  git("-C", worktreeDir, "add", "sync.txt");
  git("-C", worktreeDir, "commit", "-m", CHANGE.title);
  const repo: Repo = {
    branch,
    push: (subject) => git("-C", worktreeDir, "commit", "--allow-empty", "-m", subject),
    head: () => git("-C", repoDir, "rev-parse", `refs/heads/${branch}`),
  };
  const bitbucket = await startBitbucketStub();
  bitbucket.gitOf(gitIn(repoDir));
  bitbucket.openPullRequest({ branch, ...CHANGE });
  arrange(bitbucket, repo);
  if (signedIn) seedBitbucketSignIn(userDataDir);
  const db = openDatabase(userDataDir);
  seedProject(db, {
    id: "repo-notes",
    path: repoDir,
    name: "field-notes",
    setupKind: "clone",
    origin: ORIGIN,
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
  // This saved crew judgment lets the structural refusers reach their own
  // merge boundary; red and pending cases keep their own readiness facts.
  if (crewVerdict) {
    seedDelivery(tasks, taskId, {
      ciRepair: {
        failures: [],
        diagnoses: [],
        repairs: [],
        declarations: [
          {
            headSha: repo.head(),
            verdict: crewVerdict,
            evidence: "The scripted crew judged the arranged build statuses before the click.",
            at: Date.now(),
          },
        ],
      },
    });
  }
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
  const launched = await launchApp({ userDataDir, env: bitbucket.env });
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
    worktreeDir,
    bitbucket,
    close: async () => {
      await launched.close();
      await bitbucket.close();
    },
  };
}

/**
 * Changes that must not go in, each one fact away from the journey above:
 * what is wrong where the project lives, whether the app gets as far as
 * asking Bitbucket to merge, and the fact the task's record keeps about why
 * it stopped - read off the spec's own inputs, never the words.
 */
const REFUSALS: {
  change: string;
  arrange: (bitbucket: BitbucketStub, repo: Repo) => string;
  asksBitbucket: boolean;
  crewVerdict?: "ready" | "red";
  stoppedBy: (stop: ReturnType<typeof stopOf>, fact: string) => boolean;
}[] = [
  {
    // Bitbucket's merge names no version: the app reads the branch just before it.
    change: "a branch that moved on between the check and the merge",
    arrange: (bitbucket, repo) => {
      let pushed = false;
      bitbucket.onBranchRead((branch) => {
        if (branch !== repo.branch || pushed) return;
        pushed = true;
        repo.push("feat: one more note");
      });
      return repo.branch;
    },
    asksBitbucket: false,
    crewVerdict: "ready",
    stoppedBy: (stop, branch) => stop.problem.includes(branch),
  },
  // Bitbucket's merge would not hold to the branch's rules for an owner's
  // sign-in: its own readiness is read first, and a pull request it holds
  // is never asked to merge.
  {
    change: "a conflict with newer work on main",
    arrange: (bitbucket) => {
      bitbucket.conflicts(true);
      return "conflict";
    },
    asksBitbucket: false,
    crewVerdict: "ready",
    stoppedBy: (stop, readiness) => stop.notes.includes(` as ${readiness}`),
  },
  {
    change: "a rule on main that wants an approval it lacks",
    arrange: (bitbucket) => {
      bitbucket.requireApproval(true);
      return "blocked";
    },
    asksBitbucket: false,
    crewVerdict: "ready",
    stoppedBy: (stop, readiness) => stop.notes.includes(` as ${readiness}`),
  },
  {
    change: "a pull request turned back into a draft",
    arrange: (bitbucket) => {
      bitbucket.markDraft(1);
      return "draft";
    },
    asksBitbucket: false,
    crewVerdict: "ready",
    stoppedBy: (stop, readiness) => stop.notes.includes(` as ${readiness}`),
  },
  {
    change: "a failed build",
    arrange: (bitbucket) => {
      bitbucket.setStatuses([
        { key: "lint", name: "Lint", state: "SUCCESSFUL" },
        { key: "test", name: "Tests", state: "FAILED" },
      ]);
      return "red";
    },
    asksBitbucket: false,
    crewVerdict: "red",
    stoppedBy: (stop, reading) => stop.ci === reading,
  },
  {
    change: "a build still running",
    arrange: (bitbucket) => {
      bitbucket.setStatuses([
        { key: "lint", name: "Lint", state: "SUCCESSFUL" },
        { key: "test", name: "Tests", state: "INPROGRESS" },
      ]);
      return "pending";
    },
    asksBitbucket: false,
    stoppedBy: (stop, reading) => stop.ci === reading,
  },
  {
    change: "a build someone stopped",
    arrange: (bitbucket) => {
      bitbucket.setStatuses([{ key: "test", name: "Tests", state: "STOPPED" }]);
      return "red";
    },
    asksBitbucket: false,
    crewVerdict: "red",
    stoppedBy: (stop, reading) => stop.ci === reading,
  },
];

for (const refusal of REFUSALS) {
  test(`a merge on bitbucket.org with ${refusal.change} merges nothing and leaves the task open`, async () => {
    let fact = "";
    const merge = await seededMerge((bitbucket, repo) => {
      fact = refusal.arrange(bitbucket, repo);
    }, refusal.crewVerdict);
    try {
      const { page, key, detail, bitbucket } = merge;
      await expect
        .poll(async () => refusal.stoppedBy(stopOf(await detail()), fact), { timeout: 20_000 })
        .toBe(true);
      // Nothing went in: Bitbucket merged nothing (and was asked only where
      // nothing before the merge could tell), and the task is still open
      // with its work on its branch.
      expect(bitbucket.merges()).toEqual([]);
      expect(bitbucket.requests().filter((request) => request.endsWith("/merge"))).toHaveLength(
        refusal.asksBitbucket ? 1 : 0,
      );
      await expect(noteLines(page, key)).toHaveCount(1);
      await expect(noteLines(page, key)).toContainText(/Cannot merge|Your merge/);
      await expect(putInLine(page, key)).toHaveCount(0);
      expect(await detail()).toMatchObject({ status: "active", closedReason: null });
      expect(existsSync(join(merge.worktreeDir, "sync.txt"))).toBe(true);
    } finally {
      await merge.close();
    }
  });
}

// Bitbucket's 202 is a merge it has not finished: the pull request is read,
// and a merge request whose outcome is not known is never resent. Only a
// kept approval's merge reaches the send, so the click is on the card the
// app published.
test("a merge Bitbucket accepted and has not finished merges nothing yet, is not sent again, and leaves the task open", async () => {
  const opened = await openedOnBitbucket();
  try {
    const { page, task, detail, bitbucket } = opened;
    bitbucket.mergeLater(true);
    await page.getByRole("button", { name: MERGE_WORDS["merge-pr"], exact: true }).click();
    await expect
      .poll(async () => stopOf(await detail()).problem)
      .toContain(task.delivery?.changeLabel ?? "#1");
    expect(bitbucket.merges()).toEqual([]);
    expect(bitbucket.requests().filter((request) => request.endsWith("/merge"))).toHaveLength(1);
    await expect(noteLines(page, task.key)).toHaveCount(1);
    await expect(noteLines(page, task.key)).toContainText(/Cannot merge|Your merge/);
    await expect(putInLine(page, task.key)).toHaveCount(0);
    expect(await detail()).toMatchObject({ status: "active", closedReason: null });
    expect(git("-C", opened.worktreeDir, "log", "-1", "--format=%s", task.repo?.branch ?? "")).toBe(
      MOCK_GITHUB_CHANGE.title,
    );
  } finally {
    await opened.close();
  }
});

test("a push that lands while Bitbucket merges is merged with the approved version, and the merge line says so", async () => {
  const opened = await openedOnBitbucket();
  try {
    const { page, task, detail, bitbucket } = opened;
    let newer = "";
    // Bitbucket merges whatever the branch holds when its merge runs.
    bitbucket.onMergeRequest(() => {
      if (!newer) newer = opened.push("feat: a note pushed during the merge");
    });
    await page.getByRole("button", { name: MERGE_WORDS["merge-pr"], exact: true }).click();
    await expect(putInLine(page, task.key)).toBeVisible({ timeout: 30_000 });
    expect(bitbucket.merges()).toEqual([expect.objectContaining({ id: 1, head: newer })]);
    await expect(putInLine(page, task.key)).toContainText(
      englishOf(said("mergedChangeNewerOn", { change: "#1", place: "Bitbucket" })),
    );
    await expect.poll(detail).toMatchObject({ status: "done", closedReason: "merged" });
  } finally {
    await opened.close();
  }
});

test("a Bitbucket project added before pull requests, with no sign-in on file, merges nothing and asks for the sign-in or keeping it here", async () => {
  const merge = await seededMerge(() => {}, "ready", false);
  try {
    const { page, key, detail, bitbucket } = merge;
    await expect
      .poll(async () => {
        const { notes } = stopOf(await detail());
        return notes.includes('"Sync the notes"') && notes.includes("Bitbucket");
      })
      .toBe(true);
    expect(bitbucket.merges()).toEqual([]);
    expect(bitbucket.requests().filter((request) => request.startsWith("POST "))).toEqual([]);
    await expect(putInLine(page, key)).toHaveCount(0);
    expect(await detail()).toMatchObject({ status: "active", closedReason: null });
  } finally {
    await merge.close();
  }
});
