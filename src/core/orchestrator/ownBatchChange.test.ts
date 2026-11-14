import { tmpdir } from "node:os";
import { BATCH_STATUS_WORDS } from "@shared/batches";
import type { ChangePresentation } from "@shared/changePresentation";
import { RISK_DIMENSIONS, type RiskDeclaration } from "@shared/risk";
import { describe, expect, it } from "vitest";
import {
  BATCH_BASE,
  BatchHostForge,
  commitId as id,
  METER_DESTINATION,
  standInGit,
} from "../../../tests/helpers/batchHost";
import { BUNDLED_NAMING } from "../../../tests/helpers/namingRunbook";
import { insertTask, setup } from "../../../tests/helpers/prCiHarness";
import { BATCH_WORDS, Batches } from "../batches/batches";
import { LEFT_OUT_WORDS } from "../batches/combine";
import { BATCH_CHECK, BATCH_WAITING_WORDS, presentationCommitMessage } from "../forge";
import { seedProject } from "../workspace/seedProject";
import { BATCH_MERGE_WORDS, type MergeGuard } from "./changeMerge";
import { BATCH_OPEN_WORDS } from "./changePublication";
import { BATCH_DECLARATION_WORDS } from "./checkChangeTool";

// Intent: the captain's approved plan for batches of their own, piece 1: "each change is a
// pushed branch with its saved story and no pull request of its own. The merge click, or
// autonomy, keeps the approval at that version and puts the change in line", its checks
// are read on its pushed branch (the captain's answer own_check), and a repair answers a
// held batch by a typed declaration: send changes back, each with a reason, or declare
// its own change the fix.
//
// The change delivery is wired as the app wires it over a fresh database; the stand-in is
// the host, which holds the pushed branch, its checks and the batch's pull request, with
// the combine and the push writing to it in place of git (`combine.test.ts` owns git).

const REPO = "repo-meter";
const TASK = "ab12cd34";
const BRANCH = "fm/task-ab12cd34";
const HEAD = "5f0c2a9e41b7d3c8a6e2f9b0d4c1a7e3b8f6d2c0";
/** The story a crewmate prepared for the change at its pushed version. */
const STORY: ChangePresentation = {
  version: 1,
  taskId: TASK,
  revision: 1,
  title: "fix(parser): read dates with a time zone",
  base: BATCH_BASE,
  head: HEAD,
  destination: METER_DESTINATION,
  why: ["A date with a time zone was read an hour off."],
  whatChanged: ["Dates with a time zone are read as written."],
  before: ["A date with a zone lost its offset."],
  after: ["The date keeps the offset it was written with."],
  noPicture: "The change is in how a date is read, which no screen shows.",
  views: [],
  assets: [],
  pictures: [],
  verification: ["Ran the parser's date tests."],
  risk: Object.fromEntries(
    RISK_DIMENSIONS.map((dimension) => [dimension, { level: "low", why: "One parser function." }]),
  ) as RiskDeclaration,
  requiredActions: [],
  unfinished: [],
  projectText: "",
};

