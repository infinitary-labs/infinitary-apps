import { describe, expect, it, vi } from "vitest";
import {
  crewCard,
  decodeContext,
  drained,
  fakeClockEachTest,
  notifyProse,
  setup,
  tick,
  toolsOf,
} from "../../../tests/helpers/firstmateHarness";
import { pngImage } from "../../../tests/helpers/images";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { readTaskQueryText } from "../../../tests/helpers/taskQueryText";
import type { KnowledgeService } from "../knowledge/knowledgeService";
import { initOverflowDir, type MessageFile, withPastedFiles } from "../overflow";
import { LIST_PAGING_RESTART } from "../pi/taskTools";
import { FIRSTMATE_RECIPIENT, InboxStore } from "../storage/inboxStore";
import type { TaskSeed } from "../tasks/seedTask";
import { CAPTAIN_TURN_REF } from "./firstmateAgent";
import { captainTurn, type TypedWake } from "./wakes";

// This file chains real git and is not about the utility-QoS clamp, so what
// the product spawns runs at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

/** The first mate agent: capture (tests/helpers/firstmateHarness.ts). */
fakeClockEachTest();

/**
 * Capture (task-system P1, design section 6 and captain decision D1): every
 * captain turn opens an ask; the agent's tool calls attach it to the task
 * they act on; the host files whatever is left at turn end. Driven through
 * the real agent over a scripted session, the real TaskService and SQLite.
 */
