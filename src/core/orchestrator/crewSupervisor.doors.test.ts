/**
 * The doors callers take into the crew supervisor's card stack and its
 * settling, pinned at the caller (INF-2625's plan, the crew supervisor's
 * first step: its card and settle forwards go, and every caller reaches
 * the card service and the settle owners directly). Each case drives a
 * production caller - the first mate's tools, the window's card channels,
 * the ready sweep - and reads what it did to the record and the stack, so
 * a caller wired to the wrong owner method fails here, not only in the
 * type check. None calls a forward the step deletes.
 */
import type { Card } from "@shared/cards";
import { describe, expect, it, vi } from "vitest";
import { firstmateSeat, toolsCrew } from "../../../tests/helpers/firstmateTools";
import type { CoreServices } from "../coreServices";
import { createCoreDispatcher } from "../dispatcher";
import type { HostCapabilities } from "../host";
import type { BoundTool } from "../session/tools";
import { seedTask } from "../tasks/seedTask";

/** A supervisor over an in-memory record with no first mate attached, and the window's dispatch over it. */
function crew(saved: Card[] = []) {
  const { supervisor, tasks } = toolsCrew(saved);
  // The window's card channels read only the supervisor and the event sink.
  const dispatch = createCoreDispatcher({
    services: { supervisor, broadcastEvent: () => {} } as unknown as CoreServices,
    // Showing a card is a catalog action, which reads the app's health first.
    host: { app: { version: "0.0.0-test", platform: "darwin" } } as unknown as HostCapabilities,
    emit: () => {},
  });
  return { supervisor, tasks, dispatch };
}

/** A first mate note saved on the stack, as an earlier run left it. */
function savedNote(id: string, title: string): Card {
  return {
    id,
    author: "firstmate",
    priority: 1,
    title,
    meta: "",
    body: `<p>${title}.</p>`,
    actions: [],
    status: "ready",
    createdAt: 1_000,
  };
}

function toolOf(tools: BoundTool[], name: string): BoundTool {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`the first mate has no ${name}`);
  return tool;
}

/** A tool's answer, less the read time open_work stamps on its first line. */
async function said(tool: BoundTool, params: Record<string, unknown>): Promise<string> {
  const { text } = await tool.run(params as never);
  return text.replace(/^read_at: .*\n/, "");
}

describe("the first mate's settle_task reaches the close each mode names", () => {
  it("closes an internal step's answer as answered", async () => {
    const { tools, tasks } = await firstmateSeat();
    seedTask(tasks, {
      id: "meter-answer",
      title: "Explain the meter",
      status: "completed",
      outcome: "It reads kilowatt-hours.",
      shape: {
        kind: "plan",
        kind_source: "classifier:test",
        deliverable: "answer",
        internal_step: true,
      },
    });
    expect(
      await said(toolOf(tools, "settle_task"), { task_id: "meter-answer", mode: "answered" }),
    ).toBe('Closed SCR-1 "Explain the meter" as answered: its crewmate reported the answer.');
    expect(tasks.get("meter-answer")).toMatchObject({ status: "done", closedReason: "answered" });
  });

  it("answers a change each mode's own refusal, and leaves it open", async () => {
    const refusals: Record<string, string> = {
      released:
        'Cannot close SCR-1 "Fix the meter" as released: its working copy is unavailable; check the work before closing it.',
      finished:
        'Cannot close SCR-1 "Fix the meter" as finished: this mode is for an operation or work built in place, not an answer or a change to merge.',
      "merge-pr": "Cannot merge: task meter-fix does not deliver as a pull request.",
      answered:
        'Cannot close SCR-1 "Fix the meter" as answered: it delivers a change, not an answer - merge it, land it, or discard it instead.',
    };
    for (const [mode, refusal] of Object.entries(refusals)) {
      const { tools, tasks } = await firstmateSeat();
      seedTask(tasks, {
        id: "meter-fix",
        title: "Fix the meter",
        status: "completed",
        outcome: "Fixed.",
      });
      expect(
        await said(toolOf(tools, "settle_task"), {
          task_id: "meter-fix",
          mode,
          closing_sentence: "The meter is fixed.",
          completion_evidence: "The meter test passes.",
          release_evidence: "Version 1.2 is published.",
        }),
      ).toBe(refusal);
      expect(tasks.get("meter-fix")?.status).toBe("active");
    }
  });
});

