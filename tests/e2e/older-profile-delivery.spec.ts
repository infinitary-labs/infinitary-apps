import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { openDatabase } from "../../src/core/storage/db";
import { taskReadTable } from "../../src/core/storage/taskRecordFields";
import {
  type MergeAuthorization,
  type TaskDelivery,
  TaskStore,
} from "../../src/core/storage/taskRecords";
import { seedTask } from "../../src/core/tasks/seedTask";
import type { TaskDetail } from "../../src/shared/tasks";
import type { WriteAsk } from "../../src/shared/writeAsk";
import { scratchDir } from "../helpers/scratchDirs";
import { seedDelivery } from "../helpers/taskDelivery";
import { seedGitHubSignIn, startGitHubStub } from "./githubStub";
import { type LaunchedApp, launchApp } from "./launch";
import { asSavedByOlderRelease } from "./olderProfile";
import { seedHostedOrigins, seedProject } from "./projectSeed";
import { readSavedData } from "./savedData";
import { firstmateFields, taskWriters } from "./scenarios/olderProfileReads";
import { upgradedRelationshipsRead } from "./scenarios/upgradedRelationshipsRead";

// A profile an older release saved, opened in this build: the delivery half
// of the upgrade journeys (docs/saved-data-compatibility.md).

/** The tasks a profile's change evidence and permissions are seeded on, by role. */
const DELIVERED = {
  // Read only: what the window and the first mate read must not move.
  merged: "upgraded-merged-change",
  held: "upgraded-held-approval",
  // Effects: what a kept approval or a settle does at the upgraded boot.
  unanswered: "upgraded-unanswered-merge",
  moved: "upgraded-moved-version",
  pending: "upgraded-pending-settle",
} as const;
const CHART_REPO = "repo-chart";
const CHART_ORIGIN = { host: "github.com", owner: "octo", name: "chart" } as const;
/** The pull request each task's branch has on GitHub, by role. */
const CHART_PULLS = { merged: 61, held: 62, unanswered: 71, moved: 72, pending: 73 } as const;

/**
 * A project on GitHub with one working copy and branch per task, each
 * branch two commits past main: the change, then one more push.
 */
function seedChartProject(userDataDir: string) {
  const repoDir = join(userDataDir, "chart");
  const git = (...args: string[]) => execFileSync("git", args, { stdio: "pipe" }).toString().trim();
  git("init", "--initial-branch=main", repoDir);
  git("-C", repoDir, "config", "user.name", "Test");
  git("-C", repoDir, "config", "user.email", "test@localhost");
  git("-C", repoDir, "commit", "--allow-empty", "-m", "chore: start the chart");
  const branches = {} as Record<
    keyof typeof DELIVERED,
    { branch: string; worktreeDir: string; first: string; head: string }
  >;
  for (const [role, id] of Object.entries(DELIVERED)) {
    const branch = `fm/task-${id}`;
    const worktreeDir = join(userDataDir, "worktrees", id);
    git("-C", repoDir, "worktree", "add", "-b", branch, worktreeDir);
    writeFileSync(join(worktreeDir, `${role}.txt`), `The ${role} change.\n`);
    git("-C", worktreeDir, "add", ".");
    git("-C", worktreeDir, "commit", "-m", `feat: the ${role} change`);
    const first = git("-C", worktreeDir, "rev-parse", "HEAD");
    git(
      "-C",
      worktreeDir,
      "commit",
      "--allow-empty",
      "-m",
      `fix: the ${role} change, pushed again`,
    );
    branches[role as keyof typeof DELIVERED] = {
      branch,
      worktreeDir,
      first,
      head: git("-C", worktreeDir, "rev-parse", "HEAD"),
    };
  }
  const db = openDatabase(userDataDir);
  try {
    seedProject(db, {
      id: CHART_REPO,
      path: repoDir,
      name: "chart",
      setupKind: "clone",
      origin: `https://${CHART_ORIGIN.host}/${CHART_ORIGIN.owner}/${CHART_ORIGIN.name}.git`,
      runsOn: null,
      delivery: "direct-pr",
      rigor: "quick",
    });
    seedHostedOrigins(db, userDataDir);
  } finally {
    db.close();
  }
  return { repoDir, branches };
}