describe("FirstmateAgent capture", () => {
  // INF-2010: the captain reported INF-1956 quoting unrelated prototype work.
  // Recorded calls: spawn the replacement, file prototype work, interrupt its
  // predecessor, then link the replacement. The read message is only about
  // prototypes; operational calls must carry their own attribution decision.
  it("keeps a mixed-turn measurement card on its own request through the served tools", async () => {
    const panelWords =
      "a few problems with the tasks panel in my current build: 1) it sometimes scrolls itself up. this is very disruptive when i'm trying to use the \"start\" button on hovering each row. what i want is i can click start on one row, then move to another row and click start there too. but because the panel scrolls it self, it makes that difficult; 2) scrolling through the task panel is still very laggy. we recently did a performance optimization for it, but not sure if it solves this or is it just not in my build yet; 3) when i started SSHH-50 and SSHH-51, for a brief moment they went back into the backlog section, and then went into working again by themselves. somethings' wrong with the lifecycle there.";
    const prototypeWords =
      "the \"you asked\" section is helpful, but it's current UI looks odd. something about its font type doesn't feel quite right. have opus prototype a few different treatment for me to decide";
    const { agent, session, specs, tasks, supervisor } = setup({
      seedTasks: [
        { id: "panel", title: "Fix tasks panel problems", status: "idle" },
        { id: "prior", title: "Measure task list latency", parentId: "panel", status: "idle" },
      ],
    });
    tasks.capture.openAsk({ id: "panel-ask", text: panelWords });
    tasks.capture.attachAsk("panel-ask", "panel", "tool:create_task");
    tasks.capture.closeAsk("panel-ask", "closed");
    await agent.converse(prototypeWords);
    const tools = toolsOf(specs);
    await tools.get("spawn_crewmate")?.execute("measure", {
      title: "Measure visible-app latency",
      goal: "Measure scrolling and typing in the visible app.",
      user_words: panelWords,
      parent: "panel",
      at_time: new Date(Date.now() + 60_000).toISOString(),
      ask_id: "",
    });
    const measurement = tasks.list().find((task) => task.title === "Measure visible-app latency");
    expect(measurement).toBeDefined();
    await tools.get("create_task")?.execute("prototype", {
      title: 'Restyle the "You asked" line',
      goal: "Prototype several treatments for the captain to choose.",
      user_words: prototypeWords,
    });
    const prototype = tasks.list().find((task) => task.title === 'Restyle the "You asked" line');
    expect(prototype).toBeDefined();
    await tools.get("interrupt_crewmate")?.execute("interrupt", {
      task_id: "prior",
      mode: "cancel",
      closing_sentence: "The measurement moves to its replacement.",
      ask_id: "",
    });
    await tools.get("link_tasks")?.execute("replace", {
      from: "prior",
      to: measurement?.id,
      type: "replaced-by",
      ask_id: "",
    });
    await tools.get("emit_card")?.execute("findings", {
      title: "Visible-app latency findings",
      task_id: measurement?.id,
      body: "<p>The hidden test does not establish the visible lag’s cause.</p>",
      ask_id: "",
    });
    const card = supervisor
      .cardsSnapshot()
      .find((card) => card.title === "Visible-app latency findings");
    expect(card?.asked?.text).toBe(panelWords);
    const quoted = (id: string) => {
      const line = tasks.capture.originAbout(id);
      return line && "text" in line ? line.text : undefined;
    };
    expect(quoted("prior")).toBe(panelWords);
    expect(quoted(prototype?.id ?? "")).toBe(prototypeWords);
    const request = tasks.capture.listAsks().find((ask) => ask.text === prototypeWords);
    expect(request?.taskId).toBe(prototype?.id);
    session.emitTurnEnd("Recorded both independent outcomes.");
    session.resolveNextPrompt();
    await tick();
  });

  // INF-2326, the captain: "when it comes from an automation, it should just
  // say it's ran by an automation and name which one". Work the first mate
  // files while answering an automation run, a click or a report keeps that
  // origin; with several read and none named, the host saves none.
  it("saves the automation run or report a filing answered as the work's origin", async () => {
    const { agent, session, specs, tasks, db } = setup({
      seedTasks: [{ id: "audit", title: "Audit tonight's alpha", status: "idle" }],
    });
    agent.notifyOp(
      {
        facts: {
          kind: "scheduled",
          prompt: "check every package for a newer version",
          catchUp: false,
          rule: { id: "r-night", name: "Nightly product audit" },
        },
      },
      "scheduled",
    );
    await tick();
    const tools = toolsOf(specs);
    await tools.get("create_task")?.execute("file", {
      title: "Check package versions",
      goal: "Every package is on its newest version.",
      user_words: "check every package for a newer version",
    });
    const filed = tasks.list().find((task) => task.title === "Check package versions");
    expect(tasks.capture.originAbout(filed?.id ?? "")).toMatchObject({
      kind: "automation",
      name: "Nightly product audit",
      through: 0,
    });
    session.emitTurnEnd("Filed the version check.");
    session.resolveNextPrompt();
    await tick();

    // Two wakes in one turn: a filing that names neither saves none, an
    // unread name is refused, and a named report leads on to its task.
    const inbox = new InboxStore(db);
    const report = {
      facts: {
        kind: "report",
        task: { id: "audit", title: "Audit tonight's alpha" },
        crewmate: "crewmate",
        excerpt: "Two journeys are slow.",
        filed: [],
        cards: [],
      },
    } as unknown as TypedWake;
    inbox.enqueueWake(FIRSTMATE_RECIPIENT, report, "crewmate-report", "audit");
    inbox.enqueueWake(
      FIRSTMATE_RECIPIENT,
      {
        facts: {
          kind: "scheduled",
          prompt: "review the queue",
          catchUp: false,
          rule: { id: "r-queue", name: "Queue review" },
        },
      },
      "scheduled",
    );
    agent.pokeInbox();
    await tick();
    await tools.get("create_task")?.execute("unnamed", {
      title: "Speed up the slow journeys",
      goal: "Both journeys run in their usual time.",
      user_words: "Two journeys are slow.",
    });
    const unnamed = tasks.list().find((task) => task.title === "Speed up the slow journeys");
    expect(tasks.timeline(unnamed?.id ?? "").some((event) => event.data?.origin)).toBe(false);
    await expect(
      tools.get("create_task")?.execute("unread", {
        title: "Something else",
        goal: "Nothing.",
        user_words: "review the queue",
        origin: "r-unknown",
      }),
    ).rejects.toThrow(/origin must name/);
    const audit = tasks.get("audit");
    await tools.get("create_task")?.execute("named", {
      title: "Read the slow journeys' logs",
      goal: "The cause of each slow journey is known.",
      user_words: "Two journeys are slow.",
      origin: audit?.key,
    });
    const named = tasks.list().find((task) => task.title === "Read the slow journeys' logs");
    expect(tasks.capture.originAbout(named?.id ?? "")).toEqual({
      kind: "from",
      at: audit?.createdAt,
      key: audit?.key,
      title: "Audit tonight's alpha",
    });
    session.emitTurnEnd("Filed the follow-ups.");
    session.resolveNextPrompt();
    await tick();
  });

  it("opens an ask per captain turn and lands a task_id note on that task as an answer", async () => {
    const { agent, session, specs, tasks } = setup({
      seedTasks: [{ id: "t1", title: "Add pagination", status: "running" }],
    });
    await agent.converse("how is pagination going?");
    // The roster names the task and its id, so the model can pass task_id.
    const context = decodeContext(session.prompts[0] as string);
    expect(context.crew).toContainEqual(
      expect.objectContaining({
        task_id: "t1",
        key: expect.stringMatching(/^SCR-\d+$/),
        status: "running",
        title: "Add pagination",
      }),
    );
    const [ask] = tasks.capture.listOpenAsks();
    expect(ask?.text).toBe("how is pagination going?");
    expect(ask?.taskId).toBeNull();

    const emit = toolsOf(specs).get("emit_card");
    await emit?.execute("c1", {
      title: "Pagination is under way",
      body: "<p>The crewmate is on the second endpoint.</p>",
      task_id: "t1",
    });
    const answered = tasks.timeline("t1").find((event) => event.kind === "answered");
    expect(answered?.text).toBe("Pagination is under way");
    expect(answered?.data?.body).toBe("<p>The crewmate is on the second endpoint.</p>");
    expect(tasks.capture.getAsk(ask?.id ?? "")?.taskId).toBe("t1");
    expect(tasks.capture.getAsk(ask?.id ?? "")?.attachedVia).toBe("tool:emit_card");

    session.emitTurnEnd("Answered.");
    session.resolveNextPrompt();
    await tick();
    expect(tasks.capture.getAsk(ask?.id ?? "")?.turnState).toBe("closed");
    expect(tasks.capture.listOpenAsks()).toEqual([]);
    // Attached to existing work: no question task of its own (D1).
    expect(tasks.list().filter((record) => record.kind === "question")).toHaveLength(0);
  });

  it("files a standalone note as its own closed question task", async () => {
    const { agent, session, specs, tasks, supervisor } = setup();
    await agent.converse("what does the port flag do?");
    const emit = toolsOf(specs).get("emit_card");
    const shown = await emit?.execute("c1", {
      title: "The port flag",
      body: "<p>It picks the listening port.</p>",
      standalone: true,
    });
    const cardId = shown?.content[0]?.text?.match(/\((card-fm-[^)]+)\)/)?.[1] ?? "";
    const question = tasks.list().find((record) => record.kind === "question");
    expect(question?.status).toBe("done");
    expect(question?.closedReason).toBe("answered");
    expect(question?.title).toBe("The port flag");
    expect(question?.outcome).toBe("<p>It picks the listening port.</p>");
    expect(question?.projectId).toBe("scratch");
    const raised = tasks.timeline(question?.id ?? "").find((e) => e.kind === "card_raised");
    expect(raised?.ref).toBe(cardId);
    const [ask] = tasks.capture.listAsks();
    expect(ask?.taskId).toBe(question?.id);
    expect(ask?.attachedVia).toBe("tool:emit_card");
    // The card itself carries no task id: a question task is the record of
    // the answer, not a settle target for the card's buttons.
    expect(supervisor.cardsSnapshot()[0]?.taskId).toBeUndefined();
    // Revising the same card keeps its row and updates the answer.
    await emit?.execute("c2", {
      id: cardId,
      title: "The port flag",
      body: "<p>It picks the listening port; default 3000.</p>",
      standalone: true,
    });
    expect(tasks.list().filter((record) => record.kind === "question")).toHaveLength(1);
    expect(tasks.get(question?.id ?? "")?.outcome).toContain("default 3000");
    session.emitTurnEnd("Answered.");
    session.resolveNextPrompt();
    await tick();
  });

  it("refuses a note that names no task and asserts nothing, and an unknown task_id", async () => {
    const { agent, specs, supervisor, tasks } = setup();
    await agent.converse("tell me something");
    const emit = toolsOf(specs).get("emit_card");
    await expect(emit?.execute("c1", { title: "A fact", body: "Something." })).rejects.toThrow(
      /every card is about a task/,
    );
    await expect(
      emit?.execute("c2", { title: "A fact", body: "Something.", task_id: "nope" }),
    ).rejects.toThrow(/unknown task_id "nope"/);
    expect(supervisor.cardsSnapshot()).toHaveLength(0);
    expect(tasks.list()).toHaveLength(0);
  });

  it("a decision without a task becomes an open decision task the captain's choice closes", async () => {
    const { agent, session, specs, tasks, supervisor, events } = setup();
    await agent.converse("should we ship now or wait?");
    const emit = toolsOf(specs).get("emit_card");
    const shown = await emit?.execute("c1", {
      title: "Ship now or wait",
      body: "<p>The fix is ready to ship now.</p><ul><li>The release train leaves at noon.</li></ul>",
      actions: [
        { id: "ship-now", label: "Ship now", default: true },
        { id: "wait", label: "Wait for the train" },
      ],
    });
    const cardId = shown?.content[0]?.text?.match(/\((card-fm-[^)]+)\)/)?.[1] ?? "";
    const decision = tasks.list().find((record) => record.kind === "decision");
    expect(decision?.status).toBe("open");
    expect(decision?.gate).toEqual({ kind: "captain", ref: cardId });
    expect(tasks.capture.listAsks()[0]?.taskId).toBe(decision?.id);
    // On screen, it is waiting on the captain - not a strip count.
    expect(supervisor.crewCounts()).toEqual({ working: 0, idle: 0, queued: 0 });
    session.emitTurnEnd("Asked.");
    session.resolveNextPrompt();
    await tick();

    // The card carries exactly the two declared actions: nothing parks it
    // and nothing brings it back (cards/tasks/agents P0, WI-1).
    const shownCard = supervisor.cardsSnapshot().find((card) => card.id === cardId);
    expect(shownCard?.actions.map((action) => action.id)).toEqual(["wait", "ship-now"]);
    expect(tasks.list().filter((record) => record.id.startsWith("park-"))).toHaveLength(0);

    supervisor.act(cardId, "ship-now");
    const closed = tasks.get(decision?.id ?? "");
    expect(closed?.status).toBe("done");
    expect(closed?.closedReason).toBe("answered");
    const kinds = tasks.timeline(decision?.id ?? "").map((event) => event.kind);
    // The turn that raised it recorded its decision (R2) before the choice closed it.
    expect(kinds).toEqual(["created", "card_raised", "ask", "decided", "status"]);
    expect(tasks.timeline(decision?.id ?? "").at(-1)?.text).toBe('chose "Ship now"');
    // The choice still reaches the agent as it always did.
    expect(events.some((event) => event.type === "firstmate_state")).toBe(true);
  });

  it("INF-1879: explicit Dismiss drops a decision task; putting it away does not, and withdrawal supersedes", async () => {
    const { agent, session, specs, tasks, supervisor } = setup();
    await agent.converse("two questions");
    const emit = toolsOf(specs).get("emit_card");
    const close = toolsOf(specs).get("close_card");
    const first = await emit?.execute("c1", {
      id: "fm-first",
      title: "First choice",
      body: "<p>Pick A.</p><ul><li>B also works.</li></ul>",
      actions: [
        { id: "b", label: "B" },
        { id: "a", label: "A", default: true },
      ],
    });
    const second = await emit?.execute("c2", {
      id: "fm-second",
      title: "Second choice",
      body: "<p>Pick C.</p><ul><li>D also works.</li></ul>",
      actions: [
        { id: "d", label: "D" },
        { id: "c", label: "C", default: true },
      ],
    });
    const firstId = first?.content[0]?.text?.match(/\((card-fm-[^)]+)\)/)?.[1] ?? "";
    const secondId = second?.content[0]?.text?.match(/\((card-fm-[^)]+)\)/)?.[1] ?? "";
    supervisor.close(firstId);
    const firstQuestion = tasks.capture.openDecisionFor(firstId)!;
    expect(firstQuestion.status).toBe("open");
    expect(supervisor.cardsSnapshot().find((card) => card.id === firstId)).toMatchObject({
      minimized: true,
    });
    expect(supervisor.runTaskOp(firstQuestion.id, "dismiss-question")).toBeUndefined();
    await close?.execute("c3", { card_id: secondId, reason: "moot" });
    const rows = tasks.list().filter((record) => record.kind === "decision");
    expect(rows.map((row) => [row.status, row.closedReason])).toEqual([
      ["dropped", "cancelled"],
      ["dropped", "superseded"],
    ]);
    session.emitTurnEnd("Done.");
    session.resolveNextPrompt();
    await tick();
  });

  it("falls back to the on-screen card's task, and names it in the about line", async () => {
    const { agent, session, tasks } = setup({
      seedTasks: [{ id: "t1", title: "Add pagination", status: "idle" }],
      seedCards: [crewCard("card-crew-1", "t1", "Pagination landed", "Both endpoints paginate.")],
    });
    await agent.converse({ text: "and the tests?", visibleCardId: "card-crew-1" });
    expect(decodeContext(session.prompts[0] as string).about).toMatch(
      /SCR-\d+ "Add pagination" \(idle\) - task_id t1/,
    );
    session.emitTurnEnd("They pass.");
    session.resolveNextPrompt();
    await tick();
    const [ask] = tasks.capture.listAsks();
    expect(ask?.hintTaskId).toBe("t1");
    expect(ask?.taskId).toBe("t1");
    expect(ask?.attachedVia).toBe("host:fallback");
    expect(tasks.timeline("t1").filter((event) => event.kind === "ask")).toHaveLength(1);
    expect(tasks.list().filter((record) => record.kind === "question")).toHaveLength(0);
  });

  it("takes an explicit task hint on the turn (the record card) the same way", async () => {
    const { agent, session, tasks } = setup({
      seedTasks: [{ id: "t1", title: "Add pagination", status: "idle" }],
    });
    await agent.converse({ text: "how did this go?", taskId: "t1" });
    expect(session.prompts[0]).toContain("- task_id t1; the open card points at it");
    session.emitTurnEnd("Fine.");
    session.resolveNextPrompt();
    await tick();
    expect(tasks.capture.listAsks()[0]?.taskId).toBe("t1");
  });

  it("files a question task with the turn's closing text when nothing attached", async () => {
    const { agent, session, tasks } = setup();
    await agent.converse("hello there");
    session.emitTurnEnd("All quiet on deck.");
    session.resolveNextPrompt();
    await tick();
    const question = tasks.list().find((record) => record.kind === "question");
    expect(question?.title).toBe("hello there");
    expect(question?.outcome).toBe("All quiet on deck.");
    expect(question?.closedReason).toBe("answered");
    const [ask] = tasks.capture.listAsks();
    expect(ask?.taskId).toBe(question?.id);
    expect(ask?.attachedVia).toBe("host:fallback");
    expect(ask?.turnState).toBe("closed");
  });

  it("an operate tool files an operation task in Scratch and attaches the ask", async () => {
    const { agent, session, specs, tasks } = setup();
    await agent.converse("remember that I always squash-merge");
    const remember = toolsOf(specs).get("record_knowledge");
    const noted = await remember?.execute("m1", {
      action: "publish",
      request_id: "m1",
      kind: "concept",
      lane: "personal",
      title: "Squash merges",
      text: "The captain always squash-merges when landing work.",
    });
    const operation = tasks.list().find((record) => record.kind === "operation");
    expect(operation?.title).toBe("Knowledge publish: Squash merges");
    expect(operation?.status).toBe("done");
    expect(operation?.closedReason).toBe("settled");
    expect(operation?.outcome).toBe(noted?.content[0]?.text);
    expect(operation?.projectId).toBe("scratch");
    expect(tasks.capture.listAsks()[0]?.taskId).toBe(operation?.id);
    expect(tasks.capture.listAsks()[0]?.attachedVia).toBe("tool:record_knowledge");
    session.emitTurnEnd("Noted.");
    session.resolveNextPrompt();
    await tick();
    expect(tasks.list().filter((record) => record.kind === "question")).toHaveLength(0);
  });

  it("a message's pictures stay with the task it starts, and ride a steer it causes", async () => {
    const { agent, session, specs, supervisor, tasks } = setup({
      silent: true,
      seedTasks: [
        { id: "t1", title: "Add pagination", status: "idle", sessionFile: "/tmp/t1.jsonl" },
      ],
    });
    const commission = vi.spyOn(supervisor, "commission");
    const steer = vi.spyOn(supervisor, "steerCrewmate").mockResolvedValue("mid-turn");
    // INF-1389 friction 3 also carries complete text files before ask capture attaches the spawn.
    initOverflowDir(scratchDir("infinitary-firstmate-files-"));
    const messageFiles: MessageFile[] = [];
    const text = withPastedFiles(
      "fix this dialog, and tell pagination",
      [{ name: "notes.txt", text: "The dialog cannot open.\r\n" }],
      messageFiles,
    );
    await agent.converse({ text, images: [pngImage], messageFiles });
    const [kept] = tasks.capture.listAsks()[0]?.attachments ?? [];
    expect(kept).toMatchObject({ mimeType: "image/png", bytes: expect.any(Number) });
    const tools = toolsOf(specs);
    const started = await tools.get("spawn_crewmate")?.execute("s1", {
      title: "Fix the dialog",
      goal: "The dialog in the picture is fixed.",
      user_words: "fix this dialog",
    });
    const taskId = started?.content[0]?.text?.match(/task (\w{8})/)?.[1] ?? "";
    // The brief goes out with the message's pictures, before the message attaches.
    expect(commission.mock.calls[0]?.[0]).toMatchObject({ attachments: [kept], messageFiles });
    expect(tasks.capture.messageFiles(taskId)).toEqual(messageFiles);
    expect(tasks.capture.pictures(taskId)).toEqual([kept]);
    await tools.get("steer_crewmate")?.execute("s2", { task_id: "t1", message: "see the dialog" });
    expect(steer.mock.calls[0]?.[3]).toMatchObject({ images: [pngImage], attachments: [kept] });
    expect(tasks.capture.pictures("t1")).toEqual([kept]);
    session.emitTurnEnd("On it.");
    session.resolveNextPrompt();
    await tick();
  });

  it("a spawn attaches the ask to the task it created", async () => {
    const { agent, session, specs, tasks } = setup();
    await agent.converse("queue up the flaky test fix for later");
    const spawn = toolsOf(specs).get("spawn_crewmate");
    const queued = await spawn?.execute("s1", {
      title: "Fix the flaky test",
      goal: "Make the flaky test deterministic.",
      user_words: "queue up the flaky test fix for later",
      at_time: new Date(Date.now() + 60_000).toISOString(),
    });
    const taskId = queued?.content[0]?.text?.match(/Queued task (\w+)/)?.[1] ?? "";
    expect(tasks.get(taskId)?.kind).toBe("work");
    expect(tasks.capture.listAsks()[0]?.taskId).toBe(taskId);
    expect(tasks.capture.listAsks()[0]?.attachedVia).toBe("tool:spawn_crewmate");
    const askEvent = tasks.timeline(taskId).find((event) => event.kind === "ask");
    expect(askEvent?.text).toBe("queue up the flaky test fix for later");
    session.emitTurnEnd("Queued.");
    session.resolveNextPrompt();
    await tick();
  });

  it("a steer, an interrupt and a settle attach to the task they name", async () => {
    const { agent, session, specs, tasks } = setup({
      seedTasks: [
        { id: "t1", title: "Add pagination", status: "idle" },
        { id: "t2", title: "Fix the flaky test", status: "idle" },
      ],
    });
    await agent.converse("stop the flaky-test work and finish pagination");
    const settle = toolsOf(specs).get("settle_task");
    const interrupt = toolsOf(specs).get("interrupt_crewmate");
    await interrupt?.execute("i1", {
      task_id: "t2",
      mode: "cancel",
      closing_sentence: "The captain stopped the flaky-test work.",
    });
    await settle
      ?.execute("s1", { task_id: "t1", mode: "finish", closing_sentence: "Pagination is done." })
      .catch(() => undefined);
    const [ask] = tasks.capture.listAsks();
    expect(ask?.taskId).toBe("t2");
    expect(ask?.attachedVia).toBe("tool:interrupt_crewmate");
    expect(tasks.timeline("t1").some((event) => event.kind === "ask")).toBe(true);
    session.emitTurnEnd("Done.");
    session.resolveNextPrompt();
    await tick();
    expect(tasks.list().filter((record) => record.kind === "question")).toHaveLength(0);
  });

  it("an operational wake opens no ask and files no question", async () => {
    const { agent, db, session, tasks } = setup({
      seedTasks: [{ id: "t1", title: "Add pagination", status: "idle" }],
    });
    notifyProse(
      db,
      agent,
      '[fm-op] crewmate 1 reported on task t1 "Add pagination": done.',
      "crewmate-report",
      "t1",
    );
    await tick();
    expect(session.prompts).toHaveLength(1);
    expect(tasks.capture.listAsks()).toEqual([]);
    session.emitTurnEnd("Noted.");
    session.resolveNextPrompt();
    await tick();
    expect(tasks.capture.listAsks()).toEqual([]);
    expect(tasks.list().filter((record) => record.kind === "question")).toHaveLength(0);
  });

  it("a failed turn that keeps no words for a retry marks the ask failed and still files it", async () => {
    const { agent, session, tasks } = setup();
    await agent.converse("ship it");
    session.rejectNextPrompt("mock provider exploded");
    await tick();
    const [ask] = tasks.capture.listAsks();
    expect(ask?.turnState).toBe("failed");
    const question = tasks.get(ask?.taskId ?? "");
    expect(question?.kind).toBe("question");
    expect(question?.outcome).toContain("hit a problem:");
    expect(question?.outcome).toContain("mock provider exploded");
  });

  it("keeps a message a provider-failed turn read open, for the retry turn that answers it", async () => {
    const { agent, session, specs, supervisor, tasks } = setup({ silent: true });
    await agent.converse("count the fenders");
    session.emitTurnFailed("mock provider exploded");
    session.resolveNextPrompt();
    await tick();
    // Its words wait on the lane beside the failure card: nothing is filed yet.
    const [ask] = tasks.capture.listAsks();
    expect(ask).toMatchObject({ turnState: "open", taskId: null });
    expect(tasks.list().filter((record) => record.kind === "question")).toEqual([]);
    supervisor.act("card-fm-turn-failure", "retry-firstmate");
    await drained(session, 2);
    expect(session.prompts[1]).toContain("[user]\ncount the fenders");
    await toolsOf(specs).get("emit_card")?.execute("c1", {
      title: "Twelve fenders",
      body: "<p>Six a side.</p>",
      standalone: true,
    });
    session.emitTurnEnd("Answered.");
    session.resolveNextPrompt();
    await tick();
    // The retry that answered it files it, once, with its own answer.
    expect(tasks.capture.getAsk(ask?.id ?? "")).toMatchObject({
      turnState: "closed",
      attachedVia: "tool:emit_card",
    });
    expect(tasks.list().filter((record) => record.kind === "question")).toMatchObject([
      { title: "Twelve fenders", outcome: "<p>Six a side.</p>" },
    ]);
  });

  it("leaves a message a quit cut mid-turn to the next boot, which says the app closed (FI3-1711)", async () => {
    const before = setup({ silent: true });
    await before.agent.converse("How is the crew doing?");
    // The quit lets go of the session, which settles the cut turn as if it ended.
    before.agent.dispose();
    before.session.resolveNextPrompt();
    await tick();
    expect(before.tasks.capture.listAsks()).toMatchObject([{ turnState: "open", taskId: null }]);
    expect(before.tasks.list().filter((record) => record.kind === "question")).toEqual([]);
    const after = setup({ silent: true, db: before.db });
    expect(after.tasks.capture.listAsks()).toMatchObject([{ turnState: "failed" }]);
    expect(after.tasks.list().filter((record) => record.kind === "question")).toMatchObject([
      {
        title: "How is the crew doing?",
        outcome: "hit a problem: the app closed before this turn ended",
      },
    ]);
  });

  it("starts no turn from a drain a quit cut while it waited, and leaves its words on the lane (FI3-1747)", async () => {
    const f = setup();
    await f.agent.converse("How is the crew doing?");
    f.session.emitTurnEnd("Steady.");
    f.session.resolveNextPrompt();
    await tick();
    const inbox = new InboxStore(f.db);
    inbox.enqueue(
      FIRSTMATE_RECIPIENT,
      captainTurn("And the meter fix?", false),
      CAPTAIN_TURN_REF,
      "captain",
    );
    // The drain reads the lane, then waits on the seat and the instructions on disk.
    f.agent.pokeInbox();
    // The quit lands while it waits.
    f.agent.dispose();
    await tick();
    expect(f.session.prompts).toHaveLength(1);
    expect(inbox.inFlight(FIRSTMATE_RECIPIENT)).toEqual([]);
    expect(inbox.pending(FIRSTMATE_RECIPIENT, Date.now()).map((row) => row.origin)).toEqual([
      "captain",
    ]);
  });

  it("a steer mid-turn opens a second ask; both land when the turn ends", async () => {
    const { agent, session, tasks } = setup();
    await agent.converse("first question");
    await agent.converse("second, unrelated");
    expect(tasks.capture.listOpenAsks().map((ask) => ask.text)).toEqual([
      "first question",
      "second, unrelated",
    ]);
    session.emitTurnEnd("Both answered in passing.");
    session.resolveNextPrompt();
    await tick();
    expect(tasks.capture.listOpenAsks()).toEqual([]);
    expect(tasks.capture.listAsks().every((ask) => ask.taskId !== null)).toBe(true);
    expect(tasks.list().filter((record) => record.kind === "question")).toHaveLength(2);
  });

  it("keeps a message whose words wait on the lane open across a restart, for the turn that reads it", async () => {
    // The last process parked the captain's words for a turn of their own -
    // they landed as a turn closed - and quit before that turn read them.
    const words = "is the flaky login test fixed yet?";
    const { agent, session, specs, tasks } = setup({
      beforeBoot: ({ db, tasks }) => {
        const ask = tasks.capture.openAsk({ id: "waiting", text: words });
        new InboxStore(db).enqueue(
          FIRSTMATE_RECIPIENT,
          captainTurn(words, false, undefined, ask.id),
          CAPTAIN_TURN_REF,
          "captain",
        );
      },
    });
    // Booting files nothing for it: no turn has read it yet.
    expect(tasks.capture.getAsk("waiting")).toMatchObject({ turnState: "open", taskId: null });
    expect(tasks.list().filter((record) => record.kind === "question")).toEqual([]);
    agent.pokeInbox();
    await drained(session, 1);
    expect(session.prompts[0]).toContain(`[user]\n${words}`);
    await toolsOf(specs).get("emit_card")?.execute("c1", {
      title: "The login test is fixed",
      body: "<p>It passed ten runs in a row.</p>",
      standalone: true,
    });
    session.emitTurnEnd("Answered.");
    session.resolveNextPrompt();
    await tick();
    // The turn that read it attached and closed it, with its own answer.
    expect(tasks.capture.getAsk("waiting")).toMatchObject({
      turnState: "closed",
      attachedVia: "tool:emit_card",
    });
    expect(tasks.list().filter((record) => record.kind === "question")).toMatchObject([
      { title: "The login test is fixed", outcome: "<p>It passed ten runs in a row.</p>" },
    ]);
  });

  it("files a message refused before any turn alone, and leaves a waiting one to its own turn", async () => {
    const { agent, session, specs, tasks, db, knowledge } = setup();
    notifyProse(db, agent, "[fm-op] PR #12 checks passed", "agent");
    await drained(session, 1);
    // The captain's words land as the wake turn closes: parked, unread.
    session.holdSteers();
    await agent.converse("is the flaky login test fixed yet?");
    const [waiting] = tasks.capture.listOpenAsks();
    // Standing directions cannot be read: the drain holds the parked words,
    // and the next message is refused before any turn.
    const unreadable = vi
      .spyOn(knowledge as KnowledgeService, "availability")
      .mockReturnValue({ state: "unavailable", reason: "The folder could not be read." });
    session.emitTurnEnd("Showed the PR.");
    session.resolveNextPrompt();
    await tick();
    await agent.converse("and the alpha?");
    expect(tasks.capture.getAsk(waiting?.id ?? "")).toMatchObject({
      turnState: "open",
      taskId: null,
    });
    expect(tasks.list().filter((record) => record.kind === "question")).toMatchObject([
      { title: "and the alpha?" },
    ]);
    unreadable.mockRestore();
    agent.pokeInbox();
    await drained(session, 2);
    await toolsOf(specs).get("emit_card")?.execute("c1", {
      title: "The login test is fixed",
      body: "<p>It passed ten runs in a row.</p>",
      standalone: true,
    });
    session.emitTurnEnd("Answered.");
    session.resolveNextPrompt();
    await tick();
    expect(tasks.capture.getAsk(waiting?.id ?? "")).toMatchObject({
      turnState: "closed",
      attachedVia: "tool:emit_card",
    });
  });

  // INF-1712: the roster lists started work; the backlog is a count, and
  // every unstarted row is reachable by lookup, past the first page too.
  it("counts unstarted work in the backlog, lists none of it, and pages to every row", async () => {
    const seedTasks: TaskSeed[] = [];
    for (let index = 0; index < 15; index += 1) {
      seedTasks.push({ id: `w${index}`, title: `Work ${index}`, status: "queued" });
    }
    const { agent, session, specs, tasks } = setup({ seedTasks });
    // A chatty day: closed one-offs are in neither the roster nor the count.
    for (let index = 0; index < 5; index += 1) {
      tasks.capture.fileQuestion({
        id: `q${index}`,
        title: `Question ${index}`,
        outcome: "answered",
      });
    }
    await agent.converse("what is open?");
    const context = decodeContext(session.prompts[0] ?? "");
    expect(context.crew ?? []).toEqual([]);
    expect(context.backlog?.projects).toEqual([
      expect.objectContaining({ project: "SCR", unstarted: 15 }),
    ]);
    const served = JSON.stringify(context);
    expect(served).not.toContain("Work ");
    expect(served).not.toContain("Question ");

    const query = toolsOf(specs).get("tasks");
    const nextOf = (text: string | undefined) =>
      /More: read with next "([^"]+)" for the next page\./.exec(text ?? "")?.[1];
    const first = (await query?.execute("q1", { status: "open", limit: 10 }))?.content[0]?.text;
    expect(first).toContain("10 of 15 matching tasks");
    const next = nextOf(first);
    expect(next).toBeDefined();
    // INF-1746 R6: work filed between pages sorts first in the live order;
    // the next page reads the list as it stood, so no row repeats or drops.
    tasks.create({ id: "late", title: "Late work", prompt: "Late work", repoId: null });
    const second = (await query?.execute("q2", { status: "open", limit: 10, next }))?.content[0]
      ?.text;
    expect(second).toContain("5 of 15 matching tasks");
    expect(nextOf(second)).toBeUndefined();
    // Each page still parses as a task read, as a crewmate's paging reads it.
    const read = new Set(
      [first, second].flatMap((text) => readTaskQueryText(text ?? "").map((row) => row.task_id)),
    );
    expect(read.size).toBe(15);
    expect(second).not.toContain("Late work");
    const again = (await query?.execute("q3", { status: "open", limit: 10 }))?.content[0]?.text;
    expect(again).toContain("10 of 16 matching tasks");
    // INF-1746 R6: a next whose cut is no longer kept is refused rather
    // than read from the live order.
    const stale = (await query?.execute("q4", { status: "open", limit: 10, next }))?.content[0]
      ?.text;
    expect(stale).toBe(LIST_PAGING_RESTART);
    expect(
      (await query?.execute("q5", { status: "open", next: nextOf(again) }))?.content[0]?.text,
    ).toContain("6 of 16 matching tasks");
    session.emitTurnEnd("Listed.");
    session.resolveNextPrompt();
    await tick();
  });
});
