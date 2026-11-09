import type { Card } from "@shared/cards";
import { choiceWords, mergeClickRefusal } from "@shared/holds";
import { MERGE_WHEN_CHECKS_PASS_WORDS } from "@shared/vocabulary";
import { describe, expect, it, vi } from "vitest";
import {
  crewCard,
  decodeContext,
  drained,
  fakeClockEachTest,
  firstmateCard,
  heldContext,
  notifyProse,
  setup,
  tick,
  toolsOf,
} from "../../../tests/helpers/firstmateHarness";
import { ANSWER_ONLY_REFUSAL } from "./answerDelivery";
import { ANSWER_MISSING_OPENING } from "./captainWakes";
import { idleStallWays } from "./holds";

// This file chains real git and is not about the utility-QoS clamp, so what
// the product spawns runs at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

/** The first mate agent: knowledge and the captain's override (tests/helpers/firstmateHarness.ts). */
fakeClockEachTest();

/**
 * Knowledge first (docs/knowledge.md): a turn carries the facts its words
 * match and standing directions separately, and only a write that changed
 * the collection is the turn's action.
 */
describe("FirstmateAgent with knowledge", () => {
  const finish = async (f: ReturnType<typeof setup>, text = "Noted.") => {
    f.session.emitTurnEnd(text);
    f.session.resolveNextPrompt();
    await tick();
  };

  it("leads a turn with matching Knowledge and carries standing directions separately", async () => {
    const f = setup({ knowledge: true });
    f.knowledge?.directions.change({
      op: "add",
      id: "squash-merges",
      text: "Always squash-merge when landing work.",
      reason: "captain said so",
    });
    const recorded = await f.knowledge?.record(
      { kind: "firstmate", origin: "captain-turn", canCreate: true },
      {
        action: "publish",
        requestId: "seed",
        kind: "concept",
        title: "Inbox delivery",
        aliases: ["wake queue"],
        explanation: "Every steer and wake rides one durable row until handled.",
      },
    );
    const id = recorded?.ids[0] as string;
    await f.agent.converse("why does the wake queue retry?");
    const context = decodeContext(f.session.prompts[0] ?? "");
    const knowledge = context.knowledge as { searched: string; candidates: string[] };
    expect(knowledge.searched).toBe("private");
    expect(knowledge.candidates).toHaveLength(1);
    expect(knowledge.candidates[0]).toContain(id);
    expect(knowledge.candidates[0]).toContain('"Inbox delivery"');
    const notes = context.directions as string;
    expect(notes).toContain("squash-merges");
    expect(notes).not.toContain("office-wifi");

    // Words with nothing to search for carry no lookup at all.
    expect(decodeContext(f.agent.buildContextBlock()).knowledge).toBeUndefined();
    // Words that match nothing say so, apart from an unavailable collection.
    expect(
      decodeContext(
        f.agent.buildContextBlock(undefined, undefined, undefined, undefined, "quarterly taxes"),
      ).knowledge,
    ).toEqual({ searched: "private", found: "nothing matched these words" });
  });

  it("keeps a write that changed knowledge as the turn's fact, and still asks for the card that answers the message", async () => {
    const f = setup({ silent: true, knowledge: true });
    const states = () => f.tasks.capture.listAsks().map((ask) => ask.delivery);
    await f.agent.converse("note that deploys happen on Tuesdays");
    const tools = toolsOf(f.specs);
    const call = {
      action: "publish",
      request_id: "deploys",
      kind: "concept",
      title: "Deploy day",
      text: "Deploys happen on Tuesdays.",
    };
    await tools.get("record_knowledge")?.execute("k1", call);
    await finish(f);
    // The write took effect and is the turn's reply line, but a message is
    // answered on a card (docs/task-capture.md "How a message ends").
    expect(f.tasks.capture.listAsks()[0]?.deliveryFacts.entries).toMatchObject([
      { outcome: "action", kind: "record", tool: "record_knowledge" },
    ]);
    expect(states()).toEqual(["retrying"]);
    await drained(f.session, 2);
    expect(f.session.prompts[1]).toContain(ANSWER_MISSING_OPENING);
  });

  it("leaves a turn that only read, repeated or was refused to the answer-delivery retry", async () => {
    const f = setup({ silent: true, knowledge: true });
    const call = {
      action: "publish",
      request_id: "deploys",
      kind: "concept",
      title: "Deploy day",
      text: "Deploys happen on Tuesdays.",
    };
    await f.knowledge?.record(
      { kind: "firstmate", origin: "captain-turn", canCreate: true },
      {
        action: "publish",
        requestId: "deploys",
        kind: "concept",
        title: "Deploy day",
        explanation: "Deploys happen on Tuesdays.",
      },
    );
    await f.agent.converse("note that deploys happen on Tuesdays");
    const tools = toolsOf(f.specs);
    const repeated = await tools.get("record_knowledge")?.execute("k2", call);
    expect(repeated?.content[0]?.text).toContain("Already done");
    await tools.get("record_knowledge")?.execute("k3", { action: "publish", request_id: "bad" });
    await tools.get("knowledge")?.execute("k4", { action: "search", query: "deploy" });
    await finish(f);
    await drained(f.session, 2);
    expect(f.session.prompts[1]).toContain(ANSWER_MISSING_OPENING);
    // The output-only retry refuses a knowledge write like any other change.
    const refused = await tools
      .get("record_knowledge")
      ?.execute("k5", { ...call, request_id: "n" });
    expect(refused?.content[0]?.text).toBe(ANSWER_ONLY_REFUSAL);
  });

  it("serves neither the knowledge pair nor a lookup where knowledge is off", async () => {
    const f = setup({ knowledge: false });
    await f.agent.converse("why does the wake queue retry?");
    const tools = toolsOf(f.specs);
    expect(tools.has("knowledge")).toBe(false);
    expect(tools.has("record_knowledge")).toBe(false);
    expect(decodeContext(f.session.prompts[0] ?? "").knowledge).toBeUndefined();
    expect(tools.has("remember")).toBe(false);
  });
});

