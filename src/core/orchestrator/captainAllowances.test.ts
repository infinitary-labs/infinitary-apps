/**
 * What the captain already allowed (INF-3170 piece 2, docs/delivery-rigor.md
 * "What the captain already allowed"; the captain's pick on its plan card:
 * a yes carries to "That task, its reviewer, a stronger-model retry and a
 * takeover of its work"). A crewmate marks its yes action with `allows`;
 * the captain's own click on it is kept, quoted on the timeline, served on
 * the task's lane and in every later brief of the work it carries to, and
 * taken back only on the captain's words through the first mate. Each case
 * drives a public door - the crewmate's emit_card, a click, the first
 * mate's take-back - and reads the record and what a crewmate was served.
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ALREADY_ALLOWED_HEADING,
  allowanceRowWords,
  allowanceTakenBackWords,
  alreadyAllowedWords,
} from "@shared/captainAllowances";
import { choiceWords, STANDING_WORDS_FROM } from "@shared/holds";
import { checkYesCovers, type ValidationScenario } from "@shared/liveValidation";
import { describe, expect, it, vi } from "vitest";
import {
  endTurn,
  type FakeCrewmate,
  fakeCrewmate,
  fakeCrewTimersEachTest,
  intentOf,
  setup,
  tick,
} from "../../../tests/helpers/crewHarness";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { crewmateCardPicturesDir } from "../paths";
import { alreadyAllowed } from "../tasks/alreadyAllowed";
import { seedTask } from "../tasks/seedTask";
import { seedProject } from "../workspace/seedProject";

fakeCrewTimersEachTest();

function servedTo(crewmate: FakeCrewmate): string {
  return [
    ...crewmate.promptCalls,
    ...crewmate.steer.mock.calls.map((call) =>
      typeof call[0] === "string" ? call[0] : JSON.stringify(call[0]),
    ),
  ].join("\n");
}

const COVERS = "Signing in with your own GitHub account to run the sign-in check against it";
const TITLE = "Run the sign-in check on your account";

const OWN_ACCOUNT: ValidationScenario = {
  id: "own-account",
  source: "Fix the sign-in check.",
  importance: "required",
  action: "Run the sign-in check against your own GitHub account.",
  expected: "The check signs in and reads the account's name.",
  adverse: "A stand-in account would not show the real sign-in.",
  environment: "The app, signed in with your own GitHub account",
  signal: "The check's transcript names the account.",
  boundary: "Your real GitHub account",
  resources: "Your own GitHub account, signed in through the app",
  cost: "One sign-in check; it changes nothing on the account",
};
const REPOSITORY_LIST: ValidationScenario = {
  ...OWN_ACCOUNT,
  id: "repository-list",
  action: "List your repositories through the fixed sign-in.",
  expected: "The list names the account's repositories.",
  signal: "The check's transcript lists the repositories.",
  cost: "One read of your repository list; it changes nothing on the account",
};

/**
 * A started task, its crewmate in its first turn; with `change`, the task
 * delivers a change through a pull request, so it keeps live validation
 * records.
 */
async function startedTask(crewmates: FakeCrewmate[] = [], change = false) {
  const crewmate = fakeCrewmate();
  const h = setup(crewmate, { crewmates });
  if (change)
    seedProject(h.db, {
      id: "sign-in",
      name: "sign-in",
      path: scratchDir("infinitary-sign-in-"),
      origin: "https://github.com/octo/sign-in.git",
      delivery: "direct-pr",
    });
  const { taskId } = await h.supervisor.intake.commission({
    title: "Fix the sign-in check",
    intent: intentOf("fix the sign-in check"),
    ...(change ? { repoId: "sign-in" } : {}),
  });
  await vi.waitFor(() => expect(crewmate.promptCalls).toHaveLength(1));
  return { ...h, crewmate, taskId, key: h.tasks.get(taskId)?.key ?? taskId };
}

