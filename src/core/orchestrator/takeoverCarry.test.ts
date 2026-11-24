import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acceptedValidation, type LiveValidation } from "@shared/liveValidation";
import { afterEach, beforeEach, expect, it } from "vitest";
import { freshDatabase } from "../../../tests/helpers/database";
import { noSurfaceProof } from "../../../tests/helpers/liveValidation";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import { carryTakenOverReview } from "./takeoverCarry";

// INF-6536 finding 3: a takeover whose committed version is the very commit
// an earlier task's review passed carries that pass and its accepted proof,
// naming the task that earned them. Any other commit carries nothing.
const reviewed = "4f1c2b9e8d7a6c5b4a39281706f5e4d3c2b1a098";
const oneCommitPast = "9e2d1c0b8a7f6e5d4c3b2a1908f7e6d5c4b3a291";
const transcript = "$ pnpm test src/panels/now\n✓ 14 passed\n";

let root: string;
let tasks: TaskService;
const proofDir = (taskId: string) => join(root, taskId);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "takeover-carry-"));
  let clock = 1_000;
  tasks = new TaskService({ db: freshDatabase(), strict: true, now: () => ++clock });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function proofAt(taskId: string, head: string): LiveValidation {
  const bytes = Buffer.from(transcript, "utf8");
  const file = `${taskId}-now-panel-tests.txt`;
  mkdirSync(proofDir(taskId), { recursive: true });
  writeFileSync(join(proofDir(taskId), file), bytes);
  const state = noSurfaceProof(head);
  const [run] = state.runs;
  if (!run) throw new Error("the proof fixture has a run");
  state.runs[0] = {
    ...run,
    evidence: [
      {
        id: "now-panel-tests",
        description: "The Now panel's tests at the reviewed commit",
        digest: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.length,
        file,
        text: transcript,
      },
    ],
  };
  return state;
}

function earnedAndTakeover(options: { proof?: boolean } = {}) {
  const earned = seedTask(tasks, { id: "earned", title: "Sort the Now panel", status: "idle" });
  const takeover = seedTask(tasks, {
    id: "takeover",
    title: "Take over: sort the Now panel",
    status: "running",
  });
  tasks.graph.link(earned.id, takeover.id, "replaced-by", "firstmate");
  seedDelivery(tasks, earned.id, {
    headSha: reviewed,
    reviewVerdict: "pass",
    reviewSha: reviewed,
    reviewRisk: "low",
    reviewedAt: 5_000,
    ...(options.proof ? { liveValidation: proofAt(earned.id, reviewed) } : {}),
  });
  return { earned, takeover };
}

it("carries the pass, naming the task that earned it, when the takeover's commit is the reviewed one", () => {
  const { takeover } = earnedAndTakeover();
  const carried = carryTakenOverReview({ tasks, taskId: takeover.id, head: reviewed, proofDir });
  expect(carried).toEqual({
    taskId: "earned",
    key: tasks.get("earned")?.key,
    title: "Sort the Now panel",
    proof: false,
  });
  const delivery = tasks.get(takeover.id)?.delivery;
  expect(delivery?.reviewVerdict).toBe("pass");
  expect(delivery?.reviewSha).toBe(reviewed);
  expect(delivery?.reviewRisk).toBe("low");
  expect(delivery?.reviewFrom?.taskId).toBe("earned");
});

it("carries nothing when the takeover's commit is one past the reviewed one", () => {
  const { takeover } = earnedAndTakeover();
  expect(
    carryTakenOverReview({ tasks, taskId: takeover.id, head: oneCommitPast, proofDir }),
  ).toBeUndefined();
  expect(tasks.get(takeover.id)?.delivery?.reviewVerdict).toBeUndefined();
});

it("never replaces a verdict the takeover earned itself", () => {
  const { takeover } = earnedAndTakeover();
  tasks.delivery.recordChangeEvidence(takeover.id, {
    reviewVerdict: "findings",
    reviewSha: reviewed,
  });
  expect(
    carryTakenOverReview({ tasks, taskId: takeover.id, head: reviewed, proofDir }),
  ).toBeUndefined();
  expect(tasks.get(takeover.id)?.delivery?.reviewVerdict).toBe("findings");
  expect(tasks.get(takeover.id)?.delivery?.reviewFrom).toBeUndefined();
});

it("carries nothing to a task that is not handed the earlier work", () => {
  earnedAndTakeover();
  const stranger = seedTask(tasks, { id: "stranger", title: "Unrelated", status: "running" });
  expect(
    carryTakenOverReview({ tasks, taskId: stranger.id, head: reviewed, proofDir }),
  ).toBeUndefined();
});

it("carries the accepted proof as the takeover's own kept file", () => {
  const { takeover } = earnedAndTakeover({ proof: true });
  const carried = carryTakenOverReview({ tasks, taskId: takeover.id, head: reviewed, proofDir });
  expect(carried?.proof).toBe(true);
  const live = tasks.get(takeover.id)?.delivery?.liveValidation;
  expect(acceptedValidation(live, reviewed).ready).toBe(true);
  const evidence = live?.runs[0]?.evidence[0];
  if (!evidence) throw new Error("the carried run keeps its evidence");
  expect(evidence.file).toBe("takeover-now-panel-tests.txt");
  expect(readFileSync(join(proofDir("takeover"), evidence.file), "utf8")).toBe(transcript);
});

it("carries the pass without the proof when the proof's kept file is gone", () => {
  const { takeover } = earnedAndTakeover({ proof: true });
  rmSync(join(proofDir("earned"), "earned-now-panel-tests.txt"));
  const carried = carryTakenOverReview({ tasks, taskId: takeover.id, head: reviewed, proofDir });
  expect(carried?.proof).toBe(false);
  expect(tasks.get(takeover.id)?.delivery?.liveValidation).toBeUndefined();
});