/**
 * INF-242's plan, as the captain answered it (INF-473): only the first mate
 * records his override, in a turn that carries his own words, and the row
 * keeps those words as its reason.
 */
describe("the captain's override", () => {
  it("keeps his words from the turn that carries them, and refuses one in a turn without them", async () => {
    const f = setup({
      silent: true,
      seedTasks: [
        { id: "ab12", title: "Fix the meter", status: "idle", sessionFile: "/tmp/ab12.jsonl" },
      ],
    });
    const finish = async () => {
      f.session.emitTurnEnd("Noted.");
      f.session.resolveNextPrompt();
      await tick();
    };
    const declare = () =>
      toolsOf(f.specs)
        .get("update_task")
        ?.execute("override", {
          task: "ab12",
          override: { holds: ["waits", "checks"], until: "task" },
        });
    // An operational turn first: a wake, with no words of his.
    f.agent.notifyOp(
      {
        facts: {
          kind: "idle-stall",
          task: { id: "ab12", title: "Fix the meter" },
          crewmate: "crewmate 1",
          key: "FI3-1",
          idleMs: 20 * 60_000,
          thread: false,
          nudged: true,
          wakes: 1,
          last: { kind: "report", excerpt: "Done with step one." },
        },
        ways: idleStallWays("ab12"),
      },
      "agent",
      "ab12",
    );
    await tick();
    expect(JSON.stringify(await declare())).toContain("Override refused");
    expect(f.tasks.get("ab12")?.delivery?.override).toBeUndefined();
    await finish();
    const words = "The review covered it; merge it.";
    await f.agent.converse(words);
    expect(JSON.stringify(await declare())).toContain("Recorded the captain's override");
    expect(f.tasks.get("ab12")?.delivery?.override).toMatchObject({
      words,
      holds: ["waits", "checks"],
      until: "task",
    });
    await finish();
    f.agent.dispose();
    f.db.close();
  });
});

