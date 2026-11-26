import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { BatchHostForge } from "../../../tests/helpers/batchHost";
import { gitRepo } from "../../../tests/helpers/crewHarnessGit";
import { BRANCH, HEAD, home, REPO, STORY, TASK } from "../../../tests/helpers/ownBatchChangeHome";
import { insertTask } from "../../../tests/helpers/prCiHarness";
import { BATCH_WORDS } from "../batches/batches";
import { BATCH_DECLARATION_WORDS } from "./checkChangeTool";
import { MERGE_CARD_WORDS } from "./mergeCardSteps";

// Intent: the captain's approved plan for batches of their own, piece 1: a repair answers a
// held batch by a typed declaration: send changes back, each with a reason, or declare
// its own change the fix.

// Some cases declare a fix from a repair's working copy, a real repository whose commit the
// declaration reads with git; none is about the utility-QoS clamp, so what the product
// spawns runs at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

describe("a repair's answer to its project's held batch", () => {
  const PARSER_HEAD = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
  const EXPORT_HEAD = "0f9e8d7c6b5a49382716f5e4d3c2b1a009182736";
  const LEGEND_HEAD = "7e6d5c4b3a2918070f6e5d4c3b2a190817263544";
  const AXIS_HEAD = "3c2b1a0918f7e6d5c4b3a2918070f6e5d4c3b2a1";

  /** Three other tasks' changes in one batch whose checks failed; this task is the repair. */
  async function held(where: Parameters<typeof home>[0] = {}) {
    const at = home(where);
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

  it("refuses a declaration with no evidence, with neither answer, and one sent beside another declaration", async () => {
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
        batch: { fix: true, evidence },
        absentChecks: { headSha: HEAD, evidence: "none run", localGate: "passed" },
      }),
    ).toBe("Batch declaration refused: send batch on its own, not beside absentChecks.");
    expect(at.batches.record(REPO).fixes).toBeUndefined();
    expect(at.open()?.hold).toBeDefined();
  });

  // Intent: the captain's approved plan to stop changes bouncing between batches, piece 3:
  // one declaration sends the change at fault back and declares the repair's own change the
  // fix, which the old route refused.
  it("sends a change back and declares its own change the fix in one declaration: the batch waits for the fix", async () => {
    const at = await held();
    const before = at.forge.batchHead;
    const sendBack = [{ task: "parser01", reason: "its date test fails on the batch's version" }];
    expect(
      await at.service.checkTool.checkForCrew(TASK, { batch: { fix: true, sendBack, evidence } }),
    ).toBe(BATCH_DECLARATION_WORDS.fixAndSentBack(1));
    expect(at.heard.sentBack).toEqual([
      { taskId: "parser01", reason: "its date test fails on the batch's version" },
    ]);
    // The change sent back keeps its approval (INF-5097, the captain's answer Keep), and
    // its version stands sent back, so it cannot join with the fix.
    expect(at.approvals.has("parser01")).toBe(true);
    expect(at.batches.standing(REPO, "parser01", PARSER_HEAD)).toMatchObject({
      state: "sent-back",
    });
    expect(at.batches.record(REPO).fixes).toEqual([TASK]);
    await at.pass();
    expect(at.open()?.hold).toBeDefined();
    expect(at.forge.batchHead).toBe(before);

    await at.confirmed();
    await at.service.merges.merge(TASK, at.guard());
    await at.pass();
    expect(at.open()?.members.map((member) => member.taskId)).toEqual([
      "export02",
      "legend03",
      TASK,
    ]);
    expect(at.open()?.hold).toBeUndefined();
    expect(at.forge.batchHead).not.toBe(before);
  });

  // Intent: INF-4421's finding, a bug being fixed: a repair's change approved before it was
  // declared the held batch's fix never joined, and its kept approval left it no new merge
  // card, so the batch and the fix waited on each other.
  it("declares its own change the fix after its approval: it joins the held batch at once with the changes waiting in line", async () => {
    const at = await held();
    const before = at.forge.batchHead;
    at.other("axis04", "fix(chart): label the time axis in local time", AXIS_HEAD);
    await at.confirmed();
    await at.service.merges.merge(TASK, at.guard());
    await at.pass();
    expect(at.open()?.hold).toBeDefined();
    expect(at.line().map((change) => change.taskId)).toEqual(["axis04", TASK]);

    expect(await at.service.checkTool.checkForCrew(TASK, { batch: { fix: true, evidence } })).toBe(
      BATCH_DECLARATION_WORDS.fixApproved,
    );
    await at.pass();
    expect(at.open()?.members.map((member) => member.taskId)).toEqual([
      "parser01",
      "export02",
      "legend03",
      TASK,
      "axis04",
    ]);
    expect(at.open()?.hold).toBeUndefined();
    expect(at.line()).toEqual([]);
    expect(at.forge.batchHead).not.toBe(before);
  });

  const REPAIR = "repair09";
  const REPAIR_BRANCH = `fm/task-${REPAIR}`;
  /**
   * Another repair of the held batch with a working copy of its own, a real repository: its
   * branch checked out at the commit of its fix, built on an earlier commit of that fix.
   */
  function repairCopy(at: ReturnType<typeof home>) {
    const { dir } = gitRepo("meter");
    const git = (...args: string[]) =>
      execFileSync(
        "git",
        ["-C", dir, "-c", "user.name=Test", "-c", "user.email=test@localhost", ...args],
        { encoding: "utf8" },
      ).trim();
    const commit = (file: string, subject: string) => {
      writeFileSync(join(dir, file), `// ${subject}\n`);
      git("add", file);
      git("commit", "-q", "-m", subject);
      return git("rev-parse", "HEAD");
    };
    git("checkout", "-q", "-b", REPAIR_BRANCH);
    const earlier = commit("parser.ts", STORY.title);
    const head = commit("export.ts", "fix(export): read dates through the parser's new form");
    insertTask(at.tasks, { id: REPAIR, repoId: REPO, branch: REPAIR_BRANCH, worktreeDir: dir });
    return { dir, git, earlier, head };
  }

  // Intent: upstream issue #55, "Held batch does not resume when a takeover delivers the
  // approved repair commit", a bug being fixed, and its review's findings: the declaration is
  // bound to the exact commit the repair's own working copy has committed as it declares, not
  // to a version the host read on its branch before, and another task approved at that commit
  // ends the hold.
  it("binds a declared fix to the commit its task has committed: another task approved there ends the hold, and at an earlier version does not", async () => {
    const at = await held();
    const before = at.forge.batchHead;
    const repair = repairCopy(at);
    // The host read an earlier version of the repair's branch where the project lives.
    at.tasks.delivery.recordChangeEvidence(REPAIR, { headSha: repair.earlier });
    expect(
      await at.service.checkTool.checkForCrew(REPAIR, { batch: { fix: true, evidence } }),
    ).toBe(BATCH_DECLARATION_WORDS.fix);
    expect(at.batches.record(REPO).fixHeads).toEqual({ [REPAIR]: repair.head });

    at.other("earlier05", STORY.title, repair.earlier);
    await at.pass();
    expect(at.open()?.hold).toBeDefined();
    expect(at.forge.batchHead).toBe(before);

    at.other("deliver06", STORY.title, repair.head);
    await at.pass();
    expect(at.open()?.members.map((member) => member.taskId)).toEqual([
      "parser01",
      "export02",
      "legend03",
      "deliver06",
      "earlier05",
    ]);
    expect(at.open()?.hold).toBeUndefined();
    expect(at.forge.batchHead).not.toBe(before);
    expect(at.batches.record(REPO).fixes).toEqual([REPAIR]);
  });

  // Intent: the same issue's reviews: every declaration of a fix binds that commit, and one
  // made again beside work its commit does not hold binds none, the commit named before
  // included.
  it.each([
    ["alone", () => ({ fix: true, evidence })],
    [
      "beside a send-back",
      () => ({
        fix: true,
        sendBack: [{ task: "parser01", reason: "its date test fails on the batch's version" }],
        evidence,
      }),
    ],
    [
      "beside a version that passed on a rerun",
      (version: string) => ({ passed: version, fix: true, evidence }),
    ],
  ])(
    "binds the commit of a fix declared %s, and none once work is left to commit there",
    async (_way, batch) => {
      const at = await held();
      const repair = repairCopy(at);
      // An earlier declaration bound the commit the repair had committed then.
      await at.service.checkTool.checkForCrew(REPAIR, { batch: { fix: true, evidence } });
      expect(at.batches.record(REPO).fixHeads).toEqual({ [REPAIR]: repair.head });
      writeFileSync(join(repair.dir, "scale.ts"), "export const scale = 1;\n");
      await at.service.checkTool.checkForCrew(REPAIR, { batch: batch(at.forge.batchHead) });
      expect(at.batches.record(REPO).fixes).toEqual([REPAIR]);
      expect(at.batches.record(REPO).fixHeads).toBeUndefined();

      const again = await held();
      const committed = repairCopy(again);
      await again.service.checkTool.checkForCrew(REPAIR, { batch: batch(again.forge.batchHead) });
      expect(again.batches.record(REPO).fixHeads).toEqual({ [REPAIR]: committed.head });
    },
  );

  // Intent: the same issue's second review, a bug being fixed: the commit was read from
  // whatever the working copy had checked out, with its untracked files passed over, so a
  // declaration could name a commit that does not hold the fix.
  it.each([
    [
      "an edit to a tracked file left to commit",
      (copy: ReturnType<typeof repairCopy>) =>
        writeFileSync(join(copy.dir, "parser.ts"), "export const zone = false;\n"),
    ],
    [
      "another branch checked out",
      (copy: ReturnType<typeof repairCopy>) => copy.git("checkout", "-q", "main"),
    ],
    [
      "its commit checked out with no branch",
      (copy: ReturnType<typeof repairCopy>) => copy.git("checkout", "-q", "--detach"),
    ],
  ])("binds no commit to a fix declared from a working copy with %s", async (_state, leave) => {
    const at = await held();
    const repair = repairCopy(at);
    leave(repair);
    expect(
      await at.service.checkTool.checkForCrew(REPAIR, { batch: { fix: true, evidence } }),
    ).toBe(BATCH_DECLARATION_WORDS.fix);
    expect(at.batches.record(REPO).fixes).toEqual([REPAIR]);
    expect(at.batches.record(REPO).fixHeads).toBeUndefined();
  });

  // Intent: the same finding, where the repair runs on another computer: the commit is the
  // one its own branch has checked out there, and only with nothing left to commit there.
  it.each([
    ["with nothing left to commit", { branch: REPAIR_BRANCH, head: HEAD, dirty: false }, true],
    ["with work left to commit", { branch: REPAIR_BRANCH, head: HEAD, dirty: true }, false],
    ["on another branch", { branch: "fm/task-other", head: HEAD, dirty: false }, false],
    ["on no branch", { branch: null, head: HEAD, dirty: false }, false],
    ["that cannot be read", null, false],
  ])(
    "reads the commit of a fix declared from a working copy on another computer %s",
    async (_state, there, bound) => {
      const at = await held({ checkedOut: async () => there });
      insertTask(at.tasks, { id: REPAIR, repoId: REPO, branch: REPAIR_BRANCH, deviceId: "mini" });
      await at.service.checkTool.checkForCrew(REPAIR, { batch: { fix: true, evidence } });
      expect(at.batches.record(REPO).fixes).toEqual([REPAIR]);
      expect(at.batches.record(REPO).fixHeads).toEqual(bound ? { [REPAIR]: HEAD } : undefined);
    },
  );

  // Intent: the same review, a bug being fixed: a fix declared alone was saved on whatever
  // version the batch held at once its commit was read, so a repair that had read one held
  // version was recorded as the repair of the next.
  it("refuses a fix declared alone once the batch holds at another version than its task read", async () => {
    let meanwhile: (() => Promise<void>) | undefined;
    const at = await held({
      checkedOut: async () => {
        await meanwhile?.();
        return { branch: REPAIR_BRANCH, head: HEAD, dirty: false };
      },
    });
    insertTask(at.tasks, { id: REPAIR, repoId: REPO, branch: REPAIR_BRANCH, deviceId: "mini" });
    const read = at.forge.batchHead;
    // While the commit is read, Try again combines the batch anew and its checks fail again.
    meanwhile = async () => {
      meanwhile = undefined;
      await at.batches.answer(REPO, { action: "try-again", head: read });
      at.forge.atHead[at.forge.batchHead] = [{ name: "unit-tests", state: "failure" }];
      await at.pass();
    };

    expect(
      await at.service.checkTool.checkForCrew(REPAIR, { batch: { fix: true, evidence } }),
    ).toBe(`Batch declaration refused: ${BATCH_WORDS.ended}`);
    expect(at.open()?.hold?.head).toBe(at.forge.batchHead);
    expect(at.forge.batchHead).not.toBe(read);
    expect(at.open()?.repair).toBeUndefined();
    expect(at.batches.record(REPO).fixes).toBeUndefined();
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

  // Intent: INF-6910's defect, a bug being fixed: the repair read the held batch's checks with
  // check_change pull, which made the batch's pull request its current change, so
  // show_merge_card judged the repair's own branch by that selection and opened a pull request
  // of its own instead of confirming the declared fix on its pushed branch.
  it("confirms its declared fix on its pushed branch while it reads the held batch's pull request, and the fix joins the batch", async () => {
    const at = await held();
    const before = at.forge.batchHead;
    const batch = at.forge.batch?.number as number;
    await at.service.checkTool.checkForCrew(TASK, { pull: batch });
    expect(at.tasks.get(TASK)?.delivery?.checkTarget).toMatchObject({ number: batch });
    expect(await at.service.checkTool.checkForCrew(TASK, { batch: { fix: true, evidence } })).toBe(
      BATCH_DECLARATION_WORDS.fix,
    );
    // The story is saved for the branch the working copy has checked out, the repair's own;
    // changePublication's tests own reading that branch and its version with git.
    at.tasks.delivery.updateChangePresentation(
      TASK,
      () => ({ revisions: [STORY], receipts: [] }),
      BRANCH,
    );
    vi.spyOn(at.service.publication, "presentationHead").mockResolvedValue(HEAD);
    vi.spyOn(at.service.publication, "presentationBranch").mockResolvedValue(BRANCH);

    expect(await at.service.mergeCard.walk(TASK)).toEqual({
      did: [MERGE_CARD_WORDS.batchConfirmed(BRANCH)],
      ready: { revision: 1, title: STORY.title, head: HEAD },
    });
    // The batch's own pull request is the only one opened.
    expect(at.forge.calls.filter((call) => call.startsWith(`openChange ${BRANCH}`))).toEqual([]);
    // The confirmed branch is the change the merge card and its approval act on.
    expect(at.tasks.get(TASK)?.delivery?.checkTarget).toBeUndefined();

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
  });

  // Intent: the captain's fix 2 from the daily velocity review: "Merge a held batch once its
  // version passes, even on a rerun, and send a test-only fix declared meanwhile to the next
  // batch." The project's own rerun passed the failed test, while the host still reads it failed.
  it("declares the held version passed on its rerun beside its own fix: the batch merges as it is, and the fix goes next", async () => {
    const at = await held();
    const version = at.forge.batchHead;
    expect(
      await at.service.checkTool.checkForCrew(TASK, {
        batch: { passed: version, fix: true, evidence },
      }),
    ).toBe(BATCH_DECLARATION_WORDS.passedRecorded(true));
    expect(at.batches.record(REPO).fixes).toEqual([TASK]);
    (at.forge.batch as NonNullable<BatchHostForge["batch"]>).readiness = "clean";
    await at.pass();
    expect(at.open()).toBeUndefined();
    expect(at.batches.record(REPO).receipts.map((receipt) => receipt.taskId)).toEqual([
      "parser01",
      "export02",
      "legend03",
    ]);

    await at.confirmed();
    await at.service.merges.merge(TASK, at.guard());
    await at.pass();
    expect(at.open()?.members).toMatchObject([{ taskId: TASK, fix: true }]);
  });

  it("refuses passed for a version the batch is not held at, or beside a send-back", async () => {
    const at = await held();
    const tool = at.service.checkTool;
    expect(await tool.checkForCrew(TASK, { batch: { passed: PARSER_HEAD, evidence } })).toBe(
      BATCH_DECLARATION_WORDS.passed["other-version"],
    );
    expect(
      await tool.checkForCrew(TASK, {
        batch: {
          passed: at.forge.batchHead,
          sendBack: [{ task: "parser01", reason: "its date test fails" }],
          evidence,
        },
      }),
    ).toBe(BATCH_DECLARATION_WORDS.passedSentBack);
    expect(at.open()?.passed).toBeUndefined();
    expect(at.open()?.members).toHaveLength(3);
    expect(at.batches.record(REPO).fixes).toBeUndefined();
  });
});
