import { describe, expect, it, vi } from "vitest";
import {
  decodeContext,
  drained,
  fakeClockEachTest,
  setup,
} from "../../../tests/helpers/firstmateHarness";

// the product spawns runs at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

fakeClockEachTest();

/**
 * The project filter line (INF-6860, the captain's "are you aware of the
 * project filter i set at the top of the desktop app?" and their answers:
 * scope new work, answers and actions, naming what it left out; a phone
 * message covers every project).
 */
describe("the project filter on a first mate input", () => {
  it("names the project, the order that decides a message's project, and the scope", async () => {
    const { agent, session, tasks } = setup();
    const scratch = tasks.projects.scratch();
    void agent.converse({ text: "fix the login bug", projectFilter: { project: scratch.id } });
    await drained(session, 1);
    const k = scratch.key;
    expect(decodeContext(session.prompts[0] as string).project_filter).toBe(
      `${k} "${scratch.name}" - the project filter at the top of the captain's window. What decides a message's project, strongest first: a project, repository or task their words name; the card they replied under; the shown record or card; this filter. Where nothing stronger names one, new work goes in ${k}, answers cover ${k}'s work and say how much waits elsewhere, and actions on many tasks act on ${k}'s alone and name what they left out. Say in a few words when the filter decided something they did not say. Never change the filter; only the captain does`,
    );
  });

  it("says All projects out loud", async () => {
    const { agent, session } = setup();
    void agent.converse({ text: "what's waiting on me?", projectFilter: "all" });
    await drained(session, 1);
    expect(decodeContext(session.prompts[0] as string).project_filter).toBe(
      "All projects - the project filter at the top of the captain's window shows every project, so nothing narrows new work, answers or actions",
    );
  });

  it("says a phone message came from the phone, which shows every project", async () => {
    const { agent, session } = setup();
    void agent.converse({ text: "what's waiting on me?", projectFilter: "phone" });
    await drained(session, 1);
    expect(decodeContext(session.prompts[0] as string).project_filter).toBe(
      "every project - the captain's latest message came from their phone, which has no project filter and shows every project, so nothing narrows new work, answers or actions",
    );
  });

  it("hears the filter a reply under its card came with, and keeps it for a message saying none", async () => {
    const f = setup();
    const scratch = f.tasks.projects.scratch();
    f.supervisor.addFirstmateCard({
      title: "Pick one",
      body: "<p>A or B.</p>",
      actions: [{ id: "a", label: "A", default: true }],
    });
    const cardId = f.supervisor.cards.snapshot()[0]?.id ?? "";
    f.supervisor.cardActions.replyFromView(cardId, "the second one", undefined, {
      project: scratch.id,
    });
    await drained(f.session, 1);
    expect(decodeContext(f.session.prompts[0] as string).project_filter).toContain(
      `${scratch.key} "${scratch.name}" - the project filter`,
    );
    f.session.emitTurnEnd("Started.");
    f.session.resolveNextPrompt();
    await vi.waitFor(() => expect(f.agent.isBusy()).toBe(false));
    // Ask again and the Crewmate tab's line send no filter of their own.
    void f.agent.converse({ text: "and file the other one" });
    await drained(f.session, 2);
    expect(decodeContext(f.session.prompts[1] as string).project_filter).toContain(
      `${scratch.key} "${scratch.name}" - the project filter`,
    );
  });

  it("drops the filter for a window message that names none", async () => {
    const f = setup();
    const scratch = f.tasks.projects.scratch();
    void f.agent.converse({ text: "fix the login bug", projectFilter: { project: scratch.id } });
    await drained(f.session, 1);
    f.session.emitTurnEnd("Filed.");
    f.session.resolveNextPrompt();
    await vi.waitFor(() => expect(f.agent.isBusy()).toBe(false));
    void f.agent.converse({ text: "and the signup bug", projectFilter: null });
    await drained(f.session, 2);
    expect(decodeContext(f.session.prompts[1] as string).project_filter).toBeUndefined();
  });
});
