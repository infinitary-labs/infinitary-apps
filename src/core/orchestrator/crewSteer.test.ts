/**
 * How the crew steers a crewmate (`CrewSteer`) and hands it files (the
 * hand-over doors of `CrewSessions`; docs/inbox.md, docs/integrations.md
 * "Google", INF-992): the steers it refuses before anything reaches the
 * task's lane, a steer kept on the lane while the crewmate's computer is out
 * of reach or its resume failed, and files handed on from another task's
 * report or saved from outside, here or on a computer that runs work. These
 * cases pin the behaviour no other test reaches. Each drives a public door of
 * those owners and reads its answer, the lane and the record.
 */

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileSizeWords } from "@shared/attachments";
import { describe, expect, it, vi } from "vitest";
import {
  endTurn,
  fakeCrewmate,
  fakeCrewTimersEachTest,
  intentOf,
  reboot,
  setup,
  tick,
  workComputer,
} from "../../../tests/helpers/crewHarness";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { crewmateHandoverDir } from "../paths";
import { handoverFileName, keepHandoverFiles } from "../tasks/handoverFiles";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import { BACKLOG_STEER_LINE } from "./crewTurns";
import { renderWake } from "./wakes";

fakeCrewTimersEachTest();

const MINI = "mini-device";

/** A crewmate in its first turn, on a supervisor whose computer that runs work answers `fields`. */
async function running(fields: Parameters<typeof workComputer>[2] = {}) {
  const crewmate = fakeCrewmate();
  const h = setup(crewmate, { machines: workComputer(MINI, "Studio Mac mini", fields) });
  const { taskId } = await h.supervisor.intake.commission({
    title: "Count presses",
    intent: intentOf("make the meter count every press"),
  });
  await tick();
  return { ...h, crewmate, taskId };
}

function steers(h: Awaited<ReturnType<typeof running>>, taskId: string) {
  return h.tasks
    .timeline(taskId)
    .filter((event) => event.kind === "steered")
    .map((event) => event.data?.outcome);
}

