/**
 * A crewmate's session as the crew's session owner holds it (`CrewSessions`;
 * docs/helper.md, "Holding a conversation"): who holds a conversation's
 * files and when one is let go, which account's turns are running and what
 * disconnecting that account stops, the stop and cancel controls' edge
 * cases, and every task stopped when a computer that runs work is removed.
 * These cases pin the behaviour no other test reaches. Each drives a public
 * door of the owner and reads its answer, the crewmate's session and the
 * record.
 */

import { describe, expect, it, vi } from "vitest";
import {
  fakeCrewmate,
  intentOf,
  setup,
  tick,
  workComputer,
} from "../../../tests/helpers/crewHarness";
import { seedTask } from "../tasks/seedTask";
import type { TaskService } from "../tasks/taskService";

const MINI = "mini-device";
const AIR = "air-device";
const CODEX = { provider: "openai-codex", id: "gpt-6.1-sol" };

/** What the record says each stop or cancel did, in order. */
function interrupts(tasks: TaskService, taskId: string): unknown[] {
  return tasks
    .timeline(taskId)
    .filter((event) => event.kind === "interrupted")
    .map((event) => event.data?.effect);
}

/** The Mac mini that runs work, in reach or not, and its answer to "is that turn still running". */
function computer(fields: { ready: boolean; confirm?: (taskId: string) => Promise<boolean> }) {
  return workComputer(MINI, "Studio Mac mini", {
    ready: () => fields.ready,
    ...(fields.confirm ? { confirm: fields.confirm } : {}),
  });
}

