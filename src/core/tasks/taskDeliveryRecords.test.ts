import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import { candidateHead, standingAuthorization } from "../orchestrator/mergeAuthorization";
import { openDatabase, openInMemoryDatabase, TASK_DELIVERY_RECORDS_VERSION } from "../storage/db";
import { type MergeAuthorization, type TaskDelivery, TaskStore } from "../storage/taskRecords";
import { seedTask } from "./seedTask";
import { exportTaskRecords, parseTaskExport } from "./taskExport";
import { TaskService } from "./taskService";

// INF-1296 piece 4, the captain's approved plan B: versioned delivery
// evidence separated from exact permission and effect records, and "good
// e2e test coverage to ensure exsiting users don't get regressed during
// this migration".

function setup(db = openInMemoryDatabase()) {
  let now = 10_000;
  const tasks = new TaskService({ db, strict: true, now: () => (now += 1_000) });
  return { db, tasks };
}

const APPROVED = "a".repeat(40);
const REPAIRED = "b".repeat(40);

/**
 * A kept merge approval whose merge request went out and whose answer never
 * came: the attempt token is what restart recovery reads back before
 * anything else (docs/delivery-rigor.md, "A kept merge approval").
 */
const IN_FLIGHT: MergeAuthorization = {
  version: 1,
  id: "approval-1",
  generation: 3,
  issuer: "captain",
  at: 4_000,
  card: { id: "card-done", offerId: "offer-2", actionId: "merge", interactionId: "click-1" },
  target: {
    repoId: "repo-chart",
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
      newBase: "c".repeat(40),
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
  guidance: { latest: 1, declared: 1, at: 5_500 },
  attempt: { token: "attempt-7", head: REPAIRED, at: 6_000 },
};

/** A Careful change's live validation: one effect the captain approved, its outcome unknown. */
const LIVE_VALIDATION = {
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
        head: REPAIRED,
        scenario: "preview",
        action: "Post the preview link",
        destination: "the pull request",
        audience: "collaborators",
        visibility: "others",
        persistent: true,
        purpose: "Show the chart",
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
        expected: "The chart draws",
        adverse: "A blank chart",
        environment: "The preview site",
        signal: "The chart's bars",
        boundary: "Read-only",
      },
      state: "unknown",
      at: 6_500,
      decision: { card: "card-validate", offer: "offer-v", action: "approve" },
    },
  ],
} as unknown as NonNullable<TaskDelivery["liveValidation"]>;

/**
 * A profile as the release before this migration saved it: a task whose
 * kept merge went out with its answer unread, beside its change evidence,
 * completion offer, write ask, required action, override and live
 * validation, with a settle that has not run; a merged task in the old
 * delivery format; a closed task with its history and mode; a delivery with
 * null values; and an unreadable one.
 */
