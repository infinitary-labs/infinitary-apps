import { AUTOMATIC_EMOTE_WORDS } from "@shared/emotes";
import { type FmEvent, fmEventSchema } from "@shared/events";
import { plainProblem } from "@shared/plainProblem";
import { describe, expect, it, vi } from "vitest";
import { freshDatabase as openInMemoryDatabase } from "../../../tests/helpers/database";
import {
  bindDirections,
  drained,
  fakeClockEachTest,
  notifyProse,
  setup,
  tick,
  toolsOf,
} from "../../../tests/helpers/firstmateHarness";
import type { ModelRuntime } from "../pi/types";
import { CardStore } from "../storage/cardStore";
import { ScheduleStore } from "../storage/scheduleStore";
import { Scheduler } from "./scheduler";

// This file chains real git and is not about the utility-QoS clamp, so what
// the product spawns runs at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

/** The first mate agent: reply emotes and the reply line (tests/helpers/firstmateHarness.ts). */
fakeClockEachTest();

/**
 * The host's own reply emotes (captain's board verdict 2026-09-22, trigger
 * C): a captain turn's steer nods, a note kept tucks, a personalize applied
 * ticks - fired from the tool outcome, through the real agent and tools. An
 * operational or scheduled wake answers nobody, so it plays none of them.
 */
describe("FirstmateAgent reply emotes", () => {
  const emotes = (events: FmEvent[]) =>
    events.flatMap((event) => (event.type === "firstmate_emote" ? [event.emote] : []));

  it("nods when a captain turn's steer is delivered, and not on an operational wake", async () => {
    const { agent, db, session, specs, events } = setup({
      silent: true,
      seedTasks: [
        { id: "t1", title: "Add pagination", status: "idle", sessionFile: "/tmp/t1.jsonl" },
      ],
    });
    await agent.converse("tell pagination to add a test for the last page");
    const steer = toolsOf(specs).get("steer_crewmate");
    await steer?.execute("s1", { task_id: "t1", message: "add a test for the last page" });
    expect(emotes(events)).toEqual(["nod"]);

    session.emitTurnEnd("Steered.");
    session.resolveNextPrompt();
    await tick();
    notifyProse(
      db,
      agent,
      "[fm-op] crewmate 1 reported on task t1: done.",
      "crewmate-report",
      "t1",
    );
    await tick();
    await steer?.execute("s2", { task_id: "t1", message: "also update the docs" });
    expect(emotes(events)).toEqual(["nod"]);
  });

  it("tucks when a captain turn keeps a note, and not when it forgets one", async () => {
    const { agent, specs, events, knowledge } = setup({ silent: true });
    if (!knowledge) throw new Error("No knowledge.");
    bindDirections(agent, knowledge);
    await agent.converse("remember that I always squash-merge");
    const change = toolsOf(specs).get("app_change");
    await change?.execute("r1", {
      action: "direction",
      value: { op: "add", id: "squash-merges", text: "Always squash-merge when landing work." },
      evidence: "captain said so",
    });
    expect(emotes(events)).toEqual(["tuck"]);
    await change?.execute("r2", {
      action: "direction",
      value: { op: "retire", id: "d:squash-merges", expectedRevision: 1 },
      evidence: "no longer true",
    });
    // Forgetting one is a setting applied, never a note kept.
    expect(emotes(events)).toEqual(["tuck", "tick"]);
  });

  it("ticks when a captain turn's personalize applies, never on a refusal or a schedule", async () => {
    const { agent, db, session, specs, events } = setup({ silent: true });
    await agent.converse("switch to light");
    const personalize = toolsOf(specs).get("personalize");
    const refused = await personalize?.execute("p1", {
      action: "remove",
      surface: "nope",
      evidence: "hide nope",
    });
    expect(refused?.content[0]?.text).toContain('No surface "nope"');
    expect(emotes(events)).toEqual([]);
    await personalize?.execute("p2", {
      action: "remove",
      surface: "now",
      evidence: "remove tasks",
    });
    expect(emotes(events)).toEqual(["tick"]);

    session.emitTurnEnd("Done.");
    session.resolveNextPrompt();
    await tick();
    // A scheduled wake cannot remove a surface; nobody is there to answer.
    notifyProse(db, agent, "[fm-op] scheduled: dark in the evening", "scheduled");
    await tick();
    await personalize?.execute("p3", {
      action: "remove",
      surface: "activity",
      evidence: "schedule",
    });
    expect(emotes(events)).toEqual(["tick"]);
  });
});

