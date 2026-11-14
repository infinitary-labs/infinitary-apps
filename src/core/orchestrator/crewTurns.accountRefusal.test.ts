/**
 * The same refusal on one account (docs/inbox.md): the captain's pick A on
 * INF-2995 ("one wake per account ... further refusals in the same words on
 * that account wake nobody"). Nov 6's shape: a provider refused every
 * crewmate on one Claude account with the same words, asking for new terms,
 * and the first mate was woken once per failed turn. Each case runs two
 * crewmates on one account through a real CrewSupervisor and its inbox
 * (tests/helpers/idleLadderHarness.ts) and reads the first mate's wakes.
 */
import { describe, expect, it } from "vitest";
import {
  endTurn,
  fakeCrewmate,
  fakeCrewTimersEachTest,
  intentOf,
} from "../../../tests/helpers/crewHarness";
import {
  failTurn,
  idleLadderHarness,
  settle,
  wakesThroughInbox,
} from "../../../tests/helpers/idleLadderHarness";
import { STUCK_REFUSAL_LIMIT } from "../storage/inboxStore";

fakeCrewTimersEachTest();

/** The words Claude's client gave each refused turn on Nov 6, verbatim. */
const TERMS =
  "API Error: 400 We've updated our Consumer Terms and Privacy Policy. You'll need to accept them in claude.ai with the email in /status to continue.";

describe("the same provider refusal on one account", () => {
  const { clockedSetup, sweepWhenDue } = idleLadderHarness();

  /** Two crewmates, each on the account `accountOf` names for its spawn, both stopped after a report. */
  async function twoOnAccounts(accountOf: (spawn: number) => string) {
    const first = fakeCrewmate();
    const second = fakeCrewmate();
    let spawns = 0;
    const harness = wakesThroughInbox(
      clockedSetup(first, {
        crewmates: [second],
        routedModel: { provider: "anthropic-claude", id: "claude-opus-5-5" },
        accounts: {
          selectForSpawn: () => accountOf(spawns++),
          reselectForResume: () => ({ changed: false }),
          labelOf: () => undefined,
        },
      }),
    );
    const one = await harness.supervisor.intake.commission({
      title: "Merge cards",
      intent: intentOf("Start"),
    });
    await settle();
    await endTurn(first, one.taskId, "Done with step one.");
    const two = await harness.supervisor.intake.commission({
      title: "Test audit",
      intent: intentOf("Start"),
    });
    await settle();
    await endTurn(second, two.taskId, "Done with step one.");
    for (const [crewmate, taskId] of [
      [first, one.taskId],
      [second, two.taskId],
    ] as const) {
      await harness.supervisor.steer.steerCrewmate(taskId, "carry on");
      await settle();
      expect(crewmate.promptCalls.at(-1)).toContain("carry on");
    }
    return { ...harness, first, second, one: one.taskId, two: two.taskId };
  }

  const failedWakes = (ops: string[]) => ops.filter((op) => /failed( at the provider)?:/.test(op));
  const stuckWakes = (ops: string[]) => ops.filter((op) => op.includes("is stuck at its provider"));

  it("wakes the first mate once for the account, naming the other crewmate on it", async () => {
    const harness = await twoOnAccounts(() => "acct_claude");
    const { first, second, one, two, ops, tasks } = harness;

    await failTurn(first, one, TERMS);
    expect(failedWakes(ops)).toHaveLength(1);
    expect(failedWakes(ops)[0]).toContain(`task ${one} "Merge cards" failed at the provider`);
    expect(failedWakes(ops)[0]).toContain(`The same account serves task ${two} "Test audit".`);
    expect(failedWakes(ops)[0]).toContain("ask the captain once and name every crewmate");

    // The other crewmate meets the same words: nobody is woken, and its
    // timeline still keeps the failure.
    await failTurn(second, two, TERMS);
    // A turn of the first crewmate's own that carried no guidance fails too.
    await failTurn(first, one, TERMS);
    expect(failedWakes(ops)).toHaveLength(1);
    expect(tasks.timeline(two).some((event) => event.text === `hit a problem: ${TERMS}`)).toBe(
      true,
    );

    // Each lane keeps retrying until it stops in those words: only the task
    // whose wake named the other is told it is stuck.
    for (let refusal = 2; refusal <= STUCK_REFUSAL_LIMIT; refusal++) {
      await sweepWhenDue(harness, one);
      await failTurn(first, one, TERMS);
      await sweepWhenDue(harness, two);
      await failTurn(second, two, TERMS);
    }
    expect(harness.inbox.stuck(one)).toBeDefined();
    expect(harness.inbox.stuck(two)).toBeDefined();
    expect(stuckWakes(ops)).toHaveLength(1);
    expect(stuckWakes(ops)[0]).toContain(`task ${one} "Merge cards"`);
    expect(failedWakes(ops)).toHaveLength(1);

    // The captain accepted; the first mate's steer goes through on one lane,
    // which ends the account's refusal, so a later one is heard again.
    await harness.supervisor.steer.steerCrewmate(two, "the terms are accepted, carry on");
    await settle();
    await endTurn(second, two, "Carried on with the audit.");
    await harness.supervisor.steer.steerCrewmate(one, "carry on again");
    await settle();
    await failTurn(first, one, TERMS);
    expect(stuckWakes(ops)).toHaveLength(2);
  });

  it("wakes once per account when the same words reach crewmates on two accounts", async () => {
    const { first, second, one, two, ops } = await twoOnAccounts((spawn) =>
      spawn === 0 ? "acct_work" : "acct_home",
    );
    await failTurn(first, one, TERMS);
    await failTurn(second, two, TERMS);
    expect(failedWakes(ops)).toHaveLength(2);
    expect(failedWakes(ops)[0]).toContain("No other open task uses the same account.");
    expect(failedWakes(ops)[1]).toContain("No other open task uses the same account.");
  });

  it("keeps each crewmate's own wake for a failure that is no refusal", async () => {
    const { first, second, one, two, ops } = await twoOnAccounts(() => "acct_claude");
    await failTurn(first, one, "upstream 529 overloaded");
    await failTurn(second, two, "upstream 529 overloaded");
    expect(failedWakes(ops)).toHaveLength(2);
    expect(failedWakes(ops).join("\n")).not.toContain("same account");
  });
});