describe("the first mate reads and changes cards through its tools", () => {
  it("open_work reads an open card, the same card once closed, a row never on the stack and an unknown id", async () => {
    const { tools, cardStore } = await firstmateSeat();
    const openWork = toolOf(tools, "open_work");
    expect(
      await said(toolOf(tools, "emit_card"), {
        id: "meter-plan",
        title: "The meter reads kWh",
        body: "<p>The meter reads kilowatt-hours.</p>",
        standalone: true,
      }),
    ).toBe("Card shown: The meter reads kWh (card-fm-meter-plan)");
    const open = JSON.parse(await said(openWork, { card: "card-fm-meter-plan" }));
    expect(open).toMatchObject({
      card_id: "card-fm-meter-plan",
      from: "firstmate",
      title: "The meter reads kWh",
      state: "open",
      body: "<p>The meter reads kilowatt-hours.</p>",
      messages: [],
    });
    expect(open).not.toHaveProperty("thread");
    expect(open.waits_on).toEqual(expect.any(String));

    await toolOf(tools, "close_card").run({ card_id: "card-fm-meter-plan", reason: "answered" });
    expect(JSON.parse(await said(openWork, { card: "card-fm-meter-plan" }))).toMatchObject({
      card_id: "card-fm-meter-plan",
      state: "closed",
      from: "firstmate",
      title: "The meter reads kWh",
      body: "<p>The meter reads kilowatt-hours.</p>",
    });

    // A row the stack never loaded and nothing resolved: kept, with no ending.
    cardStore.upsert(savedNote("card-fm-unshown", "Never shown"));
    expect(await said(openWork, { card: "card-fm-unshown" })).toBe(
      "Card card-fm-unshown has no saved ending.",
    );
    expect(await said(openWork, { card: "card-nowhere" })).toBe("No card card-nowhere.");
  });

  it("update_task corrects a required action's words on its card under the same id", async () => {
    const { tools, tasks, supervisor, cardStore } = await firstmateSeat();
    seedTask(tasks, { id: "retire-host", title: "Retire the job host", status: "completed" });
    tasks.delivery.declareRequiredActions(
      "retire-host",
      {
        cardId: "card-retire-host-1",
        offerId: "offer-1",
        actions: [
          {
            id: "remove-job-host",
            target: "the shell PC",
            title: "Remove the job host from the shell PC",
            consequence: "Until then the old job host keeps taking fleet checks on that PC.",
            instructions: ["Run the remover in the FleetCheck folder as an administrator."],
            criterion: "The PC no longer lists the job host service.",
            prerequisites: [],
            completion: { kind: "manual", label: "I removed it" },
          },
        ],
      },
      true,
    );
    // The ready sweep puts the required action's card up.
    await supervisor.watch.sweepGates(Date.now());
    const shown = cardStore.listOpen();
    expect(shown).toHaveLength(1);
    const cardId = shown[0]?.id ?? "";
    expect(shown[0]?.body).toContain("FleetCheck folder");

    const text = await said(toolOf(tools, "update_task"), {
      task: cardId,
      revise_required_action: {
        source: "retire-host",
        action_id: "remove-job-host",
        expected_generation: 1,
        patch: {
          instructions: ["Run the remover in the FleetCheckSetup folder as an administrator."],
        },
        reason: "The remover lives under FleetCheckSetup",
        operation_id: "op-1",
        same_action: true,
      },
    });
    expect(text).toContain(
      `Revised card "Remove the job host from the shell PC" (${cardId}) as your first mate.`,
    );
    const cards = cardStore.listOpen();
    expect(cards.map((card) => card.id)).toEqual([cardId]);
    expect(cards[0]?.body).toContain(
      "Run the remover in the FleetCheckSetup folder as an administrator.",
    );
    expect(cards[0]?.body).toContain(
      "Corrected by your first mate: The remover lives under FleetCheckSetup",
    );
  });
});