function olderProfile() {
  const dir = scratchDir("delivery-records-");
  const at = openDatabase(dir, TASK_DELIVERY_RECORDS_VERSION - 1);
  const { tasks } = setup(at);
  seedTask(tasks, { id: "kept", title: "Color the chart", status: "idle" });
  seedDelivery(tasks, "kept", {
    mode: "direct-pr",
    prNumber: 88,
    prUrl: "https://github.com/octo/chart/pull/88",
    changeLabel: "#88",
    headSha: REPAIRED,
    changeLines: { base: "c".repeat(40), head: REPAIRED, added: 12, deleted: 3, at: 5_200 },
    ci: "green",
    ciAt: 5_300,
    ciStartedAt: 5_100,
    ciFinishedAt: 5_290,
    ciWatch: { head: REPAIRED, since: 5_100, nextAt: 5_400, tries: 2, failureSeen: false },
    ciRounds: 1,
    ciRedHead: APPROVED,
    reviewVerdict: "pass",
    reviewSha: REPAIRED,
    reviewRisk: "low",
    versionReadings: { [APPROVED]: "reading-a", [REPAIRED]: "reading-a" },
    completionOffers: [
      { cardId: "card-done", offerId: "offer-2", headSha: APPROVED, prNumber: 88, at: 3_900 },
    ],
    risk: {
      blast: { level: "low", why: "One chart" },
    } as unknown as TaskDelivery["risk"],
    mergeAuthorization: IN_FLIGHT,
    writeAsks: [
      {
        id: "ask-1",
        at: 4_500,
        method: "POST",
        path: "/repos/octo/other/issues",
        body: "{}",
      } as unknown as NonNullable<TaskDelivery["writeAsks"]>[number],
    ],
    requiredActionOffer: { cardId: "card-done", offerId: "offer-2", head: APPROVED, actions: [] },
    override: {
      at: 4_800,
      words: "Merge it even though the review is late.",
      holds: ["waits"],
      head: REPAIRED,
    } as unknown as TaskDelivery["override"],
    liveValidation: LIVE_VALIDATION,
    validationHead: REPAIRED,
  });
  tasks.delivery.setPendingSettle("kept", {
    mode: "merge-pr",
    actor: "captain",
    requestedAt: 6_100,
    proceedWithOpen: false,
  });
  seedTask(tasks, { id: "landed", title: "Fix the axis", status: "completed" });
  seedTask(tasks, { id: "closed", title: "Answer the question", status: "completed" });
  const history = {
    closedPolicies: {
      delivery: { value: "direct-pr", source: "project" },
      autonomy: { value: false, source: "project" },
      rigor: { value: "standard", source: "project", requested: "standard" },
      revision: 0,
    },
    result: { at: 7_000, value: { answer: 42 } },
  };
  seedTask(tasks, { id: "nulls", title: "A hand-edited delivery", status: "idle" });
  seedTask(tasks, { id: "odd", title: "An unreadable delivery", status: "idle" });
  const raw = at.prepare("UPDATE tasks SET delivery_json = ? WHERE id = ?");
  // Write the retired timestamp in the pre-migration storage shape.
  raw.run(
    JSON.stringify({
      mode: "direct-pr",
      prNumber: 86,
      prUrl: "https://github.com/example/chart/pull/86",
      landedMode: "pr",
      landedAt: 5_400,
      ci: "merged",
      ciAt: 5_300,
    }),
    "landed",
  );
  raw.run(JSON.stringify({ mode: "direct-pr", ...history }), "closed");
  raw.run(
    JSON.stringify({ mode: "direct-pr", headSha: null, mergeAuthorization: null, futureFact: 1 }),
    "nulls",
  );
  raw.run("{not json", "odd");
  at.close();
  return { dir, history };
}

/** What every reader of a task reads of its delivery, in the record's own words. */
function readDelivery(tasks: TaskService) {
  return Object.fromEntries(
    tasks
      .list()
      .map((record) => [
        record.id,
        { delivery: record.delivery, pendingSettle: record.pendingSettle },
      ]),
  );
}