/**
 * INF-1216's accepted plan (direction A1): a reply under a crewmate's card,
 * or a line in its Crewmate tab, records the override in the relay turn the
 * crewmate's report starts, citing the captain's message; a card on another
 * task and a scheduled check record nothing, and the task line shows it.
 */
describe("the captain's override, cited from his message on the task", () => {
  it("records his reply's own words in the relay turn, and refuses another task's card and a scheduled check", async () => {
    const f = setup({
      silent: true,
      seedTasks: [
        {
          id: "ab12",
          title: "Steady the meter retry",
          status: "idle",
          sessionFile: "/tmp/ab12.jsonl",
        },
        { id: "cd34", title: "Trim the help copy", status: "idle", sessionFile: "/tmp/cd34.jsonl" },
      ],
      seedCards: [
        crewCard(
          "card-ab12",
          "ab12",
          "The checks are still failing",
          "<p>Do you accept these failed checks?</p>",
        ),
        crewCard("card-cd34", "cd34", "The help copy is one line", "<p>Done.</p>"),
      ],
    });
    const finish = async () => {
      f.session.emitTurnEnd("Noted.");
      f.session.resolveNextPrompt();
      await tick();
    };
    const declare = (from: string) =>
      toolsOf(f.specs)
        .get("update_task")
        ?.execute("override", {
          task: "ab12",
          override: { holds: ["checks"], until: "task", from },
        });
    const reply = "I accept the current failed checks on this task.";
    const tabLine = "Keep that exception for the rest of this task.";
    f.supervisor.cardActions.replyToCard("card-ab12", reply);
    f.supervisor.cardActions.replyToCard("card-cd34", "merge it");
    await tick();
    // The crewmate relays the reply: the first mate's turn is its report.
    notifyProse(
      f.db,
      f.agent,
      `[fm-op] crewmate 1 reported on task ab12 "Steady the meter retry": the captain said "${reply}" under card card-ab12`,
      "crewmate-report",
      "ab12",
    );
    await tick();
    expect(JSON.stringify(await declare("card-cd34"))).toContain("is not on");
    expect(f.tasks.get("ab12")?.delivery?.override).toBeUndefined();
    expect(JSON.stringify(await declare("card-ab12"))).toContain("Recorded the captain's override");
    expect(f.tasks.get("ab12")?.delivery?.override).toMatchObject({
      words: reply,
      holds: ["checks"],
      until: "task",
    });
    await finish();
    // His line in the Crewmate tab, cited the same way, replaces it.
    await f.supervisor.steer.steerFromCrewmateTab("ab12", tabLine);
    notifyProse(
      f.db,
      f.agent,
      `[fm-op] crewmate 1 reported on task ab12 "Steady the meter retry": the captain typed "${tabLine}" in the Crewmate tab`,
      "crewmate-report",
      "ab12",
    );
    await tick();
    expect(JSON.stringify(await declare("crewmate-tab"))).toContain(
      "Recorded the captain's override",
    );
    expect(f.tasks.get("ab12")?.delivery?.override?.words).toBe(tabLine);
    await finish();
    // A scheduled check sees it on the task line and cannot set one.
    f.agent.notifyOp(
      { facts: { kind: "scheduled", prompt: "check the meter retry", catchUp: false } },
      "scheduled",
    );
    await tick();
    expect(JSON.stringify(await declare("card-ab12"))).toContain(
      "A scheduled check records no override",
    );
    expect(f.tasks.get("ab12")?.delivery?.override?.words).toBe(tabLine);
    // The model holds the line from the input that last changed it.
    const crew = heldContext(f.session.prompts).crew as {
      task_id: string;
      override?: string;
    }[];
    expect(crew.find((entry) => entry.task_id === "ab12")?.override).toBe(
      "the checks for the rest of this task",
    );
    await finish();
    f.agent.dispose();
    f.db.close();
  });
});

/**
 * INF-1582 finding 2, filed on the captain's words "a click on a yes button
 * does not count as your yes": a click on a card's button is his words on
 * every card alike, his words typed while a turn runs count in that turn,
 * and the one sentence recorded names more holds without a second.
 */