type ChartProject = ReturnType<typeof seedChartProject>;

/** The captain's kept merge approval of a task's pull request, at this version. */
function keptApproval(
  project: ChartProject,
  role: keyof typeof DELIVERED,
  approvedHead: string,
  extra: Partial<MergeAuthorization> = {},
): MergeAuthorization {
  return {
    version: 1,
    id: `approval-${role}`,
    generation: 1,
    issuer: "captain",
    at: Date.now() - 30 * 60_000,
    card: { id: `card-${role}`, offerId: `offer-${role}`, actionId: "merge" },
    target: {
      repoId: CHART_REPO,
      ...CHART_ORIGIN,
      prNumber: CHART_PULLS[role],
      branch: project.branches[role].branch,
      delivery: "direct-pr",
      method: "squash",
    },
    approvedHead,
    lineage: [],
    proceedWithOpen: false,
    status: "standing",
    ...extra,
  };
}

/** A task's change on GitHub as its crewmate opened it, its checks passed at this version. */
function changeOn(role: keyof typeof DELIVERED, head: string) {
  const number = CHART_PULLS[role];
  return {
    mode: "direct-pr" as const,
    prNumber: number,
    prUrl: `https://github.com/octo/chart/pull/${number}`,
    changeLabel: `#${number}`,
    headSha: head,
    ci: "green" as const,
    ciAt: Date.now() - 40 * 60_000,
  };
}

/**
 * Change evidence and permissions as this build writes them, through its
 * own writer, on two tasks nothing at boot acts on: a merged task with its
 * spent approval and receipt, its completion offer and risk, a Careful
 * live validation whose approved effect's outcome nobody knows, a sent
 * write ask, the captain's override and his confirmed required action;
 * and an open task whose approval he withdrew, holding its merge, beside
 * an unsent write ask and a refused completion card.
 */
