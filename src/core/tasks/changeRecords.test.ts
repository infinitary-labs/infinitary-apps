import { readFileSync } from "node:fs";
import type { ChangeRecord } from "@shared/change";
import type { MergeReview } from "@shared/mergeReview";
import type { WorkShape } from "@shared/routingPolicy";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import {
  type AppDatabase,
  CHANGES_VERSION,
  openDatabase,
  openInMemoryDatabase,
} from "../storage/db";
import { type MergeAuthorization, type TaskDelivery, TaskStore } from "../storage/taskStore";
import { seedTask } from "./seedTask";
import { TaskService } from "./taskService";

// INF-1868 piece 1, the captain's approved plan: the host's typed change
// record - repository, base, head, versions, and per-version check facts,
// review verdict, story and consent - with a read-through migration that
// makes one change per open task with a pull request or branch, while every
// reader keeps reading the delivery facts where they were.

function setup(db = openInMemoryDatabase()) {
  let now = 10_000;
  const tasks = new TaskService({ db, strict: true, now: () => (now += 1_000) });
  return { db, tasks };
}

/** A project the app manages, on the host its origin names. */
function addProject(
  db: AppDatabase,
  id: string,
  forge: "github" | "gitlab" | "git",
  kind: "project" | "personal" = "project",
): void {
  const origin =
    forge === "github"
      ? `https://github.com/octo/${id}.git`
      : forge === "gitlab"
        ? `https://gitlab.com/octo/${id}.git`
        : null;
  db.prepare(
    "INSERT INTO repos (id, path, name, added_at, setup_kind, origin, forge_kind, forge_host, delivery, autonomy, kind) VALUES (?, ?, ?, 1, 'clone', ?, ?, ?, ?, 0, ?)",
  ).run(
    id,
    `/fleet/${id}`,
    id,
    origin,
    forge,
    forge === "git" ? null : `${forge}.com`,
    kind === "personal" ? "local-only" : "direct-pr",
    kind,
  );
}

const APPROVED = "a".repeat(40);
const REPAIRED = "b".repeat(40);
const BASE = "c".repeat(40);
const PLAIN = "d".repeat(40);

const KEPT: MergeAuthorization = {
  version: 1,
  id: "approval-1",
  generation: 3,
  issuer: "captain",
  at: 4_000,
  card: { id: "card-done", offerId: "offer-2", actionId: "merge", interactionId: "click-1" },
  target: {
    repoId: "chart",
    host: "github.com",
    owner: "octo",
    name: "chart",
    prNumber: 88,
    branch: "fm/task-kept",
    delivery: "direct-pr",
    method: "squash",
  },
  approvedHead: APPROVED,
  lineage: [
    {
      fromHead: APPROVED,
      toHead: REPAIRED,
      newBase: BASE,
      impact: "none",
      changedPaths: [],
      evidence: "The same change on main's newer guide.",
      validation: "The checks passed at the repaired version.",
      generation: 2,
      at: 5_000,
    },
  ],
  proceedWithOpen: false,
  status: "standing",
};

/** The delivery facts of a kept merge approval at its repaired version, every version fact named. */
/** The owned merge review of the kept profile's pull request, as `check_change` records one. */
const KEPT_REVIEW: MergeReview = {
  id: "review-1",
  relationship: "owned",
  kind: "github",
  host: "github.com",
  owner: "octo",
  name: "chart",
  number: 88,
  headSha: APPROVED,
  base: "main",
  branch: "fm/task-kept",
  method: "squash",
  title: "feat(chart): color the chart",
  at: 3_800,
};

const KEPT_DELIVERY: Partial<TaskDelivery> = {
  mode: "direct-pr",
  prNumber: 88,
  prUrl: "https://github.com/octo/chart/pull/88",
  changeLabel: "#88",
  headSha: REPAIRED,
  changeLines: { base: BASE, head: REPAIRED, added: 12, deleted: 3, at: 5_200 },
  ci: "green",
  ciAt: 5_300,
  ciStartedAt: 5_100,
  ciFinishedAt: 5_290,
  checks: {
    headSha: REPAIRED,
    items: [{ name: "unit-tests", state: "success" }],
    complete: true,
    absenceDeclared: false,
  },
  reviewVerdict: "pass",
  reviewSha: REPAIRED,
  reviewRisk: "low",
  reviewRiskNote: "One chart.",
  reviewedAt: 5_250,
  reviewChange: "reading-b",
  completionOffers: [
    { cardId: "card-done", offerId: "offer-2", headSha: APPROVED, prNumber: 88, at: 3_900 },
  ],
  mergeAuthorization: KEPT,
  mergeReviews: [KEPT_REVIEW],
  override: {
    words: "Merge it even though the review is late.",
    holds: ["waits"],
    until: "version",
    head: REPAIRED,
    at: 5_400,
  } as unknown as TaskDelivery["override"],
  presentation: {
    revisions: [
      { revision: 1, head: APPROVED, base: "main", title: "feat(chart): color the chart" },
    ],
    receipts: [],
    published: {
      revision: 1,
      head: APPROVED,
      state: "confirmed",
      region: "",
      regionHash: "",
      number: 88,
    },
  } as unknown as TaskDelivery["presentation"],
};

/** The delivery facts of an open pull request, as a real older profile saved them. */
function savedOpen(): { delivery: Partial<TaskDelivery>; branch: string; repoId: string } {
  const fixture = JSON.parse(
    readFileSync(
      new URL("../../../tests/fixtures/replay/sep14-real/tables.json", import.meta.url),
      "utf8",
    ),
  ) as {
    tasks: {
      id: string;
      status: string;
      branch: string;
      repo_id: string;
      delivery_json: string | null;
    }[];
  };
  const saved = fixture.tasks.find(
    (row) => row.status === "active" && row.delivery_json?.includes('"prNumber"'),
  );
  if (!saved?.delivery_json) throw new Error("The fixture has no open pull request.");
  return { delivery: JSON.parse(saved.delivery_json), branch: saved.branch, repoId: saved.repo_id };
}

/**
 * A profile as the release before this migration saved it: on GitHub, a kept
 * merge approval at its repaired version, a crewmate that has only started,
 * and a real profile's open pull request; on GitLab, a merge request with
 * no version read yet; on a plain Git host, a branch with its checks; and
 * the tasks that carry no change - one not started, an answer, a review
 * the host raised on another task's pull request, work in the personal
 * workspace, and two closed tasks.
 */
