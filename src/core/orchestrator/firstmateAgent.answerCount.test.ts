import { describe, expect, it, vi } from "vitest";
import {
  crewCard,
  drained,
  fakeClockEachTest,
  setup,
  tick,
  toolsOf,
} from "../../../tests/helpers/firstmateHarness";
import { InboxStore } from "../storage/inboxStore";
import { ANSWER_MISSING_OPENING } from "./captainWakes";

// This file chains real git and is not about the utility-QoS clamp, so what
// the product spawns runs at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

fakeClockEachTest();

/**
 * One answer counts for every captain message it answers (INF-6749's audit,
 * finding 3, which the captain chose to build). The audit saw one question
 * get two answers in the same card thread twice in a day: a question and
 * its one-word correction answered by one line, and a question passed on to
 * the crewmate whose card it was about. Each case here is one of those two,
 * through the real agent, card service and lane.
 */
describe("one answer for every message it answers", () => {
  type Fixture = ReturnType<typeof setup>;
  const finish = async (f: Fixture, text = "Noted.") => {
    f.session.emitTurnEnd(text);
    f.session.resolveNextPrompt();
    await tick();
  };
  const retries = (f: Fixture) =>
    f.session.prompts.filter((prompt) => prompt.includes(ANSWER_MISSING_OPENING));
  const mergeCard = () =>
    crewCard(
      "card-google-merge",
      "google",
      "Set up Google with the person's own client",
      "<p>Ready to merge.</p>",
    );

  it("ends a question and its correction on the one line that names both", async () => {
    const f = setup({
      silent: true,
      seedTasks: [{ id: "google", title: "Set up an own Google client", status: "idle" }],
      seedCards: [mergeCard()],
    });
    vi.advanceTimersByTime(1_000);
    await f.agent.converse(
      "i dismissed this card multiple times, but it kept coming back by itself. why?",
    );
    await f.agent.converse('i meant "put aside"');
    const [question, correction] = f.tasks.capture.listAsks();
    await toolsOf(f.specs)
      .get("emit_card")
      ?.execute("c1", {
        id: "card-google-merge",
        title: "Set up Google with the person's own client",
        reply:
          "Putting a card aside hides it without answering it; each new version brings it back.",
        ask_id: [question?.id, correction?.id],
      });
    await finish(f, "Answered on its card.");
    await tick();

    for (const ask of f.tasks.capture.listAsks())
      expect(ask).toMatchObject({ delivery: "covered", answerCardId: "card-google-merge" });
    expect(retries(f)).toEqual([]);
    expect(
      f.supervisor.cards
        .thread("card-google-merge")
        .messages.filter((line) => line.who === "firstmate"),
    ).toHaveLength(1);
  });

  it("ends a passed-on question on the crewmate's answer in its card's thread, without asking the first mate again", async () => {
    const f = setup({
      silent: true,
      seedTasks: [
        {
          id: "strip",
          title: "Open the conversation from the strip",
          status: "idle",
          sessionFile: "/tmp/strip.jsonl",
        },
      ],
      seedCards: [
        crewCard(
          "card-strip-merge",
          "strip",
          "Open the conversation from the strip",
          "<p>Ready.</p>",
        ),
      ],
    });
    vi.advanceTimersByTime(1_000);
    await f.agent.converse("wait why does the highlight look like this?");
    await toolsOf(f.specs).get("steer_crewmate")?.execute("s1", {
      task_id: "strip",
      message:
        "The captain asked why the hover highlight is a thin band. Answer him in your card's thread.",
    });
    await finish(f, "I passed your question on.");
    const [request] = new InboxStore(f.db).pendingResponses("strip");
    if (!request) throw new Error("No open request on the strip task");

    const line = f.supervisor.cards.replyAs(
      { actor: "crewmate", taskId: "strip" },
      {
        cardId: "card-strip-merge",
        text: "I lit each round on its own instead of the whole strip.",
        response: { requestId: request.id, responseId: "strip-r1", status: "answered" },
      },
    );
    expect(line.effect).toBe("reply-only");
    f.agent.pokeInbox();
    await drained(f.session, 2);
    expect(f.session.prompts[1]).toContain("do not write it again");
    await finish(f, "The crewmate answered on its card.");
    await tick();

    const [ask] = f.tasks.capture.listAsks();
    expect(ask).toMatchObject({ delivery: "covered", answerCardId: "card-strip-merge" });
    expect(ask?.answeredAt).not.toBeNull();
    expect(retries(f)).toEqual([]);
  });
});
