/**
 * What a crewmate reports, as the crew's report intake takes it in
 * (docs/report-sort.md, docs/card-threads.md "Shared cards",
 * docs/delivery-rigor.md; `ReportIntake`). These cases pin the behaviour no
 * other test reaches: a follow-up's refusals and the one already filed for a
 * failing test, a merge that completes the task naming what the record
 * holds, each refusal of a response on a card line, the validation records a
 * report may not carry, and the kept proof re-read before a draft is offered.
 * Each drives the crewmate's own tools or a public door of the supervisor or
 * its report intake and reads the receipt, the refusal and the record.
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  askedOn,
  fakeCrewmate,
  intentOf,
  setup,
  syncCardId,
  tick,
} from "../../../tests/helpers/crewHarness";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import { crewmateCardPicturesDir } from "../paths";
import { seedProject } from "../workspace/seedProject";

const HEAD = "a".repeat(40);

/** A crewmate on its first turn in "meter", a project that delivers `delivery`. */
async function builder(delivery: "direct-pr" | "local-only" = "direct-pr") {
  const crewmate = fakeCrewmate();
  const h = setup(crewmate);
  seedProject(h.db, {
    id: "meter",
    name: "meter",
    path: scratchDir("infinitary-meter-"),
    origin: "https://github.com/octo/meter.git",
    delivery,
  });
  const { taskId } = await h.supervisor.intake.commission({
    title: "Correct the meter",
    intent: intentOf("make the meter count every press"),
    repoId: "meter",
  });
  await tick();
  const spec = h.specs.at(-1);
  if (!spec?.onReport || !spec.onFollowup || !spec.onReply || !spec.onCard)
    throw new Error("the crewmate's tools are not bound");
  return {
    ...h,
    crewmate,
    taskId,
    report: spec.onReport,
    followup: spec.onFollowup,
    reply: spec.onReply,
    card: spec.onCard,
  };
}