/**
 * The emote (INF-772's plan, the captain's "drop them"): motion only, with
 * no words of the Firstmate's own; it is an action that covers a message.
 * The host's own replies carry the app's own words (FI3-1077), marked
 * automatic, as the typed line's fallback.
 */
describe("FirstmateAgent emote", () => {
  const emoteEvents = (events: FmEvent[]) =>
    events.filter((event) => event.type === "firstmate_emote");
  const localSeat = {
    model: { provider: "local", id: "fixture" },
    runtime: {} as ModelRuntime,
    host: "localhost",
    source: "setting" as const,
  };

  it("plays with no words and counts as an action (local seat's no-answer guard)", async () => {
    const f = setup({ silent: true });
    await f.agent.setLocalOrchestrator(localSeat);
    await f.agent.converse("ship the meter fix");
    const result = await toolsOf(f.specs).get("emote")?.execute("e1", { emote: "salute" });
    expect(result?.content[0]?.text).toBe("Emote requested: salute");
    expect(emoteEvents(f.events)).toEqual([{ type: "firstmate_emote", emote: "salute" }]);
    f.session.emitTurnEnd("On it.");
    f.session.resolveNextPrompt();
    await vi.waitFor(() => expect(f.agent.isBusy()).toBe(false));
    expect(new CardStore(f.db).get("card-fm-turn-failure")).toBeUndefined();
    expect(f.tasks.capture.listAsks().map((ask) => ask.delivery)).toEqual(["covered"]);
    f.agent.dispose();
    f.db.close();
  });

  it("puts the app's own words on the host's own reply emotes, marked automatic", async () => {
    const { agent, specs, events } = setup({
      silent: true,
      seedTasks: [
        { id: "t1", title: "Add pagination", status: "idle", sessionFile: "/tmp/t1.jsonl" },
      ],
    });
    await agent.converse("tell pagination to add a test, remember I squash-merge, hide tasks");
    const tools = toolsOf(specs);
    await tools.get("steer_crewmate")?.execute("s1", { task_id: "t1", message: "add a test" });
    await tools.get("record_knowledge")?.execute("r1", {
      action: "publish",
      request_id: "r1",
      kind: "concept",
      lane: "personal",
      title: "Squash merges",
      text: "The captain always squash-merges when landing work.",
    });
    await tools.get("personalize")?.execute("p1", {
      action: "remove",
      surface: "now",
      evidence: "hide tasks",
    });
    expect(emoteEvents(events)).toEqual(
      (["nod", "tuck", "tick"] as const).map((emote) => ({
        type: "firstmate_emote",
        emote,
        text: AUTOMATIC_EMOTE_WORDS[emote],
        automatic: true,
      })),
    );
    // What crosses is what the wire accepts.
    for (const event of emoteEvents(events)) expect(fmEventSchema.parse(event)).toEqual(event);
  });
});

/**
 * The reply line beside the captain's last message (INF-772's plan;
 * docs/composer.md "The last turn"): the turn's closing words when
 * something took effect, else the typed line chosen from what the turn did,
 * sent before the busy signal falls so the working line turns straight into
 * it, and kept beside the message for the next launch. The scripted model
 * closes with no words unless a test gives some, so each test says what the
 * turn did and the typed fallback shows.
 */