function home() {
  const forge = new BatchHostForge(HEAD);
  const approvals = new Map<string, string>();
  const conflicting = new Set<string>();
  const heard = {
    sentBack: [] as { taskId: string; reason: string }[],
    settled: [] as string[][],
  };
  let clock = 10_000;
  const tick = () => {
    clock += 1;
    return clock;
  };
  const at = setup({ forge, batches: () => batches });
  seedProject(at.db, {
    id: REPO,
    name: "meter",
    path: tmpdir(),
    origin: "https://github.com/acme/meter.git",
    delivery: "queue-pr",
  });
  insertTask(at.tasks, { repoId: REPO });
  at.readHead.mockImplementation(async () => forge.pushed ?? "");
  const batches: Batches = new Batches({
    repos: at.repos,
    forgeFor: () => forge,
    now: tick,
    naming: () => BUNDLED_NAMING,
    approved: (taskId, head) => approvals.get(taskId) === head,
    runsNoChecks: (taskId, head) => at.service.checks.declaredAbsent(taskId, head),
    live: () => true,
    story: async (member) => ({ region: `<!-- story of ${member.taskId} -->`, projectText: "" }),
    settle: (taskIds) => heard.settled.push(taskIds),
    sentBack: (change, reason) => {
      approvals.delete(change.taskId);
      heard.sentBack.push({ taskId: change.taskId, reason });
    },
    held: () => {},
    note: () => {},
    taskNote: () => {},
    ...standInGit(forge, conflicting),
  });
  /** The crewmate prepared the story for the pushed version. */
  const prepare = (story: ChangePresentation = STORY) =>
    at.tasks.delivery.updateChangePresentation(TASK, () => ({ revisions: [story], receipts: [] }));
  /** The captain's click on the merge card: the approval kept at the version it showed. */
  const guard = (overrides: Partial<MergeGuard> = {}): MergeGuard => {
    approvals.set(TASK, overrides.head ?? HEAD);
    return { head: HEAD, unattended: false, beforeDispatch: () => undefined, ...overrides };
  };
  /** The story confirmed on the pushed branch, as open_change leaves it. */
  const confirmed = async () => {
    prepare();
    await at.service.publication.open(TASK, { title: STORY.title, presentation: 1 });
  };
  return {
    ...at,
    forge,
    batches,
    approvals,
    conflicting,
    heard,
    prepare,
    guard,
    confirmed,
    pass: () => batches.pass(REPO),
    line: () => batches.record(REPO).line,
    open: () => batches.record(REPO).open,
    /** Another task's approved change, already in line. */
    other(taskId: string, title: string, head: string) {
      insertTask(at.tasks, { id: taskId, repoId: REPO, branch: `fm/task-${taskId}` });
      approvals.set(taskId, head);
      batches.enqueue(REPO, {
        taskId,
        branch: `fm/task-${taskId}`,
        head,
        title,
        body: "",
        at: tick(),
      });
    },
  };
}

describe("a change of a project that gets batches of the person's own", () => {
  it("confirms its story on the pushed branch with open_change and opens no pull request of its own", async () => {
    const at = home();
    at.prepare();
    expect(await at.service.publication.open(TASK, { title: STORY.title, presentation: 1 })).toBe(
      BATCH_OPEN_WORDS.confirmed(BRANCH),
    );
    expect(at.forge.calls.filter((call) => call.startsWith("openChange"))).toEqual([]);
    expect(at.forge.batch).toBeUndefined();
    // There are no words around a story that has no pull request of its own.
    expect(
      await at.service.publication.open(TASK, {
        title: STORY.title,
        presentation: 1,
        around: { from: "", to: "Closes #412." },
      }),
    ).toBe(BATCH_OPEN_WORDS.around);
  });

  it("shows its merge card's story from the pushed branch, where no pull request of its own is open", async () => {
    const at = home();
    await at.confirmed();
    const shown = await at.service.publication.completionPresentation(TASK, 1);
    expect(shown).toMatchObject({ revision: 1, title: STORY.title });
    expect(at.forge.calls.filter((call) => call.startsWith("openChange"))).toEqual([]);

    // A story never confirmed on the pushed branch has no merge card to show.
    const unconfirmed = home();
    unconfirmed.prepare();
    await expect(unconfirmed.service.publication.completionPresentation(TASK, 1)).rejects.toThrow();
  });

  it("refuses to confirm a story whose version is not the one pushed", async () => {
    const at = home();
    at.prepare();
    at.forge.pushed = "c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7";
    const said = await at.service.publication.open(TASK, { title: STORY.title, presentation: 1 });
    expect(said).toContain("The code changed after this story was prepared.");
    expect(said).not.toBe(BATCH_OPEN_WORDS.confirmed(BRANCH));
  });

  it("reads the checks the project runs on its pushed branch, by that branch's commit", async () => {
    const at = home();
    at.forge.states = ["success", "failure"];
    at.forge.names = ["build", "unit-tests"];
    const run = await at.service.checks.run(TASK, "crewmate");
    expect(run.recorded).toBe(true);
    expect(run.checked?.change).toEqual({ branch: BRANCH, headSha: HEAD, url: null });
    expect(at.forge.calls).toContain(`checks ${HEAD}`);
    expect(at.service.checks.reading(TASK)?.overall).toBe("red");

    at.forge.states = ["success", "success"];
    await at.service.checks.run(TASK, "crewmate");
    expect(at.service.checks.reading(TASK)?.overall).toBe("green");
  });

  it("reads a branch nobody pushed as having no change yet", async () => {
    const at = home();
    at.forge.pushed = null;
    const run = await at.service.checks.run(TASK, "crewmate");
    expect(run.checked).toBeUndefined();
    expect(at.forge.calls.filter((call) => call.startsWith("checks"))).toEqual([]);
  });

  it("takes a declaration that its pushed version runs no checks, at that exact version only", async () => {
    const at = home();
    at.forge.states = [];
    const absent = {
      evidence: "No workflow of the project runs on a pushed task branch.",
      localGate: "pnpm check:changed passed at this version.",
    };
    expect(
      await at.service.checkTool.checkForCrew(TASK, {
        absentChecks: { ...absent, headSha: "c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7" },
      }),
    ).toBe(
      `Absence declaration refused: it must name this task's pushed branch at its current version, ${HEAD}, with the workflow and changed-file evidence and the local gate run at that version.`,
    );
    expect(at.service.checks.declaredAbsent(TASK, HEAD)).toBe(false);

    const said = await at.service.checkTool.checkForCrew(TASK, {
      absentChecks: { ...absent, headSha: HEAD },
    });
    expect(said).toContain("Absence evidence stored for this version.");
    expect(at.service.checks.declaredAbsent(TASK, HEAD)).toBe(true);
    // The declaration is about that version: a later push has none.
    expect(at.service.checks.declaredAbsent(TASK, "c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7")).toBe(
      false,
    );
  });
});

