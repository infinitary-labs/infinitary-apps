import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { freshDatabase } from "../../../tests/helpers/database";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import type { Card } from "../../shared/cards";
import { type AppPaths, crewmateHandoverDir, crewmateTempDir } from "../paths";
import { InboxStore } from "../storage/inboxStore";
import { keepHandoverFiles } from "../tasks/handoverFiles";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import type { CrewCore } from "./crewCore";
import { CrewSessions } from "./crewSessions";
import type { SettleServiceHost } from "./settleHost";
import { createSettleOwners } from "./settleOwners";

// Integration: real screenshot copies and a real close transaction; measured below one second.
vi.setConfig({ testTimeout: 15_000 });

// INF-1426 / INF-1389 finding 4: handed-on results are done, not discarded.
function fixture(deliverable: "answer" | "change" = "answer", reported = true) {
  const db = freshDatabase();
  const tasks = new TaskService({ db, strict: true });
  seedTask(tasks, {
    id: "finder",
    title: "Hand the screenshot to the builder",
    status: "idle",
    ...(reported ? { outcome: "The screenshot is ready for the builder." } : {}),
    shape: { kind: "research", deliverable },
  });
  seedTask(tasks, { id: "builder", title: "Fix the clipped card", status: "idle" });
  const cards: unknown[] = [];
  // What a close does to the task's cards, in order.
  const cardCloses: unknown[][] = [];
  const workStatus = vi.fn(async () => ({ dirty: false, unlandedCommits: 0 }));
  const host = {
    tasks,
    now: () => Date.now(),
    runtimeState: () => "idle",
    resolveTaskRef: (ref: string) => tasks.resolve(ref),
    deliverableOf: () => deliverable,
    taskDelivery: () => undefined,
    cards: {
      snapshot: () => cards,
      retireTaskCards: (...args: unknown[]) => cardCloses.push(["retire", ...args]),
      // A close shows a note still waiting on its crewmate (INF-2533).
      releaseNotes: (taskId: string) => cardCloses.push(["release", taskId]),
      // Every close takes down a merge note an earlier version put up (INF-2913).
      hostCards: { withdrawHostCard: () => {} },
      scheduleBroadcast: () => {},
      releaseMerged: () => {},
    },
    inbox: new InboxStore(db),
    endLiveTask: () => {},
    stopRuntime: () => undefined,
    sweepGates: async () => {},
    broadcastCrewCounts: () => {},
    workspace: { taskWorkStatus: workStatus },
  } as unknown as SettleServiceHost;
  const owners = createSettleOwners(host);
  return {
    tasks,
    host,
    service: owners.declared,
    done: owners.done,
    cards,
    cardCloses,
    workStatus,
  };
}

// A handed-on result closes done as answered: its notes stay, and a note
// still waiting on its crewmate shows after the close wrote its outcome
// on it (INF-2533).
const ANSWERED_CLOSE = [
  ["retire", "finder", "answered", { keepNotes: true }],
  ["release", "finder"],
];

