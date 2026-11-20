/**
 * Every path that saves a task title (the captain's question why a card
 * title read cut off, when INF-3676 showed "...cards on a vi", and the fix
 * the captain started; docs/task-record.md, "A task's title"). An author's
 * title past the room - the first mate's spawn, planned task or title edit,
 * a crewmate's follow-up or after-merge step - is refused naming the room and its length, and
 * nothing is saved; a title the host makes from longer words - a question
 * from the captain's message, an operation's words - is saved ending on a
 * whole word. Each case drives the supervisor's intake, the crewmate's own
 * follow-up tool or the record's own writers, and reads the record.
 */
import { AFTER_MERGE_TITLE_PREFIX } from "@shared/afterMerge";
import type { ChangePresentationDraft } from "@shared/changePresentation";
import { shortTaskTitle, TASK_TITLE_MAX, taskTitleRefusal } from "@shared/taskTitle";
import { describe, expect, it } from "vitest";
import {
  fakeCrewmate,
  fakeCrewTimersEachTest,
  intentOf,
  setup,
  tick,
} from "../../../tests/helpers/crewHarness";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { stageChangePresentation } from "../pi/changePresentation";
import { seedProject } from "../workspace/seedProject";
import { askTitle } from "./askCapture";

fakeCrewTimersEachTest();

// The words INF-3676 was filed with; the record saved their first 64, "...on a vi".
const FILED = "Name the first mate's computer in its timeline and cards on a view";

/** A crewmate on its first turn in "meter", with its follow-up tool bound. */
async function working() {
  const h = setup(fakeCrewmate());
  seedProject(h.db, {
    id: "meter",
    name: "meter",
    path: scratchDir("infinitary-meter-"),
    origin: "https://github.com/octo/meter.git",
    delivery: "direct-pr",
  });
  const { taskId } = await h.supervisor.intake.commission({
    title: "Correct the meter",
    intent: intentOf("make the meter count every press"),
    repoId: "meter",
  });
  await tick();
  const followup = h.specs.at(-1)?.onFollowup;
  if (!followup) throw new Error("the crewmate's follow-up tool is not bound");
  return { ...h, taskId, followup };
}

describe("a task title past its room", () => {
  it("is refused to its author, naming the room and its length, and nothing is saved", async () => {
    const h = await working();
    const refusal = taskTitleRefusal(FILED);
    if (!refusal) throw new Error("the fixture fits a title");
    const before = h.tasks.list().length;

    // The first mate's spawn_crewmate and create_task.
    await expect(
      h.supervisor.intake.commission({
        title: FILED,
        intent: intentOf("name the first mate's computer on a view"),
        repoId: "meter",
      }),
    ).rejects.toThrow(`Nothing was spawned. ${refusal}`);
    expect(() =>
      h.supervisor.intake.plan({
        title: FILED,
        intent: intentOf("name the first mate's computer on a view"),
        repoId: "meter",
      }),
    ).toThrow(`Nothing was filed. ${refusal}`);
    // The first mate's update_task.
    expect(() => h.tasks.updateFields(h.taskId, { title: FILED }, "firstmate")).toThrow(refusal);
    expect(h.tasks.get(h.taskId)?.title).toBe("Correct the meter");
    // A crewmate's file_followup.
    expect(() =>
      h.followup({
        title: FILED,
        goal: "A view names the first mate's computer in a task's timeline.",
        why: "The timeline still says this computer on a view.",
      }),
    ).toThrow(`Nothing was filed. ${refusal}`);
    expect(h.tasks.list()).toHaveLength(before);
    // A crewmate's after-merge step, whose task adds "Continue: " to its title.
    const room = TASK_TITLE_MAX - AFTER_MERGE_TITLE_PREFIX.length;
    const step = FILED.slice(0, TASK_TITLE_MAX - 4);
    expect(step.length).toBeGreaterThan(room);
    await expect(
      stageChangePresentation(
        {
          afterMerge: [
            {
              title: step,
              goal: "A view names the first mate's computer in a task's timeline.",
              why: "The timeline still says this computer on a view.",
            },
          ],
        } as unknown as ChangePresentationDraft,
        { taskId: h.taskId, worktree: h.paths.worktreesDir, dir: h.paths.worktreesDir },
      ),
    ).rejects.toThrow(
      `afterMerge step 1's title is ${step.length} characters, and it holds at most ${room}`,
    );

    // The same words said in the room are saved whole.
    const fits = FILED.slice(0, TASK_TITLE_MAX).replace(/ \S*$/, "");
    const filed = h.supervisor.intake.plan({
      title: fits,
      intent: intentOf("name the first mate's computer on a view"),
      repoId: "meter",
    });
    expect(filed.title).toBe(fits);
    expect(h.tasks.updateFields(h.taskId, { title: fits }, "firstmate")).toContain(
      `title "${fits}"`,
    );
  });

  it("the host makes from longer words ends on a whole word", async () => {
    const h = await working();
    // A captain's message whose first sentence is longer than a title holds.
    const asked =
      "Can you find out why the board shows the title of INF-3676 cut off in the middle of a word? It reads oddly.";
    const question = askTitle(asked);
    expect(question).toBe(shortTaskTitle(asked.slice(0, asked.indexOf("?") + 1)));
    expect(question.length).toBeLessThanOrEqual(TASK_TITLE_MAX);
    expect(asked.startsWith(`${question.slice(0, -1)} `)).toBe(true);

    // An operation's words, which the record's own create shortens.
    const words = `showed the earlier card "INF-3676's title was saved cut off at 64 characters"`;
    expect(words.length).toBeGreaterThan(TASK_TITLE_MAX);
    const row = h.tasks.capture.fileOperation({
      id: "op-title",
      title: words,
      outcome: words,
      tool: "app_change",
      actor: "captain",
    });
    expect(row.title).toBe(shortTaskTitle(words));
    expect(words.startsWith(`${row.title.slice(0, -1)} `)).toBe(true);
    expect(row.outcome).toBe(words);
  });
});
