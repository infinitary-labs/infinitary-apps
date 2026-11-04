import type { RequiredAction } from "@shared/requiredActions";
import { describe, expect, it } from "vitest";
import { openInMemoryDatabase } from "../storage/db";
import { seedTask } from "./seedTask";
import { TaskService } from "./taskService";

/**
 * Correcting a required action's words (INF-2214's approved second piece,
 * carried out by INF-2225; docs/required-actions.md "Correcting the words").
 * The captain approved that wrong words stay correctable with who corrected
 * them and why, and that a correction changes only the selected
 * requirement's words: its target, ids, source, prerequisites, completion
 * and state stay, the generation moves only on a real change, and a
 * completed action refuses. The words are DOP-217's: a remover path the
 * captain could not find.
 */

const REMOVER = "C:\\FleetCheckSetup\\shell-pc-job-host-remove.cmd";

const removal = (overrides: Partial<RequiredAction> = {}): RequiredAction => ({
  id: "remove-job-host",
  target: "the shell PC",
  title: "Remove the job host from the shell PC",
  consequence: "Until then the old job host keeps taking fleet checks on that PC.",
  instructions: ["Run C:\\FleetCheck\\remove-job-host.cmd as an administrator."],
  criterion: "The PC no longer lists the job host service.",
  prerequisites: [],
  completion: { kind: "manual", label: "I removed it" },
  ...overrides,
});

function setup() {
  const db = openInMemoryDatabase();
  let at = 1_000;
  const tasks = new TaskService({ db, strict: true, now: () => at });
  const file = (source: string, actions: RequiredAction[]) => {
    seedTask(tasks, { id: source, title: `Source ${source}`, status: "completed" });
    tasks.declareRequiredActions(
      source,
      { cardId: `card-${source}-1`, offerId: `offer-${source}`, actions },
      true,
    );
  };
  const row = () => {
    const found = tasks.listOpen().find((task) => task.delivery?.captainAction);
    if (!found) throw new Error("no required action");
    return found;
  };
  const by = { actor: "crewmate" as const, taskId: "helper", label: "the crewmate on INF-9" };
  const correct = (
    input: Partial<Parameters<TaskService["reviseRequiredAction"]>[1]> & { generation: number },
  ) =>
    tasks.reviseRequiredAction(row().id, {
      source: "dop208",
      actionId: "remove-job-host",
      expectedGeneration: input.generation,
      patch: { instructions: [`Run ${REMOVER} as an administrator.`] },
      reason: "The remover lives under FleetCheckSetup",
      operationId: "op-1",
      sameAction: true,
      by,
      presented: false,
      ...input,
    });
  return {
    tasks,
    file,
    row,
    correct,
    later: () => {
      at += 1_000;
    },
  };
}