describe("the migration of an older release's delivery facts", () => {
  it("moves each value exactly as saved into evidence and permissions, and every reader reads the same", () => {
    const { dir, history } = olderProfile();
    const before = openDatabase(dir, TASK_DELIVERY_RECORDS_VERSION - 1);
    const readBefore = readDelivery(setup(before).tasks);
    const viewsBefore = {
      tasks: before
        .prepare("SELECT task_id, delivery FROM v_tasks_v1 WHERE task_id <> 'odd' ORDER BY task_id")
        .all(),
    };
    before.close();
    // The reads name what was seeded, or a match below would compare nothing.
    expect(readBefore.kept?.delivery?.mergeAuthorization?.attempt?.token).toBe("attempt-7");
    expect(readBefore.kept?.pendingSettle).toMatchObject({ mode: "merge-pr" });
    expect(readBefore.landed?.delivery).toMatchObject({
      landedMode: "pr",
      prNumber: 86,
      ciAt: 5_300,
    });
    expect(readBefore.landed?.delivery).not.toHaveProperty("landedAt");
    expect(readBefore.odd?.delivery).toBeNull();

    const upgraded = openDatabase(dir);
    const { tasks } = setup(upgraded);
    expect(readDelivery(tasks)).toEqual(readBefore);
    expect(
      upgraded
        .prepare("SELECT task_id, delivery FROM v_tasks_v1 WHERE task_id <> 'odd' ORDER BY task_id")
        .all(),
    ).toEqual(viewsBefore.tasks);

    // Exact-version approval and uncertain-effect recovery read the same facts.
    const kept = tasks.get("kept")?.delivery;
    expect(standingAuthorization(kept)).toEqual(IN_FLIGHT);
    expect(candidateHead(standingAuthorization(kept)!)).toBe(REPAIRED);
    expect(kept?.liveValidation?.permissions).toEqual(LIVE_VALIDATION.permissions);

    // The evidence row keeps the change and its readings, bound to their version.
    const evidence = upgraded
      .prepare("SELECT * FROM task_delivery_evidence ORDER BY task_id")
      .all() as {
      task_id: string;
      format: number;
      mode: string;
      head_sha: string | null;
      evidence_json: string;
    }[];
    expect(evidence.map((row) => [row.task_id, row.format, row.mode, row.head_sha])).toEqual([
      ["closed", 1, "direct-pr", null],
      ["kept", 1, "direct-pr", REPAIRED],
      ["landed", 1, "direct-pr", null],
      ["nulls", 1, "direct-pr", null],
    ]);
    expect(JSON.parse(evidence[2]!.evidence_json)).toMatchObject({ ciAt: 5_300 });
    const keptEvidence = JSON.parse(evidence[1]!.evidence_json);
    expect(keptEvidence).toMatchObject({ prNumber: 88, ci: "green", reviewVerdict: "pass" });
    expect(keptEvidence.liveValidation).not.toHaveProperty("permissions");
    expect(keptEvidence).not.toHaveProperty("mergeAuthorization");
    expect(JSON.parse(evidence[3]!.evidence_json)).toEqual({ headSha: null, futureFact: 1 });

    // The permission row keeps the approval with its attempt, and each grant as saved.
    const permissions = upgraded
      .prepare("SELECT * FROM task_permissions ORDER BY task_id")
      .all() as Record<string, string | null>[];
    expect(permissions.map((row) => row.task_id)).toEqual(["kept", "nulls"]);
    const keptPermissions = permissions[0]!;
    expect(JSON.parse(keptPermissions.merge_authorization_json!)).toEqual(IN_FLIGHT);
    expect(JSON.parse(keptPermissions.validation_permissions_json!)).toEqual(
      LIVE_VALIDATION.permissions,
    );
    expect(JSON.parse(keptPermissions.pending_settle_json!)).toMatchObject({ mode: "merge-pr" });
    for (const column of [
      "completion_offers_json",
      "write_asks_json",
      "required_action_offer_json",
      "override_json",
    ])
      expect(keptPermissions[column]).not.toBeNull();
    expect(permissions[1]?.merge_authorization_json).toBe("null");

    // The column keeps only history; an unreadable delivery is left as saved.
    const rows = Object.fromEntries(
      (
        upgraded
          .prepare(
            "SELECT task_id AS id, delivery_json, pending_settle_json FROM task_record_history",
          )
          .all() as {
          id: string;
          delivery_json: string | null;
          pending_settle_json: string | null;
        }[]
      ).map((row) => [row.id, row]),
    );
    expect(JSON.parse(rows.kept!.delivery_json!)).toEqual({});
    expect(rows.kept!.pending_settle_json).toBeNull();
    expect(JSON.parse(rows.landed!.delivery_json!)).toEqual({});
    expect(JSON.parse(rows.closed!.delivery_json!)).toEqual(history);
    expect(rows.odd!.delivery_json).toBe("{not json");
    upgraded.close();

    // A restart reads the same, and migrates nothing twice.
    const again = openDatabase(dir);
    expect(readDelivery(setup(again).tasks)).toEqual(readBefore);
    expect(again.prepare("SELECT COUNT(*) AS n FROM task_permissions").get()).toEqual({ n: 2 });
    again.close();
  });

  it("keeps each write after the upgrade with its own record, and a settle that has not run apart from them", () => {
    const { dir } = olderProfile();
    const upgraded = openDatabase(dir);
    const { tasks } = setup(upgraded);
    // The answer came: the attempt token goes, and the approval is spent.
    seedDelivery(tasks, "kept", {
      mergeAuthorization: {
        ...IN_FLIGHT,
        attempt: undefined,
        status: "consumed",
        receipt: { head: REPAIRED, at: 7_000 },
      },
      ci: "merged",
    });
    const kept = tasks.get("kept")!;
    expect(kept.delivery?.mergeAuthorization).toMatchObject({ status: "consumed" });
    expect(kept.delivery?.mergeAuthorization).not.toHaveProperty("attempt");
    expect(kept.delivery).toMatchObject({ ci: "merged", headSha: REPAIRED, prNumber: 88 });
    // A delivery write left the settle that has not run where it was.
    expect(kept.pendingSettle).toMatchObject({ mode: "merge-pr" });
    upgraded.close();

    const again = openDatabase(dir);
    const reread = setup(again).tasks;
    expect(reread.get("kept")?.delivery?.mergeAuthorization).toMatchObject({
      status: "consumed",
      receipt: { head: REPAIRED },
    });
    expect(
      JSON.parse(
        (
          again
            .prepare(
              "SELECT merge_authorization_json AS a FROM task_permissions WHERE task_id = 'kept'",
            )
            .get() as { a: string }
        ).a,
      ),
    ).not.toHaveProperty("attempt");
    again.close();
  });
});