describe("a crewmate's steer, as CrewSteer delivers it", () => {
  it("refuses a steer it cannot carry before anything reaches the task's lane", async () => {
    let takesResponses = true;
    const h = await running({ takesResponses: () => takesResponses });
    const lane = () => h.inbox.allFor(h.taskId).length;
    const before = lane();

    await expect(
      h.supervisor.steer.steerCrewmate(h.taskId, "check the meter", "captain", {
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
      h.supervisor.steer.steerCrewmate(h.taskId, "never mind", "firstmate", {
        response: { mode: "guidance-only", cancel: [answered.request.id] },
      }),
    ).rejects.toThrow("An answered request cannot be cancelled. Nothing was sent.");

    seedTask(h.tasks, { id: "t-other", title: "Fix the nav", status: "idle" });
    const foreign = h.inbox.requestResponse("t-other", "Is the nav fixed?");
    await expect(
      h.supervisor.steer.steerCrewmate(h.taskId, "never mind", "firstmate", {
        response: { mode: "guidance-only", cancel: [foreign.request.id] },
      }),
    ).rejects.toThrow(
      `Response request ${foreign.request.id} does not belong to this task. Nothing was sent.`,
    );

    // On a computer whose Infinitary predates tracked responses, one is never asked of it.
    h.tasks.placement.setDevice(h.taskId, MINI);
    takesResponses = false;
    await expect(
      h.supervisor.steer.steerCrewmate(h.taskId, "does it count?", "firstmate", {
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

    expect(await h.supervisor.steer.steerCrewmate(h.taskId, "count the long presses too")).toBe(
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
    expect(await h.supervisor.steer.steerCrewmate("t-there", "use the new icons")).toBe(
      "recorded-retrying",
    );
    expect(steers(h, "t-there")).toEqual(["recorded-retrying"]);
    expect(h.inbox.pending("t-there").map(renderWake)).toEqual(["use the new icons"]);
    expect(h.supervisor.sessions.conversationHeld("t-there")).toBe(false);
  });

  // INF-3060: the first mate's reply to the captain waited on steers that
  // were still being delivered, once for 72 seconds handing files over.
  it("answers the first mate's steer once it is recorded, while its delivery into the turn still runs", async () => {
    const h = await running();
    let delivered!: () => void;
    h.crewmate.steer.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          delivered = resolve;
        }),
    );

    expect(
      await h.supervisor.steer.steerCrewmate(h.taskId, "count the long presses too", "firstmate", {
        behind: true,
      }),
    ).toBe("recorded-sending");
    expect(h.crewmate.steer.mock.calls[0]?.[0]).toBe("count the long presses too");
    expect(steers(h, h.taskId)).toEqual([]);

    delivered();
    await tick();
    expect(steers(h, h.taskId)).toEqual(["mid-turn"]);
  });

  it("answers a first mate steer with files before they cross, and wakes it when they cannot", async () => {
    let copied!: (path: string) => void;
    let refused!: (error: Error) => void;
    const sourceFile = vi.fn(
      () =>
        new Promise<string>((resolve, reject) => {
          copied = resolve;
          refused = reject;
        }),
    );
    const h = await running({ sourceFile, takesHandover: () => true });
    h.tasks.placement.setDevice(h.taskId, MINI);
    seedTask(h.tasks, { id: "t-finder", title: "Find the screenshot", status: "idle" });
    const picture = join(scratchDir("infinitary-handed-"), "clipped card.png");
    writeFileSync(picture, "a picture of the clipped card");
    await keepHandoverFiles([picture], crewmateHandoverDir(h.paths, "t-finder"));
    const source = { response: { mode: "guidance-only" as const } };

    // A refusal the checks know still comes back at once, and sends nothing.
    await expect(
      h.supervisor.steer.steerAfterFiles("t-none", h.taskId, "look at it", source),
    ).rejects.toThrow("There is no task t-none to hand files from.");

    const finder = h.tasks.get("t-finder")?.key ?? "";
    const missing = `Files from ${finder} were to come with the message below, but they did not arrive. If you need them, say so in your report.`;
    const lane = () => h.inbox.pending(h.taskId).map((row) => row.text);
    await h.supervisor.steer.steerAfterFiles("t-finder", h.taskId, "look at it", source);
    expect(sourceFile).toHaveBeenCalledTimes(1);
    expect(h.crewmate.steer).not.toHaveBeenCalled();
    // Recorded on the lane as it was sent, so a quit loses nothing; until
    // the files arrive, its line says what is true if they never do (the
    // captain's answer on INF-3075's review of INF-3060).
    expect(lane()).toEqual([missing, "look at it"]);
    copied(`/mini/temp/${h.taskId}/clipped card.png`);
    await vi.waitFor(() => expect(h.crewmate.steer).toHaveBeenCalledTimes(1));
    const [handed] = h.crewmate.steer.mock.calls[0]?.[0].split("\n\n") ?? [];
    expect(handed).toMatch(new RegExp(`^Files handed to you from ${finder}`));
    expect(h.crewmate.steer.mock.calls[0]?.[0]).toBe(`${handed}\n\nlook at it`);

    await h.supervisor.steer.steerAfterFiles("t-finder", h.taskId, "and this one", source);
    refused(new Error("Studio Mac mini is out of reach."));
    // The message still reaches the crewmate, saying its files did not arrive.
    await vi.waitFor(() => expect(h.crewmate.steer).toHaveBeenCalledTimes(2));
    expect(h.crewmate.steer.mock.calls[1]?.[0]).toBe(`${missing}\n\nand this one`);
    expect(h.ops).toContain(
      renderWake({
        facts: {
          kind: "handover-failed",
          task: { id: h.taskId, title: "Count presses" },
          from: h.tasks.get("t-finder")?.key ?? "",
          error: "Studio Mac mini is out of reach.",
          arrived: 0,
          files: 1,
        },
      }),
    );
  });

  // INF-3075's review of INF-3060: a steer with files answered before the
  // copy must keep the first mate's order and refuse before copying.
  it("keeps a later message behind a hand-over still copying, and refuses a dropped task before copying", async () => {
    let copied!: (path: string) => void;
    const sourceFile = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          copied = resolve;
        }),
    );
    const h = await running({ sourceFile, takesHandover: () => true });
    h.tasks.placement.setDevice(h.taskId, MINI);
    seedTask(h.tasks, { id: "t-finder", title: "Find the screenshot", status: "idle" });
    const picture = join(scratchDir("infinitary-handed-"), "clipped card.png");
    writeFileSync(picture, "a picture of the clipped card");
    await keepHandoverFiles([picture], crewmateHandoverDir(h.paths, "t-finder"));
    const source = { response: { mode: "guidance-only" as const } };

    await h.supervisor.steer.steerAfterFiles("t-finder", h.taskId, "look at it", source);
    expect(
      await h.supervisor.steer.steerCrewmate(
        h.taskId,
        "then fix the clipping",
        "firstmate",
        source,
      ),
    ).toBe("after-files");
    expect(h.crewmate.steer).not.toHaveBeenCalled();
    // Both are on the lane already, held until the files arrive.
    expect(
      h.inbox
        .pending(h.taskId)
        .map((row) => row.text)
        .slice(1),
    ).toEqual(["look at it", "then fix the clipping"]);
    copied(`/mini/temp/${h.taskId}/clipped card.png`);
    await vi.waitFor(() => expect(h.crewmate.steer).toHaveBeenCalledTimes(1));
    expect(h.crewmate.steer.mock.calls[0]?.[0]).toMatch(
      /^Files handed to you from [^\n]+\n\nlook at it\n\nthen fix the clipping$/,
    );

    seedTask(h.tasks, { id: "t-done", title: "Ship the icons", status: "cancelled" });
    await expect(
      h.supervisor.steer.steerAfterFiles("t-finder", "t-done", "look at it", source),
    ).rejects.toThrow("no longer steerable");
    expect(sourceFile).toHaveBeenCalledTimes(1);
  });

  // INF-3075's review of INF-3060: a spawn whose start failed stays open for
  // start_now (the captain's answer), so a message to it, with or without
  // files, waits on its lane for that retry instead of being refused.
  it("keeps a message, and one with files, to a task whose start failed for its retry", async () => {
    const crewmate = fakeCrewmate();
    const h = setup(crewmate);
    vi.mocked(h.sessions.open).mockRejectedValueOnce(new Error("Claude is not signed in here."));
    const { taskId, started } = await h.supervisor.intake.commission({
      title: "Count presses",
      intent: intentOf("make the meter count every press"),
    });
    await started;
    expect(h.tasks.get(taskId)).toMatchObject({ status: "open", startPolicy: "on-request" });
    seedTask(h.tasks, { id: "t-finder", title: "Find the screenshot", status: "idle" });
    const picture = join(scratchDir("infinitary-handed-"), "clipped card.png");
    writeFileSync(picture, "a picture of the clipped card");
    await keepHandoverFiles([picture], crewmateHandoverDir(h.paths, "t-finder"));
    const source = { response: { mode: "guidance-only" as const } };

    expect(
      await h.supervisor.steer.steerCrewmate(taskId, "count long presses too", "firstmate", source),
    ).toBe("recorded-queued");
    await h.supervisor.steer.steerAfterFiles("t-finder", taskId, "look at it", source);
    const finder = h.tasks.get("t-finder")?.key ?? "";
    expect(h.inbox.pending(taskId).map((row) => row.text)).toEqual([
      "count long presses too",
      `Files from ${finder} were to come with the message below, but they did not arrive. If you need them, say so in your report.`,
      "look at it",
    ]);
    expect(h.ops.filter((op) => op.includes("were not handed over"))).toEqual([]);

    await h.supervisor.starts.startQueuedNow(taskId);
    // Its crewmate reads both once it has started, the files where they now are.
    const read = () =>
      [...crewmate.promptCalls, ...crewmate.steer.mock.calls.map(([text]) => text)].join("\n\n");
    await vi.waitFor(() =>
      expect(read()).toMatch(new RegExp(`Files handed to you from ${finder}[^\n]*\n\nlook at it`)),
    );
    expect(read()).toContain("count long presses too");
    expect(h.ops.filter((op) => op.includes("were not handed over"))).toEqual([]);
  });

  // INF-3075's review of INF-3060: a started task in the backlog takes a
  // first mate message by resuming its crewmate (docs/inbox.md), and one
  // that waited on files is a first mate message too.
  it("resumes a started task in the backlog for a message whose files have crossed", async () => {
    const crewmate = fakeCrewmate();
    const h = setup(crewmate);
    const { taskId } = await h.supervisor.intake.commission({
      title: "Count presses",
      intent: intentOf("make the meter count every press"),
    });
    await tick();
    await endTurn(crewmate, taskId, "The meter counts every press.");
    h.supervisor.hostOps.moveToBacklog(taskId, { actor: "firstmate", via: "tool", decision: null });
    await tick();
    expect(await h.supervisor.sessions.releaseConversation(taskId)).toBe(true);
    seedTask(h.tasks, { id: "t-finder", title: "Find the screenshot", status: "idle" });
    const picture = join(scratchDir("infinitary-handed-"), "clipped card.png");
    writeFileSync(picture, "a picture of the clipped card");
    await keepHandoverFiles([picture], crewmateHandoverDir(h.paths, "t-finder"));
    const opened = h.sessions.open.mock.calls.length;

    await h.supervisor.steer.steerAfterFiles("t-finder", taskId, "look at it", {
      response: { mode: "guidance-only" as const },
    });
    const finder = h.tasks.get("t-finder")?.key ?? "";
    await vi.waitFor(() =>
      expect(crewmate.promptCalls.at(-1)).toMatch(
        new RegExp(`Files handed to you from ${finder}[^\n]*\n\nlook at it`),
      ),
    );
    expect(h.sessions.open.mock.calls.length).toBe(opened + 1);
    expect(crewmate.promptCalls.at(-1)?.startsWith(BACKLOG_STEER_LINE)).toBe(true);
  });

  // The captain's answer on INF-3075's review of INF-3060: a message with
  // files is saved on the task when it is sent, so a quit loses nothing.
  it("keeps a message whose files were still crossing when the app quit, for the next launch", async () => {
    const crewmate = fakeCrewmate();
    const h = setup(crewmate);
    const { taskId } = await h.supervisor.intake.commission({
      title: "Count presses",
      intent: intentOf("make the meter count every press"),
    });
    await tick();
    await endTurn(crewmate, taskId, "The meter counts every press.");
    seedTask(h.tasks, { id: "t-finder", title: "Find the screenshot", status: "idle" });
    const picture = join(scratchDir("infinitary-handed-"), "clipped card.png");
    writeFileSync(picture, "a picture of the clipped card");
    await keepHandoverFiles([picture], crewmateHandoverDir(h.paths, "t-finder"));
    // The copy to the task's folder is still going when the app quits.
    vi.spyOn(h.supervisor.sessions, "prepareHandFiles").mockResolvedValue({
      files: 1,
      copy: () => new Promise<string>(() => {}),
    });

    await h.supervisor.steer.steerAfterFiles("t-finder", taskId, "look at it", {
      response: { mode: "guidance-only" as const },
    });
    expect(crewmate.steer).not.toHaveBeenCalled();
    await h.supervisor.disposeAll();
    h.inbox.resetInFlight();

    const resumed = fakeCrewmate();
    const fresh = reboot(
      h,
      vi.fn(async () => resumed),
      { tasks: new TaskService({ db: h.db, repos: h.repos, strict: true }) },
    );
    await fresh.watch.sweepInbox(Date.now() + 100_000);
    await tick();
    const finder = h.tasks.get("t-finder")?.key ?? "";
    expect(resumed.promptCalls).toEqual([
      expect.stringContaining(
        `Files from ${finder} were to come with the message below, but they did not arrive. If you need them, say so in your report.\n\nlook at it`,
      ),
    ]);
    expect(resumed.promptCalls[0]?.split("look at it")).toHaveLength(2);
    await fresh.disposeAll();
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

    await expect(h.supervisor.sessions.handFiles("t-none", h.taskId)).rejects.toThrow(
      "There is no task t-none to hand files from.",
    );
    await expect(h.supervisor.sessions.handFiles("t-finder", "t-none")).rejects.toThrow(
      "There is no task t-none to hand files to.",
    );
    await expect(h.supervisor.sessions.handFiles("t-empty", h.taskId)).rejects.toThrow(
      `${key("t-empty")} has no reported files to hand on: its crewmate passes them in report files.`,
    );
    await expect(h.supervisor.sessions.handFiles("t-finder", "t-later")).rejects.toThrow(
      `${key("t-later")} has not started, so there is no folder to hand files into yet.`,
    );
    h.tasks.placement.setDevice(h.taskId, MINI);
    await expect(h.supervisor.sessions.handFiles("t-finder", h.taskId)).rejects.toThrow(
      `${key(h.taskId)} runs on Studio Mac mini, which needs an update to Infinitary before it can take handed files.`,
    );
    expect(sourceFile).not.toHaveBeenCalled();

    takesHandover = true;
    const guidance = await h.supervisor.sessions.handFiles("t-finder", h.taskId);
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

    expect(h.supervisor.sessions.outsideFileRefusal("t-later")).toBe(
      "this task is not running, so it has no hand-over folder to save into.",
    );
    expect(h.supervisor.sessions.outsideFileRefusal(h.taskId)).toBeUndefined();
    h.tasks.placement.setDevice(h.taskId, MINI);
    const refusal =
      "update Infinitary on Studio Mac mini before a file from outside can be saved into this task's folder there.";
    expect(h.supervisor.sessions.outsideFileRefusal(h.taskId)).toBe(refusal);
    await expect(
      h.supervisor.sessions.saveOutsideFile(h.taskId, "invoice.pdf", bytes),
    ).rejects.toThrow(refusal);
    expect(sourceFile).not.toHaveBeenCalled();

    takesOutsideFiles = true;
    expect(h.supervisor.sessions.outsideFileRefusal(h.taskId)).toBeUndefined();
    const file = handoverFileName("invoice.pdf", createHash("sha256").update(bytes).digest("hex"));
    expect(await h.supervisor.sessions.saveOutsideFile(h.taskId, "invoice.pdf", bytes)).toEqual({
      file,
      path: `/mini/temp/${h.taskId}/${file}`,
    });
    expect(sourceFile.mock.calls).toEqual([
      [MINI, h.taskId, file, expect.stringContaining("infinitary-outside-"), "handover"],
    ]);
  });
});