describe("the window's card channels reach the card stack", () => {
  it("records a sighting of the version shown and of its released update, each on its own", async () => {
    const { dispatch } = crew([savedNote("card-fm-meter", "The meter reads kWh")]);
    const shown = async () =>
      (await dispatch("inf:cards:list", [])).find((c) => c.id === "card-fm-meter");
    const first = await shown();
    expect(first).toMatchObject({ seen: false, currentUpdateSeen: false });
    await dispatch("inf:cards:seen", ["card-fm-meter", first?.offerId]);
    expect(await shown()).toMatchObject({ seen: true, currentUpdateSeen: false });
    // An update of another lifecycle is not this one's.
    await dispatch("inf:cards:seen-update", [
      "card-fm-meter",
      "an-earlier-lifecycle",
      first?.currentUpdateId,
    ]);
    expect(await shown()).toMatchObject({ currentUpdateSeen: false });
    await dispatch("inf:cards:seen-update", [
      "card-fm-meter",
      first?.lifecycleId,
      first?.currentUpdateId,
    ]);
    expect(await shown()).toMatchObject({ seen: true, currentUpdateSeen: true });
  });

  it("puts a card aside and brings it back", async () => {
    const { dispatch } = crew([savedNote("card-fm-meter", "The meter reads kWh")]);
    const listed = async () =>
      (await dispatch("inf:cards:list", [])).find((c) => c.id === "card-fm-meter");
    await dispatch("inf:cards:minimize", ["card-fm-meter", true]);
    expect((await listed())?.minimized).toBe(true);
    expect(await dispatch("inf:cards:show", ["card-fm-meter"])).toMatchObject({
      id: "card-fm-meter",
    });
    expect((await listed())?.minimized).toBeFalsy();
  });

  it("keeps the captain's reply on the card's thread", async () => {
    const { dispatch } = crew([savedNote("card-fm-meter", "The meter reads kWh")]);
    await dispatch("inf:cards:reply", ["card-fm-meter", "Which meters show watts?"]);
    expect(
      (await dispatch("inf:cards:thread", ["card-fm-meter"])).messages.map((line) => [
        line.who,
        line.text,
      ]),
    ).toEqual([["captain", "Which meters show watts?"]]);
  });

  // INF-2794: the close request only puts the note aside; its own button closes it.
  it("puts a note aside, closes it on its button and shows it again closed", async () => {
    const { dispatch } = crew([savedNote("card-fm-meter", "The meter reads kWh")]);
    expect(await dispatch("inf:cards:past", ["card-fm-meter"])).toBeNull();
    await dispatch("inf:cards:close", ["card-fm-meter"]);
    expect(
      (await dispatch("inf:cards:list", [])).find((card) => card.id === "card-fm-meter"),
    ).toMatchObject({ minimized: true });
    expect(await dispatch("inf:cards:past", ["card-fm-meter"])).toBeNull();
    await dispatch("inf:cards:note-done", ["card-fm-meter"]);
    expect((await dispatch("inf:cards:list", [])).map((card) => card.id)).not.toContain(
      "card-fm-meter",
    );
    const past = await dispatch("inf:cards:past", ["card-fm-meter"]);
    expect(past).toMatchObject({ id: "card-fm-meter", title: "The meter reads kWh" });
    expect(await dispatch("inf:cards:show", ["card-fm-meter"])).toEqual(past);
    await expect(dispatch("inf:cards:show", ["card-nowhere"])).rejects.toThrow(
      "No card card-nowhere.",
    );
  });
});

describe("the host's own steer", () => {
  it("is recorded as the supervisor's, through supervision, answering no message or card", async () => {
    const { supervisor, tasks } = crew();
    seedTask(tasks, {
      id: "checks-wait",
      title: "Wait for the checks",
      status: "idle",
      sessionFile: "/nowhere/checks-wait.jsonl",
    });
    tasks.placement.setGate("checks-wait", {
      kind: "at-time",
      until: Date.now() - 1_000,
      reason: "checks settle",
    });
    await supervisor.watch.sweepGates(Date.now());
    const steeredOf = () =>
      tasks.timeline("checks-wait").filter((event) => event.kind === "steered");
    // The steer rides the inbox, which delivers after the sweep returns.
    await vi.waitFor(() => expect(steeredOf()).toHaveLength(1));
    const steered = steeredOf();
    expect(steered[0]).toMatchObject({
      actor: "supervisor",
      // The wake's whole words are the crewmate words table's.
      text: expect.stringContaining("was waiting for has come (checks settle)."),
      data: { via: "supervision", decision: null, cardId: null },
    });
  });
});
