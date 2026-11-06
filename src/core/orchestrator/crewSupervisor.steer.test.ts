/**
 * How the crew supervisor steers a crewmate and hands it files
 * (docs/inbox.md, docs/integrations.md "Google", INF-992): the steers it
 * refuses before anything reaches the task's lane, a steer kept on the lane
 * while the crewmate's computer is out of reach or its resume failed, and
 * files handed on from another task's report or saved from outside, here or
 * on a computer that runs work. INF-2625's plan, the crew supervisor's ninth
 * step, moves this code out of the supervisor into owners of its own (crew
 * sessions, turns and steering); these cases pin, before it moves, the
 * behaviour no other test reaches. Each drives a public door of the
 * supervisor and reads its answer, the lane and the record.
 */

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileSizeWords } from "@shared/attachments";
import { describe, expect, it, vi } from "vitest";
import {
  fakeCrewmate,
  intentOf,
  setup,
  tick,
  workComputer,
} from "../../../tests/helpers/crewHarness";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { crewmateHandoverDir } from "../paths";
import { handoverFileName, keepHandoverFiles } from "../tasks/handoverFiles";
import { seedTask } from "../tasks/seedTask";
import { renderWake } from "./wakes";

const MINI = "mini-device";

/** A crewmate in its first turn, on a supervisor whose computer that runs work answers `fields`. */
async function running(fields: Parameters<typeof workComputer>[2] = {}) {
  const crewmate = fakeCrewmate();
  const h = setup(crewmate, { machines: workComputer(MINI, "Studio Mac mini", fields) });
  const { taskId } = await h.supervisor.commission({
    title: "Count presses",
    intent: intentOf("make the meter count every press"),
  });
  await tick();
  return { ...h, crewmate, taskId };
}

/** Each steer the record holds for the task, with what happened to it. */
function steers(h: Awaited<ReturnType<typeof running>>, taskId: string) {
  return h.tasks
    .timeline(taskId)
    .filter((event) => event.kind === "steered")
    .map((event) => event.data?.outcome);
}