describe("a crewmate's session, as CrewSessions holds it", () => {
  it("holds a live crewmate's conversation, and lets go of it only between turns", async () => {
    const crewmate = fakeCrewmate();
    const h = setup(crewmate);
    const { taskId } = await h.supervisor.intake.commission({
      title: "Count presses",
      intent: intentOf("make the meter count every press"),
    });
    await tick();

    expect(h.supervisor.sessions.conversationHeld(taskId)).toBe(true);
    expect(h.supervisor.sessions.conversationBusy(taskId)).toBe(true);
    expect(await h.supervisor.sessions.releaseConversation(taskId)).toBe(false);
    expect(h.supervisor.sessions.conversationHeld(taskId)).toBe(true);
    expect(crewmate.dispose).not.toHaveBeenCalled();

    crewmate.emit({ type: "turn_end", taskId });
    crewmate.finishPrompt();
    await tick();
    expect(h.supervisor.sessions.conversationBusy(taskId)).toBe(false);
    expect(await h.supervisor.sessions.releaseConversation(taskId)).toBe(true);
    expect(crewmate.dispose).toHaveBeenCalledTimes(1);
    expect(h.supervisor.sessions.conversationHeld(taskId)).toBe(false);
    // The task itself stays open: its next delivery resumes it from the saved conversation.
    expect(h.tasks.get(taskId)?.status).toBe("active");

    // Nothing holds a conversation no crewmate is running, so it is free at once.
    expect(h.supervisor.sessions.conversationHeld("t-none")).toBe(false);
    expect(await h.supervisor.sessions.releaseConversation("t-none")).toBe(true);
  });

  it("knows which account's turns are running, and disconnecting one stops only that account's crewmates", async () => {
    const first = fakeCrewmate();
    const second = fakeCrewmate({ sessionId: "s2" });
    const accountOf: Record<string, string> = {};
    const killJobs = vi.fn();
    const h = setup(first, {
      crewmates: [second],
      routedModel: CODEX,
      killJobs,
      accounts: {
        selectForSpawn: (taskId) => {
          accountOf[taskId] = Object.keys(accountOf).length === 0 ? "acct-work" : "acct-home";
          return accountOf[taskId];
        },
        reselectForResume: () => ({ changed: false }),
        labelOf: (accountId) => accountId,
      },
    });
    const work = await h.supervisor.intake.commission({
      title: "Count presses",
      intent: intentOf("make the meter count every press"),
    });
    await tick();
    const home = await h.supervisor.intake.commission({
      title: "Water the plants",
      intent: intentOf("remind me to water the plants"),
    });
    await tick();
    expect(accountOf).toEqual({ [work.taskId]: "acct-work", [home.taskId]: "acct-home" });

    expect(h.supervisor.sessions.accountHasActiveTurns("acct-work")).toBe(true);
    expect(h.supervisor.sessions.accountHasActiveTurns("acct-home")).toBe(true);
    expect(h.supervisor.sessions.accountHasActiveTurns("acct-other")).toBe(false);

    await h.supervisor.sessions.disconnectAccount("acct-work");
    expect(killJobs.mock.calls).toEqual([[work.taskId]]);
    expect(interrupts(h.tasks, work.taskId)).toEqual(["requested", "aborted-turn"]);
    expect(interrupts(h.tasks, home.taskId)).toEqual([]);
    expect(first.aborts).toHaveLength(1);
    expect(second.aborts).toHaveLength(0);
    // Disconnecting keeps the task and its history: it is stopped, not closed.
    expect(h.tasks.get(work.taskId)?.status).toBe("active");

    first.emit({ type: "turn_end", taskId: work.taskId });
    first.finishPrompt();
    await tick();
    expect(h.supervisor.sessions.accountHasActiveTurns("acct-work")).toBe(false);
    expect(h.supervisor.sessions.accountHasActiveTurns("acct-home")).toBe(true);
  });

  it("answers a stop and a cancel that find no running turn, and restores a cancel whose abort failed", async () => {
    const crewmate = fakeCrewmate();
    const h = setup(crewmate);
    await expect(h.supervisor.sessions.interruptCrewmate("t-none", "interrupt")).rejects.toThrow(
      'Unknown task "t-none".',
    );

    // A task a previous process left idle: a stop has no turn to stop, and the task stays open.
    seedTask(h.tasks, {
      id: "t-idle",
      title: "Tidy the meter",
      branch: "fm/task-t-idle",
      worktreeDir: "/work/t-idle",
      sessionFile: "/sessions/t-idle.jsonl",
      status: "idle",
    });
    await h.supervisor.sessions.interruptCrewmate("t-idle", "interrupt");
    expect(interrupts(h.tasks, "t-idle")).toEqual(["no-turn"]);
    expect(h.tasks.get("t-idle")?.status).toBe("active");

    // A cancel whose abort the session refuses leaves the task running, and says so.
    const { taskId } = await h.supervisor.intake.commission({
      title: "Count presses",
      intent: intentOf("make the meter count every press"),
    });
    await tick();
    crewmate.abort = vi.fn(async () => {
      throw new Error("the session is gone");
    });
    await expect(h.supervisor.sessions.interruptCrewmate(taskId, "cancel")).rejects.toThrow(
      "the session is gone",
    );
    expect(interrupts(h.tasks, taskId)).toEqual(["requested", "abort-failed"]);
    expect(h.supervisor.crewStatus(taskId)[0]?.status).toBe("running");
    expect(h.tasks.get(taskId)?.status).toBe("active");
    // Its turn ends as any turn does, never as the cancel that failed.
    crewmate.emit({ type: "turn_end", taskId });
    crewmate.finishPrompt();
    await tick();
    expect(h.tasks.get(taskId)?.status).toBe("active");
    expect(h.supervisor.sessions.conversationHeld(taskId)).toBe(true);
  });

  it("asks the computer a running turn is on whether it still runs after a stop", async () => {
    const crewmate = fakeCrewmate();
    const confirm = vi.fn(async () => false);
    const h = setup(crewmate, { machines: computer({ ready: true, confirm }) });
    const { taskId } = await h.supervisor.intake.commission({
      title: "Count presses",
      intent: intentOf("make the meter count every press"),
    });
    await tick();
    // Its conversation is held on the Mac mini now.
    h.tasks.placement.setDevice(taskId, MINI);

    await h.supervisor.sessions.interruptCrewmate(taskId, "interrupt");
    expect(interrupts(h.tasks, taskId)).toEqual(["requested", "aborted-turn"]);
    expect(confirm.mock.calls).toEqual([[taskId]]);
    // The computer says it still runs: nothing here ends the turn.
    await tick();
    expect(h.supervisor.crewStatus(taskId)[0]?.status).toBe("running");
  });

  it("stops every started task on a computer being removed, and leaves the rest", async () => {
    const crewmate = fakeCrewmate();
    const h = setup(crewmate, { machines: computer({ ready: false }) });
    const started = {
      branch: "fm/task",
      worktreeDir: "/work",
      sessionFile: "/sessions/s.jsonl",
      status: "idle",
    } as const;
    seedTask(h.tasks, { id: "t-there", title: "Fix the nav", deviceId: MINI, ...started });
    seedTask(h.tasks, { id: "t-elsewhere", title: "Fix the footer", deviceId: AIR, ...started });
    seedTask(h.tasks, {
      id: "t-unstarted",
      title: "Fix the menu",
      deviceId: MINI,
      status: "queued",
    });
    // A live crewmate whose computer is out of reach is stopped here.
    const { taskId } = await h.supervisor.intake.commission({
      title: "Count presses",
      intent: intentOf("make the meter count every press"),
    });
    await tick();
    h.tasks.placement.setDevice(taskId, MINI);

    await h.supervisor.sessions.stopTasksOn(MINI);

    expect(h.tasks.get("t-there")?.status).toBe("dropped");
    expect(interrupts(h.tasks, "t-there")).toEqual(["cancelled-record"]);
    expect(h.tasks.get(taskId)?.status).toBe("dropped");
    expect(interrupts(h.tasks, taskId)).toEqual(["requested"]);
    expect(h.supervisor.sessions.conversationHeld(taskId)).toBe(false);
    // The out-of-reach crewmate is never asked: its computer cannot hear it.
    expect(crewmate.aborts).toHaveLength(0);
    expect(h.tasks.get("t-elsewhere")?.status).toBe("active");
    expect(interrupts(h.tasks, "t-elsewhere")).toEqual([]);
    expect(h.tasks.get("t-unstarted")?.status).toBe("open");
    expect(interrupts(h.tasks, "t-unstarted")).toEqual([]);
  });
});
