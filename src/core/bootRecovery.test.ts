import type { FmEvent } from "@shared/events";
import { describe, expect, it } from "vitest";
import { interruptedJobNote, recoverAtBoot } from "./bootRecovery";
import { PANELS_SAFE_MODE_NOTE } from "./personal/panelLines";
import { openInMemoryDatabase } from "./storage/db";
import { FIRSTMATE_RECIPIENT, InboxStore, SUPERVISION_RECIPIENT } from "./storage/inboxStore";
import type { InterruptedJob } from "./storage/jobStore";

const titles: Record<string, string> = { "task-1": "Fix the login page" };
const titleOf = (taskId: string) => titles[taskId];

describe("interruptedJobNote", () => {
  it("says the first mate's job was stopped when the app quit, as a line with no task", () => {
    expect(
      interruptedJobNote(
        { ownerId: "firstmate", command: "pnpm test", stoppedByQuit: true },
        titleOf,
      ),
    ).toEqual({
      type: "firstmate_note",
      text: 'Your first mate\'s background job "pnpm test" was stopped when the app quit.',
    });
  });

  it("names a crewmate's task by its title and puts the line on that task", () => {
    expect(
      interruptedJobNote(
        { ownerId: "task-1", command: "pnpm build", stoppedByQuit: false },
        titleOf,
      ),
    ).toEqual({
      type: "firstmate_note",
      text: '"Fix the login page"\'s background job "pnpm build" was running when the app quit unexpectedly. It may have kept running, even to the end.',
      taskId: "task-1",
    });
  });

  it("names a task with no title by its id, and only the command's first 80 characters", () => {
    const command = `node ${"x".repeat(200)}`;
    const note = interruptedJobNote({ ownerId: "task-9", command, stoppedByQuit: true }, titleOf);
    expect(note.text).toBe(
      `"task-9"'s background job "${command.slice(0, 80)}" was stopped when the app quit.`,
    );
    expect(note.taskId).toBe("task-9");
  });
});

/** A boot with the crew's sweeps recorded in the order they ran. */
function boot(options: { enteredSafeMode: boolean; interrupted: InterruptedJob[] }) {
  const inbox = new InboxStore(openInMemoryDatabase(), { now: () => 5_000 });
  const happened: string[] = [];
  const events: FmEvent[] = [];
  return {
    inbox,
    happened,
    events,
    run: () =>
      recoverAtBoot({
        enteredSafeMode: options.enteredSafeMode,
        jobs: { reportInterrupted: () => options.interrupted },
        tasks: { get: (id) => (titles[id] ? ({ title: titles[id] } as never) : undefined) },
        supervisor: {
          reconcileCutOffs: () => void happened.push("cut-offs"),
          watch: {
            announceCarryOn: () => void happened.push("carry-on"),
            sweepInbox: async (now) => void happened.push(`inbox sweep at ${now}`),
            reconcileIdle: (now) => void happened.push(`idle sweep at ${now}`),
          },
        },
        inbox,
        now: () => 5_000,
        broadcastEvent: (event) => {
          events.push(event);
          happened.push(`line: ${event.type === "firstmate_note" ? event.text : event.type}`);
        },
      }),
  };
}

describe("recoverAtBoot", () => {
  it("says safe mode and each stranded job first, then hears cut-offs before the sweeps", () => {
    const { happened, run } = boot({
      enteredSafeMode: true,
      interrupted: [
        { ownerId: "firstmate", command: "pnpm test", stoppedByQuit: true },
        { ownerId: "task-1", command: "pnpm build", stoppedByQuit: false },
      ],
    });
    run();
    expect(happened).toEqual([
      `line: ${PANELS_SAFE_MODE_NOTE}`,
      'line: Your first mate\'s background job "pnpm test" was stopped when the app quit.',
      'line: "Fix the login page"\'s background job "pnpm build" was running when the app quit unexpectedly. It may have kept running, even to the end.',
      "cut-offs",
      "carry-on",
      "inbox sweep at 5000",
      "idle sweep at 5000",
    ]);
  });

  it("says nothing of safe mode or jobs on a launch that left neither", () => {
    const { events, happened, run } = boot({ enteredSafeMode: false, interrupted: [] });
    run();
    expect(events).toEqual([]);
    expect(happened).toEqual(["cut-offs", "carry-on", "inbox sweep at 5000", "idle sweep at 5000"]);
  });

  it("hands wakes parked on the retired supervision lane to the first mate", () => {
    const { inbox, run } = boot({ enteredSafeMode: false, interrupted: [] });
    const first = inbox.enqueue(SUPERVISION_RECIPIENT, "a crewmate reported");
    const second = inbox.enqueue(SUPERVISION_RECIPIENT, "a check finished");
    const own = inbox.enqueue(FIRSTMATE_RECIPIENT, "the captain asked");
    run();
    expect(inbox.allFor(SUPERVISION_RECIPIENT)).toEqual([]);
    expect(
      inbox
        .allFor(FIRSTMATE_RECIPIENT)
        .map((row) => row.id)
        .sort((a, b) => a - b),
    ).toEqual([first, second, own].sort((a, b) => a - b));
  });
});