function olderProfile() {
  const dir = scratchDir("change-records-");
  const at = openDatabase(dir, CHANGES_VERSION - 1);
  addProject(at, "chart", "github");
  addProject(at, "wiki", "gitlab");
  addProject(at, "notes", "git");
  addProject(at, "home", "github", "personal");
  const { tasks } = setup(at);
  seedTask(tasks, {
    id: "kept",
    title: "Color the chart",
    status: "idle",
    repoId: "chart",
    branch: "fm/task-kept",
  });
  seedDelivery(tasks, "kept", KEPT_DELIVERY);
  seedTask(tasks, {
    id: "fresh",
    title: "Label the axis",
    status: "running",
    repoId: "chart",
    branch: "fm/task-fresh",
  });
  const open = savedOpen();
  addProject(at, open.repoId, "github");
  seedTask(tasks, {
    id: "real",
    title: "A real open pull request",
    status: "idle",
    repoId: open.repoId,
    branch: open.branch,
  });
  seedDelivery(tasks, "real", open.delivery);
  seedTask(tasks, {
    id: "opened",
    title: "Explain the legend",
    status: "idle",
    repoId: "wiki",
    branch: "fm/task-opened",
  });
  seedDelivery(tasks, "opened", {
    mode: "direct-pr",
    prNumber: 7,
    prUrl: "https://gitlab.com/octo/wiki/-/merge_requests/7",
    changeLabel: "!7",
    ci: "pending",
  });
  seedTask(tasks, {
    id: "plain",
    title: "Tidy the notes",
    status: "idle",
    repoId: "notes",
    branch: "fm/task-plain",
  });
  seedDelivery(tasks, "plain", { mode: "direct-pr", headSha: PLAIN, ci: "no-pr", ciAt: 6_000 });
  seedTask(tasks, { id: "queued", title: "Not started", status: "queued", repoId: "chart" });
  seedTask(tasks, {
    id: "answer",
    title: "Which chart?",
    status: "idle",
    kind: "question",
    repoId: "chart",
    branch: "fm/task-answer",
  });
  seedTask(tasks, {
    id: "review",
    title: "Review the chart's pull request",
    status: "idle",
    repoId: "chart",
    branch: "fm/task-review",
    parentId: "kept",
    shape: { kind: "review", kind_source: "host:review" } as unknown as WorkShape,
  });
  seedTask(tasks, {
    id: "home",
    title: "Note in the workspace",
    status: "idle",
    repoId: "home",
    branch: "main",
  });
  seedDelivery(tasks, "home", { mode: "in-place" });
  seedTask(tasks, {
    id: "merged",
    title: "Fix the axis",
    status: "idle",
    repoId: "chart",
    branch: "fm/task-merged",
  });
  seedDelivery(tasks, "merged", {
    mode: "direct-pr",
    prNumber: 86,
    headSha: APPROVED,
    landedMode: "pr",
    mergedSha: BASE,
    ci: "merged",
  });
  tasks.close("merged", { status: "done", reason: "merged", actor: "captain" });
  seedTask(tasks, {
    id: "dropped",
    title: "Try a gradient",
    status: "cancelled",
    repoId: "chart",
    branch: "fm/task-dropped",
  });
  at.close();
  return { dir, open };
}

/** What every reader of a task reads of its delivery, in the record's own words. */
function readDelivery(tasks: TaskService) {
  return Object.fromEntries(tasks.list().map((record) => [record.id, record.delivery]));
}

function byTask(store: TaskStore): Record<string, ChangeRecord> {
  return Object.fromEntries(store.changes.list().map((change) => [change.taskId ?? "", change]));
}

/** The change less what the store assigns - its id and clock - so a match reads the facts. */
function facts(change: ChangeRecord | undefined) {
  if (!change) return undefined;
  const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...rest } = change;
  return rest;
}