describe("FirstmateAgent reply line", () => {
  type Fixture = ReturnType<typeof setup>;
  const finish = async (f: Fixture, closing = "") => {
    f.session.emitTurnEnd(closing);
    f.session.resolveNextPrompt();
    await tick();
  };
  /** The newest message and its reply line, without the round before it. */
  const newestRound = (f: Fixture) => {
    const turn = f.tasks.capture.lastTurn();
    return turn && { you: turn.you, reply: turn.reply };
  };
  /** The reply lines and busy signals, in the order the window hears them. */
  const heard = (f: Fixture) =>
    f.events.flatMap((event) =>
      event.type === "firstmate_reply"
        ? [`reply:${event.text}${event.problem ? ":problem" : ""}`]
        : event.type === "firstmate_state"
          ? [`busy:${event.busy}`]
          : [],
    );
  const note = (id: string, title: string) => ({
    id,
    title,
    body: "<p>Here is the answer.</p>",
  });

  it.each(["none", "closing"])(
    "states where the filed task landed, its key and title, unless the turn closed with words (%s)",
    async (closing) => {
      const f = setup({ silent: true });
      await f.agent.converse("file a task to build personal panels in isolation");
      const tools = toolsOf(f.specs);
      const title = "Build personal panels in isolation, swap in when ready";
      await tools.get("create_task")?.execute("file", {
        title,
        goal: "Build panels in isolation",
        user_words: "file a task to build personal panels in isolation",
      });
      const filed = f.tasks.list().find((task) => task.title === title);
      expect(filed?.status).toBe("open");
      const words = `Filed ${filed?.key} for the panel build.`;
      await finish(f, closing === "closing" ? words : "");
      expect(f.tasks.capture.lastTurn()?.reply).toEqual({
        // INF-2601, folded into INF-2715: the reply says filed work is in the backlog.
        text: closing === "closing" ? words : `Filed ${filed?.key} in the backlog: ${title}`,
        eligibility: "completed",
      });
    },
  );

  it.each(["update", "link", "unlink", "drop"])(
    "names the %s record mutation, not a generic acknowledgment",
    async (action) => {
      const f = setup({ silent: true });
      await f.agent.converse("file the work");
      const tools = toolsOf(f.specs);
      for (const title of ["Panel build", "Panel check"]) {
        await tools
          .get("create_task")
          ?.execute(title, { title, goal: title, user_words: "file the work" });
      }
      const build = f.tasks.list().find((row) => row.title === "Panel build");
      const check = f.tasks.list().find((row) => row.title === "Panel check");
      const edge = { from: build?.key, to: check?.key, type: "blocks" };
      if (action === "unlink") await tools.get("link_tasks")?.execute("prerequisite", edge);
      await finish(f);
      await f.agent.converse(`${action} the work`);
      if (action === "update")
        await tools
          .get("update_task")
          ?.execute("update", { task: build?.key, goal: "Build the panel safely" });
      if (action === "drop")
        await tools
          .get("update_task")
          ?.execute("drop", { task: build?.key, drop: true, reason: "No longer needed" });
      if (action === "link" || action === "unlink")
        await tools
          .get("link_tasks")
          ?.execute("edge", { ...edge, ...(action === "unlink" ? { remove: true } : {}) });
      await finish(f);
      const expected =
        action === "update"
          ? `Updated ${build?.key}: Panel build`
          : action === "drop"
            ? `Dropped ${build?.key}: Panel build`
            : `${action === "link" ? "Linked" : "Unlinked"} ${build?.key} and ${check?.key}`;
      expect(f.tasks.capture.lastTurn()?.reply?.text).toBe(expected);
    },
  );

  // INF-3127, the captain's choice "The first mate pins and unpins by your words".
  it("pins and unpins a task on the captain's words, naming it on the line and the record", async () => {
    const f = setup({ silent: true });
    await f.agent.converse("file the release checklist");
    const tools = toolsOf(f.specs);
    const title = "Write the release checklist";
    await tools
      .get("create_task")
      ?.execute("file", { title, goal: title, user_words: "file the release checklist" });
    const work = f.tasks.list().find((row) => row.title === title);
    await finish(f);
    await f.agent.converse(`pin ${work?.key}`);
    await tools.get("update_task")?.execute("pin", { task: work?.key, pinned: true });
    await finish(f);
    expect(f.tasks.get(work?.id ?? "")?.pinnedAt).not.toBeNull();
    expect(f.tasks.listPinned().map((row) => row.id)).toEqual([work?.id]);
    expect(f.tasks.capture.lastTurn()?.reply?.text).toBe(
      `Pinned ${work?.key} to the top of Tasks: ${title}`,
    );
    await f.agent.converse(`unpin ${work?.key}`);
    await tools.get("update_task")?.execute("unpin", { task: work?.key, pinned: false });
    await finish(f);
    expect(f.tasks.listPinned()).toEqual([]);
    expect(f.tasks.capture.lastTurn()?.reply?.text).toBe(`Unpinned ${work?.key}: ${title}`);
    const pins = f.tasks
      .timeline(work?.id ?? "")
      .filter((event) => event.data && "pin" in event.data)
      .map((event) => [event.actor, event.data?.pin]);
    expect(pins).toEqual([
      ["firstmate", "pinned"],
      ["firstmate", "unpinned"],
    ]);
  });

  it.each([
    "unchanged",
    "missing-link",
    "refused-start",
    "refused-drop",
    "withdraw-without-approval",
    "unpin-unpinned",
  ])("does not announce a record success for %s", async (action) => {
    const f = setup({ silent: true });
    await f.agent.converse("file the work");
    const tools = toolsOf(f.specs);
    for (const title of ["Panel build", "Panel check"])
      await tools
        .get("create_task")
        ?.execute(title, { title, goal: title, user_words: "file the work" });
    const build = f.tasks.list().find((row) => row.title === "Panel build");
    const check = f.tasks.list().find((row) => row.title === "Panel check");
    if (action === "refused-start")
      await tools
        .get("link_tasks")
        ?.execute("block", { from: build?.key, to: check?.key, type: "blocks" });
    if (action === "refused-drop")
      await tools.get("update_task")?.execute("parent", { task: check?.key, parent: build?.key });
    await finish(f);
    await f.agent.converse("change the work");
    if (action === "missing-link")
      await tools
        .get("link_tasks")
        ?.execute("remove", { from: build?.key, to: check?.key, type: "blocks", remove: true });
    else
      await tools.get("update_task")?.execute("update", {
        task: action === "refused-start" ? check?.key : build?.key,
        ...(action === "refused-start" ? { start_now: true } : {}),
        ...(action === "refused-drop" ? { drop: true, reason: "Not needed" } : {}),
        ...(action === "withdraw-without-approval" ? { withdraw_merge: true } : {}),
        ...(action === "unpin-unpinned" ? { pinned: false } : {}),
      });
    await finish(f);
    expect(f.tasks.capture.lastTurn()?.reply).toBeNull();
  });

  // INF-759, the captain's answer "a spark anyway, because its task changed".
  it("sparks to a crewmate whose task an edit changed, though it never hears the edit", async () => {
    const f = setup({ silent: true });
    await f.agent.converse("start the panel");
    const tools = toolsOf(f.specs);
    await tools.get("spawn_crewmate")?.execute("spawn", {
      title: "Panel build",
      goal: "Build the panel",
      user_words: "start the panel",
    });
    const build = f.tasks.list().find((row) => row.title === "Panel build");
    expect(build?.status).toBe("active");
    const sparks = () =>
      f.events.filter(
        (event) => event.type === "task_event" && event.reached && event.taskId === build?.id,
      ).length;
    const before = sparks();
    await tools.get("update_task")?.execute("speed", { task: build?.key, crew_speed: "fast" });
    expect(sparks()).toBe(before + 1);
    await finish(f);
  });

  it("describes a scheduled prompt and its cancellation only when they take effect", async () => {
    const store = new ScheduleStore(openInMemoryDatabase());
    const scheduler = new Scheduler({ store, notify: () => {}, broadcastEvent: () => {} });
    const f = setup({ silent: true, scheduler });
    // cancel_schedule is Settings → Automation's Delete (INF-752): the
    // catalog's automation-delete, whose trail records the delivery.
    const deletes: unknown[] = [];
    f.agent.bindAppDispatch(async (channel, args, actor) => {
      deletes.push([channel, args, actor]);
      const [id] = args as [string];
      scheduler.cancel(id, { say: () => {} });
      const row = f.tasks.capture.fileOperation({
        id: "cancel-1",
        title: "Schedule cancelled",
        outcome: "Schedule cancelled",
        tool: "app_change",
        actor: "firstmate",
      });
      f.agent.appActionRecorded(row.id);
      return { id } as never;
    });
    await f.agent.converse("remind me to check the panel");
    const tools = toolsOf(f.specs);
    await tools
      .get("schedule_prompt")
      ?.execute("schedule", { prompt: "Check the panel", every_minutes: 30 });
    const schedule = store.list()[0];
    await finish(f);
    expect(f.tasks.capture.lastTurn()?.reply?.text).toBe("Scheduled: Check the panel");
    // Each message still owes the captain its card: the retry shows it.
    const answerRetry = async (count: number) => {
      await drained(f.session, count);
      await tools.get("emit_card")?.execute(`answer-${count}`, note(`answer-${count}`, "Done"));
      await finish(f);
    };
    await answerRetry(2);
    await f.agent.converse("cancel that reminder");
    await tools.get("cancel_schedule")?.execute("cancel", { schedule_id: schedule?.id });
    await finish(f);
    expect(f.tasks.capture.lastTurn()?.reply?.text).toBe("Cancelled schedule: Check the panel");
    await answerRetry(4);
    expect(deletes).toEqual([
      [
        "inf:automation:delete",
        [schedule?.id],
        {
          kind: "firstmate",
          wake: "captain",
          action: "automation-delete",
          evidence: "cancel_schedule",
        },
      ],
    ]);
    await f.agent.converse("cancel it again");
    await tools.get("cancel_schedule")?.execute("noop", { schedule_id: schedule?.id });
    await finish(f);
    expect(f.tasks.capture.lastTurn()?.reply).toBeNull();
    expect(deletes).toHaveLength(1);
  });

  it.each(["spawn", "start"])(
    "describes work that %s started instead of echoing its title",
    async (path) => {
      const f = setup({ silent: true });
      const title = "Promote alpha 0.1.31-alpha.46 to the stable release";
      const words = "promote latest alpha to stable release btw";
      await f.agent.converse(words);
      const tools = toolsOf(f.specs);
      const input = { title, goal: "Promote the current alpha to stable", user_words: words };
      if (path === "spawn") {
        await tools.get("spawn_crewmate")?.execute("spawn", input);
      } else {
        await tools.get("create_task")?.execute("plan", input);
        const planned = f.tasks.list().find((task) => task.title === title);
        expect(planned?.status).toBe("open");
        await tools.get("update_task")?.execute("start", { task: planned?.key, start_now: true });
      }
      expect(f.tasks.list().find((task) => task.title === title)?.status).toBe("active");
      await finish(f);
      expect(f.tasks.capture.lastTurn()?.reply?.text).not.toBe(title);
      expect(newestRound(f)).toEqual({
        you: words,
        reply: { text: `Started: ${title}`, eligibility: "completed" },
      });
      expect(heard(f)).toEqual(["busy:true", `reply:Started: ${title}`, "busy:false"]);
    },
  );

  it("puts the closing words ahead of every app-written reply", async () => {
    const f = setup({ silent: true });
    await f.agent.converse("start the release");
    const tools = toolsOf(f.specs);
    await tools.get("spawn_crewmate")?.execute("spawn", {
      title: "Promote the alpha",
      goal: "Promote the alpha to stable",
      user_words: "start the release",
    });
    await finish(f, "Started the alpha's promotion.");
    expect(f.tasks.capture.lastTurn()?.reply).toEqual({
      text: "Started the alpha's promotion.",
      eligibility: "completed",
    });

    await f.agent.converse("remember I squash merges");
    await tools.get("record_knowledge")?.execute("note", {
      action: "publish",
      request_id: "note",
      kind: "concept",
      lane: "personal",
      title: "Squash merges",
      text: "The captain always squash-merges.",
    });
    await finish(f, "Kept your squash-merge rule.");
    expect(heard(f)).toEqual([
      "busy:true",
      "reply:Started the alpha's promotion.",
      "busy:false",
      "busy:true",
      "reply:Kept your squash-merge rule.",
      "busy:false",
      // The message still owes the captain its card: the retry turn starts.
      "busy:true",
    ]);
  });

  it("takes the words of the turn's last request, never ones written before the newest message was read", async () => {
    const f = setup({ silent: true });
    await f.agent.converse("salute me");
    const tools = toolsOf(f.specs);
    await tools.get("emote")?.execute("e1", { emote: "salute" });
    f.session.holdSteers();
    await f.agent.converse("how is the alpha?");
    // A request that closed before the new message was read.
    f.session.emitTurnEnd("Saluted you.");
    f.session.readSteers();
    await tools.get("emit_card")?.execute("c1", note("alpha", "The alpha is cut"));
    await finish(f);
    expect(newestRound(f)).toEqual({
      you: "how is the alpha?",
      reply: { text: "The alpha is cut", eligibility: "completed" },
    });
  });

  it("shows no closing words when nothing took effect, and the answer check retries", async () => {
    const f = setup({ silent: true });
    await f.agent.converse("what is PR 58's state?");
    await finish(f, "PR 58 merged an hour ago.");
    await drained(f.session, 2);
    expect(newestRound(f)).toEqual({ you: "what is PR 58's state?", reply: null });
    expect(f.tasks.capture.listAsks().at(-1)?.delivery).toBe("retrying");
  });

  it("shows the closing words of a reply under its own card on the line and in the thread", async () => {
    // INF-772, the captain's answer: "The closing words show in both places".
    const f = setup({ silent: true });
    const cardId = f.supervisor.addFirstmateCard({
      title: "Pick one",
      body: "<p>A or B.</p>",
      actions: [{ id: "a", label: "A", default: true }],
    });
    f.supervisor.cardActions.replyToCard(cardId, "why A?");
    await drained(f.session, 1);
    await finish(f, "A keeps the queue in order.");
    expect(f.tasks.capture.lastTurn()?.reply).toEqual({
      text: "A keeps the queue in order.",
      eligibility: "completed",
    });
    expect(
      f.supervisor.cards
        .thread(cardId)
        .messages.filter((message) => message.who === "firstmate")
        .map((message) => message.text),
    ).toEqual(["A keeps the queue in order."]);
  });

  it("is the title of the card the turn showed, sent before busy falls and kept beside the message", async () => {
    const f = setup({ silent: true });
    await f.agent.converse("how is the alpha coming along?");
    await toolsOf(f.specs).get("emit_card")?.execute("c1", note("alpha", "The alpha is cut"));
    await finish(f);
    expect(heard(f)).toEqual(["busy:true", "reply:The alpha is cut", "busy:false"]);
    expect(newestRound(f)).toEqual({
      you: "how is the alpha coming along?",
      reply: { text: "The alpha is cut", eligibility: "completed" },
    });
    for (const event of f.events.filter((e) => e.type === "firstmate_reply")) {
      expect(fmEventSchema.parse(event)).toEqual(event);
    }
  });

  it("keeps the card's title over a later wordless emote, and app words after keeping a note", async () => {
    const f = setup({ silent: true });
    await f.agent.converse("show me the alpha and salute");
    const tools = toolsOf(f.specs);
    await tools.get("emit_card")?.execute("c1", note("alpha", "The alpha is cut"));
    await tools.get("emote")?.execute("e1", { emote: "salute" });
    await finish(f);
    expect(f.tasks.capture.lastTurn()?.reply).toEqual({
      text: "The alpha is cut",
      eligibility: "completed",
    });

    await f.agent.converse("remember that I always squash-merge");
    await toolsOf(f.specs).get("record_knowledge")?.execute("r1", {
      action: "publish",
      request_id: "r1",
      kind: "concept",
      lane: "personal",
      title: "Squash merges",
      text: "The captain always squash-merges when landing work.",
    });
    await finish(f);
    expect(newestRound(f)).toEqual({
      you: "remember that I always squash-merge",
      reply: { text: AUTOMATIC_EMOTE_WORDS.tuck, eligibility: "completed" },
    });
  });

  it("discards pre-read replies and uses the latest reply across kinds", async () => {
    const f = setup({ silent: true });
    notifyProse(f.db, f.agent, "[fm-op] earlier work", "agent");
    await drained(f.session, 1);
    const tools = toolsOf(f.specs);
    await tools.get("emote")?.execute("old", { emote: "tick" });
    f.session.holdSteers();
    await f.agent.converse("what is next?");
    // The step already running is still about earlier work, even though
    // the message has arrived. Only the model's read witness resets it.
    await tools.get("emote")?.execute("old-step", { emote: "salute" });
    f.session.readSteers();
    await tools.get("emit_card")?.execute("answer", note("next", "The next task"));
    await finish(f);
    expect(f.tasks.capture.lastTurn()?.reply).toEqual({
      text: "The next task",
      eligibility: "completed",
    });

    const g = setup({ silent: true });
    await g.agent.converse("salute then show a card");
    await toolsOf(g.specs).get("emote")?.execute("first", { emote: "salute" });
    await toolsOf(g.specs).get("emit_card")?.execute("last", note("answer", "The latest answer"));
    await finish(g);
    expect(g.tasks.capture.lastTurn()?.reply).toEqual({
      text: "The latest answer",
      eligibility: "completed",
    });
  });

  it("does not reuse an earlier reply when a read message receives no action", async () => {
    const f = setup({ silent: true });
    await f.agent.converse("first question");
    await toolsOf(f.specs).get("emote")?.execute("old", { emote: "salute" });
    await f.agent.converse("second question");
    await finish(f);
    await drained(f.session, 2);
    expect(newestRound(f)).toEqual({ you: "second question", reply: null });
    expect(heard(f).filter((line) => line.startsWith("reply:"))).toEqual([]);
    expect(f.tasks.capture.listAsks().at(-1)?.delivery).toBe("retrying");
  });

  it("keeps a late unread message open with no earlier turn's reply or task attachment", async () => {
    const f = setup({ silent: true });
    await f.agent.converse("first question");
    await toolsOf(f.specs).get("emote")?.execute("old", { emote: "salute" });
    f.session.holdSteers();
    await f.agent.converse("late question");
    const late = f.tasks.capture.listAsks().at(-1);
    // A tool in the earlier step still belongs to the first question.
    await toolsOf(f.specs).get("emit_card")?.execute("first", note("first", "First answer"));
    expect(f.tasks.capture.getAsk(late?.id ?? "")?.taskId).toBeNull();
    await finish(f);
    await drained(f.session, 2);
    expect(f.tasks.capture.getAsk(late?.id ?? "")).toMatchObject({
      turnState: "open",
      taskId: null,
    });
    expect(newestRound(f)).toEqual({ you: "late question", reply: null });
    expect(heard(f).filter((line) => line.startsWith("reply:"))).toEqual([]);
    await toolsOf(f.specs).get("emit_card")?.execute("answer", note("late", "Late answer"));
    await finish(f);
    expect(f.tasks.capture.getAsk(late?.id ?? "")).toMatchObject({ turnState: "closed" });
    expect(f.tasks.capture.lastTurn()?.reply).toEqual({
      text: "Late answer",
      eligibility: "completed",
    });
    const attached = f.tasks.capture.getAsk(late?.id ?? "")?.taskId;
    expect(f.tasks.get(attached ?? "")).toMatchObject({
      title: "Late answer",
      outcome: "<p>Here is the answer.</p>",
    });
  });

  it("says what went wrong in plain words when the turn fails", async () => {
    const f = setup({ silent: true });
    await f.agent.converse("merge the open pull request");
    f.session.emitTurnFailed("socket hang up");
    f.session.resolveNextPrompt();
    await tick();
    const line = plainProblem(f.events.find((e) => e.type === "turn_failed")?.error);
    expect(heard(f)).toEqual(["busy:true", `reply:${line}:problem`, "busy:false"]);
    expect(f.tasks.capture.lastTurn()?.reply).toEqual({ text: line, problem: true });
  });

  it("leaves the line alone for an operational wake, which answers nobody", async () => {
    const f = setup({ silent: true });
    await f.agent.converse("how is the alpha coming along?");
    await toolsOf(f.specs).get("emit_card")?.execute("c1", note("alpha", "The alpha is cut"));
    await finish(f);
    notifyProse(f.db, f.agent, "[fm-op] a crewmate reported", "agent");
    await drained(f.session, 2);
    await toolsOf(f.specs).get("emit_card")?.execute("c2", note("report", "A crewmate reported"));
    await finish(f);
    expect(heard(f)).toEqual([
      "busy:true",
      "reply:The alpha is cut",
      "busy:false",
      "busy:true",
      "busy:false",
    ]);
    expect(f.tasks.capture.lastTurn()?.reply).toEqual({
      text: "The alpha is cut",
      eligibility: "completed",
    });
  });
});
