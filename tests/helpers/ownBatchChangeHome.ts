import { tmpdir } from "node:os";
import { Batches } from "../../src/core/batches/batches";
import type { MergeGuard } from "../../src/core/orchestrator/changeMerge";
import {
  candidateHead,
  standingAuthorization,
} from "../../src/core/orchestrator/mergeAuthorization";
import { approvedWhere } from "../../src/core/orchestrator/ownBatches";
import { seedProject } from "../../src/core/workspace/seedProject";
import type { ChangePresentation } from "../../src/shared/changePresentation";
import { RISK_DIMENSIONS, type RiskDeclaration } from "../../src/shared/risk";
import { BATCH_BASE, BatchHostForge, METER_DESTINATION, standInGit } from "./batchHost";
import { BUNDLED_NAMING } from "./namingRunbook";
import { type CheckedOut, insertTask, setup } from "./prCiHarness";

// A change of a project that gets batches of the person's own, for
// `src/core/orchestrator/ownBatchChange.test.ts` and `ownBatchChange.held.test.ts`.
//
// The change delivery is wired as the app wires it over a fresh database; the stand-in is
// the host, which holds the pushed branch, its checks and the batch's pull request, with
// the combine and the push writing to it in place of git (`combine.test.ts` owns git).

export const REPO = "repo-meter";
export const TASK = "ab12cd34";
export const BRANCH = "fm/task-ab12cd34";
export const HEAD = "5f0c2a9e41b7d3c8a6e2f9b0d4c1a7e3b8f6d2c0";
export const STORY: ChangePresentation = {
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

/**
 * The project and its host. `dir` is the project's folder, a real repository where a
 * case reads git, `head` the pushed version the story and the approval name, and
 * `checkedOut` what the computer a task runs on says of its working copy there.
 */
export function home(where: { dir?: string; head?: string; checkedOut?: CheckedOut } = {}) {
  const head = where.head ?? HEAD;
  const story: ChangePresentation = { ...STORY, head };
  const forge = new BatchHostForge(head);
  const approvals = new Map<string, string>();
  const conflicting = new Set<string>();
  const heard = {
    sentBack: [] as { taskId: string; reason: string }[],
    addressMoved: [] as { taskId: string; reason: string }[],
    settled: [] as string[][],
  };
  let clock = 10_000;
  const tick = () => {
    clock += 1;
    return clock;
  };
  const at = setup({
    forge,
    batches: () => batches,
    ...(where.checkedOut ? { checkedOut: where.checkedOut } : {}),
  });
  seedProject(at.db, {
    id: REPO,
    name: "meter",
    path: where.dir ?? tmpdir(),
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
    // As the app reads it: the captain's standing approval covers the version, or the
    // stand-in's own click for a change that has none on its record.
    approved: (taskId, version, repo) => {
      const kept = standingAuthorization(at.tasks.get(taskId)?.delivery);
      if (kept && candidateHead(kept) === version) return approvedWhere(kept, repo);
      return approvals.get(taskId) === version;
    },
    runsNoChecks: (taskId, head) => at.service.checks.declaredAbsent(taskId, head),
    live: () => true,
    story: async (member) => ({ region: `<!-- story of ${member.taskId} -->`, projectText: "" }),
    settle: (taskIds) => heard.settled.push(taskIds),
    sentBack: (change, sent) => heard.sentBack.push({ taskId: change.taskId, reason: sent.reason }),
    addressMoved: (change, reason) => heard.addressMoved.push({ taskId: change.taskId, reason }),
    held: () => {},
    note: () => {},
    taskNote: () => {},
    ...standInGit(forge, conflicting),
  });
  const prepare = (prepared: ChangePresentation = story) =>
    at.tasks.delivery.updateChangePresentation(TASK, () => ({
      revisions: [prepared],
      receipts: [],
    }));
  /** The captain's click on the merge card: the approval kept at the version it showed. */
  const guard = (overrides: Partial<MergeGuard> = {}): MergeGuard => {
    approvals.set(TASK, overrides.head ?? head);
    return { head, unattended: false, beforeDispatch: () => undefined, ...overrides };
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