function seedDeliveryReads(userDataDir: string, project: ChartProject) {
  const { db, tasks } = taskWriters(userDataDir);
  const merged = project.branches.merged;
  const held = project.branches.held;
  try {
    // The merged task's working copy is already gone, so no boot cleans it
    // up while the window reads it.
    seedTask(tasks, {
      id: DELIVERED.merged,
      title: "Label the chart's bars",
      status: "idle",
      repoId: CHART_REPO,
      repoDir: project.repoDir,
    });
    seedTask(tasks, {
      id: DELIVERED.held,
      title: "Color the chart's legend",
      status: "idle",
      repoId: CHART_REPO,
      repoDir: project.repoDir,
      worktreeDir: held.worktreeDir,
      branch: held.branch,
    });
    const requirement = {
      id: "reload-the-chart",
      target: "The chart page",
      title: "Reload the chart page",
      consequence: "The labels show only after a reload.",
      instructions: ["Reload the chart page once."],
      criterion: "The bars show their labels.",
      prerequisites: [],
      completion: { kind: "manual" as const, label: "Reloaded" },
    };
    seedDelivery(tasks, DELIVERED.merged, {
      ...changeOn("merged", merged.head),
      reviewVerdict: "pass",
      reviewSha: merged.head,
      completionOffers: [
        {
          cardId: "card-merged",
          offerId: "offer-merged",
          headSha: merged.head,
          prNumber: CHART_PULLS.merged,
          at: Date.now() - 35 * 60_000,
        },
      ],
      risk: {
        declared: {
          blast: { level: "low", why: "One chart" },
          behavior: { level: "low", why: "Labels a person reads" },
          undo: { level: "low", why: "Revert and done" },
          evidence: { level: "low", why: "Shown working" },
          sensitivity: { level: "low", why: "None" },
          novelty: { level: "low", why: "Well-trodden code" },
          deps: { level: "low", why: "None" },
        },
      },
      mergeAuthorization: keptApproval(project, "merged", merged.head, {
        status: "consumed",
        endedAt: Date.now() - 20 * 60_000,
        receipt: { head: merged.head, sha: `squash-${merged.head}`, at: Date.now() - 20 * 60_000 },
      }),
      writeAsks: [
        {
          id: "ask-label-issue",
          kind: "github",
          host: "github.com",
          place: "GitHub",
          via: "project",
          method: "POST",
          path: "/repos/octo/labels/issues",
          body: '{"title":"Label the bars"}',
          at: Date.now() - 33 * 60_000,
          sentAt: Date.now() - 32 * 60_000,
          outcome: { kind: "sent", status: 201 },
        } as unknown as WriteAsk,
      ],
      requiredActionOffer: {
        cardId: "card-merged",
        offerId: "offer-merged",
        head: merged.head,
        actions: [requirement],
      },
      captainAction: {
        requirements: [
          {
            source: DELIVERED.merged,
            offer: "offer-merged",
            head: merged.head,
            action: requirement,
          },
        ],
        generation: 1,
        state: "confirmed",
        cardId: "card-merged",
        presentedGeneration: 1,
        activatedAt: Date.now() - 20 * 60_000,
        completedAt: Date.now() - 10 * 60_000,
      },
      // An override on the review hold, as a release before INF-1876
      // retired that hold wrote it: the record keeps it and names it retired.
      override: {
        words: "Merge it, the review is late.",
        holds: ["review"],
        until: "version",
        head: merged.head,
        at: Date.now() - 36 * 60_000,
      } as unknown as TaskDelivery["override"],
      liveValidation: {
        stateRevision: 2,
        scenarioRevision: 1,
        scenarios: [],
        plans: [],
        runs: [],
        reviews: [],
        permissions: [
          {
            request: {
              kind: "effect",
              id: "post-preview",
              head: merged.head,
              scenario: "preview",
              action: "Post the preview link",
              destination: "the pull request",
              audience: "collaborators",
              visibility: "others",
              persistent: true,
              purpose: "Show the labels",
              lastingEffects: "A comment stays",
              cleanup: "Delete the comment",
              access: "Your GitHub sign-in",
              preChange: false,
              prerequisitePublication: false,
            },
            scenario: {
              id: "preview",
              source: "the captain's ask",
              importance: "required",
              action: "Open the preview",
              expected: "The labels draw",
              adverse: "No labels",
              environment: "The preview site",
              signal: "The bars' labels",
              boundary: "Read-only",
            },
            state: "unknown",
            at: Date.now() - 34 * 60_000,
            decision: { card: "card-validate", offer: "offer-validate", action: "approve" },
          },
        ],
      } as unknown as TaskDelivery["liveValidation"],
      validationHead: merged.head,
    });
    tasks.close(DELIVERED.merged, { status: "done", reason: "merged", actor: "captain" });

    seedDelivery(tasks, DELIVERED.held, {
      ...changeOn("held", held.head),
      completionOffers: [
        {
          cardId: "card-held",
          offerId: "offer-held",
          headSha: held.first,
          prNumber: CHART_PULLS.held,
          at: Date.now() - 35 * 60_000,
        },
      ],
      mergeAuthorization: keptApproval(project, "held", held.first, {
        status: "revoked",
        reason: "the captain withdrew it",
        endedAt: Date.now() - 25 * 60_000,
        holds: true,
      }),
      writeAsks: [
        {
          id: "ask-legend-issue",
          kind: "github",
          host: "github.com",
          place: "GitHub",
          via: "project",
          method: "POST",
          path: "/repos/octo/legend/issues",
          body: '{"title":"Pick the legend colors"}',
          at: Date.now() - 24 * 60_000,
        } as WriteAsk,
      ],
      cardRefusal: {
        at: Date.now() - 23 * 60_000,
        title: "Color the chart's legend",
        reason: "checks",
        why: "The checks have not passed at this version.",
      },
    });
    const key = (id: string) => tasks.get(id)?.key ?? "";
    return { merged: key(DELIVERED.merged), held: key(DELIVERED.held) };
  } finally {
    db.close();
  }
}

/**
 * The tasks whose permissions act at boot, seeded while the app is stopped:
 * a kept merge whose request went out and whose answer never came, its
 * pull request merged by hand meanwhile; a kept merge of an earlier
 * version than the pull request now holds; and a merge the captain asked
 * for that a quit interrupted.
 */
