/**
 * A task's title past its room (the captain's question why a card title
 * read cut off, when INF-3676 showed "...cards on a vi"; docs/task-record.md,
 * "A task's title"): an author's title is refused naming the room and its
 * length, and a title the host makes ends on its last whole word.
 */
import { describe, expect, it } from "vitest";
import { savedTaskTitle, shortTaskTitle, TASK_TITLE_MAX, taskTitleRefusal } from "./taskTitle";

// The words INF-3676 was filed with; the record saved their first 64, "...on a vi".
const FILED = "Name the first mate's computer in its timeline and cards on a view";

describe("a task's title", () => {
  it("refuses an author's title past the room, naming the room and its length", () => {
    expect(FILED.length).toBeGreaterThan(TASK_TITLE_MAX);
    const refusal = taskTitleRefusal(FILED);
    expect(refusal).toContain(`${FILED.length} characters`);
    expect(refusal).toContain(`at most ${TASK_TITLE_MAX}`);
    expect(taskTitleRefusal(FILED.slice(0, TASK_TITLE_MAX))).toBeUndefined();
    expect(taskTitleRefusal("Name the first mate's computer in timelines")).toBeUndefined();
  });

  it("ends a host title on its last whole word, marked, and leaves one that fits as it is", () => {
    const short = shortTaskTitle(FILED);
    expect(short).toBe("Name the first mate's computer in its timeline and cards on a…");
    expect(short.length).toBeLessThanOrEqual(TASK_TITLE_MAX);
    // What it keeps is FILED up to a space: no word is cut.
    const kept = short.slice(0, -1);
    expect(FILED.startsWith(`${kept} `)).toBe(true);

    expect(shortTaskTitle("  Review:   Correct the meter  ")).toBe("Review: Correct the meter");
    // The record keeps a fitting title exactly as given.
    expect(savedTaskTitle("Correct  the meter")).toBe("Correct  the meter");
    expect(savedTaskTitle(`Review: ${FILED}`)).toBe(shortTaskTitle(`Review: ${FILED}`));
  });

  it("cuts inside only a first word longer than the room", () => {
    const path = "src/renderer/src/design/core/TaskFacts.tsx#RecordAttentionAndDeliveredRows";
    expect(path.length).toBeGreaterThan(TASK_TITLE_MAX);
    expect(shortTaskTitle(`${path} reads cut off`)).toBe(`${path.slice(0, TASK_TITLE_MAX - 1)}…`);
  });
});
