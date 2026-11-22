import { describe, expect, it } from "vitest";
import {
  drained,
  fakeClockEachTest,
  notifyProse,
  setup,
  tick,
  toolsOf,
} from "../../../tests/helpers/firstmateHarness";

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

  it("refuses the start from a wake while the card waits, naming the card", async () => {
    const f = await cardUp();
    notifyProse(
      f.db,
      f.agent,
      "[fm-op] crewmate 1 reported on task origin: done.",
      "crewmate-report",
      "origin",
    );
    await drained(f.session, 2);
    const text = await startNow(f);
    expect(text).toContain(`Not started: your open card "${decision.title}" (${f.card.id})`);
    expect(f.tasks.get(f.task.id)?.status).toBe("open");
    expect(f.tasks.starts.startAttemptOf(f.task.id)).toBeFalsy();
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
