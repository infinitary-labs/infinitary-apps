import type { LeftoversReport } from "@shared/leftoverPrograms";
import { expect, it, vi } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { openDatabase } from "../storage/db";
import { noteLeftovers } from "../tasks/leftoverPrograms";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import { recordedPressureLeftovers, resolveClearedLeftovers } from "./pressureLeftovers";

// INF-3497 finding 5: pressure lines read the predecessor's saved close
// outcomes by task and computer, not all closed tasks or guessed process use.
it("reads only unresolved close outcomes on their recorded computer after reopening", () => {
  const dir = scratchDir("infinitary-pressure-leftovers-");
  const db = openDatabase(dir);
  const tasks = new TaskService({ db });
  const record = seedTask(tasks, {
    id: "closed",
    title: "Check a scratch machine",
    status: "cancelled",
    deviceId: "work",
  });
  const report: LeftoversReport = {
    stops: [
      { label: "scratch machine", outcome: "failed", exitCode: 1 },
      { label: "scratch server", outcome: "ran" },
    ],
    programs: [
      { pid: 4118, name: "sleep", outcome: "survived" },
      { pid: 4119, name: "sleep", outcome: "ended" },
    ],
    holders: "checked",
  };
  noteLeftovers(tasks, record.id, report, "work");
  // A task may have both local stops and a remote conversation. The event's
  // computer, never its current placement, owns each close report.
  noteLeftovers(tasks, record.id, {
    ...report,
    programs: [],
    stops: [{ label: "local server", outcome: "timed-out" }],
  });
  noteLeftovers(
    tasks,
    record.id,
    { stops: [{ label: "finished machine", outcome: "ran" }], programs: [], holders: "checked" },
    "work",
  );
  tasks.note(record.id, "An older close report without computer provenance", {
    news: true,
    data: { leftoverPrograms: report },
  });
  db.close();

  const reopened = openDatabase(dir);
  try {
    const saved = new TaskService({ db: reopened });
    const prepare = vi.spyOn(reopened, "prepare");
    const notes = saved.leftoverNotes("work");
    const sql = prepare.mock.calls.at(-1)![0];
    prepare.mockRestore();
    const plan = reopened.prepare(`EXPLAIN QUERY PLAN ${sql}`).all("work") as { detail: string }[];
    expect(plan.map((row) => row.detail).join("\n")).toMatch(
      /SEARCH task_events USING INDEX task_events_leftovers/,
    );
    expect(plan.some((row) => /SCAN|TEMP B-TREE/.test(row.detail))).toBe(false);
    expect(notes).toHaveLength(1);
    expect(recordedPressureLeftovers(saved, "work")).toEqual([
      {
        id: notes[0]!.identity,
        taskId: record.id,
        key: record.key,
        report: { ...report, stops: [report.stops[0]!], programs: [report.programs[0]!] },
      },
    ]);
    expect(recordedPressureLeftovers(saved, null)[0]?.report.stops).toEqual([
      { label: "local server", outcome: "timed-out" },
    ]);
    expect(recordedPressureLeftovers(saved, "other")).toEqual([]);
    // Neither a malformed report nor a task still open is a closed-task fact.
    saved.note(record.id, "Unreadable report", {
      news: true,
      data: { leftoversComputerId: "work", leftoversUnresolved: true, leftoverPrograms: {} },
    });
    const open = seedTask(saved, { id: "open", title: "Work in progress", status: "idle" });
    noteLeftovers(saved, open.id, report, "work");
    expect(recordedPressureLeftovers(saved, "work")).toHaveLength(1);
  } finally {
    reopened.close();
  }
});

// INF-3592's review, the captain's choice "Mark it resolved too, so later
// notices stop naming it": once the computer's list shows a task keeps
// nothing there, its close report stops being named; a report from a close
// that kept no file is left as it was.
it("marks a close report resolved once the computer's list shows its task keeps nothing", () => {
  const dir = scratchDir("infinitary-pressure-leftovers-");
  const db = openDatabase(dir);
  try {
    const tasks = new TaskService({ db });
    const kept = seedTask(tasks, {
      id: "kept",
      title: "Boot a scratch machine",
      status: "cancelled",
    });
    const cleared = seedTask(tasks, {
      id: "cleared",
      title: "Boot a simulator",
      status: "cancelled",
    });
    const older = seedTask(tasks, { id: "older", title: "Run a server", status: "cancelled" });
    const report: LeftoversReport = {
      stops: [{ label: "scratch machine", outcome: "timed-out" }],
      programs: [],
      holders: "checked",
      keptInFile: true,
    };
    noteLeftovers(tasks, kept.id, report, "work");
    noteLeftovers(tasks, cleared.id, report, "work");
    const { keptInFile: _kept, ...beforeTheFile } = report;
    noteLeftovers(tasks, older.id, beforeTheFile, "work");

    resolveClearedLeftovers(tasks, "work", [kept.id]);
    expect(recordedPressureLeftovers(tasks, "work").map((leftover) => leftover.taskId)).toEqual([
      kept.id,
      older.id,
    ]);
    // Another computer's list says nothing of this one's reports.
    resolveClearedLeftovers(tasks, null, []);
    expect(recordedPressureLeftovers(tasks, "work")).toHaveLength(2);
  } finally {
    db.close();
  }
});
