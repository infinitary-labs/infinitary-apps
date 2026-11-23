/**
 * The host's own work in a project's folder, as the crew's in-place work files
 * and closes it (INF-549 a folder a merge left behind, INF-572 a folder
 * missing or behind at start, the pull request an abandoned task left open;
 * `InPlaceWork`). These cases pin the behaviour the real-git journeys beside
 * it do not reach: a start check that cannot read a folder, a project with no
 * address, a folder found missing twice, a later refusal on a standing
 * repair, one pull repair per pull request, and what keeps a repair open - a
 * crewmate still working, a card of its own up, a read that fails, a close
 * that came first. Each drives a public door of the supervisor or its
 * in-place work over the stand-in workspace and reads the record, the feed
 * and the words.
 */

import type { FmEvent } from "@shared/events";
import { describe, expect, it, vi } from "vitest";
import {
  fakeCrewmate,
  fakeCrewTimersEachTest,
  type SetupExtras,
  setup,
  tick,
} from "../../../tests/helpers/crewHarness";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import { seedTask } from "../tasks/seedTask";
import { seedProject } from "../workspace/seedProject";
import { FOLDER_REPAIR_TITLE, PULL_REPAIR_TITLE } from "./intentBrief";

fakeCrewTimersEachTest();

const ORIGIN = "https://github.com/octo/shop.git";

/**
 * A supervisor over the stand-in workspace, with one project "shop" whose
 * folder `folder` is (by default one that does not exist) and the folder
 * reads `reads` answers.
 */
function shop(
  options: { origin?: string | null; folder?: string; readPull?: SetupExtras["readPull"] } = {},
) {
  const crewmate = fakeCrewmate();
  const h = setup(crewmate, options.readPull ? { readPull: options.readPull } : {});
  const folder = options.folder ?? `${scratchDir("infinitary-shop-")}/shop`;
  seedProject(h.db, {
    id: "shop",
    name: "shop",
    path: folder,
    origin: options.origin === undefined ? ORIGIN : options.origin,
    delivery: "direct-pr",
  });
  const reads = {
    refreshAtStart: vi.fn(async (_path: string): Promise<unknown> => ({ outcome: "level" })),
    folderDefaultBranch: vi.fn(async (_path: string) => "main"),
    folderCurrent: vi.fn(async (_path: string, _branch: string, _reach?: string) => false),
  };
  Object.assign(h.workspace, reads);
  const repairs = () =>
    h.tasks.list().filter((row) => row.repoId === "shop" && row.shape?.in_place);
  return { ...h, crewmate, folder, reads, repairs };
}

function feed(events: FmEvent[]): string[] {
  return events.flatMap((event) => (event.type === "firstmate_note" ? [event.text] : []));
}

/** The task a merge into shop left behind, as the settle reads it. */
function merged(h: ReturnType<typeof shop>, id = "merged1") {
  seedTask(h.tasks, { id, title: "Ship the shop", status: "idle", repoId: "shop" });
  const record = h.tasks.get(id);
  if (!record) throw new Error("the merged task was not seeded");
  return record;
}

async function pullRepair(h: ReturnType<typeof shop>): Promise<string> {
  seedTask(h.tasks, {
    id: "dropped1",
    title: "Ship the shop",
    status: "cancelled",
    repoId: "shop",
  });
  seedDelivery(h.tasks, "dropped1", { prNumber: 12 });
  const abandoned = h.tasks.get("dropped1");
  if (!abandoned) throw new Error("the dropped task was not seeded");
  const id = h.supervisor.inPlaceWork.filePullRepair(abandoned, undefined)?.record.id;
  if (!id) throw new Error("no pull repair was filed");
  await vi.waitFor(() => expect(h.crewmate.promptCalls).toHaveLength(1));
  return id;
}