describe("the captain's override, from a click, a thread or words typed mid-turn", () => {
  const meterTask = {
    id: "ab12",
    title: "Steady the meter retry",
    status: "idle" as const,
    sessionFile: "/tmp/ab12.jsonl",
  };
  const harness = (seedCards: Card[] = []) => {
    const f = setup({ silent: true, seedTasks: [meterTask], seedCards });
    const finish = async () => {
      f.session.emitTurnEnd("Noted.");
      f.session.resolveNextPrompt();
      await tick();
    };
    const declare = async (override: Record<string, unknown>) =>
      JSON.stringify(
        await toolsOf(f.specs).get("update_task")?.execute("override", { task: "ab12", override }),
      );
    const report = (excerpt: string) =>
      notifyProse(
        f.db,
        f.agent,
        `[fm-op] crewmate 1 reported on task ab12 "Steady the meter retry": ${excerpt}`,
        "crewmate-report",
        "ab12",
      );
    const recorded = () => f.tasks.get("ab12")?.delivery?.override;
    return { ...f, finish, declare, report, recorded };
  };

  it("records the button's words from a click on the first mate's own card, and nothing from its script's choice", async () => {
    const rerun = "Rerun the meter fix's checks after a GitHub outage?";
    const f = harness([
      firstmateCard("card-fm-rerun", "ab12", rerun, [
        { id: "rerun", label: "Rerun the five checks", default: true },
        { id: "leave", label: "Leave them" },
      ]),
      firstmateCard("card-fm-timeline", "ab12", "Show the retry timeline?", [
        { id: "show", label: "Show it", default: true },
      ]),
    ]);
    // A script in the card's body chooses: its author's choice, never his.
    f.supervisor.cardActions.act("card-fm-timeline", "show", "frame");
    await drained(f.session, 1);
    expect(
      await f.declare({ holds: ["checks"], until: "task", from: "card-fm-timeline" }),
    ).toContain("The record holds no words of the captain's on card");
    expect(f.recorded()).toBeUndefined();
    await f.finish();
    // His click, as on Oct 26: its own turn cites the card it was on.
    f.supervisor.cardActions.act("card-fm-rerun", "rerun");
    await drained(f.session, 2);
    expect(await f.declare({ holds: ["checks"], until: "task", from: "card-fm-rerun" })).toContain(
      "Recorded the captain's override",
    );
    expect(f.recorded()).toMatchObject({
      words: choiceWords("Rerun the five checks", rerun),
      holds: ["checks"],
      until: "task",
    });
    await f.finish();
    f.agent.dispose();
    f.db.close();
  });

  it("records a click on a crewmate's card in the relay turn, and a reply under the first mate's card in a later turn", async () => {
    const failing = "The checks are still failing";
    const f = harness([
      {
        ...crewCard("card-ab12", "ab12", failing, "<p>Do you accept these failed checks?</p>"),
        actions: [{ id: "accept", label: "Accept the failed checks", default: true }],
      },
      firstmateCard("card-fm-review", "ab12", "Skip the review on the meter fix?", [
        { id: "skip", label: "Skip it", default: true },
      ]),
    ]);
    f.supervisor.cardActions.act("card-ab12", "accept");
    await tick();
    f.report(`the captain clicked "Accept the failed checks" on card card-ab12`);
    await drained(f.session, 1);
    expect(await f.declare({ holds: ["checks"], until: "task", from: "card-ab12" })).toContain(
      "Recorded the captain's override",
    );
    expect(f.recorded()?.words).toBe(choiceWords("Accept the failed checks", failing));
    await f.finish();
    // His reply under the first mate's card is its own turn; a report later cites it.
    const reply = "Skip the review this once; the diff is one line.";
    f.supervisor.cardActions.replyToCard("card-fm-review", reply);
    await drained(f.session, 2);
    await f.finish();
    f.report("the review is the one hold left.");
    await drained(f.session, 3);
    expect(await f.declare({ holds: ["checks"], until: "task", from: "card-fm-review" })).toContain(
      "Recorded the captain's override",
    );
    expect(f.recorded()).toMatchObject({ words: reply, holds: ["checks"] });
    await f.finish();
    f.agent.dispose();
    f.db.close();
  });

  it("records the words the captain typed while a crewmate's report was being read", async () => {
    const f = harness();
    f.report("five checks failed while GitHub could not serve downloads.");
    await drained(f.session, 1);
    // He types into the running turn, as at 5:34 PM on Oct 26.
    const words = "Rerun them, and merge if they pass.";
    await f.agent.converse(words);
    expect(f.session.steers).toHaveLength(1);
    expect(await f.declare({ holds: ["checks"], until: "task" })).toContain(
      "Recorded the captain's override",
    );
    expect(f.recorded()).toMatchObject({ words, holds: ["checks"], until: "task" });
    await f.finish();
    f.agent.dispose();
    f.db.close();
  });

  it("names more holds with the words already standing, and refuses that when none stands", async () => {
    const f = harness();
    f.report("the checks and the review both hold the merge.");
    await drained(f.session, 1);
    expect(await f.declare({ holds: ["checks"], until: "task", from: "standing" })).toContain(
      "No override stands on",
    );
    expect(f.recorded()).toBeUndefined();
    await f.finish();
    const words = "Get the meter fix merged today.";
    await f.agent.converse(words);
    await drained(f.session, 2);
    expect(await f.declare({ holds: ["checks"], until: "task" })).toContain(
      "Recorded the captain's override",
    );
    await f.finish();
    // A later report names a hold his sentence also reaches: the same words, no second ask.
    f.report("a wait on another task still holds the merge.");
    await drained(f.session, 3);
    expect(
      await f.declare({ holds: ["checks", "waits"], until: "task", from: "standing" }),
    ).toContain("Recorded the captain's override");
    expect(f.recorded()).toMatchObject({ words, holds: ["checks", "waits"], until: "task" });
    await f.finish();
    f.agent.dispose();
    f.db.close();
  });

  // INF-1966: on DOP-140 the first mate cited the captain's click on Merge
  // when checks pass as words passing the checks, and the pull request merged
  // with no word of theirs that the checks need not pass.
  it("refuses to turn an ordinary merge click into any override or standing words (INF-1966, INF-3284)", async () => {
    const ready = "The meter retry is ready to merge";
    const f = harness([
      {
        ...crewCard("card-ab12", "ab12", ready, "<p>The checks are still running.</p>"),
        actions: [
          {
            id: "merge-pr",
            label: MERGE_WHEN_CHECKS_PASS_WORDS,
            default: true,
            effect: { kind: "merge", after: "close" },
          },
        ],
      },
    ]);
    f.supervisor.cardActions.act("card-ab12", "merge-pr");
    await tick();
    f.report(`the captain clicked "${MERGE_WHEN_CHECKS_PASS_WORDS}" on card card-ab12`);
    await drained(f.session, 1);
    const clicked = choiceWords(MERGE_WHEN_CHECKS_PASS_WORDS, ready);
    expect(await f.declare({ holds: ["checks"], until: "task", from: "card-ab12" })).toContain(
      JSON.stringify(mergeClickRefusal(clicked)).slice(1, -1),
    );
    expect(f.recorded()).toBeUndefined();
    // INF-3284's accepted retirement: even a non-check hold cannot turn
    // this scoped approval into general permission through the tool boundary.
    expect(await f.declare({ holds: ["waits"], until: "task", from: "card-ab12" })).toContain(
      JSON.stringify(mergeClickRefusal(clicked)).slice(1, -1),
    );
    expect(f.recorded()).toBeUndefined();
    await f.finish();
    // The rejected click created no standing words to cite later.
    f.report("the checks still hold the merge.");
    await drained(f.session, 2);
    expect(
      await f.declare({ holds: ["waits", "checks"], until: "task", from: "standing" }),
    ).toContain("Override refused");
    expect(f.recorded()).toBeUndefined();
    await f.finish();
    f.agent.dispose();
    f.db.close();
  });
});