async function askedConsent(crewmates: FakeCrewmate[] = [], change = false) {
  const h = await startedTask(crewmates, change);
  const shown = await h.specs[0]?.onCard?.({
    title: TITLE,
    body: "<p>The check needs your own account; it changes nothing on it.</p>",
    actions: [
      { id: "yes", label: "Use my account", default: true },
      { id: "no", label: "Not now" },
    ],
    allows: { action: "yes", covers: COVERS },
  });
  await endTurn(h.crewmate, h.taskId, "The sign-in check waits on your consent.");
  const card = h.supervisor.cards.snapshot().find((entry) => entry.taskId === h.taskId);
  if (!card) throw new Error(`the consent card did not go up: ${JSON.stringify(shown)}`);
  return { ...h, card };
}

/**
 * The crewmate's live checks of a change task, through its report: the plan,
 * a check request (naming a kept yes's card, or asking), and a run whose
 * observations pass, or leave untested every check not in `ran`, at the
 * committed version, which `commit` moves.
 */
async function plannedChecks(
  h: Awaited<ReturnType<typeof startedTask>>,
  scenarios: ValidationScenario[],
) {
  let head = "a".repeat(40);
  vi.mocked(h.workspace.branchHead).mockResolvedValue(head);
  const commit = (next: string) => {
    head = next;
    vi.mocked(h.workspace.branchHead).mockResolvedValue(next);
  };
  const report = h.specs[0]?.onReport;
  if (!report) throw new Error("the crewmate's report is not bound");
  await report("Planned before the checks.", undefined, {
    validation: {
      kind: "plan",
      previousRevision: 0,
      reason: "The sign-in checks run against the captain's own account.",
      scenarios,
    },
  });
  const transcript = "signed in as the account's owner\n";
  const dir = crewmateCardPicturesDir(h.paths, h.taskId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${h.taskId}-sign-in.txt`), transcript);
  const check = (id: string, scenario: string, allowance?: string) =>
    report("The check's approval.", undefined, {
      validation: {
        kind: "request",
        request: { kind: "check", id, head, scenario, ...(allowance ? { allowance } : {}) },
      },
    });
  const run = (id: string, ran = scenarios.map((scenario) => scenario.id)) =>
    report("The checks ran.", undefined, {
      validation: {
        kind: "run",
        id,
        head,
        scenarioRevision: 1,
        completion: "complete",
        verdict: ran.length === scenarios.length ? "go" : "inconclusive",
        reason: "The checks signed in with the captain's account.",
        observations: scenarios.map((scenario) =>
          ran.includes(scenario.id)
            ? {
                scenario: scenario.id,
                result: "pass" as const,
                live: true,
                actual: scenario.expected,
                evidence: ["sign-in"],
                standIns: [],
                unproven: [],
                attempted: [],
              }
            : {
                scenario: scenario.id,
                result: "untested" as const,
                live: false,
                actual: "It did not run this time.",
                evidence: [],
                standIns: [],
                unproven: [scenario.expected],
                attempted: ["The other check alone"],
                reason: "Only the other check ran.",
              },
        ),
        evidence: [
          {
            id: "sign-in",
            description: "The sign-in check's transcript",
            digest: createHash("sha256").update(transcript).digest("hex"),
            bytes: Buffer.byteLength(transcript),
            file: `${h.taskId}-sign-in.txt`,
          },
        ],
      },
    });
  return { check, run, commit };
}

describe("a yes the captain gave on a crewmate's card", () => {
  it("is kept from the captain's own click, quoted on the timeline and served on the task's lane", async () => {
    const h = await askedConsent();
    expect(h.card.body).toContain("is kept as your yes to");
    expect(h.card.body).toContain(COVERS);

    h.supervisor.cardActions.act(h.card.id, "yes", "chrome", {
      answers: [
        { name: "anything_else", values: [], changed: true, written: "only for this check" },
      ],
    });
    await tick();
    const words = choiceWords("Use my account", TITLE, "only for this check");
    expect(h.tasks.get(h.taskId)?.delivery?.captainAllowances).toEqual([
      { words, covers: COVERS, card: h.card.id, at: expect.any(Number) },
    ]);
    expect(h.tasks.timeline(h.taskId).map((event) => event.text)).toContain(
      allowanceRowWords({ words, covers: COVERS }),
    );
    // The crewmate's next turn, which the choice starts, reads the whole list.
    const entry = h.tasks.get(h.taskId)?.delivery?.captainAllowances?.[0];
    if (!entry) throw new Error("the yes was not kept");
    await vi.waitFor(() =>
      expect(servedTo(h.crewmate)).toContain(
        alreadyAllowedWords({ allowances: [entry] }, "crewmate"),
      ),
    );
  });

  it("records nothing for the other action, or for a click that is not the captain's", async () => {
    const declined = await askedConsent();
    declined.supervisor.cardActions.act(declined.card.id, "no", "chrome");
    await tick();
    expect(declined.tasks.get(declined.taskId)?.delivery?.captainAllowances).toBeUndefined();

    const scripted = await askedConsent();
    scripted.supervisor.cardActions.act(scripted.card.id, "yes", "frame");
    await tick();
    expect(scripted.tasks.get(scripted.taskId)?.delivery?.captainAllowances).toBeUndefined();
  });

  it("is served in the brief of a stronger-model retry of the work", async () => {
    const retry = fakeCrewmate();
    const h = await askedConsent([retry]);
    h.supervisor.cardActions.act(h.card.id, "yes", "chrome");
    await tick();
    h.crewmate.finishPrompt();
    await tick();
    await h.supervisor.intake.commission({
      title: "Fix the sign-in check again",
      intent: intentOf("fix the sign-in check"),
      shape: { escalate_from: h.key },
    });
    await vi.waitFor(() => expect(retry.promptCalls.length).toBeGreaterThan(0));
    const original = h.tasks.get(h.taskId);
    if (!original) throw new Error("the original task is gone");
    const [entry] = alreadyAllowed(h.tasks, original).allowances;
    if (!entry) throw new Error("the yes was not kept");
    expect(retry.promptCalls[0]).toContain(
      alreadyAllowedWords(
        {
          allowances: [{ ...entry, from: { key: h.key, title: "Fix the sign-in check" } }],
        },
        "crewmate",
      ),
    );
  });

  it("is taken back only through the first mate, which names its card", async () => {
    const h = await askedConsent();
    h.supervisor.cardActions.act(h.card.id, "yes", "chrome");
    await tick();
    expect(h.supervisor.overrides.withdrawAllowance(h.taskId, "card-unknown")).toMatchObject({
      ok: false,
    });
    expect(h.supervisor.overrides.withdrawAllowance(h.taskId, h.card.id)).toMatchObject({
      ok: true,
    });
    expect(h.tasks.get(h.taskId)?.delivery?.captainAllowances).toBeUndefined();
    const words = choiceWords("Use my account", TITLE);
    await vi.waitFor(() =>
      expect(servedTo(h.crewmate)).toContain(allowanceTakenBackWords({ words, covers: COVERS })),
    );
  });

  it("tells a running retry when the yes it read is taken back on the task it was given on", async () => {
    const retry = fakeCrewmate();
    const h = await askedConsent([retry]);
    h.supervisor.cardActions.act(h.card.id, "yes", "chrome");
    await tick();
    h.crewmate.finishPrompt();
    await tick();
    await h.supervisor.intake.commission({
      title: "Fix the sign-in check again",
      intent: intentOf("fix the sign-in check"),
      shape: { escalate_from: h.key },
    });
    await vi.waitFor(() => expect(retry.promptCalls.length).toBeGreaterThan(0));
    // The first mate names the task the yes was given on, not the retry.
    expect(h.supervisor.overrides.withdrawAllowance(h.taskId, h.card.id)).toMatchObject({
      ok: true,
    });
    const words = choiceWords("Use my account", TITLE);
    await vi.waitFor(() =>
      expect(servedTo(retry)).toContain(allowanceTakenBackWords({ words, covers: COVERS })),
    );
  });

  it("tells a running task that now carries on the work the yes was given on, and nothing for a link with no yes", async () => {
    const carrier = fakeCrewmate();
    const h = await askedConsent([carrier]);
    const { taskId: carrierId } = await h.supervisor.intake.commission({
      title: "Carry the sign-in fix on",
      intent: intentOf("carry the sign-in fix on"),
    });
    await vi.waitFor(() => expect(carrier.promptCalls).toHaveLength(1));
    const quiet = seedTask(h.tasks, {
      id: "quiet",
      title: "Nothing allowed here",
      status: "running",
    });
    h.tasks.graph.link(quiet.id, carrierId, "replaced-by", "firstmate");
    await tick();
    expect(servedTo(carrier)).not.toContain(ALREADY_ALLOWED_HEADING);

    h.supervisor.cardActions.act(h.card.id, "yes", "chrome");
    await tick();
    h.tasks.graph.link(h.taskId, carrierId, "replaced-by", "firstmate");
    const record = h.tasks.get(carrierId);
    if (!record) throw new Error("the carrier is gone");
    const served = alreadyAllowedWords(alreadyAllowed(h.tasks, record), "crewmate");
    expect(served).toContain(`on ${h.key} "Fix the sign-in check", whose work this is`);
    await vi.waitFor(() => expect(servedTo(carrier)).toContain(served));
  });

  // INF-4446: on INF-4343 the captain's yes covered a check's runs, yet the
  // check's run was refused until a second click recorded the same yes.
  it("approves a check whose resources and cost it covers, with no second card, until the captain takes it back", async () => {
    const h = await askedConsent([], true);
    h.supervisor.cardActions.act(h.card.id, "yes", "chrome");
    await tick();
    const live = await plannedChecks(h, [OWN_ACCOUNT]);
    await expect(live.check("not-a-yes", OWN_ACCOUNT.id, "card-unknown")).rejects.toThrow(
      "Already allowed",
    );
    const cardsBefore = h.supervisor.cards.snapshot().length;
    await live.check("own-account-run", OWN_ACCOUNT.id, h.card.id);
    await live.run("first-run");
    expect(h.tasks.get(h.taskId)?.delivery?.liveValidation?.runs.map((r) => r.id)).toEqual([
      "first-run",
    ]);
    expect(h.supervisor.cards.snapshot()).toHaveLength(cardsBefore);
    h.supervisor.overrides.withdrawAllowance(h.taskId, h.card.id);
    await expect(live.run("after-take-back")).rejects.toThrow("needs your approval");
  });

  // INF-4446, the captain's "pivot to the fuller fix": a yes on a check's own
  // card is one of the captain's yeses, kept in the same record as the rest.
  it("keeps a yes given on a check's own card with the others, so a later check names it and taking it back ends both", async () => {
    const h = await startedTask([], true);
    const live = await plannedChecks(h, [OWN_ACCOUNT, REPOSITORY_LIST]);
    await live.check("own-account-ask", OWN_ACCOUNT.id);
    const title = "Approve the sign-in check on your account?";
    await h.specs[0]?.onCard?.({
      title,
      body: "<p>The check signs in with your own account and changes nothing on it.</p>",
      actions: [
        { id: "approve", label: "Approve the check", default: true },
        { id: "hold", label: "Not now" },
      ],
      validationDecision: { request: "own-account-ask", action: "approve" },
    });
    await endTurn(h.crewmate, h.taskId, "The sign-in check waits on your approval.");
    const card = h.supervisor.cards.snapshot().find((entry) => entry.title === title);
    if (!card) throw new Error("the check's approval card did not go up");
    h.supervisor.cardActions.act(card.id, "approve", "chrome");
    await tick();
    const yes = {
      words: choiceWords("Approve the check", title),
      covers: checkYesCovers(OWN_ACCOUNT),
      card: card.id,
      at: expect.any(Number),
    };
    expect(h.tasks.get(h.taskId)?.delivery?.captainAllowances).toEqual([yes]);
    const record = h.tasks.get(h.taskId);
    if (!record) throw new Error("the task is gone");
    await vi.waitFor(() =>
      expect(servedTo(h.crewmate)).toContain(
        alreadyAllowedWords(alreadyAllowed(h.tasks, record), "crewmate"),
      ),
    );
    // The crewmate judges that yes covers a second check on the same sign-in.
    const cardsBefore = h.supervisor.cards.snapshot().length;
    await live.check("repositories-from-yes", REPOSITORY_LIST.id, card.id);
    await live.run("both-checks");
    expect(h.tasks.get(h.taskId)?.delivery?.liveValidation?.runs.map((r) => r.id)).toEqual([
      "both-checks",
    ]);
    expect(h.supervisor.cards.snapshot()).toHaveLength(cardsBefore);
    h.supervisor.overrides.withdrawAllowance(h.taskId, card.id);
    await expect(live.run("after-take-back")).rejects.toThrow(OWN_ACCOUNT.id);
    await expect(live.run("after-take-back", [REPOSITORY_LIST.id])).rejects.toThrow(
      REPOSITORY_LIST.id,
    );
  });

  // INF-4446, the review of the fuller fix: the captain's standing override
  // is on the same Already allowed list, so its words approve a check too.
  it("approves a check from the captain's standing override while that very override stands", async () => {
    const h = await startedTask([], true);
    const live = await plannedChecks(h, [OWN_ACCOUNT]);
    await expect(live.check("no-override", OWN_ACCOUNT.id, STANDING_WORDS_FROM)).rejects.toThrow(
      "No standing override",
    );
    const words = "Use my own GitHub account for whatever checks the fix needs";
    h.supervisor.overrides.declareOverride(h.taskId, {
      words,
      holds: ["asks-first"],
      until: "task",
    });
    const cardsBefore = h.supervisor.cards.snapshot().length;
    expect(await live.check("from-standing", OWN_ACCOUNT.id, STANDING_WORDS_FROM)).toContain(
      `The check ${OWN_ACCOUNT.id} is approved from the captain's standing override`,
    );
    await live.run("first-run");
    expect(h.supervisor.cards.snapshot()).toHaveLength(cardsBefore);
    // New words replace the override, and the approval rested on the earlier ones.
    vi.advanceTimersByTime(1_000);
    h.supervisor.overrides.declareOverride(h.taskId, {
      words: `${words}, and merge it once it is green`,
      holds: ["asks-first"],
      until: "task",
    });
    await expect(live.run("after-new-words")).rejects.toThrow("needs your approval");
    await live.check("from-new-words", OWN_ACCOUNT.id, STANDING_WORDS_FROM);
    await live.run("second-run");
    h.supervisor.overrides.withdrawOverride(h.taskId);
    await expect(live.run("after-take-back")).rejects.toThrow("needs your approval");
    expect(h.tasks.get(h.taskId)?.delivery?.liveValidation?.runs.map((r) => r.id)).toEqual([
      "first-run",
      "second-run",
    ]);
  });

  it("approves a check from an override for this version only while the branch is at that version", async () => {
    const h = await startedTask([], true);
    const live = await plannedChecks(h, [OWN_ACCOUNT]);
    h.tasks.delivery.recordChangeEvidence(h.taskId, { headSha: "a".repeat(40) });
    h.supervisor.overrides.declareOverride(h.taskId, {
      words: "Use my own GitHub account for the checks of this version",
      holds: ["asks-first"],
      until: "version",
    });
    expect(await live.check("from-standing", OWN_ACCOUNT.id, STANDING_WORDS_FROM)).toContain(
      `The check ${OWN_ACCOUNT.id} is approved from the captain's standing override`,
    );
    await live.run("at-that-version");
    // A new commit, not yet pushed, is another version: the override does not reach it.
    live.commit("b".repeat(40));
    await expect(live.run("at-a-new-commit")).rejects.toThrow("needs your approval");
    expect(h.tasks.get(h.taskId)?.delivery?.liveValidation?.runs.map((r) => r.id)).toEqual([
      "at-that-version",
    ]);
  });

  it("refuses a mark on an action with an effect, on an action the card lacks, and with nothing it covers", async () => {
    const crewmate = fakeCrewmate();
    const h = setup(crewmate);
    await h.supervisor.intake.commission({
      title: "Fix the sign-in check",
      intent: intentOf("fix the sign-in check"),
    });
    await vi.waitFor(() => expect(crewmate.promptCalls).toHaveLength(1));
    const emit = (allows: { action: string; covers: string }) =>
      h.specs[0]?.onCard?.({
        title: TITLE,
        body: "<p>The check needs your own account.</p>",
        actions: [
          { id: "yes", label: "Use my account", default: true },
          { id: "drop", label: "Drop it", effect: { kind: "settle", mode: "discard" } },
        ],
        allows,
      });
    const refusal = async (allows: { action: string; covers: string }) => {
      try {
        await emit(allows);
        return "shown";
      } catch (caught) {
        return (caught as Error).message;
      }
    };
    expect(await refusal({ action: "drop", covers: COVERS })).toContain("not an ordinary action");
    expect(await refusal({ action: "maybe", covers: COVERS })).toContain("not an ordinary action");
    expect(await refusal({ action: "yes", covers: " " })).toContain("allows needs covers");
  });
});