function seedDeliveryEffects(userDataDir: string, project: ChartProject): void {
  const { db, tasks } = taskWriters(userDataDir);
  try {
    const titles = {
      unanswered: "Sort the chart's bars",
      moved: "Round the chart's corners",
      pending: "Space the chart's ticks",
    } as const;
    for (const role of ["unanswered", "moved", "pending"] as const)
      seedTask(tasks, {
        id: DELIVERED[role],
        title: titles[role],
        status: "idle",
        repoId: CHART_REPO,
        repoDir: project.repoDir,
        worktreeDir: project.branches[role].worktreeDir,
        branch: project.branches[role].branch,
      });
    const { unanswered, moved, pending } = project.branches;
    seedDelivery(tasks, DELIVERED.unanswered, {
      ...changeOn("unanswered", unanswered.head),
      mergeAuthorization: keptApproval(project, "unanswered", unanswered.head, {
        attempt: { token: "attempt-unanswered", head: unanswered.head, at: Date.now() - 60_000 },
      }),
    });
    seedDelivery(tasks, DELIVERED.moved, {
      ...changeOn("moved", moved.head),
      mergeAuthorization: keptApproval(project, "moved", moved.first),
    });
    seedDelivery(tasks, DELIVERED.pending, changeOn("pending", pending.head));
    tasks.delivery.setPendingSettle(DELIVERED.pending, {
      mode: "merge-pr",
      actor: "captain",
      requestedAt: Date.now() - 60_000,
      proceedWithOpen: false,
    });
  } finally {
    db.close();
  }
}

/** Each seeded task's delivery facts as the saved rows hold them. */
function savedDelivery(userDataDir: string) {
  return readSavedData(userDataDir, (db) => {
    const has = (table: string) =>
      Boolean(
        db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
      );
    const ids = JSON.stringify(Object.values(DELIVERED));
    const rows = (table: string) =>
      has(table)
        ? db
            .prepare(
              `SELECT * FROM ${table} WHERE task_id IN (SELECT value FROM json_each(?)) ORDER BY task_id`,
            )
            .all(ids)
        : undefined;
    return {
      // An older release's profile has neither table.
      evidence: rows("task_delivery_evidence") as Record<string, unknown>[] | undefined,
      permissions: rows("task_permissions") as Record<string, unknown>[] | undefined,
      tasks: db
        .prepare(
          `SELECT id, delivery_json, pending_settle_json FROM ${taskReadTable(db)}
           WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id`,
        )
        .all(ids) as {
        id: string;
        delivery_json: string | null;
        pending_settle_json: string | null;
      }[],
      records: Object.fromEntries(
        new TaskStore(db)
          .list()
          .filter((record) => (Object.values(DELIVERED) as string[]).includes(record.id))
          .map((record) => [
            record.id,
            {
              status: record.status,
              closedReason: record.closedReason,
              delivery: record.delivery,
              pendingSettle: record.pendingSettle,
            },
          ]),
      ),
    };
  });
}

/** The delivery fields the first mate reads of each read-only task, by role. */
const DELIVERY_FIELDS = {
  merged: ["status", "change", "required_action", "live_validation"],
  held: ["status", "change"],
} as const;

/** What the window and the first mate read of the read-only tasks' change and permissions. */
async function deliveryAsRead(
  app: LaunchedApp,
  keys: Record<keyof typeof DELIVERY_FIELDS, string>,
) {
  const details = await app.page.evaluate(
    (ids) => Promise.all(ids.map((id) => window.infinitary.tasks.detail(id))),
    [DELIVERED.merged, DELIVERED.held],
  );
  const shown = Object.fromEntries(
    details.map((detail: TaskDetail) => [
      detail.id,
      {
        status: detail.status,
        closedReason: detail.closedReason,
        flags: detail.flags,
        delivery: detail.delivery,
        requiredAction: detail.requiredAction,
        liveValidation: detail.liveValidation,
        hold: detail.hold,
        asks: detail.asks,
        events: detail.events.map((event) => event.id),
      },
    ]),
  );
  const firstmate: Record<string, Record<string, unknown>> = {};
  for (const [role, fields] of Object.entries(DELIVERY_FIELDS))
    firstmate[role] = await firstmateFields(
      app,
      keys[role as keyof typeof DELIVERY_FIELDS],
      fields,
    );
  return { window: shown, firstmate };
}