describe("the migration of an older release's open changes", () => {
  it("makes one change per open task with a pull request or branch, with every version fact the task names, and every reader reads the same", () => {
    const { dir, open } = olderProfile();
    const before = openDatabase(dir, CHANGES_VERSION - 1);
    const readBefore = readDelivery(setup(before).tasks);
    const viewsBefore = before.prepare("SELECT * FROM v_tasks_v1 ORDER BY task_id").all();
    before.close();
    expect(readBefore.kept?.mergeAuthorization?.approvedHead).toBe(APPROVED);

    const upgraded = openDatabase(dir);
    const { tasks } = setup(upgraded);
    expect(readDelivery(tasks)).toEqual(readBefore);
    expect(upgraded.prepare("SELECT * FROM v_tasks_v1 ORDER BY task_id").all()).toEqual(
      viewsBefore,
    );

    const changes = byTask(new TaskStore(upgraded));
    expect(Object.keys(changes).sort()).toEqual(["fresh", "kept", "opened", "plain", "real"]);
    expect(facts(changes.kept)).toEqual({
      repoId: "chart",
      base: "main",
      head: { branch: "fm/task-kept" },
      handle: {
        kind: "pr",
        number: 88,
        url: "https://github.com/octo/chart/pull/88",
        label: "#88",
      },
      raisedBy: { kind: "task", task: "kept" },
      taskId: "kept",
      override: null,
      receipt: null,
      versions: [
        {
          seq: 1,
          head: APPROVED,
          at: 3_800,
          checks: null,
          review: null,
          story: {
            revisions: [{ revision: 1, title: "feat(chart): color the chart" }],
            published: { revision: 1, state: "confirmed", number: 88 },
          },
          consent: {
            click: {
              authorization: "approval-1",
              generation: 3,
              card: { id: "card-done", offerId: "offer-2", actionId: "merge" },
              status: "standing",
              at: 4_000,
            },
          },
        },
        {
          seq: 2,
          head: REPAIRED,
          at: 5_000,
          checks: {
            state: "green",
            snapshot: KEPT_DELIVERY.checks,
            at: 5_300,
            startedAt: 5_100,
            finishedAt: 5_290,
            lines: { base: BASE, added: 12, deleted: 3, at: 5_200 },
          },
          review: {
            verdict: "pass",
            risk: "low",
            riskNote: "One chart.",
            at: 5_250,
            reading: "reading-b",
          },
          story: null,
          consent: {
            carried: {
              authorization: "approval-1",
              from: APPROVED,
              impact: "none",
              generation: 2,
              at: 5_000,
            },
            override: KEPT_DELIVERY.override,
          },
        },
      ],
    });
    // A crewmate that has only started: the branch is the change, with nothing read yet.
    expect(facts(changes.fresh)).toEqual({
      repoId: "chart",
      base: null,
      head: { branch: "fm/task-fresh" },
      handle: null,
      raisedBy: { kind: "task", task: "fresh" },
      taskId: "fresh",
      override: null,
      receipt: null,
      versions: [],
    });
    // A real profile's open pull request: its handle, and no version until a head is read.
    expect(facts(changes.real)).toMatchObject({
      repoId: open.repoId,
      head: { branch: open.branch },
      handle: { kind: "pr", number: open.delivery.prNumber, url: open.delivery.prUrl },
      versions: [],
    });
    expect(changes.opened?.handle).toEqual({
      kind: "mr",
      number: 7,
      url: "https://gitlab.com/octo/wiki/-/merge_requests/7",
      label: "!7",
    });
    expect(changes.opened?.versions).toEqual([]);
    // A plain Git host keeps no handle: the branch and its checks are the change.
    expect(changes.plain?.handle).toBeNull();
    expect(changes.plain?.versions).toEqual([
      {
        seq: 1,
        head: PLAIN,
        at: 6_000,
        checks: { state: "no-pr", at: 6_000 },
        review: null,
        story: null,
        consent: null,
      },
    ]);
    // The migration dates each change by its task's own clock.
    for (const change of Object.values(changes)) {
      expect(change.createdAt).toBe(tasks.get(change.taskId ?? "")?.updatedAt);
      expect(change.updatedAt).toBe(change.createdAt);
    }
    upgraded.close();

    // A restart reads the same, and migrates nothing twice.
    const again = openDatabase(dir);
    const reread = byTask(new TaskStore(again));
    expect(Object.fromEntries(Object.entries(reread).map(([task, c]) => [task, c.id]))).toEqual(
      Object.fromEntries(Object.entries(changes).map(([task, c]) => [task, c.id])),
    );
    expect(again.prepare("SELECT COUNT(*) AS n FROM change_versions").get()).toEqual({ n: 3 });
    again.close();
  });

  it("leaves out what an older release saved without its pull request in a slot that records a referenced one - a selection's head and checks, the override given there, a head left beside the own number when a selection cleared, and an override at the own head - and binds the upgraded writers' stamped reading by its number", () => {
    // INF-1884 R2 (round 4) and INF-1873: the older declareOverride writer
    // saved an override without its pull request, and the older check readers
    // a head and checks without theirs; the older noteChange writer named the
    // own change again without moving the head and checks the selection
    // left. The record binds a fact by the pull request it names, never by
    // its head, so one saved without it in a slot that records a referenced
    // pull request is nobody's and is left out - the override at the own
    // head too, which the host cannot tell from one given for the selection.
    // The upgrade reads the saved data as it is; nothing rewrites it.
    const dir = scratchDir("change-records-legacy-");
    const at = openDatabase(dir, CHANGES_VERSION - 1);
    addProject(at, "chart", "github");
    const { tasks } = setup(at);
    const own = "1".repeat(40);
    const reviewed = "e".repeat(40);
    const moved = "f".repeat(40);
    const later = "9".repeat(40);
    const release = (head: string): MergeReview => ({
      id: "review-release",
      relationship: "referenced",
      kind: "github",
      host: "github.com",
      owner: "octo",
      name: "chart",
      number: 151,
      headSha: head,
      base: "main",
      branch: "release-please--branches--main",
      method: "squash",
      title: "chore(main): release 0.2.0",
      at: 7_000,
    });
    const owned = (number: number, task: string): MergeReview => ({
      ...KEPT_REVIEW,
      id: `review-${task}`,
      number,
      headSha: own,
      branch: `fm/task-${task}`,
      at: 6_500,
    });
    const legacyOverride = (head: string) =>
      ({
        words: "Merge the release at its new version; the upload is its only check.",
        holds: ["checks"],
        until: "version",
        head,
        at: 7_500,
      }) as unknown as TaskDelivery["override"];
    const readAt = (head: string) => ({
      headSha: head,
      ci: "green" as const,
      ciAt: 7_200,
      checks: {
        headSha: head,
        items: [{ name: "upload", state: "success" as const }],
        complete: true,
        absenceDeclared: false,
      },
    });
    const selection = {
      mode: "direct-pr" as const,
      prNumber: 151,
      prUrl: "https://github.com/octo/chart/pull/151",
      changeLabel: "#151",
      checkTarget: release(reviewed),
    };
    for (const task of ["selected", "again", "cleared", "kept"])
      seedTask(tasks, {
        id: task,
        title: `Label the axis (${task})`,
        status: "running",
        repoId: "chart",
        branch: `fm/task-${task}`,
      });
    // The release selected and reviewed at its first head, re-read at its moved head, and the override given there.
    seedDelivery(tasks, "selected", {
      ...selection,
      ...readAt(moved),
      mergeReviews: [owned(61, "selected"), release(reviewed)],
      override: legacyOverride(moved),
    });
    // The same after the release moved once more: nothing names the override's head.
    seedDelivery(tasks, "again", {
      ...selection,
      ...readAt(later),
      mergeReviews: [owned(63, "again"), release(reviewed)],
      override: legacyOverride(moved),
    });
    // The selection cleared by the older writer: the own number back, the release's reviewed head and checks still beside it.
    seedDelivery(tasks, "cleared", {
      mode: "direct-pr",
      prNumber: 62,
      prUrl: "https://github.com/octo/chart/pull/62",
      changeLabel: "#62",
      ...readAt(reviewed),
      mergeReviews: [owned(62, "cleared"), release(reviewed)],
    });
    // An override given for the own version before the selection: its head is the owned review's.
    seedDelivery(tasks, "kept", {
      ...selection,
      ...readAt(moved),
      mergeReviews: [owned(64, "kept"), release(reviewed)],
      override: legacyOverride(own),
    });
    at.close();

    const upgraded = openDatabase(dir);
    const summary = (change: ChangeRecord | undefined) => ({
      handle: change?.handle?.number,
      base: change?.base,
      override: change?.override,
      versions: change?.versions.map((v) => [v.head, v.checks?.state ?? null, v.consent]),
    });
    const changes = byTask(new TaskStore(upgraded));
    const ownOnly = (number: number) => ({
      handle: number,
      base: "main",
      override: null,
      versions: [[own, null, null]],
    });
    expect(summary(changes.selected)).toEqual(ownOnly(61));
    expect(summary(changes.again)).toEqual(ownOnly(63));
    expect(summary(changes.cleared)).toEqual(ownOnly(62));
    expect(summary(changes.kept)).toEqual(ownOnly(64));
    // The store reads the same on a later write. An unstamped reading beside
    // the own number still makes no version there, while the upgraded reader's
    // reading, stamped with the pull request it is of, makes the own version's checks.
    const { tasks: after } = setup(upgraded);
    seedDelivery(after, "cleared", readAt(own));
    expect(summary(byTask(new TaskStore(upgraded)).cleared)).toEqual(ownOnly(62));
    const stamped = readAt(own);
    seedDelivery(after, "cleared", { ...stamped, checks: { ...stamped.checks, prNumber: 62 } });
    expect(summary(byTask(new TaskStore(upgraded)).cleared)).toEqual({
      ...ownOnly(62),
      versions: [[own, "green", null]],
    });
    upgraded.close();
  });
});