describe("handed-on result completion", () => {
  it("delivers a real screenshot before closing the source as done, and keeps the successor's copy", async () => {
    const { tasks, done, cardCloses } = fixture("change");
    const paths = { crewmatesDir: scratchDir("infinitary-handed-result-") } as AppPaths;
    const original = fileURLToPath(
      new URL("../../../release-notes/pictures/action-reply-line-dark.webp", import.meta.url),
    );
    const [kept] = await keepHandoverFiles([original], crewmateHandoverDir(paths, "finder"));
    const sessions = new CrewSessions({ options: { tasks, paths } } as unknown as CrewCore);
    const guidance = await sessions.handFiles("finder", "builder");
    if (!kept) throw new Error("the screenshot was not retained");
    const delivered = join(crewmateTempDir(paths, "builder"), "handover", kept.file);
    expect(guidance).toContain(delivered);
    expect(await readFile(delivered)).toEqual(await readFile(original));
    expect(await done.close("finder", { why: "answered" })).toMatchObject({ ok: true });
    expect(tasks.get("finder")).toMatchObject({ status: "done", closedReason: "answered" });
    expect(cardCloses).toEqual(ANSWERED_CLOSE);
    expect(await readFile(delivered)).toEqual(await readFile(original));
  });

  it("does not record a handoff when no files arrived", async () => {
    const { tasks } = fixture("change");
    const paths = { crewmatesDir: scratchDir("infinitary-missing-result-") } as AppPaths;
    const sessions = new CrewSessions({ options: { tasks, paths } } as unknown as CrewCore);
    await expect(sessions.handFiles("finder", "builder")).rejects.toThrow("no reported files");
    expect(tasks.capture.resultHandoffOf("finder")).toBe(false);
  });

  it.each(["answer", "change"] as const)(
    "closes a reported %s handed to another task without an internal-step declaration",
    async (kind) => {
      const { tasks, done, cardCloses } = fixture(kind);
      tasks.capture.recordResultHandoff("finder", { taskId: "builder" });
      expect(await done.close("finder", { why: "answered" })).toMatchObject({ ok: true });
      expect(tasks.get("finder")).toMatchObject({ status: "done", closedReason: "answered" });
      expect(cardCloses).toEqual(ANSWERED_CLOSE);
      expect(tasks.timeline("finder")).toContainEqual(
        expect.objectContaining({
          data: expect.objectContaining({ resultHandoff: { taskId: "builder" } }),
        }),
      );
    },
  );

  it("records a captain result choice on a change without closing it mid-turn, then finishes it as answered", async () => {
    const { tasks, done, service, cardCloses } = fixture("change");
    const card = {
      id: "card-finder-result",
      taskId: "finder",
      title: "Screenshot found",
      actions: [{ id: "use", label: "Use it" }],
    } as Card;
    expect(service.closeAnsweredTask(card, "use", "captain")).toBe(false);
    expect(tasks.capture.resultHandoffOf("finder")).toBe(true);
    expect(cardCloses).toEqual([]);
    expect(await done.close("finder", { why: "answered" })).toMatchObject({ ok: true });
    expect(tasks.get("finder")?.status).toBe("done");
    expect(cardCloses).toEqual(ANSWERED_CLOSE);
  });

  it.each(["dismissed", "closed", "invented"])("does not count %s as a result choice", (action) => {
    const { tasks, service } = fixture("change");
    service.closeAnsweredTask(
      { id: "card-finder-result", taskId: "finder", actions: [{ id: "use" }] } as Card,
      action,
      "captain",
    );
    expect(tasks.capture.resultHandoffOf("finder")).toBe(false);
  });

  it("does not count a continuing consent card as a result", () => {
    const { tasks, service } = fixture("change");
    service.closeAnsweredTask(
      {
        id: "card-finder-consent",
        taskId: "finder",
        continues: true,
        actions: [{ id: "allow" }],
      } as Card,
      "allow",
      "captain",
    );
    expect(tasks.capture.resultHandoffOf("finder")).toBe(false);
  });

  it("requires the source's report even when files were delivered", async () => {
    const { tasks, done } = fixture("change", false);
    tasks.capture.recordResultHandoff("finder", { taskId: "builder" });
    expect(await done.close("finder", { why: "answered" })).toMatchObject({ ok: false });
  });

  // INF-3169 piece 2, captain: "Leave it open where the project lives, and say so on the record".
  it("holds while its own pull request reads open, and closes over one it cannot read", async () => {
    const open = fixture("change");
    open.tasks.capture.recordResultHandoff("finder", { taskId: "builder" });
    seedDelivery(open.tasks, "finder", { prNumber: 497 });
    open.host.readPull = async () => ({ number: 497, state: "open" }) as never;
    expect(await open.done.close("finder", { why: "answered" })).toMatchObject({
      ok: false,
      text: expect.stringContaining("its own pull request #497 is still open"),
    });
    expect(open.tasks.get("finder")?.status).toBe("active");
    const unread = fixture("change");
    unread.tasks.capture.recordResultHandoff("finder", { taskId: "builder" });
    seedDelivery(unread.tasks, "finder", { prNumber: 497 });
    expect(await unread.done.close("finder", { why: "answered" })).toMatchObject({
      ok: true,
      text: expect.stringContaining("could not be read"),
    });
    expect(unread.tasks.get("finder")?.status).toBe("done");
  });

  it("preserves the open-child close rule after a result handoff", async () => {
    const { tasks, done } = fixture("change");
    tasks.capture.recordResultHandoff("finder", { taskId: "builder" });
    seedTask(tasks, {
      id: "child",
      title: "Check screenshot dimensions",
      parentId: "finder",
      status: "idle",
    });
    expect(await done.close("finder", { why: "answered" })).toMatchObject({ ok: false });
  });

  it("does not turn a report alone into permission to finish a captain-requested answer", async () => {
    const { tasks, done } = fixture();
    expect(await done.close("finder", { why: "answered" })).toMatchObject({ ok: false });
    expect(tasks.get("finder")?.status).toBe("active");
  });

  it.each([
    { dirty: true, unlandedCommits: 0 },
    { dirty: false, unlandedCommits: 1 },
  ])("keeps unmerged work after handoff: %j", async (work) => {
    const { tasks, done, workStatus } = fixture("change");
    tasks.capture.recordResultHandoff("finder", { taskId: "builder" });
    tasks.starts.dispatch("finder", {
      workspace: { repoDir: "/project", worktreeDir: "/working-copy", branch: "finder" },
      assignee: "crewmate",
      accountId: null,
    });
    tasks.turns.setActivity("finder", "idle");
    workStatus.mockResolvedValue(work);
    // The proof hold names what the close could name instead (INF-3169 piece 2).
    expect(await done.close("finder", { why: "answered" })).toMatchObject({
      ok: false,
      text: expect.stringContaining("the close names nowhere else it went"),
    });
    expect(tasks.get("finder")?.status).toBe("active");
  });

  it("keeps a question and its result open after handoff", async () => {
    const { tasks, done, cards } = fixture();
    tasks.capture.recordResultHandoff("finder", { taskId: "builder" });
    cards.push({
      id: "card-finder-result",
      taskId: "finder",
      title: "Which screenshot?",
      actions: [{ id: "pick" }],
    });
    expect(await done.close("finder", { why: "answered" })).toMatchObject({ ok: false });
  });
});
