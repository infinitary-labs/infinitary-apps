import { describe, expect, it } from "vitest";
import {
  drained,
  fakeClockEachTest,
  notifyProse,
  setup,
  tick,
  toolsOf,
} from "../../../tests/helpers/firstmateHarness";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";

fakeClockEachTest();

/**
 * INF-6091 finding 1, the captain's pick "Start a task now to build it": on
 * Nov 21 the first mate started INF-6050 26 seconds before the captain
 * answered its own card asking whether to start it. The first mate's start
 * of a task its own open decision still asks about waits for the captain.
 * The fixture follows that day: a filed follow-up, a decision filed as its
 * own record naming it and the running task it came from, and the start
 * from an operational wake that carries none of the captain's words.
 */
describe("FirstmateAgent start held by its own open card", () => {
  const followUp = "Remove the App Store Connect key the signing job leaves";
  const decision = {
    title: "Each alpha leaves your App Store Connect key on the Mac",
    body: "<p>Every alpha cut leaves the notarization key in the Mac's home folder.</p>",
    actions: [
      { id: "start-fix", label: "Start the fix now", default: true },
      { id: "leave", label: "Leave it in the backlog" },
    ],
  };

  async function cardUp() {
    const f = setup({
      silent: true,
      seedTasks: [
        {
          id: "origin",
          title: "Stop an alpha cut soon after its first failed check",
          status: "running",
        },
      ],
    });
    await f.agent.converse("what did the alpha cut review find?");
    const tools = toolsOf(f.specs);
    await tools.get("create_task")?.execute("file", {
      title: followUp,
      goal: "The signing job removes the key it writes when the job ends.",
      user_words: "what did the alpha cut review find?",
    });
    const task = f.tasks.list().find((row) => row.title === followUp);
    if (!task) throw new Error("No follow-up.");
    await tools.get("emit_card")?.execute("ask", { ...decision, related: [task.key, "origin"] });
    const card = f.supervisor.cards.snapshot().find((shown) => shown.title === decision.title);
    if (!card) throw new Error("No card.");
    f.session.emitTurnEnd("Asked.");
    f.session.resolveNextPrompt();
    await tick();
    return { ...f, tools, task, card };
  }

  const startNow = async (f: Awaited<ReturnType<typeof cardUp>>) =>
    (await f.tools.get("update_task")?.execute("start", { task: f.task.key, start_now: true }))
      ?.content[0]?.text;

  /** The Nov 21 turn: an operational wake carrying none of the captain's words. */
  const reportWake = async (f: Awaited<ReturnType<typeof cardUp>>) => {
    notifyProse(
      f.db,
      f.agent,
      "[fm-op] crewmate 1 reported on task origin: done.",
      "crewmate-report",
      "origin",
    );
    await drained(f.session, 2);
  };

  it("refuses the start from a wake while the card waits, naming the card", async () => {
    const f = await cardUp();
    await reportWake(f);
    const text = await startNow(f);
    expect(text).toContain(`Not started: your open card "${decision.title}" (${f.card.id})`);
    expect(f.tasks.get(f.task.id)?.status).toBe("open");
    expect(f.tasks.starts.startAttemptOf(f.task.id)).toBeFalsy();
  });

  // The review's finding: when-ready lets the ready sweep start it at once.
  it("refuses setting it to start when ready from a wake while the card waits", async () => {
    const f = await cardUp();
    await reportWake(f);
    const text = (
      await f.tools
        .get("update_task")
        ?.execute("ready", { task: f.task.key, start_policy: "when-ready", blocked_by: [] })
    )?.content[0]?.text;
    expect(text).toContain(`Not set to start when ready: your open card "${decision.title}"`);
    expect(text).toContain("Soft hold card-question");
    await tick();
    expect(f.tasks.get(f.task.id)?.status).toBe("open");
    expect(f.tasks.get(f.task.id)?.startPolicy).not.toBe("when-ready");
    expect(f.tasks.starts.startAttemptOf(f.task.id)).toBeFalsy();
  });

  // The review's second finding: removing the last wait lets the ready sweep start it.
  it("refuses removing the last wait of when-ready work from a wake while the card waits", async () => {
    const f = await cardUp();
    await f.agent.converse("let the key fix wait for the alpha cut work");
    await f.tools.get("update_task")?.execute("wait", {
      task: f.task.key,
      start_policy: "when-ready",
      blocked_by: ["origin"],
    });
    f.session.emitTurnEnd("It waits.");
    f.session.resolveNextPrompt();
    await tick();
    await reportWake(f);
    const text = (
      await f.tools.get("link_tasks")?.execute("unwait", {
        from: "origin",
        to: f.task.key,
        type: "blocks",
        remove: true,
      })
    )?.content[0]?.text;
    expect(text).toContain(`Wait not removed: your open card "${decision.title}"`);
    await tick();
    expect(f.tasks.graph.blockers(f.task.id).map((row) => row.id)).toEqual(["origin"]);
    expect(f.tasks.get(f.task.id)?.status).toBe("open");
    expect(f.tasks.starts.startAttemptOf(f.task.id)).toBeFalsy();
  });

  // The takeover review's settled finding: on batched pull requests an approved
  // wait counts as answered once needs_merge stops naming it, or once
  // start_at_approval names it, so either edit lets the ready sweep start it.
  it("refuses an approval edit that ends every wait of when-ready work from a wake while the card waits", async () => {
    const f = setup({
      silent: true,
      seedTasks: [
        {
          id: "origin",
          title: "Stop an alpha cut soon after its first failed check",
          status: "running",
        },
      ],
    });
    await f.agent.converse("what did the alpha cut review find?");
    const tools = toolsOf(f.specs);
    const batched = (id: string, title: string, repoId: string | null, shape = {}) =>
      f.tasks.create({
        id,
        title,
        prompt: title,
        repoId,
        startPolicy: "on-request",
        shape: { kind: "implement", delivery_ask: "queue-pr", ...shape },
      });
    // The signing work the key fix waits on, approved to merge in the next batch.
    const approved = (id: string, title: string, repoId: string | null) => {
      const task = batched(id, title, repoId);
      seedDelivery(f.tasks, task.id, {
        mergeAuthorization: {
          version: 1,
          id: `approval-${id}`,
          generation: 1,
          issuer: "captain",
          at: 1,
          card: { id: `merge-card-${id}`, offerId: `offer-${id}`, actionId: "merge" },
          target: {
            repoId: repoId ?? "r1",
            host: "github.com",
            owner: "example",
            name: "nimbus-api",
            branch: `inf/${id}-a1b2`,
            delivery: "direct-pr",
            method: "squash",
          },
          approvedHead: "0f3c9a1e4b7d2c6a8e5f1b3d9c7a2e4f6b8d0c1a",
          proceedWithOpen: false,
          status: "standing",
          lineage: [],
        },
      });
      return task;
    };
    const signing = approved("signing", "Sign each alpha with the kept key", null);
    const guide = approved("guide", "Publish the signing guide", "site-repo");
    // Each set to start when ready before the card went up, waiting until its work merges:
    // the key fix needs the signing work merged, and the guide sits in another project.
    const keyFix = batched("key-fix", followUp, null, { needs_merge: [signing.id] });
    const docs = batched("docs", "Document the signing cleanup", null);
    for (const [blocker, waiter] of [
      [signing, keyFix],
      [guide, docs],
    ] as const) {
      f.tasks.graph.link(blocker.id, waiter.id, "blocks", "firstmate");
      f.tasks.updateFields(waiter.id, { startPolicy: "when-ready" }, "firstmate");
    }
    await tools.get("emit_card")?.execute("ask", { ...decision, related: [keyFix.id, docs.id] });
    const card = f.supervisor.cards.snapshot().find((shown) => shown.title === decision.title);
    if (!card) throw new Error("No card.");
    f.session.emitTurnEnd("Asked.");
    f.session.resolveNextPrompt();
    await tick();
    const waits = (id: string) => f.tasks.graph.waitingOn(id).map((row) => row.id);
    const edit = async (id: string, params: Record<string, unknown>) =>
      (await tools.get("update_task")?.execute("edit", { task: id, ...params }))?.content[0]?.text;
    const held = `Not updated, since the edit ends every wait of work set to start when ready: your open card "${decision.title}" (${card.id})`;
    // The ready sweep's claim of the task: the host's own starting line. The stand-in
    // workspace cannot build on an approved base, so a claimed start goes no further.
    const claimed = (id: string) =>
      f.tasks
        .timeline(id)
        .some(
          (event) => event.actor === "host" && event.kind === "status" && event.text === "starting",
        );
    await reportWake({ ...f, tools, task: keyFix, card });

    expect(await edit(keyFix.id, { needs_merge: [] })).toContain(held);
    const refused = await edit(docs.id, { start_at_approval: guide.id, priority: 1 });
    expect(refused).toContain(held);
    expect(refused).toContain("Soft hold card-question");
    await tick();
    // Nothing changed: each still waits, and neither started.
    expect(f.tasks.get(keyFix.id)?.shape?.needs_merge).toEqual([signing.id]);
    expect(f.tasks.get(docs.id)?.shape?.start_at_approval).toBeUndefined();
    expect(f.tasks.get(docs.id)?.priority).not.toBe(1);
    expect(waits(keyFix.id)).toEqual([signing.id]);
    expect(waits(docs.id)).toEqual([guide.id]);
    for (const id of [keyFix.id, docs.id]) {
      expect(f.tasks.get(id)?.status).toBe("open");
      expect(claimed(id)).toBe(false);
    }

    // The captain's typed words lift the hold, and the same edit lets the ready sweep start it.
    await f.agent.converse("the key fix only needs the signing code, start it");
    expect(await edit(keyFix.id, { needs_merge: [] })).toContain(`Updated ${keyFix.key}`);
    await tick();
    expect(claimed(keyFix.id)).toBe(true);
  });

  // The captain's pick on the review: "Only your typed words, or your answer on that card".
  it("keeps the hold when the turn carries only a click on another card", async () => {
    const f = await cardUp();
    await f.agent.converse("anything else waiting on me?");
    await f.tools.get("emit_card")?.execute("other", {
      title: "Your panel layout has two options",
      body: "<p>The panel can sit on the left or the right.</p>",
      actions: [
        { id: "left", label: "Keep it on the left", default: true },
        { id: "right", label: "Move it to the right" },
      ],
    });
    const other = f.supervisor.cards.snapshot().find((shown) => shown.id !== f.card.id);
    if (!other) throw new Error("No second card.");
    f.session.emitTurnEnd("Asked.");
    f.session.resolveNextPrompt();
    await tick();
    f.supervisor.cardActions.act(other.id, "left");
    await drained(f.session, 3);
    expect(await startNow(f)).toContain(`Not started: your open card "${decision.title}"`);
    expect(f.tasks.get(f.task.id)?.status).toBe("open");
  });

  // The captain's pick on the takeover's review: "Also wait until your first mate has read your choice".
  it("holds a start in the running turn until the first mate reads the captain's choice on the card", async () => {
    const f = await cardUp();
    await reportWake(f);
    // The captain chooses while that turn runs: the card leaves the stack at the click,
    // and the choice waits on the first mate's lane for the turn after.
    f.supervisor.cardActions.act(f.card.id, "leave");
    await tick();
    expect(f.supervisor.cards.get(f.card.id)).toBeUndefined();
    const text = await startNow(f);
    expect(text).toContain(
      `Not started: the captain chose on your card "${decision.title}" (${f.card.id})`,
    );
    expect(text).toContain("Soft hold card-question");
    expect(f.tasks.get(f.task.id)?.status).toBe("open");
    expect(f.tasks.starts.startAttemptOf(f.task.id)).toBeFalsy();

    // The next turn carries the choice; once the first mate has read it, nothing holds the start.
    f.session.emitTurnEnd("Noted the report.");
    f.session.resolveNextPrompt();
    await drained(f.session, 3);
    expect(f.session.prompts[2]).toContain("Leave it in the backlog");
    expect(await startNow(f)).not.toContain("Not started");
    expect(f.tasks.get(f.task.id)?.status).toBe("active");
  });

  it("starts once the captain chooses on the card", async () => {
    const f = await cardUp();
    f.supervisor.cardActions.act(f.card.id, "start-fix");
    await drained(f.session, 2);
    expect(await startNow(f)).not.toContain("Not started");
    expect(f.tasks.get(f.task.id)?.status).toBe("active");
  });

  it("starts on the captain's own words while the card is still up", async () => {
    const f = await cardUp();
    await f.agent.converse("go ahead and start the key fix");
    expect(await startNow(f)).not.toContain("Not started");
    expect(f.tasks.get(f.task.id)?.status).toBe("active");
  });
});