describe("the change a task carries after the upgrade", () => {
  it("follows the facts that move it: a pull request opened, each version pushed with what was read at it, the merge, and the task's end", () => {
    const { dir } = olderProfile();
    const db = openDatabase(dir);
    const { tasks } = setup(db);
    const store = new TaskStore(db);
    const first = "1".repeat(40);
    const second = "2".repeat(40);

    // The crewmate opens its pull request and pushes a first version.
    seedDelivery(tasks, "fresh", {
      prNumber: 12,
      prUrl: "https://github.com/octo/chart/pull/12",
      changeLabel: "#12",
      headSha: first,
      ci: "pending",
      ciAt: 7_000,
    });
    let change = store.changes.forTask("fresh");
    expect(change?.handle).toEqual({
      kind: "pr",
      number: 12,
      url: "https://github.com/octo/chart/pull/12",
      label: "#12",
    });
    expect(change?.versions.map((v) => [v.seq, v.head, v.checks?.state, v.at])).toEqual([
      [1, first, "pending", 7_000],
    ]);
    expect(change?.updatedAt).toBe(tasks.get("fresh")?.updatedAt);

    // A later reading at the same head: its facts follow, its date is still when the host first saw it.
    seedDelivery(tasks, "fresh", {
      ci: "green",
      ciAt: 7_500,
      checks: {
        headSha: first,
        items: [{ name: "unit-tests", state: "success" }],
        complete: true,
        absenceDeclared: false,
      },
    });
    expect(store.changes.forTask("fresh")?.versions[0]).toMatchObject({
      at: 7_000,
      checks: { state: "green", at: 7_500 },
    });

    // The review, the story and the captain's consent at the first version.
    const approval: MergeAuthorization = {
      ...KEPT,
      id: "approval-12",
      target: { ...KEPT.target, prNumber: 12, branch: "fm/task-fresh" },
      approvedHead: first,
      lineage: [],
      at: 7_900,
    };
    seedDelivery(tasks, "fresh", {
      reviewVerdict: "pass",
      reviewSha: first,
      reviewedAt: 7_600,
      presentation: {
        revisions: [{ revision: 1, head: first, base: "main", title: "feat: label the axis" }],
        receipts: [],
        published: {
          revision: 1,
          head: first,
          state: "confirmed",
          region: "",
          regionHash: "",
          number: 12,
        },
      } as unknown as TaskDelivery["presentation"],
      completionOffers: [
        { cardId: "card-12", offerId: "offer-1", headSha: first, prNumber: 12, at: 7_800 },
      ],
      mergeAuthorization: approval,
      override: {
        words: "Merge it; the late check is the docs build.",
        holds: ["checks"],
        until: "version",
        head: first,
        at: 7_950,
      } as unknown as TaskDelivery["override"],
    });
    const atFirst = store.changes.forTask("fresh")?.versions[0];
    expect(atFirst).toMatchObject({
      head: first,
      at: 7_000,
      review: { verdict: "pass", at: 7_600 },
      story: {
        revisions: [{ revision: 1, title: "feat: label the axis" }],
        published: { revision: 1, state: "confirmed", number: 12 },
      },
      consent: {
        click: { authorization: "approval-12", status: "standing", at: 7_900 },
        override: { holds: ["checks"], head: first },
      },
    });

    // A second version, checked and published: the slot now names only the
    // newest story and the checks at the new head, and the first version
    // keeps every fact read at it.
    seedDelivery(tasks, "fresh", {
      headSha: second,
      ci: "green",
      ciAt: 8_000,
      checks: {
        headSha: second,
        items: [{ name: "unit-tests", state: "success" }],
        complete: true,
        absenceDeclared: false,
      },
      presentation: {
        revisions: [{ revision: 2, head: second, base: "main", title: "feat: label the axis" }],
        receipts: [],
        published: {
          revision: 2,
          head: second,
          state: "confirmed",
          region: "",
          regionHash: "",
          number: 12,
        },
      } as unknown as TaskDelivery["presentation"],
      mergeAuthorization: { ...approval, status: "superseded", endedAt: 8_100 },
    });
    change = store.changes.forTask("fresh");
    expect(change?.versions.map((v) => [v.seq, v.head, v.checks?.state, v.at])).toEqual([
      [1, first, "green", 7_000],
      [2, second, "green", 8_000],
    ]);
    expect(change?.versions[0]).toEqual({
      ...atFirst,
      consent: {
        ...atFirst?.consent,
        click: { ...atFirst?.consent?.click, status: "superseded" },
      },
    });
    expect(change?.versions[1]).toMatchObject({
      checks: { snapshot: { items: [{ name: "unit-tests", state: "success" }] } },
      review: null,
      story: {
        revisions: [{ revision: 2, title: "feat: label the axis" }],
        published: { revision: 2, state: "confirmed", number: 12 },
      },
      consent: null,
    });

    // The merge, and the task's close: one receipt, the record kept.
    seedDelivery(tasks, "fresh", { ci: "merged", landedMode: "pr", mergedSha: BASE });
    tasks.close("fresh", { status: "done", reason: "merged", actor: "captain" });
    const closed = tasks.get("fresh");
    expect(closed?.status).toBe("done");
    change = store.changes.forTask("fresh");
    expect(change?.receipt).toEqual({
      outcome: "merged",
      reason: "merged",
      head: second,
      sha: BASE,
      at: closed?.closedAt,
    });
    expect(change?.versions).toHaveLength(2);
    expect(change?.updatedAt).toBe(closed?.updatedAt);

    // A discard records its own receipt.
    tasks.close("plain", { status: "dropped", reason: "discarded", actor: "captain" });
    expect(store.changes.forTask("plain")?.receipt).toEqual({
      outcome: "discarded",
      reason: "discarded",
      at: tasks.get("plain")?.closedAt,
    });

    // A delivery cleared keeps the change's handle and versions: a fact is never erased.
    store.update("opened", { delivery: null });
    expect(store.changes.forTask("opened")?.handle).toMatchObject({ kind: "mr", number: 7 });
    db.close();

    const again = openDatabase(dir);
    const reread = new TaskStore(again).changes.forTask("fresh");
    expect(reread?.versions).toHaveLength(2);
    expect(reread?.versions[0]?.story?.published).toEqual({
      revision: 1,
      state: "confirmed",
      number: 12,
    });
    expect(reread?.receipt).toMatchObject({ outcome: "merged" });
    again.close();
  });

  it("makes a version only of a head the project's host saw, and attaches what was read at an unpushed head once it is pushed", () => {
    const { db, tasks } = setup();
    addProject(db, "chart", "github");
    const store = new TaskStore(db);
    const unpushed = "e".repeat(40);
    seedTask(tasks, {
      id: "work",
      title: "Color the chart",
      status: "running",
      repoId: "chart",
      branch: "fm/task-work",
    });
    // The host's own lines reading of the working copy, an independent review of
    // the committed version and a story prepared at it: none is a push.
    seedDelivery(tasks, "work", {
      mode: "direct-pr",
      changeLines: { base: BASE, head: unpushed, added: 4, deleted: 1, at: 9_000 },
      reviewVerdict: "pass",
      reviewSha: unpushed,
      reviewedAt: 9_100,
      presentation: {
        revisions: [{ revision: 1, head: unpushed, base: "main", title: "feat(chart): color it" }],
        receipts: [],
      } as unknown as TaskDelivery["presentation"],
    });
    expect(store.changes.forTask("work")?.versions).toEqual([]);
    // Pushed and its checks read: the version, with those facts attached.
    seedDelivery(tasks, "work", {
      prNumber: 13,
      headSha: unpushed,
      ci: "pending",
      ciAt: 9_500,
    });
    expect(store.changes.forTask("work")?.versions).toEqual([
      {
        seq: 1,
        head: unpushed,
        at: 9_500,
        checks: {
          state: "pending",
          at: 9_500,
          lines: { base: BASE, added: 4, deleted: 1, at: 9_000 },
        },
        review: { verdict: "pass", at: 9_100 },
        story: { revisions: [{ revision: 1, title: "feat(chart): color it" }] },
        consent: null,
      },
    ]);
  });

  it("keeps the consent of an override given for a version nothing else names any more", () => {
    const { db, tasks } = setup();
    addProject(db, "chart", "github");
    const store = new TaskStore(db);
    const first = "1".repeat(40);
    const second = "2".repeat(40);
    seedTask(tasks, {
      id: "work",
      title: "Color the chart",
      status: "running",
      repoId: "chart",
      branch: "fm/task-work",
    });
    // The profile as saved: the override at the first version, the checks already at the second.
    seedDelivery(tasks, "work", {
      mode: "direct-pr",
      prNumber: 14,
      headSha: second,
      ci: "green",
      ciAt: 9_900,
      override: {
        words: "Merge it; the late check is the docs build.",
        holds: ["checks"],
        until: "version",
        head: first,
        at: 9_700,
      } as unknown as TaskDelivery["override"],
    });
    expect(store.changes.forTask("work")?.versions.map((v) => [v.head, v.at, v.consent])).toEqual([
      [
        first,
        9_700,
        {
          override: {
            words: "Merge it; the late check is the docs build.",
            holds: ["checks"],
            until: "version",
            head: first,
            at: 9_700,
          },
        },
      ],
      [second, 9_900, null],
    ]);
    expect(store.changes.forTask("work")?.override).toBeNull();
  });

  it("places the version a declared repair carried the approval to after the one it repaired, whatever the host read in between", () => {
    // docs/task-record.md, "A task's change": versions in the order the host
    // saw them. INF-1884 R5's carried approval, run live, showed a declared
    // repair's head ordered before the approved head the slot still read.
    const { db, tasks } = setup();
    addProject(db, "chart", "github");
    const store = new TaskStore(db);
    seedTask(tasks, {
      id: "work",
      title: "Color the chart",
      status: "running",
      repoId: "chart",
      branch: "fm/task-kept",
    });
    // The profile as saved: the host read the approved head, the crewmate
    // declared the repair, and the read that follows a declaration did not
    // reach the repaired head.
    seedDelivery(tasks, "work", {
      mode: "direct-pr",
      prNumber: 88,
      headSha: APPROVED,
      ci: "green",
      ciAt: 3_800,
      mergeAuthorization: KEPT,
    });
    expect(
      store.changes.forTask("work")?.versions.map((v) => [v.seq, v.head, v.at, v.consent]),
    ).toEqual([
      [
        1,
        APPROVED,
        3_800,
        {
          click: {
            authorization: "approval-1",
            generation: 3,
            card: { id: "card-done", offerId: "offer-2", actionId: "merge" },
            status: "standing",
            at: 4_000,
          },
        },
      ],
      [
        2,
        REPAIRED,
        5_000,
        {
          carried: {
            authorization: "approval-1",
            from: APPROVED,
            impact: "none",
            generation: 2,
            at: 5_000,
          },
        },
      ],
    ]);
    // The next read reaches the repaired head: its version gains the checks
    // read there and keeps its place and date.
    seedDelivery(tasks, "work", { headSha: REPAIRED, ci: "green", ciAt: 5_300 });
    expect(
      store.changes.forTask("work")?.versions.map((v) => [v.seq, v.head, v.at, v.checks?.at]),
    ).toEqual([
      [1, APPROVED, 3_800, 3_800],
      [2, REPAIRED, 5_000, 5_300],
    ]);
  });

  it("reads only the task's own change while a referenced pull request is selected or approved, and after the selection is cleared, through the writers' own order", () => {
    const { db, tasks } = setup();
    addProject(db, "chart", "github");
    const store = new TaskStore(db);
    const own = "1".repeat(40);
    const theirs = "9".repeat(40);
    seedTask(tasks, {
      id: "work",
      title: "Watch the release",
      status: "idle",
      repoId: "chart",
      branch: "fm/task-work",
    });
    seedDelivery(tasks, "work", {
      mode: "direct-pr",
      prNumber: 12,
      prUrl: "https://github.com/octo/chart/pull/12",
      changeLabel: "#12",
      headSha: own,
      ci: "green",
      ciAt: 7_000,
      mergeReviews: [
        {
          ...KEPT_REVIEW,
          id: "review-own",
          number: 12,
          headSha: own,
          branch: "fm/task-work",
          at: 7_100,
        },
      ],
    });
    const before = facts(store.changes.forTask("work"));
    expect(before?.versions.map((v) => v.head)).toEqual([own]);
    // check_change(pull) selects the release pull request: the slot's number, page, label
    // and every check read follow it, and the task's own branch stays its own.
    const referenced = {
      ...KEPT_REVIEW,
      id: "review-theirs",
      relationship: "referenced" as const,
      number: 94,
      headSha: theirs,
      branch: "release-please--branches--main",
      title: "chore(main): release 0.2.0",
      at: 7_200,
    };
    seedDelivery(tasks, "work", {
      mergeReviews: [referenced, ...(tasks.get("work")?.delivery?.mergeReviews ?? [])],
      checkTarget: referenced,
      prNumber: 94,
      prUrl: "https://github.com/octo/chart/pull/94",
      changeLabel: "#94",
      headSha: theirs,
      ci: "green",
      ciAt: 7_300,
      checks: {
        headSha: theirs,
        prNumber: 94,
        items: [{ name: "release", state: "success" }],
        complete: true,
        absenceDeclared: false,
      },
    });
    expect(facts(store.changes.forTask("work"))).toEqual(before);
    // The captain's click merges that pull request: consent to it, and its receipt, are not this change's.
    seedDelivery(tasks, "work", {
      mergeAuthorization: {
        ...KEPT,
        id: "approval-94",
        review: referenced,
        target: { ...KEPT.target, prNumber: 94, branch: referenced.branch },
        approvedHead: theirs,
        lineage: [],
        status: "consumed",
        receipt: { head: theirs, sha: BASE, at: 7_400 },
      },
      ci: "merged",
    });
    expect(facts(store.changes.forTask("work"))).toEqual(before);
    // An override saved by an older app, before it named its pull request, in a
    // slot that records a referenced one, is nobody's: the host cannot tell
    // whose version it was given for (INF-1873).
    seedDelivery(tasks, "work", {
      override: {
        words: "Merge the release; its only check is the upload.",
        holds: ["checks"],
        until: "version",
        head: theirs,
        at: 7_450,
      } as unknown as TaskDelivery["override"],
    });
    expect(facts(store.changes.forTask("work"))).toEqual(before);
    // INF-1884 R2: the check watch reads the release pull request at a newer
    // head after its review; the slot's head and checks follow it, stamped with its number.
    const theirsLater = "8".repeat(40);
    seedDelivery(tasks, "work", {
      headSha: theirsLater,
      ci: "green",
      ciAt: 7_460,
      checks: {
        headSha: theirsLater,
        prNumber: 94,
        items: [{ name: "release", state: "success" }],
        complete: true,
        absenceDeclared: false,
      },
    });
    expect(facts(store.changes.forTask("work"))).toEqual(before);
    // The first mate's override at that head, which no review recorded, names
    // the pull request it was given for (`HoldOverride.prNumber`).
    seedDelivery(tasks, "work", {
      override: {
        words: "Merge the release at its new version; the upload is the only check.",
        holds: ["checks"],
        until: "version",
        head: theirsLater,
        prNumber: 94,
        at: 7_470,
      } as unknown as TaskDelivery["override"],
    });
    expect(facts(store.changes.forTask("work"))).toEqual(before);
    // The writers' own order. open_change clears the selection first, while the
    // slot still names the referenced number and head; naming the own change
    // then writes its number with its head and no reading, and the own reading,
    // stamped with the own number, follows as a separate record.
    seedDelivery(tasks, "work", { checkTarget: undefined });
    expect(facts(store.changes.forTask("work"))).toEqual(before);
    seedDelivery(tasks, "work", {
      prNumber: 12,
      prUrl: "https://github.com/octo/chart/pull/12",
      changeLabel: "#12",
      headSha: own,
      checks: undefined,
      ci: undefined,
      ciAt: undefined,
      ciStartedAt: undefined,
      ciFinishedAt: undefined,
    });
    expect(facts(store.changes.forTask("work"))).toEqual(before);
    const ownChecks = {
      headSha: own,
      prNumber: 12,
      items: [{ name: "unit-tests", state: "success" as const }],
      complete: true,
      absenceDeclared: false,
    };
    seedDelivery(tasks, "work", {
      headSha: own,
      ci: "green",
      ciAt: 7_500,
      checks: ownChecks,
    });
    expect(facts(store.changes.forTask("work"))).toEqual({
      ...before,
      versions: [
        { ...before?.versions[0], checks: { state: "green", at: 7_500, snapshot: ownChecks } },
      ],
    });
  });

  it("binds a reading at a commit both pull requests share by the pull request it names: the own pull request's reading is this change's though a referenced review names the same commit, a reading of a referenced pull request makes no version, and an override saved without its pull request there is neither's", () => {
    // INF-1884 R9 and R10, re-keyed by INF-1873: a pull request another branch
    // opened at the same commit as the task's own is reviewed as referenced.
    // Every reading names the pull request it is of (`CheckSnapshot.prNumber`),
    // so two pull requests sharing a commit never share a reading: the own
    // pull request's is this change's, a referenced one's is theirs; and an
    // override saved there without its pull request is neither change's consent.
    const { db, tasks } = setup();
    addProject(db, "chart", "github");
    const store = new TaskStore(db);
    const shared = "1".repeat(40);
    const next = "2".repeat(40);
    const foreign = "9".repeat(40);
    const ownChange = {
      prNumber: 12,
      prUrl: "https://github.com/octo/chart/pull/12",
      changeLabel: "#12",
    };
    const reading = (head: string, state: "pending" | "success", at: number, of = 12) => ({
      headSha: head,
      ci: state === "success" ? ("green" as const) : ("pending" as const),
      ciAt: at,
      checks: {
        headSha: head,
        prNumber: of,
        items: [{ name: "unit-tests", state }],
        complete: state === "success",
        absenceDeclared: false,
      },
    });
    seedTask(tasks, {
      id: "work",
      title: "Label the axis",
      status: "running",
      repoId: "chart",
      branch: "fm/task-work",
    });
    // The own pull request, read while its checks still run.
    seedDelivery(tasks, "work", {
      mode: "direct-pr",
      ...ownChange,
      ...reading(shared, "pending", 7_000),
    });
    const pending = facts(store.changes.forTask("work"));
    expect(pending?.versions.map((v) => [v.head, v.checks?.state])).toEqual([[shared, "pending"]]);
    // check_change(pull) reviews a pull request another branch opened at the same
    // commit, and the reading under its number, stamped with it, follows it.
    const mirror: MergeReview = {
      ...KEPT_REVIEW,
      id: "review-mirror",
      relationship: "referenced",
      number: 94,
      headSha: shared,
      branch: "fm/task-mirror",
      title: "feat(chart): label the axis",
      at: 7_100,
    };
    seedDelivery(tasks, "work", {
      mergeReviews: [mirror],
      checkTarget: mirror,
      prNumber: 94,
      prUrl: "https://github.com/octo/chart/pull/94",
      changeLabel: "#94",
      ...reading(shared, "success", 7_200, 94),
    });
    expect(facts(store.changes.forTask("work"))).toEqual(pending);
    // The selection clears, the own change is named again at its head with no
    // reading, and the own reading at the shared commit follows: it names the
    // own pull request, so it is this change's, though the referenced review
    // names the same commit.
    seedDelivery(tasks, "work", { checkTarget: undefined });
    seedDelivery(tasks, "work", {
      ...ownChange,
      headSha: shared,
      checks: undefined,
      ci: undefined,
      ciAt: undefined,
      ciStartedAt: undefined,
      ciFinishedAt: undefined,
    });
    expect(facts(store.changes.forTask("work"))).toEqual(pending);
    const fresh = reading(shared, "success", 7_300);
    seedDelivery(tasks, "work", fresh);
    expect(store.changes.forTask("work")?.versions.map((v) => [v.head, v.checks])).toEqual([
      [shared, { state: "green", at: 7_300, snapshot: fresh.checks }],
    ]);
    // Both branches move to a second commit the record does not hold yet; the
    // mirror is reviewed there and read under its number. open_change then
    // clears the selection, publishes the own story at the pushed head, names
    // the own change at it, and the own reading follows.
    const mirrorNext: MergeReview = { ...mirror, id: "review-mirror-2", headSha: next, at: 7_400 };
    seedDelivery(tasks, "work", {
      mergeReviews: [mirrorNext, mirror],
      checkTarget: mirrorNext,
      prNumber: 94,
      prUrl: "https://github.com/octo/chart/pull/94",
      changeLabel: "#94",
      ...reading(next, "success", 7_500, 94),
    });
    expect(store.changes.forTask("work")?.versions.map((v) => v.head)).toEqual([shared]);
    seedDelivery(tasks, "work", { checkTarget: undefined });
    seedDelivery(tasks, "work", {
      presentation: {
        revisions: [
          { revision: 1, head: next, base: "main", title: "feat(chart): label the axis" },
        ],
        receipts: [],
        publication: {
          revision: 1,
          head: next,
          state: "confirmed",
          region: "",
          regionHash: "",
          number: 12,
        },
      } as unknown as TaskDelivery["presentation"],
    });
    seedDelivery(tasks, "work", {
      ...ownChange,
      headSha: next,
      checks: undefined,
      ci: undefined,
      ciAt: undefined,
      ciStartedAt: undefined,
      ciFinishedAt: undefined,
    });
    const freshNext = reading(next, "success", 7_600);
    seedDelivery(tasks, "work", freshNext);
    expect(store.changes.forTask("work")?.versions).toEqual([
      {
        seq: 1,
        head: shared,
        at: 7_000,
        checks: { state: "green", at: 7_300, snapshot: fresh.checks },
        review: null,
        story: null,
        consent: null,
      },
      {
        seq: 2,
        head: next,
        at: 7_600,
        checks: { state: "green", at: 7_600, snapshot: freshNext.checks },
        review: null,
        story: {
          revisions: [{ revision: 1, title: "feat(chart): label the axis" }],
          published: { revision: 1, state: "confirmed", number: 12 },
        },
        consent: null,
      },
    ]);
    // An override saved by an older app without its pull request, in a slot
    // that records a referenced one, is consent the host cannot place: it was
    // given for one of two pull requests' versions, so it is neither's (R10).
    const legacyOverride = {
      words: "Merge it; the unit tests are its only check.",
      holds: ["checks"],
      until: "version",
      head: next,
      at: 7_650,
    };
    seedDelivery(tasks, "work", {
      override: legacyOverride as unknown as TaskDelivery["override"],
    });
    expect(store.changes.forTask("work")?.versions.map((v) => v.consent)).toEqual([null, null]);
    expect(store.changes.forTask("work")?.override).toBeNull();
    // The boundary: a reading stamped with a referenced pull request's number
    // makes no version, whatever number the slot names beside it.
    const other: MergeReview = {
      ...mirror,
      id: "review-other",
      number: 95,
      headSha: foreign,
      branch: "release-please--branches--main",
      title: "chore(main): release 0.2.0",
      at: 7_700,
    };
    seedDelivery(tasks, "work", {
      mergeReviews: [other, mirrorNext, mirror],
      ...reading(foreign, "success", 7_800, 95),
    });
    expect(store.changes.forTask("work")?.versions.map((v) => [v.head, v.checks?.at])).toEqual([
      [shared, 7_300],
      [next, 7_600],
    ]);
  });

  it("binds a reading to the pull request it names: the own pull request's reading at a commit only a referenced review names so far is this change's version", () => {
    // INF-1884 R9 (round 6), re-keyed by INF-1873: an ordinary check_change or
    // check-watch read writes the own number and the head with its checks
    // together, stamped with the pull request it is of, and needs no earlier
    // own fact at that head. The number it names is what binds it, so the
    // reading at a commit only a referenced review names so far is this
    // change's, with no record age or head set to consult.
    const { db, tasks } = setup();
    addProject(db, "chart", "github");
    const store = new TaskStore(db);
    const first = "1".repeat(40);
    const shared = "2".repeat(40);
    const ownChange = {
      prNumber: 12,
      prUrl: "https://github.com/octo/chart/pull/12",
      changeLabel: "#12",
    };
    const reading = (head: string, at: number, of: number) => ({
      headSha: head,
      ci: "green" as const,
      ciAt: at,
      checks: {
        headSha: head,
        prNumber: of,
        items: [{ name: "unit-tests", state: "success" as const }],
        complete: true,
        absenceDeclared: false,
      },
    });
    const mirror = (id: string, head: string, at: number): MergeReview => ({
      ...KEPT_REVIEW,
      id,
      relationship: "referenced",
      number: 94,
      headSha: head,
      branch: "fm/task-mirror",
      title: "feat(chart): label the axis",
      at,
    });
    const owned = (id: string, head: string, at: number): MergeReview => ({
      ...KEPT_REVIEW,
      id,
      relationship: "owned",
      number: 12,
      headSha: head,
      branch: "fm/task-work",
      at,
    });
    const selection = {
      prNumber: 94,
      prUrl: "https://github.com/octo/chart/pull/94",
      changeLabel: "#94",
    };
    const cleared = {
      checks: undefined,
      ci: undefined,
      ciAt: undefined,
      ciStartedAt: undefined,
      ciFinishedAt: undefined,
    };
    seedTask(tasks, {
      id: "since",
      title: "Label the axis",
      status: "running",
      repoId: "chart",
      branch: "fm/task-work",
    });
    expect(store.changes.forTask("since")?.versions).toEqual([]);
    // check_change(pull) reviews a pull request another branch opened at a commit the
    // own branch does not have yet, and reads it under its number.
    const review = mirror("review-mirror", shared, 7_100);
    seedDelivery(tasks, "since", {
      mode: "direct-pr",
      mergeReviews: [review],
      checkTarget: review,
      ...selection,
      ...reading(shared, 7_200, 94),
    });
    expect(store.changes.forTask("since")?.versions).toEqual([]);
    // check_change(pull) of the own pull request at its first head: the owned review
    // clears the selection, and the reading under the own number follows.
    const own = owned("review-own", first, 7_300);
    seedDelivery(tasks, "since", { mergeReviews: [own, review], checkTarget: undefined });
    seedDelivery(tasks, "since", { ...ownChange, headSha: first, ...cleared });
    const atFirst = reading(first, 7_400, 12);
    seedDelivery(tasks, "since", atFirst);
    expect(store.changes.forTask("since")?.versions.map((v) => [v.head, v.checks])).toEqual([
      [first, { state: "green", at: 7_400, snapshot: atFirst.checks }],
    ]);
    // The own branch moves to the shared commit and the own pull request is read
    // there: the first own fact at that commit, before any publication, offer or
    // review names it, while the referenced review still does. It names the own
    // pull request, so it is this change's version.
    const atShared = reading(shared, 7_500, 12);
    seedDelivery(tasks, "since", atShared);
    expect(store.changes.forTask("since")?.versions.map((v) => [v.head, v.checks])).toEqual([
      [first, { state: "green", at: 7_400, snapshot: atFirst.checks }],
      [shared, { state: "green", at: 7_500, snapshot: atShared.checks }],
    ]);
    expect(store.changes.forTask("since")?.handle?.number).toBe(12);
  });

  it("refreshes what the slot says at a head the change already holds, though no pushed-head fact names it any more", () => {
    // INF-1884 R7: a review, a lines reading or a story at an earlier version
    // attaches to it after a newer push moved the slot's head and checks on.
    const { db, tasks } = setup();
    addProject(db, "chart", "github");
    const store = new TaskStore(db);
    const first = "1".repeat(40);
    const second = "2".repeat(40);
    seedTask(tasks, {
      id: "work",
      title: "Color the chart",
      status: "running",
      repoId: "chart",
      branch: "fm/task-work",
    });
    seedDelivery(tasks, "work", {
      mode: "direct-pr",
      prNumber: 12,
      headSha: first,
      ci: "green",
      ciAt: 8_000,
    });
    seedDelivery(tasks, "work", { headSha: second, ci: "pending", ciAt: 8_100 });
    expect(store.changes.forTask("work")?.versions.map((v) => [v.head, v.checks])).toEqual([
      [first, { state: "green", at: 8_000 }],
      [second, { state: "pending", at: 8_100 }],
    ]);
    // The reviewer reads the first version, the host reads its lines, and a story is prepared at it.
    seedDelivery(tasks, "work", {
      reviewVerdict: "pass",
      reviewSha: first,
      reviewRisk: "low",
      reviewedAt: 8_200,
      reviewChange: "reading-1",
      changeLines: { base: BASE, head: first, added: 4, deleted: 1, at: 8_150 },
      presentation: {
        revisions: [{ revision: 1, head: first, base: "main", title: "feat(chart): color it" }],
        receipts: [],
      } as unknown as TaskDelivery["presentation"],
    });
    expect(store.changes.forTask("work")?.versions).toEqual([
      {
        seq: 1,
        head: first,
        at: 8_000,
        checks: {
          state: "green",
          at: 8_000,
          lines: { base: BASE, added: 4, deleted: 1, at: 8_150 },
        },
        review: { verdict: "pass", risk: "low", at: 8_200, reading: "reading-1" },
        story: { revisions: [{ revision: 1, title: "feat(chart): color it" }] },
        consent: null,
      },
      {
        seq: 2,
        head: second,
        at: 8_100,
        checks: { state: "pending", at: 8_100 },
        review: null,
        story: null,
        consent: null,
      },
    ]);
  });

  it("replaces a version's check reading and its review whole, and keeps its lines and the earlier version's last reading", () => {
    // INF-1884 R8: a rerun's reading no longer names the finish time the last
    // one had, and a new review no longer names the reading the last one rested on.
    const { db, tasks } = setup();
    addProject(db, "chart", "github");
    const store = new TaskStore(db);
    const first = "1".repeat(40);
    const second = "2".repeat(40);
    const snapshot = (state: "pending" | "success") => ({
      headSha: first,
      items: [{ name: "unit-tests", state }],
      complete: state === "success",
      absenceDeclared: false,
    });
    seedTask(tasks, {
      id: "work",
      title: "Color the chart",
      status: "running",
      repoId: "chart",
      branch: "fm/task-work",
    });
    seedDelivery(tasks, "work", {
      mode: "direct-pr",
      prNumber: 12,
      headSha: first,
      ci: "pending",
      ciAt: 8_000,
      ciStartedAt: 7_900,
      checks: snapshot("pending"),
      changeLines: { base: BASE, head: first, added: 4, deleted: 1, at: 7_950 },
    });
    const lines = { base: BASE, added: 4, deleted: 1, at: 7_950 };
    const checksOf = () => store.changes.forTask("work")?.versions.map((v) => v.checks);
    expect(checksOf()).toEqual([
      { state: "pending", snapshot: snapshot("pending"), at: 8_000, startedAt: 7_900, lines },
    ]);
    // The checks finish: the reading names its finish.
    seedDelivery(tasks, "work", {
      ci: "green",
      ciAt: 8_100,
      ciStartedAt: 7_900,
      ciFinishedAt: 8_090,
      checks: snapshot("success"),
    });
    expect(checksOf()).toEqual([
      {
        state: "green",
        snapshot: snapshot("success"),
        at: 8_100,
        startedAt: 7_900,
        finishedAt: 8_090,
        lines,
      },
    ]);
    // A rerun at the same head: the reading clears the finish, and the record follows it.
    seedDelivery(tasks, "work", {
      ci: "pending",
      ciAt: 8_200,
      ciStartedAt: 8_150,
      ciFinishedAt: undefined,
      checks: snapshot("pending"),
    });
    expect(checksOf()).toEqual([
      { state: "pending", snapshot: snapshot("pending"), at: 8_200, startedAt: 8_150, lines },
    ]);
    // A review with its reading, then one without: the second names no reading.
    seedDelivery(tasks, "work", {
      reviewVerdict: "findings",
      reviewSha: first,
      reviewRisk: "medium",
      reviewRiskNote: "The legend overlaps.",
      reviewedAt: 8_300,
      reviewChange: "reading-1",
    });
    const reviewOf = () => store.changes.forTask("work")?.versions.map((v) => v.review);
    expect(reviewOf()).toEqual([
      {
        verdict: "findings",
        risk: "medium",
        riskNote: "The legend overlaps.",
        at: 8_300,
        reading: "reading-1",
      },
    ]);
    seedDelivery(tasks, "work", {
      reviewVerdict: "pass",
      reviewRisk: undefined,
      reviewRiskNote: undefined,
      reviewedAt: 8_400,
      reviewChange: undefined,
    });
    expect(reviewOf()).toEqual([{ verdict: "pass", at: 8_400 }]);
    // A newer push: the earlier version keeps its last reading and review.
    seedDelivery(tasks, "work", {
      headSha: second,
      ci: "pending",
      ciAt: 8_500,
      ciStartedAt: undefined,
      checks: undefined,
    });
    expect(
      store.changes.forTask("work")?.versions.map((v) => [v.head, v.checks, v.review]),
    ).toEqual([
      [
        first,
        { state: "pending", snapshot: snapshot("pending"), at: 8_200, startedAt: 8_150, lines },
        { verdict: "pass", at: 8_400 },
      ],
      [second, { state: "pending", at: 8_500 }, null],
    ]);
  });

  it("gives a change only to work on a project the app manages, on a branch, that the host did not raise on another change", () => {
    const { db, tasks } = setup();
    addProject(db, "chart", "github");
    addProject(db, "home", "github", "personal");
    const store = new TaskStore(db);
    seedTask(tasks, {
      id: "work",
      title: "Color the chart",
      status: "running",
      repoId: "chart",
      branch: "fm/task-work",
    });
    seedTask(tasks, { id: "queued", title: "Not started", status: "queued", repoId: "chart" });
    seedTask(tasks, {
      id: "answer",
      title: "Which chart?",
      status: "running",
      kind: "question",
      repoId: "chart",
      branch: "fm/task-answer",
    });
    seedTask(tasks, {
      id: "review",
      title: "Review the pull request",
      status: "running",
      repoId: "chart",
      branch: "fm/task-review",
      parentId: "work",
      shape: { kind: "review", kind_source: "host:review" } as unknown as WorkShape,
    });
    seedTask(tasks, {
      id: "home",
      title: "Note in the workspace",
      status: "running",
      repoId: "home",
      branch: "main",
    });
    seedDelivery(tasks, "home", { mode: "in-place" });
    seedTask(tasks, {
      id: "nowhere",
      title: "No project",
      status: "running",
      branch: "fm/task-nowhere",
    });
    seedTask(tasks, {
      id: "unknown",
      title: "A project the app no longer has",
      status: "running",
      repoId: "gone",
      branch: "fm/task-unknown",
    });
    expect(Object.keys(byTask(store))).toEqual(["work"]);
    // A task's hard delete takes its change with it.
    tasks.close("work", { status: "dropped", reason: "cancelled", actor: "host" });
    expect(store.changes.forTask("work")?.receipt).toMatchObject({
      outcome: "closed",
      reason: "cancelled",
    });
    store.delete("work");
    expect(store.changes.list()).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM change_versions").get()).toEqual({ n: 0 });
  });
});