describe("what a crewmate reports", () => {
  it("refuses a follow-up without a title, a goal or a reason, and names the one already filed for the same failing test", async () => {
    const h = await builder();
    expect(() => h.followup({ title: "  ", goal: "g", why: "w" })).toThrow("title is required.");
    expect(() => h.followup({ title: "Fix", goal: " ", why: "w" })).toThrow(
      "goal is required: one sentence saying what done looks like.",
    );
    expect(() => h.followup({ title: "Fix", goal: "g", why: "" })).toThrow(
      "why is required: what you found that makes this follow-up needed.",
    );
    expect(h.tasks.list()).toHaveLength(1);

    const flake = {
      title: "Fix the meter flake",
      goal: "The meter test passes ten times in a row.",
      why: "It failed once on untouched main.",
      testFailure: true,
      testPath: "tests/meter.test.ts",
    };
    const first = h.followup(flake);
    const filed = h.tasks.list().find((row) => row.title === flake.title);
    if (!filed) throw new Error("the follow-up was not filed");
    expect(first).toContain(`Filed follow-up ${filed.key} "${flake.title}"`);
    expect(h.followup({ ...flake, title: "Fix it again" })).toBe(
      `Already filed as ${filed.key} "${flake.title}" for tests/meter.test.ts. Name that key in your report; do not file another.`,
    );
    expect(h.tasks.list()).toHaveLength(2);
  });

  it("refuses a merge that completes the task unless it names the recorded pull request and checked version", async () => {
    const h = await builder();
    const completes = { mergeCompletesTask: { prNumber: 7, headSha: HEAD } };
    const refusal =
      "Report refused: merge_completes_task must name this task's recorded pull request and checked version.";
    expect(() => h.report("The meter counts every press.", undefined, completes)).toThrow(refusal);
    seedDelivery(h.tasks, h.taskId, { prNumber: 7, headSha: "b".repeat(40) });
    expect(() => h.report("The meter counts every press.", undefined, completes)).toThrow(refusal);
    seedDelivery(h.tasks, h.taskId, { prNumber: 8, headSha: HEAD });
    expect(() => h.report("The meter counts every press.", undefined, completes)).toThrow(refusal);
    seedDelivery(h.tasks, h.taskId, { prNumber: 7, headSha: HEAD });
    expect(h.report("The meter counts every press.", undefined, completes)).toContain("Reported.");

    // A project that merges nothing has no pull request to name.
    const local = await builder("local-only");
    seedDelivery(local.tasks, local.taskId, { prNumber: 7, headSha: HEAD });
    expect(() => local.report("The meter counts every press.", undefined, completes)).toThrow(
      refusal,
    );
  });

  it("refuses a response on a card line for a request that is unknown, cancelled, already answered, about another card or another message", async () => {
    const h = await builder();
    const cardId = syncCardId(
      h.card({
        title: "Raise the threshold?",
        body: "<p>Raise the meter's threshold to 8.</p><p>Decision 5 sets it.</p>",
        actions: [
          { id: "raise", label: "Raise it", default: true },
          { id: "keep", label: "Keep it" },
        ],
      }) as string,
    );
    if (!cardId) throw new Error("the card did not go up");
    h.supervisor.cardActions.replyToCard(cardId, "Why 8?");
    await tick();
    const captainLine = askedOn(h.supervisor, cardId);
    if (captainLine === undefined) throw new Error("the captain's line is missing");
    const lifecycle = h.cardStore.get(cardId)?.lifecycleId ?? "";
    const ask = (card: { id: string; lifecycle: string; messageId: number } | null) =>
      h.inbox.requestResponse(h.taskId, "Why 8?", card ? { card } : {}).request.id;
    const line = (requestId: string, responseId: string, answersMessage?: number) =>
      h.reply({
        cardId,
        text: "8 is the press count the meter misses.",
        ...(answersMessage !== undefined ? { answersMessage } : {}),
        response: { requestId, responseId, status: "answered" },
      });

    expect(line("no-such-request", "r1", captainLine)).toContain(
      "there is no response request no-such-request.",
    );
    const cancelled = ask(null);
    h.inbox.cancelResponse(cancelled);
    expect(line(cancelled, "r2", captainLine)).toContain("that response request was cancelled.");
    const elsewhere = ask({ id: "card-other", lifecycle: "life-other", messageId: captainLine });
    expect(line(elsewhere, "r3", captainLine)).toContain(
      `request ${elsewhere} is about card card-other in lifecycle life-other; answer it there.`,
    );
    const otherCard = ask({ id: "card-other", lifecycle, messageId: captainLine });
    expect(line(otherCard, "r3b", captainLine)).toContain(
      `request ${otherCard} is about card card-other in lifecycle ${lifecycle}; answer it there.`,
    );
    const otherMessage = ask({ id: cardId, lifecycle, messageId: captainLine + 100 });
    expect(line(otherMessage, "r4", captainLine)).toContain(
      `request ${otherMessage} asks about the captain's message ${captainLine + 100}; name it in answers_message.`,
    );
    expect(h.inbox.savedResponse("r1")).toBeUndefined();

    // The request about this card and this message is answered once.
    const here = ask({ id: cardId, lifecycle, messageId: captainLine });
    line(here, "r5", captainLine);
    expect(h.inbox.savedResponse("r5")).toMatchObject({ requestId: here });
    const again = ask(null);
    expect(line(again, "r5", captainLine)).toContain(
      "response r5 is already saved; a corrected answer needs a new response identity.",
    );
    // A request about no card is answered from any card line.
    line(again, "r6");
    expect(h.inbox.savedResponse("r6")).toMatchObject({ requestId: again });
  });

  it("refuses validation for a change that opens no pull request, a decision by report, and an effect before review on a changed branch", async () => {
    const plan = {
      kind: "plan" as const,
      previousRevision: 0,
      reason: "The meter's count is read in the launched app.",
      scenarios: [],
    };
    const local = await builder("local-only");
    await expect(local.report("Planned.", undefined, { validation: plan })).rejects.toThrow(
      "Live validation belongs to a change delivered through a pull request.",
    );

    const h = await builder();
    vi.mocked(h.workspace.branchHead).mockResolvedValue(HEAD);
    await expect(
      h.report("Approve it.", undefined, {
        validation: { kind: "decision", request: "count-press", card: "card-1", action: "approve" },
      }),
    ).rejects.toThrow("Bind validation permission with emit_card.validation_request");

    const effect = {
      kind: "effect" as const,
      id: "post-count",
      head: HEAD,
      scenario: "count-press",
      action: "Post the meter's count",
      destination: "The staging dashboard",
      audience: "Only the captain",
      visibility: "captain-only" as const,
      persistent: false,
      purpose: "Show the count reaches the dashboard",
      lastingEffects: "None",
      cleanup: "Nothing to clean up",
      access: "A disposable dashboard",
      preChange: true,
      prerequisitePublication: false,
    };
    // The stand-in branch already changes two files, so it is no pre-change reproduction.
    await expect(
      h.report("Request the effect.", undefined, {
        validation: { kind: "request", request: effect },
      }),
    ).rejects.toThrow(
      "A changed branch needs code review before a validation effect; it is not a pre-change reproduction.",
    );
    expect(h.tasks.get(h.taskId)?.delivery?.liveValidation).toBeUndefined();
  });

  it("sends no validation write for a task that is gone or whose committed version cannot be read", async () => {
    const h = await builder();
    await expect(
      h.supervisor.reportIntake.consumeValidationEffect("no-such-task", "post-count"),
    ).rejects.toThrow("The task no longer exists; nothing was sent.");
    vi.mocked(h.workspace.branchHead).mockResolvedValue(null);
    await expect(
      h.supervisor.reportIntake.consumeValidationEffect(h.taskId, "post-count"),
    ).rejects.toThrow("The task's committed version cannot be read; validation remains held.");
    expect(h.tasks.get(h.taskId)?.delivery?.liveValidation).toBeUndefined();
  });

  it("re-reads the newest run's kept proof before a draft is offered, and refuses it once the bytes changed", async () => {
    const h = await builder();
    // No run yet: nothing to re-read.
    expect(() => h.supervisor.reportIntake.verifyValidationEvidence(h.taskId)).not.toThrow();
    expect(() => h.supervisor.reportIntake.verifyValidationEvidence("no-such-task")).not.toThrow();

    const transcript = "pressed three times; the meter read 3\n";
    const file = `${h.taskId}-count.txt`;
    const dir = crewmateCardPicturesDir(h.paths, h.taskId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, file), transcript);
    h.tasks.delivery.recordLiveValidation(
      h.taskId,
      { kind: "plan", previousRevision: 0, reason: "The count is read in the app.", scenarios: [] },
      { head: HEAD },
    );
    // An earlier run kept no proof; only the newest one is re-read.
    h.tasks.delivery.recordLiveValidation(
      h.taskId,
      {
        kind: "run",
        id: "first-look",
        head: HEAD,
        scenarioRevision: 1,
        completion: "interrupted",
        verdict: "inconclusive",
        reason: "The app closed before the meter was read.",
        observations: [],
        evidence: [],
      },
      { head: HEAD },
    );
    h.tasks.delivery.recordLiveValidation(
      h.taskId,
      {
        kind: "run",
        id: "count",
        head: HEAD,
        scenarioRevision: 1,
        completion: "complete",
        verdict: "inconclusive",
        reason: "The meter read three after three presses; no scenario is planned yet.",
        observations: [],
        evidence: [
          {
            id: "count",
            description: "The meter's count after three presses",
            digest: createHash("sha256").update(transcript).digest("hex"),
            bytes: Buffer.byteLength(transcript),
            file,
            text: transcript,
          },
        ],
      },
      { head: HEAD },
    );
    expect(() => h.supervisor.reportIntake.verifyValidationEvidence(h.taskId)).not.toThrow();

    writeFileSync(join(dir, file), transcript.replace("3", "2"));
    expect(() => h.supervisor.reportIntake.verifyValidationEvidence(h.taskId)).toThrow(
      "Kept validation proof changed; record and review fresh evidence.",
    );
  });
});