describe("the merge of a change that joins a batch", () => {
  it("joins only from its merge card: a merge with no kept approval says so and puts nothing in line", async () => {
    const at = home();
    await at.confirmed();
    expect(await at.service.merges.merge(TASK)).toEqual({
      ok: false,
      text: BATCH_MERGE_WORDS.needsCard,
      plain: "it joins its batch from its merge card",
    });
    expect(at.line()).toEqual([]);
    expect(at.open()).toBeUndefined();
  });

  it("puts the approved version in line with its story's title and commit words, and sends no merge", async () => {
    const at = home();
    await at.confirmed();
    const outcome = await at.service.merges.merge(TASK, at.guard());
    expect(outcome).toEqual({
      ok: false,
      text: `Approved and in line: ${BATCH_WAITING_WORDS.toLowerCase()}. The change merges with this project's next batch, as one commit of its own.`,
      plain: BATCH_WAITING_WORDS.toLowerCase(),
      stop: "queue",
    });
    await at.pass();
    expect(at.open()?.members).toMatchObject([
      {
        taskId: TASK,
        branch: BRANCH,
        head: HEAD,
        title: STORY.title,
        body: presentationCommitMessage(STORY, BUNDLED_NAMING),
      },
    ]);
    expect(at.forge.calls.filter((call) => call.startsWith("putIn"))).toEqual([]);
    // The batch of one opened as this change's own pull request would read.
    expect(at.forge.batch).toMatchObject({ number: 31, title: STORY.title });
  });

  it("keeps the order of the approvals in line when a later approval's merge run reaches the line first", async () => {
    // The plan: the app combines "the whole line at home, in approval order".
    // A merge run reads the branch, its checks and its story before it reaches
    // the line, so a change approved first can arrive there second.
    const at = home();
    await at.confirmed();
    // A batch being checked, so the approvals after it wait in line.
    at.other("aa11bb22", "fix(dates): keep the dates file", "1".repeat(40));
    await at.pass();
    at.other("cd34ef56", "fix(export): keep the export file", "2".repeat(40));
    await at.pass();
    const later = at.line()[0]?.at as number;
    await at.service.merges.merge(TASK, at.guard({ approvedAt: later - 1 }));
    expect(at.line().map((change) => change.taskId)).toEqual([TASK, "cd34ef56"]);
  });

  it("waits while its batch is checked, shows its place as the batch check, then merges with the batch and names its own commit", async () => {
    const at = home();
    await at.confirmed();
    const guard = at.guard();
    await at.service.merges.merge(TASK, guard);
    await at.pass();

    expect(await at.service.merges.merge(TASK, guard)).toEqual({
      ok: false,
      text: `Cannot merge yet - ${BATCH_WAITING_WORDS}: the change is in batch #31, whose checks have not passed yet.`,
      plain: BATCH_WAITING_WORDS.toLowerCase(),
      stop: "queue",
    });
    // Its own check reading carries its place in the batch, kept on the task for the merge card.
    await at.service.checks.run(TASK, "crewmate");
    expect(at.tasks.get(TASK)?.delivery?.queueStatus).toEqual({
      head: HEAD,
      kind: "in-batch",
      words: BATCH_STATUS_WORDS.batch,
      link: "https://github.com/acme/meter/pull/31",
    });
    expect(at.service.checks.reading(TASK)?.overall).toBe("pending");

    at.forge.atHead[at.forge.batchHead] = [{ name: "build", state: "success" }];
    (at.forge.batch as NonNullable<BatchHostForge["batch"]>).readiness = "clean";
    await at.pass();
    const commit = at.forge.batchHead;
    expect(await at.service.merges.merge(TASK, guard)).toEqual({
      ok: true,
      text: "Merged with batch #31 on GitHub. https://github.com/acme/meter/pull/31",
      line: "Merged with batch #31 on GitHub",
      receipt: { head: HEAD, sha: id(`merge of ${commit}`) },
    });
    expect(at.heard.settled).toEqual([[TASK]]);
  });

  it("puts nothing in line while the pushed branch's own checks have not passed", async () => {
    const at = home();
    await at.confirmed();
    at.forge.states = ["failure"];
    expect(await at.service.merges.merge(TASK, at.guard())).toMatchObject({
      ok: false,
      notGreen: true,
      stop: "checks",
      plain: "the checks failed",
    });
    at.forge.states = ["pending"];
    expect(await at.service.merges.merge(TASK, at.guard())).toMatchObject({
      ok: false,
      notGreen: true,
      stop: "checks",
    });
    expect(at.line()).toEqual([]);
    expect(at.open()).toBeUndefined();
  });

  it("puts nothing in line for a branch that moved past the approved version, a held approval or a withdrawn one", async () => {
    const at = home();
    await at.confirmed();
    expect(
      await at.service.merges.merge(
        TASK,
        at.guard({ held: () => "the captain's newer words wait for the crewmate's declaration" }),
      ),
    ).toEqual({
      ok: false,
      text: "Cannot merge yet: the captain's newer words wait for the crewmate's declaration.",
      stop: "guidance",
    });
    expect(
      await at.service.merges.merge(
        TASK,
        at.guard({ beforeDispatch: () => "The merge approval was withdrawn" }),
      ),
    ).toEqual({
      ok: false,
      text: "Cannot merge: The merge approval was withdrawn.",
      stop: "withdrawn",
    });
    at.forge.pushed = "c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7";
    expect(await at.service.merges.merge(TASK, at.guard())).toMatchObject({
      ok: false,
      plain: "it changed after the version you approved",
      stop: "moved",
    });
    expect(at.line()).toEqual([]);
    expect(at.open()).toBeUndefined();
  });

  it("refuses a version whose story was never confirmed on the pushed branch", async () => {
    const at = home();
    const outcome = await at.service.merges.merge(TASK, at.guard());
    expect(outcome.ok).toBe(false);
    expect(outcome.stop).not.toBe("queue");
    expect(at.line()).toEqual([]);
  });

  it("says why a change was left out of its batch", async () => {
    const at = home();
    await at.confirmed();
    at.conflicting.add(TASK);
    const guard = at.guard();
    await at.service.merges.merge(TASK, guard);
    await at.pass();
    expect(await at.service.merges.merge(TASK, guard)).toEqual({
      ok: false,
      text: `Cannot merge: the change was left out of its batch because ${LEFT_OUT_WORDS.conflict}.`,
      plain: LEFT_OUT_WORDS.conflict,
      stop: "conflict",
    });
  });

  it("reads its batch's failed checks as its own when it is the batch's only change", async () => {
    const at = home();
    await at.confirmed();
    const guard = at.guard();
    await at.service.merges.merge(TASK, guard);
    await at.pass();
    at.forge.atHead[at.forge.batchHead] = [{ name: "unit-tests", state: "failure" }];
    await at.pass();
    expect(await at.service.merges.merge(TASK, guard)).toEqual({
      ok: false,
      text: "Cannot merge yet - the checks of its batch, #31, failed: unit-tests. Its crewmate reads them there and repairs the change in a new version.",
      plain: "the checks of its batch failed",
      notGreen: true,
      stop: "checks",
    });
    await at.service.checks.run(TASK, "crewmate");
    expect(at.service.checks.reading(TASK)?.overall).toBe("red");
    expect(at.tasks.get(TASK)?.delivery?.queueStatus).toMatchObject({ kind: "failed" });
  });

  it("leaves the line and the open batch when its approval is removed", async () => {
    const at = home();
    await at.confirmed();
    await at.service.merges.merge(TASK, at.guard());
    await at.pass();
    expect(at.open()?.members.map((member) => member.taskId)).toEqual([TASK]);
    await at.service.merges.removeQueuedApproval(TASK, {
      head: HEAD,
      target: { repoId: REPO, branch: BRANCH },
    } as Parameters<typeof at.service.merges.removeQueuedApproval>[1]);
    await at.pass();
    expect(at.open()).toBeUndefined();
    expect(at.batches.standing(REPO, TASK, HEAD)).toBeUndefined();
  });

  // The independent review's finding on this change, a bug being fixed, with the captain's
  // answer to it: a story revised at the approved version keeps its change in its batch.
  it("keeps its place in its batch when its story is revised at the approved version, and the batch takes the story's words", async () => {
    const at = home();
    await at.confirmed();
    const guard = at.guard();
    await at.service.merges.merge(TASK, guard);
    await at.pass();
    expect(at.forge.batch).toMatchObject({ number: 31, title: STORY.title, state: "open" });

    // The crewmate revises the story's What changed at the same pushed version.
    const revised: ChangePresentation = {
      ...STORY,
      revision: 2,
      whatChanged: ["A date keeps the time zone it was written with."],
    };
    at.tasks.delivery.updateChangePresentation(TASK, (kept) => ({
      ...(kept as NonNullable<typeof kept>),
      revisions: [STORY, revised],
    }));
    expect(await at.service.publication.open(TASK, { title: STORY.title, presentation: 2 })).toBe(
      BATCH_OPEN_WORDS.confirmed(BRANCH),
    );
    await at.pass();
    expect(at.open()?.members).toMatchObject([
      { taskId: TASK, head: HEAD, body: presentationCommitMessage(revised, BUNDLED_NAMING) },
    ]);
    // The same pull request, still open: none was closed and none opened beside it.
    expect(at.forge.calls.filter((call) => call.startsWith("openChange"))).toHaveLength(1);
    expect(at.forge.calls.filter((call) => call.startsWith("close"))).toEqual([]);
    expect(at.forge.batch).toMatchObject({ number: 31, state: "open" });
    // Its kept merge reads the change still in its batch, and puts nothing in line again.
    expect(await at.service.merges.merge(TASK, guard)).toMatchObject({ stop: "queue" });
    expect(at.line()).toEqual([]);
  });

  // Intent: the follow-up filed at this project's own switch from the team queue (INF-3773):
  // "a version still carrying the queue's waiting mark joins the person's own batch instead of
  // waiting forever". An earlier version of the app wrote that mark where the project lives, and
  // nothing answers it now.
  it("is not held by the waiting mark an earlier version's team queue left on its version", async () => {
    const at = home();
    await at.confirmed();
    at.forge.atHead[HEAD] = [
      { name: "linux-checks", state: "success" },
      { name: BATCH_CHECK, state: "pending", statusId: 41, detail: BATCH_WAITING_WORDS },
    ];

    await at.service.checks.run(TASK, "crewmate");
    expect(at.service.checks.reading(TASK)?.overall).toBe("green");
    // The captain's approval, kept from before the switch, runs again.
    expect(await at.service.merges.merge(TASK, at.guard({ unattended: true }))).toMatchObject({
      ok: false,
      stop: "queue",
    });
    await at.pass();
    expect(at.open()?.members).toMatchObject([{ taskId: TASK, head: HEAD }]);
  });
});