describe("a task's delivery records", () => {
  it("replaces evidence and permissions with each whole delivery, and drops rows a task no longer needs", () => {
    const { db, tasks } = setup();
    seedTask(tasks, { id: "t", title: "Ship the legend", status: "idle" });
    seedDelivery(tasks, "t", {
      mode: "direct-pr",
      prNumber: 9,
      headSha: APPROVED,
      completionOffers: [{ cardId: "c", offerId: "o", headSha: APPROVED, prNumber: 9, at: 1 }],
    });
    const counts = () =>
      [
        db.prepare("SELECT COUNT(*) AS n FROM task_delivery_evidence").get(),
        db.prepare("SELECT COUNT(*) AS n FROM task_permissions").get(),
      ].map((row) => (row as { n: number }).n);
    expect(counts()).toEqual([1, 1]);
    // The offer ends: its permission row goes, the evidence stays.
    seedDelivery(tasks, "t", { completionOffers: undefined });
    expect(tasks.get("t")?.delivery).toEqual({ mode: "direct-pr", prNumber: 9, headSha: APPROVED });
    expect(counts()).toEqual([1, 0]);
    // The whole record is cleared: nothing is left behind.
    new TaskStore(db).update("t", { delivery: null });
    expect(tasks.get("t")?.delivery).toBeNull();
    expect(counts()).toEqual([0, 0]);
  });
});

describe("a record export of delivery facts", () => {
  it("reads the same before and after the upgrade, and an import grants no permission", () => {
    const { dir } = olderProfile();
    const parsed = (lines: string[]) => lines.map((line) => JSON.parse(line));
    const before = openDatabase(dir, TASK_DELIVERY_RECORDS_VERSION - 1);
    const older = exportTaskRecords(setup(before).tasks, 1);
    before.close();
    const upgraded = openDatabase(dir);
    const lines = exportTaskRecords(setup(upgraded).tasks, 1);
    upgraded.close();
    expect(parsed(lines)).toEqual(parsed(older));
    const kept = parsed(lines).find((line) => line.id === "kept");
    expect(kept?.delivery).toEqual({
      mode: "direct-pr",
      prUrl: "https://github.com/octo/chart/pull/88",
      prNumber: 88,
      changeLabel: "#88",
      ci: "green",
      ciAt: 5_300,
    });

    const { db: fresh, tasks: restored } = setup();
    restored.archive.importRecords(parseTaskExport(lines));
    expect(restored.get("kept")?.delivery).toEqual(kept?.delivery);
    expect(parsed(exportTaskRecords(restored, 1))).toEqual(parsed(lines));
    // The export carries the change, never a permission: an import approves nothing.
    expect(fresh.prepare("SELECT COUNT(*) AS n FROM task_delivery_evidence").get()).toEqual({
      n: 4,
    });
    expect(fresh.prepare("SELECT COUNT(*) AS n FROM task_permissions").get()).toEqual({ n: 0 });
    expect(standingAuthorization(restored.get("kept")?.delivery)).toBeUndefined();
  });
});
