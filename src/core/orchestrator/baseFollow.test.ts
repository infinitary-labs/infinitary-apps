import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import { LEFT_OUT_WORDS } from "../batches/combine";
import { openInMemoryDatabase } from "../storage/db";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import { approvedChangeBase, followBase, recordedBases } from "./baseFollow";
import { lineageFacts } from "./checkChangeTool";
import { renderRepairAssessmentBrief } from "./intentBrief";
import { unaccountedPaths } from "./mergeAuthorization";

// This file chains real git and is not about the utility-QoS clamp, so what
// the product spawns runs at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

// Integration budget (docs/test-cohorts.md): real git in a scratch repository, the slowest
// test took 2.4 s on the Mac, five times that rounded up.
vi.setConfig({ testTimeout: 12_000 });

// Intent: INF-5269's approved plan, part 3, "Follow the part under it": a part built on
// another part's approved version moves its recorded base to that part's newer approved
// version once its own version holds it, a merge card at a version that does not is
// refused in the batch line's words, and a kept approval's repair onto that newer version
// compares paths against the version the part was approved on.

const run = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" })
    .toString()
    .trim();

/** Commit one file on the checked-out branch and return the new version. */
function commit(repo: string, file: string, text: string, subject: string): string {
  writeFileSync(join(repo, file), text);
  run(repo, "add", file);
  run(repo, "commit", "-m", subject);
  return run(repo, "rev-parse", "HEAD");
}

/**
 * A project whose first part was approved at `first`, the second part built on it at
 * `second`, and the first part then repaired onto a newer default branch at `newer`,
 * which the captain's kept approval covers: the second part replays its own commit onto
 * `newer` at `replayed`.
 */
function chain() {
  const repo = scratchDir("infinitary-base-follow-");
  run(repo, "init", "--initial-branch=main");
  run(repo, "config", "user.name", "Ada Crew");
  run(repo, "config", "user.email", "ada@example.com");
  commit(repo, "readme.md", "meter\n", "chore: start the meter");
  run(repo, "checkout", "-b", "inf/csv-export");
  const first = commit(repo, "export.ts", "export const csv = 1;\n", "feat: add the CSV export");
  run(repo, "checkout", "-b", "inf/export-panel");
  const second = commit(repo, "panel.ts", "export const panel = 1;\n", "feat: show the export");
  // The default branch moves on and the first part is brought up to date with it.
  run(repo, "checkout", "main");
  commit(repo, "license.md", "MIT\n", "docs: add the license");
  run(repo, "checkout", "inf/csv-export");
  run(repo, "rebase", "main");
  const newer = run(repo, "rev-parse", "HEAD");
  run(repo, "checkout", "-b", "replayed", "inf/export-panel");
  run(repo, "rebase", "--onto", newer, first);
  const replayed = run(repo, "rev-parse", "HEAD");
  return { repo, first, second, newer, replayed };
}

function setup(facts: ReturnType<typeof chain>) {
  const tasks = new TaskService({ db: openInMemoryDatabase(), now: () => 1_000, strict: true });
  const base = seedTask(tasks, {
    id: "base",
    title: "Add the CSV export",
    status: "completed",
    repoDir: facts.repo,
  });
  const later = seedTask(tasks, {
    id: "later",
    title: "Show the export in the panel",
    status: "completed",
    repoDir: facts.repo,
    shape: {
      kind: "implement",
      built_on: { task: base.key, branch: "inf/csv-export", head: facts.first },
    },
  });
  // The captain's kept approval of the first part covers its repair onto the newer default branch.
  seedDelivery(tasks, base.id, {
    mergeAuthorization: {
      version: 1,
      id: "approval-base",
      generation: 1,
      issuer: "captain",
      at: 1,
      card: { id: "merge-card", offerId: "offer-1", actionId: "merge" },
      target: {
        repoId: "r1",
        host: "github.com",
        owner: "example",
        name: "meter",
        branch: "inf/csv-export",
        delivery: "direct-pr",
        method: "squash",
      },
      approvedHead: facts.first,
      proceedWithOpen: false,
      status: "standing",
      lineage: [
        {
          fromHead: facts.first,
          toHead: facts.newer,
          newBase: run(facts.repo, "rev-parse", "main"),
          impact: "none",
          changedPaths: [],
          evidence: "brought up to date with the default branch",
          validation: "the unit tests",
          generation: 1,
          at: 2,
        },
      ],
    },
  });
  return { tasks, later };
}