describe("the work a yes carries to", () => {
  it("reaches a takeover and a stronger-model retry through earlier tasks, never a follow-up a merge filed", () => {
    const h = setup(fakeCrewmate());
    const given = seedTask(h.tasks, {
      id: "given",
      title: "Fix the sign-in check",
      status: "running",
    });
    h.tasks.delivery.recordAllowance(given.id, {
      words: "Use my account",
      covers: COVERS,
      card: "card-1",
      at: 1,
    });
    const takeover = seedTask(h.tasks, {
      id: "takeover",
      title: "Carry the fix on",
      status: "running",
    });
    h.tasks.graph.link(given.id, takeover.id, "replaced-by", "firstmate");
    // The task the yes was given on closes; its yes stays for the work that carries it on.
    h.tasks.close(given.id, { status: "dropped", reason: "cancelled", actor: "firstmate" });
    const retry = seedTask(h.tasks, {
      id: "retry",
      title: "Retry the carried fix",
      status: "queued",
      shape: { kind: "fix", escalate_from: takeover.key },
    });
    const followUp = seedTask(h.tasks, {
      id: "follow-up",
      title: "Tidy the sign-in copy",
      status: "queued",
    });
    h.tasks.graph.link(followUp.id, given.id, "discovered-from", "crewmate");

    const carried = (id: string) => {
      const record = h.tasks.get(id);
      if (!record) throw new Error(`no task ${id}`);
      return alreadyAllowed(h.tasks, record).allowances.map((entry) => ({
        covers: entry.covers,
        from: entry.from?.key,
      }));
    };
    expect(carried(given.id)).toEqual([{ covers: COVERS, from: undefined }]);
    expect(carried(takeover.id)).toEqual([{ covers: COVERS, from: given.key }]);
    expect(carried(retry.id)).toEqual([{ covers: COVERS, from: given.key }]);
    expect(carried(followUp.id)).toEqual([]);
  });

  it("reaches a Take over filing that continues the task's branch, linked only related and blocks (the captain's \"Count branch takeovers\")", () => {
    const h = setup(fakeCrewmate());
    const given = seedTask(h.tasks, {
      id: "given",
      title: "Fix the sign-in check",
      status: "running",
    });
    h.tasks.delivery.recordAllowance(given.id, {
      words: "Use my account",
      covers: COVERS,
      card: "card-1",
      at: 1,
    });
    const takeOver = seedTask(h.tasks, {
      id: "take-over",
      title: "Take over: my branch",
      status: "queued",
      shape: { kind: "fix", branch_from: given.key },
    });
    h.tasks.graph.link(takeOver.id, given.id, "related", "firstmate");
    h.tasks.graph.link(given.id, takeOver.id, "blocks", "firstmate");
    const record = h.tasks.get(takeOver.id);
    if (!record) throw new Error("no take-over task");
    expect(
      alreadyAllowed(h.tasks, record).allowances.map((entry) => ({
        covers: entry.covers,
        from: entry.from?.key,
      })),
    ).toEqual([{ covers: COVERS, from: given.key }]);
  });
});