describe("a repair's answer to its project's held batch", () => {
  const PARSER_HEAD = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
  const EXPORT_HEAD = "0f9e8d7c6b5a49382716f5e4d3c2b1a009182736";
  const LEGEND_HEAD = "7e6d5c4b3a2918070f6e5d4c3b2a190817263544";

  /** Three other tasks' changes in one batch whose checks failed; this task is the repair. */
  async function held() {
    const at = home();
    at.other("parser01", "fix(parser): read dates with a time zone", PARSER_HEAD);
    at.other("export02", "feat(export): add a CSV export", EXPORT_HEAD);
    at.other("legend03", "fix(chart): keep the legend inside the chart", LEGEND_HEAD);
    await at.pass();
    at.forge.atHead[at.forge.batchHead] = [{ name: "unit-tests", state: "failure" }];
    await at.pass();
    expect(at.open()?.hold).toMatchObject({ reason: "checks", checks: ["unit-tests"] });
    return at;
  }
  const evidence =
    "The date test fails with the parser change alone and passes without it; the export and legend changes touch neither.";

  it("refuses a declaration where no batch of the project is held", async () => {
    const at = home();
    expect(await at.service.checkTool.checkForCrew(TASK, { batch: { fix: true, evidence } })).toBe(
      BATCH_DECLARATION_WORDS.none,
    );
  });

  it("sends two changes back, each with the reason its crewmate reads, and the rest go on", async () => {
    const at = await held();
    const said = await at.service.checkTool.checkForCrew(TASK, {
      batch: {
        sendBack: [
          { task: "parser01", reason: "its date test fails on the batch's version" },
          { task: "export02", reason: "its export reads the dates the parser change moved" },
        ],
        evidence,
      },
    });
    expect(said).toBe(BATCH_DECLARATION_WORDS.sentBack(2));
    expect(at.heard.sentBack).toEqual([
      { taskId: "parser01", reason: "its date test fails on the batch's version" },
      { taskId: "export02", reason: "its export reads the dates the parser change moved" },
    ]);
    expect(at.open()?.members.map((member) => member.taskId)).toEqual(["legend03"]);
    expect(at.open()?.hold).toBeUndefined();
  });

  it("refuses a send-back that names a change the batch does not carry, or gives no reason", async () => {
    const at = await held();
    expect(
      await at.service.checkTool.checkForCrew(TASK, {
        batch: { sendBack: [{ task: TASK, reason: "it broke the date test" }], evidence },
      }),
    ).toBe(
      // The batch's changes are named by the keys a person reads on their tasks.
      BATCH_DECLARATION_WORDS.notMember(
        TASK,
        ["parser01", "export02", "legend03"].map((member) => at.tasks.get(member)?.key as string),
      ),
    );
    expect(
      await at.service.checkTool.checkForCrew(TASK, {
        batch: { sendBack: [{ task: "parser01", reason: "  " }], evidence },
      }),
    ).toBe(BATCH_DECLARATION_WORDS.reason("parser01"));
    expect(at.heard.sentBack).toEqual([]);
    expect(at.open()?.members).toHaveLength(3);
  });

  it("refuses a declaration with no evidence, with both answers or with neither, and one sent beside another declaration", async () => {
    const at = await held();
    const tool = at.service.checkTool;
    expect(await tool.checkForCrew(TASK, { batch: { fix: true, evidence: " " } })).toBe(
      BATCH_DECLARATION_WORDS.evidence,
    );
    expect(await tool.checkForCrew(TASK, { batch: { evidence } })).toBe(
      BATCH_DECLARATION_WORDS.one,
    );
    expect(
      await tool.checkForCrew(TASK, {
        batch: {
          fix: true,
          sendBack: [{ task: "parser01", reason: "its date test fails" }],
          evidence,
        },
      }),
    ).toBe(BATCH_DECLARATION_WORDS.one);
    expect(
      await tool.checkForCrew(TASK, {
        batch: { fix: true, evidence },
        absentChecks: { headSha: HEAD, evidence: "none run", localGate: "passed" },
      }),
    ).toBe("Batch declaration refused: send batch on its own, not beside absentChecks.");
    expect(at.batches.record(REPO).fixes).toBeUndefined();
    expect(at.open()?.hold).toBeDefined();
  });

  it("declares its own change the batch's fix: once approved it joins the held batch and ends the hold", async () => {
    const at = await held();
    const before = at.forge.batchHead;
    expect(await at.service.checkTool.checkForCrew(TASK, { batch: { fix: true, evidence } })).toBe(
      BATCH_DECLARATION_WORDS.fix,
    );
    expect(at.batches.record(REPO).fixes).toEqual([TASK]);
    // Declared, not yet approved: the batch stays held.
    await at.pass();
    expect(at.open()?.hold).toBeDefined();

    await at.confirmed();
    await at.service.merges.merge(TASK, at.guard());
    await at.pass();
    expect(at.open()?.members.map((member) => member.taskId)).toEqual([
      "parser01",
      "export02",
      "legend03",
      TASK,
    ]);
    expect(at.open()?.hold).toBeUndefined();
    expect(at.forge.batchHead).not.toBe(before);
    expect(at.forge.batch?.title).toBe("chore: merge 4 approved changes");
  });
});

describe("the words a batch gives a task", () => {
  it("tells a left-out change's task what to do next in words that name no tool of one host", () => {
    expect(BATCH_WORDS.leftOut(LEFT_OUT_WORDS.moved)).toBe(
      "This change was left out of its batch because its pushed branch is no longer at the approved version, so the batch could not carry what was approved. Bring the branch up to date and show a new version; the other changes went on.",
    );
  });
});