describe("a crewmate's steer, before it moves out of the crew supervisor", () => {
  it("refuses a steer it cannot carry before anything reaches the task's lane", async () => {
    let takesResponses = true;
    const h = await running({ takesResponses: () => takesResponses });
    const lane = () => h.inbox.allFor(h.taskId).length;
    const before = lane();

    await expect(
      h.supervisor.steerCrewmate(h.taskId, "check the meter", "captain", {
        response: { mode: "expected" },
      }),
    ).rejects.toThrow("Only a first mate message creates or cancels its response expectations.");

    const answered = h.inbox.requestResponse(h.taskId, "Does the meter count?");
    h.inbox.submitResponse(
      { requestId: answered.request.id, responseId: "r-1", status: "answered" },
      { task: h.taskId, session: null },
      "It counts every press.",
    );
    await expect(
      h.supervisor.steerCrewmate(h.taskId, "never mind", "firstmate", {
        response: { mode: "guidance-only", cancel: [answered.request.id] },
      }),
    ).rejects.toThrow("An answered request cannot be cancelled. Nothing was sent.");

    seedTask(h.tasks, { id: "t-other", title: "Fix the nav", status: "idle" });
    const foreign = h.inbox.requestResponse("t-other", "Is the nav fixed?");
    await expect(
      h.supervisor.steerCrewmate(h.taskId, "never mind", "firstmate", {
        response: { mode: "guidance-only", cancel: [foreign.request.id] },
      }),
    ).rejects.toThrow(
      `Response request ${foreign.request.id} does not belong to this task. Nothing was sent.`,
    );

    // On a computer whose Infinitary predates tracked responses, one is never asked of it.
    h.tasks.placement.setDevice(h.taskId, MINI);
    takesResponses = false;
    await expect(
      h.supervisor.steerCrewmate(h.taskId, "does it count?", "firstmate", {
        response: { mode: "expected" },
      }),
    ).rejects.toThrow(
      "Update Infinitary on the work computer before requesting a tracked response. Nothing was sent.",
    );

    // The two requests written above are the only rows: no refused steer reached the lane.
    expect(lane()).toBe(before + 1);
    expect(h.inbox.responseRequest(foreign.request.id)?.state).toBe("pending");
    expect(steers(h, h.taskId)).toEqual([]);
    expect(h.crewmate.steer).not.toHaveBeenCalled();
  });

  it("keeps a steer on the lane while the crewmate's computer is out of reach, and one whose resume failed", async () => {
    let ready = true;
    const h = await running({ ready: () => ready, folders: () => undefined });
    h.tasks.placement.setDevice(h.taskId, MINI);
    ready = false;

    expect(await h.supervisor.steerCrewmate(h.taskId, "count the long presses too")).toBe(
      "recorded-held",
    );
    expect(h.crewmate.steer).not.toHaveBeenCalled();
    expect(steers(h, h.taskId)).toEqual(["recorded-held"]);
    expect(h.inbox.pending(h.taskId).map(renderWake)).toContain("count the long presses too");

    // A task whose conversation is held on a computer that cannot give its folders back.
    seedTask(h.tasks, {
      id: "t-there",
      title: "Fix the nav",
      branch: "fm/task-t-there",
      worktreeDir: "/work/t-there",
      sessionFile: "/sessions/t-there.jsonl",
      deviceId: MINI,
      status: "idle",
    });
    ready = true;
    expect(await h.supervisor.steerCrewmate("t-there", "use the new icons")).toBe(
      "recorded-retrying",
    );
    expect(steers(h, "t-there")).toEqual(["recorded-retrying"]);
    expect(h.inbox.pending("t-there").map(renderWake)).toEqual(["use the new icons"]);
    expect(h.supervisor.conversationHeld("t-there")).toBe(false);
  });

  it("hands another task's reported files on, refusing what it cannot deliver", async () => {
    const sourceFile = vi.fn(async (_machine: string, taskId: string, file: string) =>
      join("/mini/temp", taskId, file),
    );
    let takesHandover = false;
    const h = await running({ sourceFile, takesHandover: () => takesHandover });
    seedTask(h.tasks, { id: "t-finder", title: "Find the screenshot", status: "idle" });
    seedTask(h.tasks, { id: "t-empty", title: "Find nothing", status: "idle" });
    seedTask(h.tasks, { id: "t-later", title: "Fix the clipped card", status: "queued" });
    const picture = join(scratchDir("infinitary-handed-"), "clipped card.png");
    writeFileSync(picture, "a picture of the clipped card");
    const handover = crewmateHandoverDir(h.paths, "t-finder");
    const [kept] = await keepHandoverFiles([picture], handover);
    if (!kept) throw new Error("the picture was not kept");
    const key = (id: string) => h.tasks.get(id)?.key;

    await expect(h.supervisor.handFiles("t-none", h.taskId)).rejects.toThrow(
      "There is no task t-none to hand files from.",
    );
    await expect(h.supervisor.handFiles("t-finder", "t-none")).rejects.toThrow(
      "There is no task t-none to hand files to.",
    );
    await expect(h.supervisor.handFiles("t-empty", h.taskId)).rejects.toThrow(
      `${key("t-empty")} has no reported files to hand on: its crewmate passes them in report files.`,
    );
    await expect(h.supervisor.handFiles("t-finder", "t-later")).rejects.toThrow(
      `${key("t-later")} has not started, so there is no folder to hand files into yet.`,
    );
    h.tasks.placement.setDevice(h.taskId, MINI);
    await expect(h.supervisor.handFiles("t-finder", h.taskId)).rejects.toThrow(
      `${key(h.taskId)} runs on Studio Mac mini, which needs an update to Infinitary before it can take handed files.`,
    );
    expect(sourceFile).not.toHaveBeenCalled();

    takesHandover = true;
    const guidance = await h.supervisor.handFiles("t-finder", h.taskId);
    expect(sourceFile.mock.calls).toEqual([
      [MINI, h.taskId, kept.file, join(handover, kept.file), "handover"],
    ]);
    expect(guidance).toBe(
      `Files handed to you from ${key("t-finder")}, verified byte for byte, in your hand-over folder: /mini/temp/${h.taskId}/${kept.file} (${fileSizeWords(kept.size)}). They may hold secrets: never print, quote or paste their content anywhere, and read only what your work needs. They are removed when this task closes.`,
    );
  });

  it("saves a file from outside into a task's folder on its computer, once that computer takes one", async () => {
    const sourceFile = vi.fn(async (_machine: string, taskId: string, file: string) =>
      join("/mini/temp", taskId, file),
    );
    let takesOutsideFiles = false;
    const h = await running({ sourceFile, takesOutsideFiles: () => takesOutsideFiles });
    seedTask(h.tasks, { id: "t-later", title: "Fix the clipped card", status: "queued" });
    const bytes = Buffer.from("the invoice");

    expect(h.supervisor.outsideFileRefusal("t-later")).toBe(
      "this task is not running, so it has no hand-over folder to save into.",
    );
    expect(h.supervisor.outsideFileRefusal(h.taskId)).toBeUndefined();
    h.tasks.placement.setDevice(h.taskId, MINI);
    const refusal =
      "update Infinitary on Studio Mac mini before a file from outside can be saved into this task's folder there.";
    expect(h.supervisor.outsideFileRefusal(h.taskId)).toBe(refusal);
    await expect(h.supervisor.saveOutsideFile(h.taskId, "invoice.pdf", bytes)).rejects.toThrow(
      refusal,
    );
    expect(sourceFile).not.toHaveBeenCalled();

    takesOutsideFiles = true;
    expect(h.supervisor.outsideFileRefusal(h.taskId)).toBeUndefined();
    const file = handoverFileName("invoice.pdf", createHash("sha256").update(bytes).digest("hex"));
    expect(await h.supervisor.saveOutsideFile(h.taskId, "invoice.pdf", bytes)).toEqual({
      file,
      path: `/mini/temp/${h.taskId}/${file}`,
    });
    expect(sourceFile.mock.calls).toEqual([
      [MINI, h.taskId, file, expect.stringContaining("infinitary-outside-"), "handover"],
    ]);
  });
});