describe("following the part under it", () => {
  it("refuses a version behind the part's newest approved version in the batch line's words", async () => {
    const facts = chain();
    const { tasks, later } = setup(facts);
    expect(await followBase(tasks, later.id, facts.second)).toBe(
      LEFT_OUT_WORDS.behindBase(facts.newer),
    );
    expect(tasks.get(later.id)?.shape?.built_on?.head).toBe(facts.first);
  });

  it("moves the recorded base once the part's version holds the newer approved version", async () => {
    const facts = chain();
    const { tasks, later } = setup(facts);
    expect(await followBase(tasks, later.id, facts.replayed)).toBeUndefined();
    expect(tasks.get(later.id)?.shape?.built_on).toEqual({
      task: tasks.get("base")?.key,
      branch: "inf/csv-export",
      head: facts.newer,
    });
  });

  it("says nothing about a version this checkout does not hold", async () => {
    const facts = chain();
    const { tasks, later } = setup(facts);
    expect(await followBase(tasks, later.id, "f".repeat(40))).toBeUndefined();
    expect(tasks.get(later.id)?.shape?.built_on?.head).toBe(facts.first);
  });

  it("compares a repair onto the newer approved version with the version the part was approved on", async () => {
    const facts = chain();
    const question = {
      approvedHead: facts.second,
      fromHead: facts.second,
      toHead: facts.replayed,
      newBase: facts.newer,
    };
    const read = await lineageFacts(facts.repo, {
      ...question,
      recordedBases: [facts.newer, facts.first],
    });
    if (!read.known) throw new Error(read.why);
    expect(read.baseInTo).toBe(true);
    expect(read.approvedPaths).toEqual(["panel.ts"]);
    expect(read.repairedPaths).toEqual(["panel.ts"]);
    expect(unaccountedPaths(read, [])).toEqual([]);
    // Read from where it leaves the newer version alone, the first part's paths would count.
    const unread = await lineageFacts(facts.repo, question);
    if (!unread.known) throw new Error(unread.why);
    expect(unaccountedPaths(unread, [])).toEqual(["export.ts"]);
  });

  // The captain's answer on the review's question: the repair's independent assessment
  // starts from the version the part was approved on, worked out when it is commissioned.
  it("briefs a repair's assessment with the approved change read from the version the part was built on", async () => {
    const facts = chain();
    const { tasks, later } = setup(facts);
    const recorded = recordedBases(tasks, tasks.get(later.id)!, facts.newer);
    expect(recorded).toEqual([facts.first]);
    expect(recordedBases(tasks, tasks.get(later.id)!, facts.second)).toBeUndefined();
    const approvedBase = await approvedChangeBase(facts.repo, facts.second, facts.newer, recorded);
    expect(approvedBase).toBe(facts.first);
    const brief = renderRepairAssessmentBrief({
      builderTitle: "Show the export in the panel",
      change: "the change",
      approvedHead: facts.second,
      fromHead: facts.second,
      toHead: facts.replayed,
      newBase: facts.newer,
      approvedBase,
      paths: { approved: ["panel.ts"], repaired: ["panel.ts"] },
      evidence: "replayed onto the repaired export",
      validation: "the unit tests",
    });
    // The command the assessor runs reads only the part's own file.
    expect(brief).toContain(`git diff ${facts.first} ${facts.second}`);
    expect(run(facts.repo, "diff", "--name-only", approvedBase, facts.second)).toBe("panel.ts");
    expect(brief).not.toContain("git merge-base");
  });
});
