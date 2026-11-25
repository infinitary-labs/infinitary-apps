import * as m from "@shared/i18n/messages.generated";
import { describe, expect, it, vi } from "vitest";
import {
  drained,
  fakeClockEachTest,
  setup,
  tick,
  toolsOf,
} from "../../../tests/helpers/firstmateHarness";
import { FIRSTMATE_RECIPIENT, InboxStore } from "../storage/inboxStore";
import { ANSWER_NOTICE_TITLE } from "./answerDelivery";
import { ANSWER_MISSING_OPENING, TAKEN_BACK_OPENING } from "./captainWakes";

fakeClockEachTest();

/**
 * Taking back a message (docs/task-capture.md, "Taking back a message"),
 * from INF-6763's approved plan: the captain takes back their newest
 * message within one minute, the first mate's actions credited to it are
 * refused, and the first mate is asked to undo what it already did.
 */
describe("FirstmateAgent taking back a message", () => {
  type Fixture = ReturnType<typeof setup>;
  const finish = async (f: Fixture, text = "Noted.") => {
    f.session.emitTurnEnd(text);
    f.session.resolveNextPrompt();
    await tick();
  };
  const newest = (f: Fixture) => {
    const ask = f.tasks.capture.listAsks().at(-1);
    if (!ask) throw new Error("no message was saved");
    return ask;
  };
  const createTask = (f: Fixture, params: Record<string, unknown>) =>
    toolsOf(f.specs)
      .get("create_task")
      ?.execute("t", { goal: `${params.title} is done.`, ...params });
  const textOf = (result: { content: { text?: string }[] } | undefined) =>
    result?.content[0]?.text ?? "";
  const lane = (f: Fixture) => new InboxStore(f.db).allFor(FIRSTMATE_RECIPIENT);

  it("withdraws a message no turn read, and never serves it", async () => {
    const options = { silent: true, failCreate: "Conversation could not start." };
    const f = setup(options);
    await f.agent.converse("start a task to delete the old logs");
    expect(lane(f)).toHaveLength(1);
    expect(f.agent.takeBack(newest(f).id)).toEqual({ outcome: "withdrawn" });
    expect(lane(f)).toEqual([]);
    options.failCreate = "";
    f.agent.pokeInbox();
    await tick();
    expect(f.session.prompts).toEqual([]);
    expect(newest(f).turnState).not.toBe("open");
  });

  it("types the line of a message no turn read as withdrawn, and never of one a turn is reading", async () => {
    // The review of the desktop take back: the window words "taken back
    // before your first mate read it" from this fact, never from a missing line.
    const options = { silent: true, failCreate: "Conversation could not start." };
    const f = setup(options);
    await f.agent.converse("start a task to delete the old logs");
    const unread = newest(f);
    expect(f.agent.takeBack(unread.id)).toEqual({ outcome: "withdrawn" });
    // A reader that draws `text`, as the phone does, reads the catalog's words.
    expect(f.tasks.capture.lastTurn()).toMatchObject({
      askId: unread.id,
      reply: { withdrawn: true, text: m.shellLastTurnRevertedUnread() },
    });
    expect(f.events.filter((event) => event.type === "firstmate_reply").at(-1)).toMatchObject({
      askId: unread.id,
      withdrawn: true,
    });

    options.failCreate = "";
    await f.agent.converse("start a task to archive the old logs");
    await drained(f.session, 1);
    const reading = newest(f);
    await f.agent.converse({ text: "archive only last year's logs", replaces: reading.id });
    expect(f.tasks.capture.lastTurn()?.previous).toMatchObject({
      askId: reading.id,
      takenBack: true,
    });
    expect(f.tasks.capture.lastTurn()?.previous?.reply).toBeNull();
    expect(
      f.events.filter((event) => event.type === "firstmate_reply" && event.askId === reading.id),
    ).toEqual([]);
  });

  it("drops a message taken back while it is still being handed to the first mate", async () => {
    let release = () => {};
    const sourceRead = new Promise<never>((resolve) => {
      release = () => resolve(undefined as never);
    });
    const f = setup({ silent: true, selfSourceFactsAsync: () => sourceRead });
    const sending = f.agent.converse("start a task to delete the old logs");
    // tick() would wait for this hand-off itself, which the source read holds.
    await vi.waitFor(() => expect(f.tasks.capture.listAsks()).toHaveLength(1));
    expect(f.agent.takeBack(newest(f).id)).toEqual({ outcome: "withdrawn" });
    release();
    await sending;
    await tick();
    expect(f.session.prompts).toEqual([]);
    expect(f.session.steers).toEqual([]);
    expect(lane(f)).toEqual([]);
  });

  it("withdraws a message whose steer the running turn refused", async () => {
    const f = setup({ silent: true });
    await f.agent.converse("look at the build logs");
    const steer = f.session.steer;
    f.session.steer = async () => {
      throw new Error("The session refused the steer.");
    };
    await f.agent.converse({ text: "start a task to delete the old logs" });
    const ask = newest(f);
    f.session.steer = steer;
    expect(f.agent.takeBack(ask.id)).toEqual({ outcome: "withdrawn" });
    expect(f.session.steers.filter((text) => text.includes(TAKEN_BACK_OPENING))).toEqual([]);
    expect(
      lane(f).filter((row) => row.facts?.kind === "captain-turn" && row.facts.askId === ask.id),
    ).toEqual([]);
    expect(f.tasks.capture.getAsk(ask.id)?.turnState).not.toBe("open");
    expect(f.tasks.capture.lastTurn()?.reply).toMatchObject({ withdrawn: true });
    await finish(f);
  });

  it("refuses a call naming the taken-back message, and one naming none in the turn that read it", async () => {
    const f = setup({ silent: true });
    await f.agent.converse("start a task to delete the old logs");
    const ask = newest(f);
    expect(f.agent.takeBack(ask.id)).toEqual({ outcome: "stopping" });
    expect(f.session.steers.at(-1)).toContain(`${TAKEN_BACK_OPENING} ${ask.id}`);
    const named = await createTask(f, { title: "Delete the old logs", ask_id: ask.id });
    expect(textOf(named)).toContain(`The captain took back message ${ask.id}`);
    const unnamed = await createTask(f, { title: "Delete the old logs" });
    expect(textOf(unnamed)).toContain(`The captain took back message ${ask.id}`);
    expect(f.tasks.list().map((task) => task.title)).not.toContain("Delete the old logs");
    await finish(f);
  });

  it("lets a call through that names another message or no message", async () => {
    const f = setup({ silent: true });
    await f.agent.converse("start a task to delete the old logs");
    const first = newest(f);
    await f.agent.converse({ text: "also file the pagination bug" });
    const second = newest(f);
    expect(second.id).not.toBe(first.id);
    // The second message is the newest now, so the first can no longer be taken back.
    expect(f.agent.takeBack(first.id)).toEqual({ outcome: "refused", reason: "not-newest" });
    expect(f.agent.takeBack(second.id)).toEqual({ outcome: "stopping" });
    const other = await createTask(f, { title: "Delete the old logs", ask_id: first.id });
    expect(textOf(other)).not.toContain("took back");
    const unrelated = await createTask(f, { title: "Tidy the logs folder", ask_id: "" });
    expect(textOf(unrelated)).not.toContain("took back");
    expect(f.tasks.list().map((task) => task.title)).toEqual(
      expect.arrayContaining(["Delete the old logs", "Tidy the logs folder"]),
    );
    await finish(f);
  });

  it("asks the first mate once, after the turn, to undo what the message caused, by task key", async () => {
    const f = setup({ silent: true });
    await f.agent.converse("start a task to delete the old logs");
    const ask = newest(f);
    await createTask(f, { title: "Delete the old logs" });
    const filed = f.tasks.list().find((task) => task.title === "Delete the old logs");
    expect(filed).toBeDefined();
    expect(f.agent.takeBack(ask.id)).toEqual({ outcome: "stopping" });
    await finish(f);
    await drained(f.session, 2);
    const wake = f.session.prompts[1] ?? "";
    expect(wake).toContain(`${TAKEN_BACK_OPENING} ${ask.id}`);
    expect(wake).toContain(
      `create_task on task ${filed?.id} (${filed?.key || filed?.id}) "Delete the old logs"`,
    );
    expect(wake).toContain('Set ask_id to "" on each of these calls.');
    await finish(f, "Dropped it.");
    await tick();
    // Counted across prompts, since two queued wakes may share one turn.
    const served = f.session.prompts.join("\n").split(`${TAKEN_BACK_OPENING} ${ask.id}`);
    expect(served).toHaveLength(2);
    expect(f.agent.takeBack(ask.id)).toEqual({ outcome: "refused", reason: "taken-back" });
  });

  it("lists an action for the message that took effect after the take back", async () => {
    const f = setup({ silent: true });
    await f.agent.converse("drop the old logs task");
    const ask = newest(f);
    await createTask(f, { title: "Old logs", ask_id: "" });
    const filed = f.tasks.list().find((task) => task.title === "Old logs");
    const settling = toolsOf(f.specs)
      .get("settle_task")
      ?.execute("t", { task_id: filed?.id, mode: "discard", closing_sentence: "Dropped it." });
    expect(f.agent.takeBack(ask.id)).toEqual({ outcome: "stopping" });
    await settling;
    expect(f.tasks.get(filed?.id ?? "")?.status).toBe("dropped");
    await finish(f);
    await drained(f.session, 2);
    expect(f.session.prompts[1]).toContain(`settle_task on task ${filed?.id}`);
  });

  it("gives a taken-back message no answer retry and no notice", async () => {
    const f = setup({ silent: true });
    await f.agent.converse("start a task to delete the old logs");
    const ask = newest(f);
    expect(f.agent.takeBack(ask.id)).toEqual({ outcome: "stopping" });
    await finish(f);
    await tick();
    expect(f.session.prompts.filter((prompt) => prompt.includes(ANSWER_MISSING_OPENING))).toEqual(
      [],
    );
    expect(f.supervisor.cards.snapshot().map((card) => card.title)).not.toContain(
      ANSWER_NOTICE_TITLE,
    );
    expect(f.tasks.capture.getAsk(ask.id)?.delivery).toBe("covered");
  });

  it("asks for the undo at once when the turn that acted on the message already ended", async () => {
    const f = setup({ silent: true });
    await f.agent.converse("start a task to delete the old logs");
    const ask = newest(f);
    await createTask(f, { title: "Delete the old logs" });
    await finish(f, "Filed it.");
    expect(f.agent.takeBack(ask.id)).toEqual({ outcome: "undoing" });
    await drained(f.session, 2);
    expect(f.session.prompts[1]).toContain(`${TAKEN_BACK_OPENING} ${ask.id}`);
  });

  it("refuses a take back past one minute", async () => {
    const f = setup({ silent: true });
    await f.agent.converse("start a task to delete the old logs");
    await finish(f, "Filed it.");
    vi.setSystemTime(Date.now() + 60_001);
    expect(f.agent.takeBack(newest(f).id)).toEqual({ outcome: "refused", reason: "past-window" });
    expect(f.agent.takeBack("no-such-message")).toEqual({ outcome: "refused", reason: "unknown" });
  });

  it("takes back the newest message when a replacement names it, and hands its words to the undo", async () => {
    const f = setup({ silent: true });
    await f.agent.converse("start a task to delete the old logs");
    const first = newest(f);
    await createTask(f, { title: "Delete the old logs" });
    await finish(f, "Filed it.");
    await f.agent.converse({ text: "start a task to archive the old logs", replaces: first.id });
    const second = newest(f);
    expect(second.correctionOf).toBe(first.id);
    expect(f.tasks.capture.getAsk(first.id)?.takenBackAt).toBeDefined();
    await finish(f);
    await vi.waitFor(() =>
      expect(f.session.prompts.some((prompt) => prompt.includes(TAKEN_BACK_OPENING))).toBe(true),
    );
    const wake = f.session.prompts.find((prompt) => prompt.includes(TAKEN_BACK_OPENING)) ?? "";
    expect(wake).toContain(
      'They replaced it with a new message: "start a task to archive the old logs".',
    );
  });

  it("writes the undo turn's closing line beside the message it took back", async () => {
    const f = setup({ silent: true });
    await f.agent.converse("start a task to delete the old logs");
    const ask = newest(f);
    await createTask(f, { title: "Delete the old logs" });
    await finish(f, "Filed it.");
    expect(f.agent.takeBack(ask.id)).toEqual({ outcome: "undoing" });
    await drained(f.session, 2);
    await finish(f, "Took it back: dropped its task.");
    expect(f.tasks.capture.lastTurn()).toMatchObject({
      askId: ask.id,
      reply: { text: "Took it back: dropped its task." },
    });
    const lines = f.events.filter((event) => event.type === "firstmate_reply");
    expect(lines.at(-1)).toMatchObject({ text: "Took it back: dropped its task.", askId: ask.id });
  });

  it("keeps the line beside a replacement whose turn also carries the undo", async () => {
    const f = setup({ silent: true });
    await f.agent.converse("start a task to delete the old logs");
    const first = newest(f);
    await createTask(f, { title: "Delete the old logs" });
    await finish(f, "Filed it.");
    await f.agent.converse({ text: "start a task to archive the old logs", replaces: first.id });
    const second = newest(f);
    await drained(f.session, 2);
    expect(f.session.prompts[1]).toContain(`${TAKEN_BACK_OPENING} ${first.id}`);
    await createTask(f, { title: "Archive the old logs", ask_id: second.id });
    await finish(f, "Dropped the delete task and filed the archive task.");
    expect(f.tasks.capture.lastTurn()).toMatchObject({
      askId: second.id,
      reply: { text: "Dropped the delete task and filed the archive task." },
      previous: { askId: first.id, takenBack: true, reply: { text: "Filed it." } },
    });
  });
});
