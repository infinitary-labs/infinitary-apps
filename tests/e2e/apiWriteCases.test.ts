import { expect, it } from "vitest";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import type { ForgeWriteAsk } from "../../src/shared/writeAsk";
import { scratchDir } from "../helpers/scratchDirs";
import { savedWriteAsks, writeAskCall } from "./apiWriteCases";

// INF-1392's nightly failure: the shared journey reader must follow saved
// write permissions after delivery records moved out of tasks.delivery_json.
it("reads pending, sent and answered write asks through the saved task without changing it", () => {
  const userDataDir = scratchDir("infinitary-saved-write-asks-");
  const db = openDatabase(userDataDir);
  let now = 1_000;
  const tasks = new TaskService({ db, now: () => now });
  const taskId = "write-to-website";
  const ask: ForgeWriteAsk = {
    id: "website-issue",
    kind: "github",
    host: "github.com",
    place: "GitHub",
    via: "project",
    ...writeAskCall("ask before writing"),
    at: now,
  };
  try {
    seedTask(tasks, { id: taskId, title: "Link the new meter docs", status: "running" });
    seedTask(tasks, { id: "another-task", title: "Another project", status: "queued" });
    expect(savedWriteAsks(userDataDir, "missing-task")).toEqual([]);
    expect(savedWriteAsks(userDataDir, taskId)).toEqual([]);

    // Use the real writer, so a future storage move still exercises its reader.
    tasks.keepWriteAsk(taskId, ask);
    expect(savedWriteAsks(userDataDir, taskId)).toEqual([ask]);
    expect(savedWriteAsks(userDataDir, "another-task")).toEqual([]);

    now += 1_000;
    const sent = { ...ask, sentAt: now };
    expect(tasks.takeWriteAsk(taskId, ask.id)).toEqual({ ask: sent });
    expect(savedWriteAsks(userDataDir, taskId)).toEqual([sent]);

    const outcome = { kind: "answered", status: 201, requestId: "website-created" } as const;
    tasks.recordWriteAskOutcome(taskId, ask.id, outcome);
    const beforeRead = db.serialize();
    expect(savedWriteAsks(userDataDir, taskId)).toEqual([{ ...sent, outcome }]);
    expect(db.serialize().equals(beforeRead)).toBe(true);
    expect(tasks.get(taskId)?.status).toBe("active");
    expect(tasks.get(taskId)?.activity).toBe("running");
  } finally {
    db.close();
  }
});