/**
 * INF-1296 piece 4, the captain's "i want to make sure this gets good e2e
 * test coverage to ensure exsiting users don't get regressed during this
 * migration". Promised result: change evidence and permissions an older
 * release kept in a task's delivery facts and its settle that had not run
 * on the task row - a spent approval with its receipt, completion offers,
 * risk, live validation with an effect of unknown outcome, write asks, an
 * override, a required action, a withdrawn approval holding the merge and
 * a refused card - read the same in the window and through the first
 * mate's `tasks` reads after the upgrade moves them into their own records
 * and after a restart; and at the upgraded boot a kept merge whose answer
 * never came is read back from GitHub and never sent again, a kept merge
 * of an earlier version than the pull request holds waits for its repair,
 * and the interrupted settle merges exactly once. Data: tasks written
 * through the app's own writer on a real git project with a working copy
 * per task, rewritten into the older release's form
 * (`asSavedByOlderRelease`), and a disposable GitHub (`githubStub`).
 * Completion: the first mate's answers after its reads, the merges GitHub
 * recorded, and the saved rows read back after the app quits.
 * Prerequisites: the hermetic launcher and local git. Shared resources: none.
 */
test("change evidence and permissions an older release saved read the same after the upgrade, and no kept merge is sent twice", async () => {
  const userDataDir = scratchDir("infinitary-upgraded-delivery-");
  const project = seedChartProject(userDataDir);
  const github = await startGitHubStub();
  for (const [role, number] of Object.entries(CHART_PULLS)) {
    const branch = project.branches[role as keyof typeof DELIVERED];
    github.serveNumbered({
      number,
      branch: branch.branch,
      title: `feat: the ${role} change`,
      headSha: branch.head,
    });
  }
  github.mergeByHand(CHART_PULLS.merged);
  seedGitHubSignIn(userDataDir);
  const keys = seedDeliveryReads(userDataDir, project);
  const launch = () =>
    launchApp({
      withMockProvider: true,
      scenarios: [upgradedRelationshipsRead],
      userDataDir,
      env: github.env,
    });
  const mergesOf = (role: keyof typeof DELIVERED) =>
    github.merges().filter((merge) => merge.number === CHART_PULLS[role]);

  let app: LaunchedApp | undefined = await launch();
  try {
    const before = await deliveryAsRead(app, keys);
    // The reads name what was seeded, or a match below would compare nothing.
    expect(before.window[DELIVERED.merged]).toMatchObject({
      status: "done",
      requiredAction: { state: "confirmed" },
    });
    expect(before.firstmate.merged?.live_validation).toMatchObject({
      permissions: [{ state: "unknown" }],
    });
    expect(before.firstmate.held?.change).toEqual({
      label: `#${CHART_PULLS.held}`,
      url: `https://github.com/octo/chart/pull/${CHART_PULLS.held}`,
    });
    await app.close();
    app = undefined;
    const readOnly = savedDelivery(userDataDir);
    expect(readOnly.records[DELIVERED.held]?.delivery?.mergeAuthorization).toMatchObject({
      status: "revoked",
      holds: true,
    });

    seedDeliveryEffects(userDataDir, project);
    github.mergeByHand(CHART_PULLS.unanswered);
    const recorded = savedDelivery(userDataDir);
    const older = asSavedByOlderRelease(userDataDir);
    // Something was rewritten, or the journey would open this build's own profile.
    expect(older.delivery).toEqual(
      expect.arrayContaining(
        Object.values(DELIVERED).map((taskId) => ({
          taskId,
          evidence: true,
          permissions: true,
        })),
      ),
    );
    const asOlder = savedDelivery(userDataDir);
    expect(asOlder.evidence).toBeUndefined();
    expect(asOlder.permissions).toBeUndefined();
    // The older release's rows hold every fact this build read, and the settle on the row.
    expect(asOlder.records).toEqual(recorded.records);
    expect(
      JSON.parse(
        String(asOlder.tasks.find((row) => row.id === DELIVERED.pending)?.pending_settle_json),
      ),
    ).toMatchObject({ mode: "merge-pr" });

    await test.step("upgrade: the window and the first mate read every change and permission as before", async () => {
      app = await launch();
      expect(await deliveryAsRead(app, keys)).toEqual(before);
    });

    await test.step("upgrade: the unanswered merge is read back, never sent again", async () => {
      const task = () =>
        app?.page.evaluate((id) => window.infinitary.tasks.detail(id), DELIVERED.unanswered);
      await expect.poll(task).toMatchObject({ status: "done", closedReason: "merged" });
      expect(mergesOf("unanswered")).toEqual([]);
      expect(
        github
          .requests()
          .filter((request) => request.includes(`/pulls/${CHART_PULLS.unanswered}/merge`)),
      ).toEqual([]);
    });

    await test.step("upgrade: the interrupted settle merges once, and the moved version waits", async () => {
      await expect.poll(() => mergesOf("pending").length).toBe(1);
      expect(mergesOf("pending")[0]?.sha).toBe(project.branches.pending.head);
      await expect
        .poll(() =>
          app?.page.evaluate((id) => window.infinitary.tasks.detail(id), DELIVERED.pending),
        )
        .toMatchObject({ status: "done", closedReason: "merged" });
      await expect
        .poll(
          () =>
            savedDelivery(userDataDir).records[DELIVERED.moved]?.delivery?.mergeAuthorization
              ?.waiting?.on,
        )
        .toBe("repair");
      expect(mergesOf("moved")).toEqual([]);
      await app?.close();
      app = undefined;
      const saved = savedDelivery(userDataDir);
      expect(saved.records[DELIVERED.unanswered]?.delivery?.mergeAuthorization).toMatchObject({
        status: "consumed",
        approvedHead: project.branches.unanswered.head,
        // The pull request read back: its merge, never one this app sent.
        receipt: {
          head: project.branches.unanswered.head,
          sha: `squash-${project.branches.unanswered.head}`,
        },
      });
      expect(
        saved.records[DELIVERED.unanswered]?.delivery?.mergeAuthorization?.attempt,
      ).toBeUndefined();
      expect(saved.records[DELIVERED.moved]?.delivery?.mergeAuthorization).toMatchObject({
        status: "standing",
        approvedHead: project.branches.moved.first,
      });
      expect(saved.records[DELIVERED.pending]?.pendingSettle).toBeNull();
      // The read-only tasks' rows moved as saved, and the column keeps only history.
      for (const id of [DELIVERED.merged, DELIVERED.held]) {
        expect(saved.records[id]).toEqual(readOnly.records[id]);
        expect(saved.evidence?.find((row) => row.task_id === id)).toEqual(
          recorded.evidence?.find((row) => row.task_id === id),
        );
        expect(saved.permissions?.find((row) => row.task_id === id)).toEqual(
          recorded.permissions?.find((row) => row.task_id === id),
        );
      }
      for (const row of saved.tasks) {
        expect(row.pending_settle_json).toBeNull();
        expect(Object.keys(JSON.parse(row.delivery_json ?? "{}"))).toEqual(
          expect.not.arrayContaining(["mergeAuthorization", "completionOffers", "headSha", "ci"]),
        );
      }
    });

    await test.step("restart: the same reads, and no merge is sent again", async () => {
      const merges = github.merges();
      app = await launch();
      expect(await deliveryAsRead(app, keys)).toEqual(before);
      await expect
        .poll(
          () =>
            savedDelivery(userDataDir).records[DELIVERED.moved]?.delivery?.mergeAuthorization
              ?.waiting?.on,
        )
        .toBe("repair");
      await app.close();
      app = undefined;
      expect(github.merges()).toEqual(merges);
    });
  } finally {
    await app?.close();
    await github.close();
  }
});