describe("the host's own work in a project's folder", () => {
  it("at start says nothing and files nothing for a project with no address or a folder that cannot be read, and skips the check where folders cannot be read at start", async () => {
    const h = shop();
    h.reads.refreshAtStart.mockRejectedValueOnce(new Error("git is gone"));
    await h.supervisor.inPlaceWork.checkFoldersAtStart();
    expect(h.reads.refreshAtStart).toHaveBeenCalledTimes(1);
    expect(h.repairs()).toEqual([]);
    expect(feed(h.events)).toEqual([]);

    const unreadable = shop();
    Object.assign(unreadable.workspace, { refreshAtStart: undefined });
    await expect(unreadable.supervisor.inPlaceWork.checkFoldersAtStart()).resolves.toBeUndefined();
    expect(unreadable.repairs()).toEqual([]);

    const local = shop({ origin: null });
    await local.supervisor.inPlaceWork.checkFoldersAtStart();
    expect(local.reads.refreshAtStart).not.toHaveBeenCalled();
    expect(local.repairs()).toEqual([]);
  });

  it("at start files a repair again after the captain closed one when where the project lives was not read", async () => {
    const h = shop();
    h.reads.refreshAtStart.mockResolvedValue({
      outcome: "refused",
      refusal: { refreshed: false, cause: "fetch-failed" },
    });
    await h.supervisor.inPlaceWork.checkFoldersAtStart();
    const [closed] = h.repairs();
    if (!closed) throw new Error("no repair task was filed");
    expect(closed.shape?.in_place).toEqual({ cause: "fetch-failed", noticed: "app-start" });
    h.tasks.close(closed.id, { status: "dropped", reason: "cancelled", actor: "captain" });

    await h.supervisor.inPlaceWork.checkFoldersAtStart();
    expect(h.repairs().filter((row) => row.id !== closed.id)).toHaveLength(1);
  });

  it("files one repair for a folder found missing: a second notice names the standing repair and tells nobody anything new", async () => {
    const h = shop();
    const by = merged(h);
    const first = h.supervisor.inPlaceWork.folderMissing("shop", "start", by);
    const [repair] = h.repairs();
    if (!repair) throw new Error("no repair task was filed");
    expect(repair).toMatchObject({
      title: FOLDER_REPAIR_TITLE,
      goal: "Bring back the folder of shop, which is missing.",
    });
    expect(repair.shape?.in_place).toMatchObject({
      cause: "missing",
      noticed: "start",
      after: by.key,
    });
    expect(first).toContain(h.folder);
    expect(first).toContain(repair.key);
    const notes = h.tasks.timeline(repair.id).length;

    const second = h.supervisor.inPlaceWork.folderMissing("shop", "land");
    expect(h.repairs()).toHaveLength(1);
    expect(second).toContain(repair.key);
    expect(second).not.toBe(first);
    expect(h.tasks.get(repair.id)?.shape?.in_place).toMatchObject({ noticed: "start" });
    expect(h.tasks.timeline(repair.id)).toHaveLength(notes);

    expect(h.supervisor.inPlaceWork.folderMissing("gone", "start")).toBe(
      "The project's folder is missing.",
    );
  });

  it("a later refusal updates the standing repair's facts, keeps where it started, and tells its crewmate; a merge outside any project files nothing", async () => {
    const h = shop();
    h.supervisor.inPlaceWork.folderMissing("shop", "start");
    const [repair] = h.repairs();
    if (!repair) throw new Error("no repair task was filed");
    await vi.waitFor(() => expect(h.crewmate.promptCalls).toHaveLength(1));
    const startedIn = h.tasks.get(repair.id)?.shape?.in_place;
    expect(startedIn).toMatchObject({ started_in: expect.any(String) });

    const answer = h.supervisor.inPlaceWork.fileFolderRepair(merged(h, "merged2"), {
      refreshed: false,
      cause: "dirty",
      branch: "main",
      reach: "c".repeat(40),
    });
    expect(answer).toMatchObject({ record: { id: repair.id }, filed: false });
    expect(h.repairs()).toHaveLength(1);
    expect(h.tasks.get(repair.id)?.shape?.in_place).toEqual({
      cause: "dirty",
      branch: "main",
      reach: "c".repeat(40),
      after: h.tasks.get("merged2")?.key,
      started_in: (startedIn as { started_in: string }).started_in,
    });
    const update = `Another merge, ${h.tasks.get("merged2")?.key}, could not bring the folder up to date either`;
    expect(h.tasks.timeline(repair.id).map((event) => event.text)).toContainEqual(
      expect.stringContaining(update),
    );
    await vi.waitFor(() =>
      expect(h.crewmate.steers.map((steer) => steer.text).join("\n")).toContain(update),
    );

    seedTask(h.tasks, { id: "loose", title: "Outside", status: "idle", repoId: null });
    const loose = h.tasks.get("loose");
    if (!loose) throw new Error("the loose task was not seeded");
    expect(
      h.supervisor.inPlaceWork.fileFolderRepair(loose, { refreshed: false, cause: "dirty" }),
    ).toBeUndefined();
  });

  it("files one pull repair per pull request, and none for a task with no project or no pull request", () => {
    const h = shop();
    const abandoned = merged(h, "dropped1");
    expect(h.supervisor.inPlaceWork.filePullRepair(abandoned, "it is protected")).toBeUndefined();
    seedDelivery(h.tasks, "dropped1", {
      prNumber: 12,
      prUrl: "https://github.com/octo/shop/pull/12",
    });
    const withPull = h.tasks.get("dropped1");
    if (!withPull) throw new Error("the abandoned task is gone");

    const first = h.supervisor.inPlaceWork.filePullRepair(withPull, "it is protected");
    expect(first).toMatchObject({ filed: true, record: { title: PULL_REPAIR_TITLE } });
    expect(first?.record.goal).toBe(
      `Close the pull request #12 of shop, which ${withPull.key} left open, or report why it cannot be closed.`,
    );
    expect(first?.record.shape?.in_place).toMatchObject({
      pull: {
        number: 12,
        label: "#12",
        url: "https://github.com/octo/shop/pull/12",
        problem: "it is protected",
      },
      after_id: "dropped1",
    });

    const again = h.supervisor.inPlaceWork.filePullRepair(withPull, "still protected");
    expect(again).toEqual({
      record: expect.objectContaining({ id: first?.record.id }),
      filed: false,
    });
    expect(h.repairs()).toHaveLength(1);

    seedTask(h.tasks, { id: "loose", title: "Outside", status: "idle", repoId: null });
    seedDelivery(h.tasks, "loose", { prNumber: 12 });
    const loose = h.tasks.get("loose");
    if (!loose) throw new Error("the loose task was not seeded");
    expect(h.supervisor.inPlaceWork.filePullRepair(loose, undefined)).toBeUndefined();
  });

  it("closes a pull repair once its pull request is merged, and keeps it open while its crewmate works, a card of its own is up, the pull request cannot be read or was not closed", async () => {
    let answer: "open" | "fails" | "merged" = "open";
    const readPull = vi.fn(async () => {
      if (answer === "fails") throw new Error("offline");
      return {
        state: answer === "merged" ? "closed" : "open",
        merged: answer === "merged",
      } as never;
    });
    const h = shop({
      folder: scratchDir("infinitary-shop-here-"),
      readPull,
    });
    const id = await pullRepair(h);

    // Its crewmate is mid-turn: not even read.
    answer = "merged";
    await h.supervisor.inPlaceWork.closeCurrentFolders();
    expect(readPull).not.toHaveBeenCalled();
    expect(h.tasks.get(id)?.status).toBe("active");
    h.crewmate.finishPrompt();
    await vi.waitFor(() => expect(h.tasks.get(id)?.activity).toBe("idle"));

    const card = h.supervisor.cards.addFirstmateCard({
      title: "Close #12?",
      body: "<p>Close it?</p>",
      taskId: id,
      actions: [],
    });
    await h.supervisor.inPlaceWork.closeCurrentFolders();
    expect(h.tasks.get(id)?.status).toBe("active");
    h.supervisor.cards.close(card, { kind: "firstmate" });

    answer = "open";
    await h.supervisor.inPlaceWork.closeCurrentFolders();
    answer = "fails";
    await h.supervisor.inPlaceWork.closeCurrentFolders();
    expect(h.tasks.get(id)?.status).toBe("active");

    answer = "merged";
    await h.supervisor.inPlaceWork.closeCurrentFolders();
    expect(h.tasks.get(id)).toMatchObject({ status: "done", closedReason: "finished" });
    expect(h.tasks.timeline(id).map((event) => event.text)).toContain(
      "The pull request #12 is merged where the project lives.",
    );
  });

  it("leaves a pull repair alone with no way to read pull requests, and a repair closed during its read stays as it was closed", async () => {
    const unread = shop({ folder: scratchDir("infinitary-shop-here-") });
    const unreadId = await pullRepair(unread);
    unread.crewmate.finishPrompt();
    await tick();
    await unread.supervisor.inPlaceWork.closeCurrentFolders();
    expect(unread.tasks.get(unreadId)?.status).toBe("active");

    // The captain drops the repair while the host reads the pull request.
    let repairId = "";
    const h = shop({
      folder: scratchDir("infinitary-shop-here-"),
      readPull: async () => {
        h.tasks.close(repairId, { status: "dropped", reason: "cancelled", actor: "captain" });
        return { state: "closed", merged: false } as never;
      },
    });
    repairId = await pullRepair(h);
    h.crewmate.finishPrompt();
    await vi.waitFor(() => expect(h.tasks.get(repairId)?.activity).toBe("idle"));
    await h.supervisor.inPlaceWork.closeCurrentFolders();
    expect(h.tasks.get(repairId)).toMatchObject({ status: "dropped", closedReason: "cancelled" });
    expect(h.tasks.timeline(repairId).map((event) => event.text)).not.toContainEqual(
      expect.stringContaining("is closed where the project lives"),
    );
  });

  it("a folder repair that named no branch reads the folder's own, stays open while either read fails, and closes at or past the merged version", async () => {
    const h = shop({ folder: scratchDir("infinitary-shop-here-") });
    const reach = "d".repeat(40);
    h.supervisor.inPlaceWork.fileFolderRepair(merged(h), {
      refreshed: false,
      cause: "diverged",
      reach,
    });
    const [repair] = h.repairs();
    if (!repair) throw new Error("no repair task was filed");
    await vi.waitFor(() => expect(h.crewmate.promptCalls).toHaveLength(1));
    h.crewmate.finishPrompt();
    await vi.waitFor(() => expect(h.tasks.get(repair.id)?.activity).toBe("idle"));

    h.reads.folderDefaultBranch.mockRejectedValueOnce(new Error("no HEAD"));
    await h.supervisor.inPlaceWork.closeCurrentFolders();
    expect(h.reads.folderCurrent).not.toHaveBeenCalled();
    h.reads.folderCurrent.mockRejectedValueOnce(new Error("locked"));
    await h.supervisor.inPlaceWork.closeCurrentFolders();
    expect(h.tasks.get(repair.id)?.status).toBe("active");

    h.reads.folderCurrent.mockResolvedValue(true);
    await h.supervisor.inPlaceWork.closeCurrentFolders();
    expect(h.reads.folderCurrent).toHaveBeenLastCalledWith(h.folder, "main", reach);
    expect(h.tasks.get(repair.id)).toMatchObject({ status: "done", closedReason: "finished" });
    expect(h.tasks.timeline(repair.id).map((event) => event.text)).toContain(
      `The project's folder is up to date: clean, on main and at or past ${reach.slice(0, 7)}.`,
    );
  });
});
