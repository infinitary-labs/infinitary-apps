/**
 * A sub-task's brief carries only the captain's words for it (INF-1939
 * friction 5, the captain's checked improvement "A sub-task's brief carries
 * only your words for it; an inherited override shows as a labeled fact").
 * The audit found a bedtime instruction about merging one task opening the
 * briefs of two unrelated checks as "the user's words, verbatim". Each case
 * drives the first mate's door - spawn_crewmate's intent at the tool
 * boundary, then intake - and reads what the crewmate was served.
 */

import { inheritedOverrideWords } from "@shared/holds";
import { describe, expect, it, vi } from "vitest";
import {
  fakeCrewmate,
  fakeCrewTimersEachTest,
  intentOf,
  setup,
} from "../../../tests/helpers/crewHarness";
import { alreadyAllowed } from "../tasks/alreadyAllowed";
import { NO_WORDS_FOR_THIS_TASK, parseSpawnIntent } from "./intentBrief";

fakeCrewTimersEachTest();

const BEDTIME =
  "i'm going to bed. i want the sign-in fix autonomously merged without asking for me. if it runs into some problem, you need to drive it forward.";
const CHECK_GOAL =
  "Run the sign-in journey on untouched main and report whether its failure also happens there.";

describe("a sub-task's brief", () => {
  it("opens a step the first mate started with no words of the captain's as such, its goal standing in", async () => {
    const crewmate = fakeCrewmate();
    const h = setup(crewmate);
    await h.supervisor.intake.commission({
      title: "Check the sign-in journey on main",
      intent: parseSpawnIntent({ goal: CHECK_GOAL }),
    });
    await vi.waitFor(() => expect(crewmate.promptCalls).toHaveLength(1));
    const brief = crewmate.promptCalls[0] ?? "";
    expect(brief.startsWith(`${NO_WORDS_FOR_THIS_TASK}\n\nGoal: ${CHECK_GOAL}\n`)).toBe(true);
    expect(brief).not.toContain("The user's words, verbatim");
  });

  it("shows an override standing on the task it is part of as a labeled inherited fact that passes no hold here", async () => {
    const crewmate = fakeCrewmate();
    const h = setup(crewmate);
    const parent = h.supervisor.intake.plan({
      title: "Fix the sign-in check",
      intent: intentOf("fix the sign-in check"),
    });
    expect(
      h.supervisor.overrides.declareOverride(parent.id, {
        words: BEDTIME,
        holds: ["asks-first"],
        until: "task",
      }).ok,
    ).toBe(true);
    const { taskId } = await h.supervisor.intake.commission({
      title: "Check the sign-in journey on main",
      intent: parseSpawnIntent({ goal: CHECK_GOAL }),
      parent: parent.key,
    });
    await vi.waitFor(() => expect(crewmate.promptCalls).toHaveLength(1));
    const brief = crewmate.promptCalls[0] ?? "";
    const override = h.tasks.get(parent.id)?.delivery?.override;
    if (!override) throw new Error("the parent's override was not recorded");
    expect(brief).toContain(
      inheritedOverrideWords(override, { key: parent.key, title: "Fix the sign-in check" }),
    );
    // Never as this task's own ask, and never passing a hold on it.
    expect(brief.startsWith(NO_WORDS_FOR_THIS_TASK)).toBe(true);
    expect(brief).not.toContain("The user's words, verbatim");
    const child = h.tasks.get(taskId);
    if (!child) throw new Error("the sub-task was not recorded");
    expect(alreadyAllowed(h.tasks, child).override).toBeUndefined();
  });

  it("still opens with the captain's own words when they asked for the task", async () => {
    const crewmate = fakeCrewmate();
    const h = setup(crewmate);
    await h.supervisor.intake.commission({
      title: "Check the sign-in journey on main",
      intent: parseSpawnIntent({ goal: CHECK_GOAL, user_words: "check whether main fails too" }),
    });
    await vi.waitFor(() => expect(crewmate.promptCalls).toHaveLength(1));
    expect(crewmate.promptCalls[0]).toMatch(
      /^The user's words, verbatim - [^\n]*\ncheck whether main fails too\n\nGoal: /,
    );
  });
});