describe("correcting a required action's words", () => {
  it("changes only the named requirement's words, records who and why, and moves the generation once", () => {
    const f = setup();
    f.file("dop208", [removal({ sharedId: "shell-pc" })]);
    f.file("dop210", [
      removal({ id: "restart-pc", title: "Restart the shell PC", sharedId: "shell-pc" }),
    ]);
    const before = f.row().delivery?.captainAction;
    expect(before?.requirements).toHaveLength(2);
    const generation = before?.generation ?? 0;
    f.later();

    const result = f.correct({ generation });
    expect(result).toMatchObject({
      effect: "revised",
      generation: generation + 1,
      changed: ["instructions"],
    });
    const after = f.row().delivery?.captainAction;
    expect(after?.generation).toBe(generation + 1);
    expect(after?.state).toBe(before?.state);
    const [corrected, other] = after?.requirements ?? [];
    const [was, untouched] = before?.requirements ?? [];
    expect(corrected).toEqual({
      ...was,
      action: { ...was?.action, instructions: [`Run ${REMOVER} as an administrator.`] },
      corrections: [
        {
          operationId: "op-1",
          actor: "crewmate",
          taskId: "helper",
          label: "the crewmate on INF-9",
          at: 2_000,
          reason: "The remover lives under FleetCheckSetup",
          generation: generation + 1,
          previous: { instructions: was?.action.instructions },
        },
      ],
    });
    expect(other).toEqual(untouched);
    expect(f.tasks.timeline(f.row().id).at(-1)?.text).toBe(
      "the crewmate on INF-9 corrected the required action's instructions: The remover lives under FleetCheckSetup",
    );
  });

  it("keeps a deferred or blocked action's state, and an older confirmation no longer completes it", () => {
    const f = setup();
    f.file("dop208", [removal()]);
    const id = f.row().id;
    f.tasks.presentCaptainAction(id);
    f.tasks.deferCaptainAction(id);
    const generation = f.row().delivery?.captainAction?.generation ?? 0;
    f.correct({ generation, presented: true });
    expect(f.row().delivery?.captainAction).toMatchObject({
      state: "deferred",
      generation: generation + 1,
      presentedGeneration: generation + 1,
    });
    expect(f.tasks.completeCaptainAction(id, generation, "confirmed")).toBe(false);
    expect(f.row().status).toBe("open");

    const g = setup();
    seedTask(g.tasks, { id: "pc-online", title: "Bring the PC online", status: "running" });
    g.file("dop208", [removal({ prerequisites: ["pc-online"] })]);
    const blocked = g.row().delivery?.captainAction;
    expect(blocked?.state).toBe("blocked");
    g.correct({ generation: blocked?.generation ?? 0 });
    expect(g.row().delivery?.captainAction).toMatchObject({
      state: "blocked",
      requirements: [{ action: { prerequisites: ["pc-online"] } }],
    });
    expect(g.tasks.blockers(g.row().id).map((task) => task.id)).toEqual(["pc-online"]);
  });

  it("refuses a stale generation, a different action and a completed action, writing nothing", () => {
    const f = setup();
    f.file("dop208", [removal()]);
    const id = f.row().id;
    const generation = f.row().delivery?.captainAction?.generation ?? 0;
    const kept = JSON.stringify(f.row().delivery?.captainAction);

    expect(f.correct({ generation: generation + 5 })).toMatchObject({
      effect: "refused",
      generation,
    });
    expect(f.correct({ generation, sameAction: false })).toMatchObject({ effect: "refused" });
    expect(f.correct({ generation, actionId: "no-such-action" })).toMatchObject({
      effect: "refused",
    });
    expect(JSON.stringify(f.row().delivery?.captainAction)).toBe(kept);

    f.tasks.presentCaptainAction(id);
    expect(f.tasks.completeCaptainAction(id, generation, "confirmed")).toBe(true);
    const completed = f.tasks.reviseRequiredAction(id, {
      source: "dop208",
      actionId: "remove-job-host",
      expectedGeneration: generation,
      patch: { instructions: ["Other words."] },
      reason: "Late",
      operationId: "op-late",
      sameAction: true,
      by: { actor: "firstmate", label: "your first mate" },
      presented: false,
    });
    expect(completed).toMatchObject({ effect: "refused" });
    if (completed.effect === "refused") expect(completed.refusal).toContain("already completed");
    expect(f.tasks.get(id)?.delivery?.captainAction?.requirements[0]?.action.instructions).toEqual(
      removal().instructions,
    );
  });

  it("leaves the generation alone for the same words, and answers a repeated operation with its first correction", () => {
    const f = setup();
    f.file("dop208", [removal()]);
    const generation = f.row().delivery?.captainAction?.generation ?? 0;
    expect(
      f.correct({ generation, patch: { instructions: removal().instructions } }),
    ).toMatchObject({ effect: "unchanged", generation });
    expect(f.row().delivery?.captainAction?.generation).toBe(generation);

    f.correct({ generation });
    const again = f.correct({ generation });
    expect(again).toMatchObject({
      effect: "repeated",
      generation: generation + 1,
      correction: { operationId: "op-1", generation: generation + 1 },
    });
    expect(f.row().delivery?.captainAction?.generation).toBe(generation + 1);
    expect(f.row().delivery?.captainAction?.requirements[0]?.corrections).toHaveLength(1);
  });
});
