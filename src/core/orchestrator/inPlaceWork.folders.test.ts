/**
 * The host's own work in a project's folder as `InPlaceWork` files it
 * (docs/task-record.md): a merge that leaves the folder behind, a folder that
 * is missing or behind, a discard that leaves its pull request open, and work
 * the first mate declares in the folder.
 * Each case drives a real CrewSupervisor through the crew harness
 * (tests/helpers/crewHarness.ts) and reads what it answers, the cards and the record.
 * The cases drive real git.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { plainProblem } from "@shared/plainProblem";
import { isFolderRepair } from "@shared/routingPolicy";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fakeCrewmate,
  fakeCrewTimersEachTest,
  intentOf,
  SETTLE_MERGE,
  settleLines,
  setup,
  tick,
} from "../../../tests/helpers/crewHarness";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import { type Forge, ForgeError, type ForgePull } from "../forge";
import { crewmateComputersNote } from "../pi/piResources";
import type { CrewMachines } from "../placed/crewMachines";
import { seedTask } from "../tasks/seedTask";
import type { TaskService } from "../tasks/taskService";
import { git } from "../workspace/git";
import { type ChangeDelivery, createChangeDelivery } from "./changeDelivery";
import { folderUpToDateLine } from "./inPlaceWork";
import { FOLDER_REPAIR_TITLE, IN_PLACE_OPENING, PULL_REPAIR_TITLE } from "./intentBrief";

// This file chains real git and is not about the utility-QoS clamp, so what
// the product spawns runs at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

fakeCrewTimersEachTest();

/**
 * INF-549, the captain's words: "when a project folder couldn't be brought up
 * to date, were you informed? if so, why didn't you either resolve it, or ask
 * me? this needs to be corrected durably in infinitary." His approved plan: a
 * refused refresh leaves a note and a line on the merged task, and the host
 * files and starts one regular task under the project that works in the
 * folder itself, with no delivery line, and closes it once the folder is
 * clean, on the default branch and at or past the merged version.
 */
describe("a merge that leaves the project's folder behind (INF-549, real git)", {
  timeout: 60_000,
}, () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  const REAL_GIT_WAIT = { timeout: 20_000, interval: 25 };
  const run = (dir: string, ...args: string[]) =>
    git(dir, ["-c", "user.name=T", "-c", "user.email=t@l", ...args]);

  /** A project whose folder holds the captain's draft while origin moved on by one merge. */
  async function behindAfterMerge() {
    const crewmate = fakeCrewmate();
    let merged = "";
    const mergePullRequest = vi.fn(async () => ({
      ok: true,
      text: "Change #2 is in on GitHub.",
      receipt: { head: merged, sha: merged },
    }));
    const harness = setup(crewmate, { realWorkspace: true, mergePullRequest });
    const { repo } = await harness.repos.setup({ kind: "init", name: "shop" });
    const folder = repo.path;
    await run(folder, "commit", "--allow-empty", "-m", "chore: start");
    const origins = scratchDir("infinitary-folder-origin-");
    const remote = join(origins, "origin.git");
    await git(origins, ["init", "--bare", "--initial-branch=main", remote]);
    await run(folder, "remote", "add", "origin", remote);
    await run(folder, "push", "-u", "origin", "main");
    await run(folder, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    // Merging is automatic in this project, as it was for the folder INB-9 repaired.
    harness.repos.configure(repo.id, { origin: remote, delivery: "direct-pr", autonomy: true });
    // The pull request merged where the project lives, not in the folder.
    const clones = scratchDir("infinitary-folder-clone-");
    const other = join(clones, "clone");
    await git(clones, ["clone", remote, other]);
    await run(other, "commit", "--allow-empty", "-m", "feat: the merged change (#2)");
    await run(other, "push", "origin", "main");
    merged = await git(other, ["rev-parse", "HEAD"]);
    writeFileSync(join(folder, "draft.txt"), "the captain's draft\n");
    const ship = (id: string, title: string) =>
      seedTask(harness.tasks, {
        id,
        title,
        status: "idle",
        repoId: repo.id,
        repoDir: folder,
      });
    return { ...harness, crewmate, repo, folder, remote, merged, ship };
  }

  function repairOf(tasks: TaskService, repoId: string) {
    return tasks.list().filter((row) => row.repoId === repoId && row.shape?.in_place);
  }

  it("the first mate's own merge files and starts the repair in the folder, with no delivery line, and the repair closes once the folder is current", async () => {
    const h = await behindAfterMerge();
    h.ship("shipped1", "Ship the shop");

    const reply = await h.supervisor.settling.settle.settleTask("shipped1", "merge-pr");

    const [repair] = repairOf(h.tasks, h.repo.id);
    if (!repair) throw new Error("no repair task was filed");
    const sentence = `Merged, but your project's folder was not brought up to date: it has edits that are not committed. Infinitary started ${repair.key} "${FOLDER_REPAIR_TITLE}" to do it.`;
    expect(reply).toContain(sentence);
    expect(h.tasks.get("shipped1")).toMatchObject({ status: "done", closedReason: "merged" });
    // The fact is kept on the merged task's record, and it is the Activity
    // line, since the first mate's own settle writes none of its own.
    const note = h.tasks.timeline("shipped1").find((event) => event.data?.folderRefresh);
    expect(note).toMatchObject({ text: sentence, feed: true });
    expect(note?.data?.folderRefresh).toMatchObject({
      cause: "dirty",
      branch: "main",
      reach: h.merged,
    });
    expect(repair).toMatchObject({
      title: FOLDER_REPAIR_TITLE,
      startPolicy: "when-ready",
    });

    // It starts on its own, in the folder itself, with a brief that names no delivery.
    await vi.waitFor(() => expect(h.crewmate.promptCalls).toHaveLength(1), REAL_GIT_WAIT);
    const session = h.sessionSpecs.at(-1);
    expect(session?.cwd).toBe(h.folder);
    expect(h.tasks.get(repair.id)).toMatchObject({ status: "active", worktreeDir: "", branch: "" });
    const brief = h.crewmate.promptCalls[0] ?? "";
    expect(brief).toContain(`Folder: ${h.folder}`);
    expect(brief).toContain(`Merged version: ${h.merged}`);
    expect(brief).toContain(
      "Why it was not brought up to date: it has edits that are not committed",
    );
    expect(brief).toContain(IN_PLACE_OPENING);
    expect(brief).not.toContain("Delivery:");
    expect(brief).not.toContain("open_change");
    expect(h.specs.at(-1)?.procedure).toEqual({ delivery: "none", rigor: "none" });
    expect(h.specs.at(-1)?.onOpenChange).toBeUndefined();

    // A second refusal while it stands updates it and files nothing new.
    h.crewmate.finishPrompt();
    await vi.waitFor(() => expect(h.tasks.get(repair.id)?.activity).toBe("idle"), REAL_GIT_WAIT);
    h.ship("shipped2", "Ship the shop again");
    expect(await h.supervisor.settling.settle.settleTask("shipped2", "merge-pr")).toContain(
      `${repair.key} "${FOLDER_REPAIR_TITLE}" is already doing it.`,
    );
    expect(repairOf(h.tasks, h.repo.id)).toHaveLength(1);
    // The standing crewmate is told of the newer version, on a turn of its own.
    await vi.waitFor(() => expect(h.crewmate.promptCalls).toHaveLength(2), REAL_GIT_WAIT);
    expect(h.crewmate.promptCalls[1]).toContain("Another merge, SHOP-");
    h.crewmate.finishPrompt();
    await vi.waitFor(() => expect(h.tasks.get(repair.id)?.activity).toBe("idle"), REAL_GIT_WAIT);

    // Still behind: the host leaves it open.
    await h.supervisor.inPlaceWork.closeCurrentFolders();
    expect(h.tasks.get(repair.id)?.status).toBe("active");

    // The crewmate sets the draft aside and fast-forwards; the host sees it
    // and closes the task as settled, with its own line.
    await run(h.folder, "stash", "push", "-u", "-m", `${repair.key}: the captain's draft`);
    await run(h.folder, "pull", "--ff-only", "origin", "main");
    await h.supervisor.inPlaceWork.closeCurrentFolders();
    expect(h.tasks.get(repair.id)).toMatchObject({ status: "done", closedReason: "finished" });
    expect(h.tasks.timeline(repair.id)).toContainEqual(
      expect.objectContaining({
        text: folderUpToDateLine("main", h.merged),
        feed: true,
      }),
    );
    await h.supervisor.disposeAll();
  });

  it("the captain's merge click keeps the fact on the record, and its own line says it once", async () => {
    const h = await behindAfterMerge();
    h.ship("clicked1", "Ship the shop");
    const card = h.supervisor.addFirstmateCard({
      requiredActions: [],
      taskId: "clicked1",
      title: "Ready to merge",
      body: "Merge the shop change.",
      actions: [{ id: "merge", label: "Merge", effect: SETTLE_MERGE }],
    });
    h.supervisor.cardActions.act(card, "merge");

    // The merge closes the task first; the folder is read after it.
    await vi.waitFor(() => expect(repairOf(h.tasks, h.repo.id)).toHaveLength(1), REAL_GIT_WAIT);
    expect(h.tasks.get("clicked1")).toMatchObject({ status: "done", closedReason: "merged" });
    const [repair] = repairOf(h.tasks, h.repo.id);
    if (!repair) throw new Error("no repair task was filed");
    const sentence = `Merged, but your project's folder was not brought up to date: it has edits that are not committed. Infinitary started ${repair.key} "${FOLDER_REPAIR_TITLE}" to do it.`;
    // INF-1845: the note is the task's keyed warning line beside the merge's own line.
    await vi.waitFor(
      () =>
        expect(
          h.tasks.timeline("clicked1").find((event) => event.data?.folderRefresh),
        ).toMatchObject({ text: sentence, feed: true }),
      REAL_GIT_WAIT,
    );
    expect(settleLines(h.tasks, "clicked1").filter((line) => line.includes(sentence))).toEqual([]);
    await vi.waitFor(() => expect(h.sessionSpecs.at(-1)?.cwd).toBe(h.folder), REAL_GIT_WAIT);
    await h.supervisor.disposeAll();
  });

  // INF-583: a repair filed because the folder named no default branch, or
  // had no origin, closes once its crewmate has fixed the folder, like any
  // other folder repair.
  it.each(["no-default-branch", "no-origin"] as const)(
    "a repair filed for %s has its crewmate name origin's default branch, and closes once it is named and the folder is current",
    async (cause) => {
      const h = await behindAfterMerge();
      rmSync(join(h.folder, "draft.txt"));
      if (cause === "no-origin") await run(h.folder, "remote", "remove", "origin");
      else await run(h.folder, "symbolic-ref", "--delete", "refs/remotes/origin/HEAD");
      h.ship("shipped1", "Ship the shop");

      await h.supervisor.settling.settle.settleTask("shipped1", "merge-pr");

      const [repair] = repairOf(h.tasks, h.repo.id);
      if (!repair) throw new Error("no repair task was filed");
      expect(repair.shape?.in_place).toMatchObject({ cause, reach: h.merged });
      expect(repair.shape?.in_place).not.toHaveProperty("branch");
      await vi.waitFor(() => expect(h.crewmate.promptCalls).toHaveLength(1), REAL_GIT_WAIT);
      const brief = h.crewmate.promptCalls[0] ?? "";
      expect(brief).toContain(
        "Make sure origin's HEAD names the default branch: `git remote set-head origin --auto` sets it from where the project lives",
      );
      if (cause === "no-origin") {
        expect(brief).toContain(`The folder has no remote called origin: add it at ${h.remote}`);
      }
      h.crewmate.finishPrompt();
      await vi.waitFor(() => expect(h.tasks.get(repair.id)?.activity).toBe("idle"), REAL_GIT_WAIT);

      // A pull of the one branch brings the folder level but leaves origin's
      // HEAD unset, so the host still reads no default branch.
      if (cause === "no-origin") await run(h.folder, "remote", "add", "origin", h.remote);
      await run(h.folder, "pull", "--ff-only", "origin", "main");
      await h.supervisor.inPlaceWork.closeCurrentFolders();
      expect(h.tasks.get(repair.id)?.status).toBe("active");

      // The crewmate names it as its brief says; the host reads the folder
      // current and closes the task as settled, with its own line.
      await run(h.folder, "remote", "set-head", "origin", "--auto");
      await h.supervisor.inPlaceWork.closeCurrentFolders();
      expect(h.tasks.get(repair.id)).toMatchObject({ status: "done", closedReason: "finished" });
      expect(h.tasks.timeline(repair.id)).toContainEqual(
        expect.objectContaining({
          text: folderUpToDateLine("main", h.merged),
          feed: true,
        }),
      );
      await h.supervisor.disposeAll();
    },
  );
});

/**
 * INF-572, the captain's words: "pass this evidence back to first mate and
 * ask it to figure out how to handle this kind of local inconsistencies".
 * The approved plan: a missing folder is called missing wherever work needs
 * it, refuses that work naming the folder and its repair, and the repair
 * starts above it; at each app start a clean folder behind on its default
 * branch is brought up to date, one with edits or its own commits gets the
 * repair, a missing one and one on another branch are left alone, and a
 * repair the captain closed comes back only once where the project lives moved on.
 */
describe("a project folder that is missing or behind (INF-572, real git)", {
  timeout: 60_000,
}, () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  const REAL_GIT_WAIT = { timeout: 20_000, interval: 25 };
  const run = (dir: string, ...args: string[]) =>
    git(dir, ["-c", "user.name=T", "-c", "user.email=t@l", ...args]);

  /** A project with an address, its folder level with origin, and a clone that merges "on the website". */
  async function project() {
    const crewmate = fakeCrewmate();
    const mergePullRequest = vi.fn(async () => ({ ok: true, text: "Change #2 is in on GitHub." }));
    const harness = setup(crewmate, { realWorkspace: true, mergePullRequest });
    const { repo: created } = await harness.repos.setup({ kind: "init", name: "shop" });
    const folder = created.path;
    await run(folder, "commit", "--allow-empty", "-m", "chore: start");
    const origins = scratchDir("infinitary-missing-origin-");
    const remote = join(origins, "origin.git");
    await git(origins, ["init", "--bare", "--initial-branch=main", remote]);
    await run(folder, "remote", "add", "origin", remote);
    await run(folder, "push", "-u", "origin", "main");
    await run(folder, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    // Merging is automatic, so the first mate's own merge goes through.
    const repo = harness.repos.configure(created.id, {
      origin: remote,
      delivery: "direct-pr",
      autonomy: true,
    });
    const clone = join(scratchDir("infinitary-missing-clone-"), "clone");
    await git(dirname(clone), ["clone", remote, clone]);
    const mergeOnWebsite = async (message: string) => {
      await run(clone, "commit", "--allow-empty", "-m", message);
      await run(clone, "push", "origin", "main");
      return git(clone, ["rev-parse", "HEAD"]);
    };
    const repairs = () =>
      harness.tasks.list().filter((row) => row.repoId === repo.id && row.shape?.in_place);
    const notes = () =>
      harness.events.flatMap((event) => (event.type === "firstmate_note" ? [event.text] : []));
    return { ...harness, crewmate, repo, folder, remote, mergeOnWebsite, repairs, notes };
  }

  it("a merge's update calls a deleted folder missing, and its repair starts above it and closes once the folder is back", async () => {
    const h = await project();
    seedTask(h.tasks, {
      id: "shipped1",
      title: "Ship the shop",
      status: "idle",
      repoId: h.repo.id,
      repoDir: h.folder,
    });
    rmSync(h.folder, { recursive: true, force: true });

    const reply = await h.supervisor.settling.settle.settleTask("shipped1", "merge-pr");

    const [repair] = h.repairs();
    if (!repair) throw new Error("no repair task was filed");
    expect(reply).toContain(
      `Merged, but your project's folder was not brought up to date: it is missing. Infinitary started ${repair.key} "${FOLDER_REPAIR_TITLE}" to do it.`,
    );
    expect(repair.shape?.in_place).toMatchObject({ cause: "missing" });

    // It starts in the folder that held the missing one, with the missing folder's brief.
    await vi.waitFor(() => expect(h.crewmate.promptCalls).toHaveLength(1), REAL_GIT_WAIT);
    const parent = dirname(h.folder);
    expect(h.sessionSpecs.at(-1)?.cwd).toBe(parent);
    expect(h.tasks.get(repair.id)?.shape?.in_place).toMatchObject({ started_in: parent });
    const brief = h.crewmate.promptCalls[0] ?? "";
    expect(brief).toContain(`Goal: bring back the folder of shop at ${h.folder}`);
    expect(brief).toContain(`your working directory is ${parent}`);
    expect(brief).toContain(`clone it again from there into exactly ${h.folder}`);
    expect(brief).toContain("In every other case change nothing and ask the captain on a card");
    expect(brief).toContain(`Where the project lives: ${h.remote}`);
    h.crewmate.finishPrompt();
    await vi.waitFor(() => expect(h.tasks.get(repair.id)?.activity).toBe("idle"), REAL_GIT_WAIT);

    // Still missing: it stays open.
    await h.supervisor.inPlaceWork.closeCurrentFolders();
    expect(h.tasks.get(repair.id)?.status).toBe("active");

    // The crewmate clones it again; the host reads it back and closes the task.
    await git(parent, ["clone", h.remote, h.folder]);
    await h.supervisor.inPlaceWork.closeCurrentFolders();
    expect(h.tasks.get(repair.id)).toMatchObject({ status: "done", closedReason: "finished" });
    expect(h.tasks.timeline(repair.id)).toContainEqual(
      expect.objectContaining({
        text: "The project's folder is back: clean, on main and level with origin's main.",
        feed: true,
      }),
    );
    await h.supervisor.disposeAll();
  });

  it("refuses a task starting on this computer while its folder is missing, naming the folder and the one repair", async () => {
    const h = await project();
    seedTask(h.tasks, {
      id: "header01",
      title: "Fix the header",
      status: "queued",
      repoId: h.repo.id,
    });
    seedTask(h.tasks, {
      id: "footer01",
      title: "Fix the footer",
      status: "queued",
      repoId: h.repo.id,
    });
    rmSync(h.folder, { recursive: true, force: true });

    await h.supervisor.starts.dispatchQueuedTask("header01");
    const [repair] = h.repairs();
    if (!repair) throw new Error("no repair task was filed");
    const header = h.tasks.get("header01");
    expect(header?.status).toBe("open");
    expect(header?.gate).toMatchObject({ kind: "captain", ref: "dispatch-failed" });
    expect(header?.gate?.reason).toContain(
      `Your project's folder ${h.folder} is missing, so this task cannot start on this computer. Infinitary started ${repair.key} "${FOLDER_REPAIR_TITLE}" to bring it back.`,
    );
    expect(repair.shape?.in_place).toMatchObject({
      cause: "missing",
      noticed: "start",
      after: header?.key,
    });
    await vi.waitFor(() => expect(h.crewmate.promptCalls).toHaveLength(1), REAL_GIT_WAIT);
    expect(h.crewmate.promptCalls[0]).toContain(
      `When ${header?.key} was starting on this computer`,
    );

    // A second task finds the same repair standing, and nothing new is filed.
    await h.supervisor.starts.dispatchQueuedTask("footer01");
    expect(h.tasks.get("footer01")?.gate?.reason).toContain(
      `${repair.key} "${FOLDER_REPAIR_TITLE}" is already bringing it back.`,
    );
    expect(h.repairs()).toHaveLength(1);
    await h.supervisor.disposeAll();
  });

  // INF-584: the plan assumed folder work (INF-567's in_folder) is refused
  // the same way, rather than starting its crewmate in a folder that is gone.
  it("refuses folder work starting while its folder is missing, with the same words, and files the one repair", async () => {
    const h = await project();
    const folderRepairs = () =>
      h.tasks
        .list()
        .filter((row) => row.repoId === h.repo.id && isFolderRepair(row.shape?.in_place));
    const intent = {
      goal: "Bring the shop folder up to date with main.",
      userWords: "bring the shop folder up to date",
      constraints: [],
    };
    const queued = h.supervisor.intake.plan({
      title: "Tidy the shop folder",
      intent,
      repoId: h.repo.id,
      shape: { in_folder: true },
    });
    rmSync(h.folder, { recursive: true, force: true });

    await expect(
      h.supervisor.intake.commission({
        title: "Update the shop folder",
        intent,
        repoId: h.repo.id,
        shape: { in_folder: true },
      }),
    ).rejects.toThrow(
      `Your project's folder ${h.folder} is missing, so this task cannot start on this computer. Infinitary started `,
    );
    const [repair] = folderRepairs();
    if (!repair) throw new Error("no repair task was filed");
    expect(repair).toMatchObject({ title: FOLDER_REPAIR_TITLE });
    expect(repair.shape?.in_place).toMatchObject({ cause: "missing", noticed: "start" });

    // The repair itself still starts, in the folder above the missing one.
    await vi.waitFor(() => expect(h.crewmate.promptCalls).toHaveLength(1), REAL_GIT_WAIT);
    expect(h.sessionSpecs.at(-1)?.cwd).toBe(dirname(h.folder));
    expect(h.crewmate.promptCalls[0]).toContain(
      `Goal: bring back the folder of shop at ${h.folder}`,
    );

    // Queued folder work waits behind the same words, naming the standing repair.
    await h.supervisor.starts.dispatchQueuedTask(queued.id);
    const waiting = h.tasks.get(queued.id);
    expect(waiting?.status).toBe("open");
    expect(waiting?.gate).toMatchObject({ kind: "captain", ref: "dispatch-failed" });
    expect(waiting?.gate?.reason).toContain(
      `Your project's folder ${h.folder} is missing, so this task cannot start on this computer. ${repair.key} "${FOLDER_REPAIR_TITLE}" is already bringing it back.`,
    );
    expect(folderRepairs()).toHaveLength(1);
    expect(h.sessionSpecs.map((spec) => spec.cwd)).not.toContain(h.folder);
    await h.supervisor.disposeAll();
  });

  // INF-585: a repair that started above its missing folder and then failed
  // to start handed that folder to the working copy's removal, which deleted
  // it with every project beside it. Its goal: that folder stays untouched.
  it("a repair that started above its missing folder and fails to start leaves that folder and the projects beside it as they were", async () => {
    const h = await project();
    const parent = dirname(h.folder);
    const blog = join(parent, "blog");
    mkdirSync(blog);
    writeFileSync(join(blog, "post.md"), "# The captain's draft\n");
    const untouched = () =>
      expect(readFileSync(join(blog, "post.md"), "utf8")).toBe("# The captain's draft\n");
    seedTask(h.tasks, {
      id: "header01",
      title: "Fix the header",
      status: "queued",
      repoId: h.repo.id,
    });
    // The captain moved the folder somewhere else.
    const moved = join(scratchDir("infinitary-moved-"), "shop");
    renameSync(h.folder, moved);
    const unchecked = new Error("This custom connection needs its checked account.");
    h.sessions.open.mockRejectedValueOnce(unchecked);

    // The first start: the repair opens in the folder above, and its crewmate cannot open.
    await h.supervisor.starts.dispatchQueuedTask("header01");
    const [repair] = h.repairs();
    if (!repair) throw new Error("no repair task was filed");
    await vi.waitFor(
      () =>
        expect(h.tasks.get(repair.id)?.gate).toMatchObject({
          kind: "captain",
          ref: "dispatch-failed",
        }),
      REAL_GIT_WAIT,
    );
    expect(h.sessions.open.mock.calls[0]?.[0].cwd).toBe(parent);
    untouched();

    // The captain names the folder's new place and presses Start; it fails again.
    h.repos.configure(h.repo.id, { path: moved });
    h.sessions.open.mockRejectedValueOnce(unchecked);
    await h.supervisor.starts.dispatchQueuedTask(repair.id, { requested: { by: "captain" } });
    expect(h.sessions.open).toHaveBeenCalledTimes(2);
    expect(h.tasks.get(repair.id)?.gate?.reason).toContain(unchecked.message);
    untouched();
    expect(await git(moved, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
    await h.supervisor.disposeAll();
  });

  // INF-757: once the captain named a moved folder's new place, the standing
  // repair kept starting in the folder above the old one while its brief
  // named the new folder. Its goal: it starts in the folder the captain named.
  it("a repair that started above its missing folder starts in the folder the captain names for it", async () => {
    const h = await project();
    const parent = dirname(h.folder);
    seedTask(h.tasks, {
      id: "header01",
      title: "Fix the header",
      status: "queued",
      repoId: h.repo.id,
    });
    // The captain moved the folder somewhere else.
    const moved = join(scratchDir("infinitary-moved-"), "shop");
    renameSync(h.folder, moved);
    h.sessions.open.mockRejectedValueOnce(
      new Error("This custom connection needs its checked account."),
    );

    // The first start opens in the folder above the missing one, and fails.
    await h.supervisor.starts.dispatchQueuedTask("header01");
    const [repair] = h.repairs();
    if (!repair) throw new Error("no repair task was filed");
    await vi.waitFor(
      () =>
        expect(h.tasks.get(repair.id)?.gate).toMatchObject({
          kind: "captain",
          ref: "dispatch-failed",
        }),
      REAL_GIT_WAIT,
    );
    expect(h.sessions.open.mock.calls[0]?.[0].cwd).toBe(parent);

    // The captain names the folder's new place and presses Start.
    const named = h.repos.configure(h.repo.id, { path: moved }).path;
    await h.supervisor.starts.dispatchQueuedTask(repair.id, { requested: { by: "captain" } });
    await vi.waitFor(() => expect(h.crewmate.promptCalls).toHaveLength(1), REAL_GIT_WAIT);
    expect(h.sessions.open.mock.calls[1]?.[0].cwd).toBe(named);
    const brief = h.crewmate.promptCalls[0] ?? "";
    expect(brief).toContain(`- Folder: ${named}`);
    expect(brief).toContain(`your working directory is ${named}, the project's folder itself`);
    // A resume of this conversation opens where it started, not above the old folder.
    expect(h.tasks.get(repair.id)?.shape?.in_place).not.toHaveProperty("started_in");
    expect(h.tasks.get(repair.id)?.repoDir).toBe(named);
    await h.supervisor.disposeAll();
  });

  it("refuses a merge into a folder that is missing, and files its repair", async () => {
    const h = await project();
    h.repos.configure(h.repo.id, { delivery: "local-only" });
    seedTask(h.tasks, {
      id: "landed01",
      title: "Land the shop",
      status: "idle",
      repoId: h.repo.id,
      repoDir: h.folder,
      branch: "fm/task-landed01",
    });
    rmSync(h.folder, { recursive: true, force: true });

    const reply = await h.supervisor.settling.settle.settleTask("landed01", "land");

    const [repair] = h.repairs();
    if (!repair) throw new Error("no repair task was filed");
    expect(reply).toContain(
      `Your project's folder ${h.folder} is missing, so nothing can be merged into it.`,
    );
    expect(h.tasks.get("landed01")?.status).not.toBe("done");
    expect(repair.shape?.in_place).toMatchObject({ cause: "missing", noticed: "land" });
    await h.supervisor.disposeAll();
  });

  it("at app start brings a clean folder up to date, files the repair for one with edits, and leaves one on another branch or missing", async () => {
    const h = await project();
    // Merged on the website: the clean folder moves forward, with one line.
    const first = await h.mergeOnWebsite("feat: merged on the website (#3)");
    await h.supervisor.inPlaceWork.checkFoldersAtStart();
    expect(await git(h.folder, ["rev-parse", "HEAD"])).toBe(first);
    expect(h.notes()).toEqual([
      "The folder of shop was behind where the project lives; Infinitary brought its main up to date.",
    ]);
    expect(h.repairs()).toEqual([]);

    // On another branch: left alone, and nothing is said.
    const second = await h.mergeOnWebsite("feat: another merge (#4)");
    await run(h.folder, "checkout", "-b", "spike");
    await h.supervisor.inPlaceWork.checkFoldersAtStart();
    expect(await git(h.folder, ["rev-parse", "main"])).toBe(first);
    expect(h.repairs()).toEqual([]);

    // Behind with the captain's edits: the repair, which says the start found it.
    await run(h.folder, "checkout", "main");
    writeFileSync(join(h.folder, "draft.txt"), "the captain's draft\n");
    await h.supervisor.inPlaceWork.checkFoldersAtStart();
    const [repair] = h.repairs();
    if (!repair) throw new Error("no repair task was filed");
    expect(repair.shape?.in_place).toMatchObject({
      cause: "dirty",
      noticed: "app-start",
      branch: "main",
      remote: second,
    });
    expect(repair.prompt).toContain("When the app started and read where the project lives");
    expect(h.notes()).toHaveLength(1);
    await h.supervisor.disposeAll();
  });

  it("at app start leaves a missing folder for the work that next needs it", async () => {
    const h = await project();
    await h.mergeOnWebsite("feat: merged on the website (#3)");
    rmSync(h.folder, { recursive: true, force: true });
    await h.supervisor.inPlaceWork.checkFoldersAtStart();
    expect(h.repairs()).toEqual([]);
    expect(h.notes()).toEqual([]);
    await h.supervisor.disposeAll();
  });

  it("files a repair the captain closed again only once where the project lives has moved on", async () => {
    const h = await project();
    await h.mergeOnWebsite("feat: merged on the website (#3)");
    await run(h.folder, "commit", "--allow-empty", "-m", "chore: the captain's own commit");
    await h.supervisor.inPlaceWork.checkFoldersAtStart();
    const [closed] = h.repairs();
    if (!closed) throw new Error("no repair task was filed");
    expect(closed.shape?.in_place).toMatchObject({ cause: "diverged" });
    h.tasks.close(closed.id, { status: "dropped", reason: "cancelled", actor: "captain" });

    // The next start: nothing moved where the project lives, so nothing is filed.
    await h.supervisor.inPlaceWork.checkFoldersAtStart();
    expect(h.repairs()).toHaveLength(1);

    // Where the project lives moved on: the repair comes back once.
    const moved = await h.mergeOnWebsite("feat: a later merge (#5)");
    await h.supervisor.inPlaceWork.checkFoldersAtStart();
    const again = h.repairs().filter((row) => row.id !== closed.id);
    expect(again).toHaveLength(1);
    expect(again[0]?.shape?.in_place).toMatchObject({ cause: "diverged", remote: moved });
    await h.supervisor.disposeAll();
  });
});

/**
 * INF-549's sibling, the captain's words: "Yes, as its own small change after
 * this one, with a brief that says close the pull request or report why not".
 * A discard whose pull request GitHub would not close files and starts the
 * same kind of in-place task, which reads and writes where the project lives
 * and closes once the host reads that pull request closed.
 */
describe("a discard that leaves its pull request open (INF-549's sibling)", () => {
  const refused = "Resource not accessible by integration";

  async function discardRefused() {
    const crewmate = fakeCrewmate();
    let state: ForgePull["state"] = "open";
    const forge = {
      kind: "github",
      host: "github.com",
      place: "GitHub",
      hasChecks: true,
      changeFor: vi.fn(async (branch: string) => ({
        number: 9,
        branch,
        headSha: "abc",
        url: null,
      })),
      close: vi.fn(async () => {
        throw new ForgeError("refused", refused);
      }),
      pull: vi.fn(async (number: number) => ({
        number,
        state,
        merged: false,
        headSha: "abc",
        base: "main",
        readiness: { kind: "unknown" },
      })),
      label: () => "#9",
      url: () => "https://github.com/acme/shop/pull/9",
    } as unknown as Forge;
    let delivery: ChangeDelivery;
    const githubWrite = vi.fn(async () => "200 OK");
    const githubRead = vi.fn(async () => "200 OK");
    const harness = setup(crewmate, {
      closePullRequest: (id) => delivery.merges.close(id),
      readPull: (id, number) => delivery.merges.pullState(id, number),
      githubRead,
      githubWrite,
    });
    delivery = createChangeDelivery({
      tasks: harness.tasks,
      repos: harness.repos,
      forgeFor: () => forge,
    });
    const { repo } = await harness.repos.setup({ kind: "init", name: "shop" });
    harness.repos.configure(repo.id, { delivery: "direct-pr" });
    const { taskId } = await harness.supervisor.intake.commission({
      title: "An idea the captain dropped",
      intent: intentOf("try the new meter"),
      repoId: repo.id,
    });
    seedDelivery(harness.tasks, taskId, {
      prNumber: 9,
      prUrl: "https://github.com/acme/shop/pull/9",
    });
    await tick();
    crewmate.finishPrompt();
    await tick();
    const repairs = () => harness.tasks.list().filter((row) => row.shape?.in_place);
    const closeOnGitHub = () => {
      state = "closed";
    };
    return { ...harness, crewmate, repo, taskId, repairs, closeOnGitHub, forge, githubWrite };
  }

  it("the first mate's discard files and starts a task that closes the pull request or says why not, and it closes once the pull request is closed", async () => {
    const h = await discardRefused();

    const reply = await h.supervisor.settling.settle.settleTask(h.taskId, "discard");

    const [repair] = h.repairs();
    if (!repair) throw new Error("no repair task was filed");
    const sentence = `Infinitary started ${repair.key} "${PULL_REPAIR_TITLE}" to close it.`;
    expect(reply).toContain(sentence);
    expect(h.tasks.get(h.taskId)).toMatchObject({ status: "dropped", closedReason: "discarded" });
    // The discarded task's record keeps the fact, as an Activity line of its own.
    const note = h.tasks.timeline(h.taskId).find((event) => event.data?.pullRepair);
    expect(note).toMatchObject({
      text: `Its pull request is still open where the project lives: ${plainProblem(refused)}. ${sentence}`,
      feed: true,
      data: expect.objectContaining({ problem: refused }),
    });
    // The first mate still reads what GitHub said.
    expect(reply).toContain(`Could not close PR: ${refused}`);
    expect(repair).toMatchObject({ title: PULL_REPAIR_TITLE, startPolicy: "when-ready" });

    // It starts on its own, in the project's folder, with the GitHub pair and nothing that ships.
    await vi.waitFor(() => expect(h.crewmate.promptCalls).toHaveLength(2));
    expect(h.sessionSpecs.at(-1)?.cwd).toBe(h.repo.path);
    expect(h.tasks.get(repair.id)).toMatchObject({ status: "active", worktreeDir: "", branch: "" });
    const brief = h.crewmate.promptCalls[1] ?? "";
    expect(brief).toContain("close the pull request #9 (https://github.com/acme/shop/pull/9)");
    expect(brief).toContain("or report why it cannot be closed");
    expect(brief).toContain(`What the project's host answered: ${refused}`);
    expect(brief).toContain(IN_PLACE_OPENING);
    expect(brief).not.toContain("Delivery:");
    expect(brief).not.toContain("open_change");
    const spec = h.specs.at(-1);
    expect(spec?.procedure).toEqual({ delivery: "none", rigor: "none" });
    expect(spec?.onOpenChange).toBeUndefined();
    expect(spec?.onCheckChange).toBeUndefined();
    expect(spec?.onGithubWrite).toBeDefined();
    expect(spec?.onGithubRead).toBeDefined();
    h.crewmate.finishPrompt();
    await vi.waitFor(() => expect(h.tasks.get(repair.id)?.activity).toBe("idle"));

    // Still open where the project lives: the host leaves it open.
    await h.supervisor.inPlaceWork.closeCurrentFolders();
    expect(h.tasks.get(repair.id)?.status).toBe("active");

    // Closed on GitHub: the host reads it closed and closes the task, with its own line.
    h.closeOnGitHub();
    await h.supervisor.inPlaceWork.closeCurrentFolders();
    expect(h.tasks.get(repair.id)).toMatchObject({ status: "done", closedReason: "finished" });
    expect(h.tasks.timeline(repair.id)).toContainEqual(
      expect.objectContaining({
        text: "The pull request #9 is closed where the project lives.",
        feed: true,
      }),
    );
    await h.supervisor.disposeAll();
  });

  it("the captain's discard click says it once on the feed, and a second try at the same pull request files nothing new", async () => {
    const h = await discardRefused();

    await h.supervisor.settling.settle.requestDiscard(h.taskId);

    const [repair] = h.repairs();
    if (!repair) throw new Error("no repair task was filed");
    expect(settleLines(h.tasks, h.taskId)).toContainEqual(
      expect.stringMatching(
        new RegExp(
          `^Discarded\\. Its pull request is still open where the project lives: .+\\. Infinitary started ${repair.key} "${PULL_REPAIR_TITLE}" to close it\\.$`,
        ),
      ),
    );
    const note = h.tasks.timeline(h.taskId).find((event) => event.data?.pullRepair);
    expect(note).toMatchObject({ feed: false });

    // The same pull request again names the standing task.
    const discarded = h.tasks.get(h.taskId);
    if (!discarded) throw new Error("the discarded task is gone");
    expect(h.supervisor.inPlaceWork.filePullRepair(discarded, refused)).toMatchObject({
      record: { id: repair.id },
      filed: false,
    });
    expect(h.repairs()).toHaveLength(1);
    await h.supervisor.disposeAll();
  });
});

/**
 * INF-567, the captain's words: "hmm this is because we set this up on my
 * macbook? pass this evidence back to first mate and ask it to figure out
 * how to handle this kind of local inconsistencies". His approved plan,
 * direction A: a task the first mate declares as folder work runs on the
 * computer keeping the folder, inside it, shipping nothing, even when the
 * project's Runs on names another computer.
 */
describe("work the first mate declares in a project's folder (INF-567, real git)", {
  timeout: 60_000,
}, () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  const REAL_GIT_WAIT = { timeout: 8_000, interval: 25 };
  const MINI = "mini-device";

  /** A project whose Runs on is the Mac mini, which is out of reach, as INB-9's was set. */
  async function runsOnTheMini() {
    const crewmate = fakeCrewmate();
    const machines = {
      computers: () => [MINI],
      ready: () => false,
      nameOf: () => "Kun's Mac mini",
      placeOf: () => ({ label: "Kun's Mac mini", where: "on Kun's Mac mini" }),
      signInWait: () => undefined,
    } as unknown as CrewMachines;
    const harness = setup(crewmate, { realWorkspace: true, machines });
    const { repo } = await harness.repos.setup({ kind: "init", name: "business" });
    await git(repo.path, [
      "-c",
      "user.name=T",
      "-c",
      "user.email=t@l",
      "commit",
      "--allow-empty",
      "-m",
      "chore: start",
    ]);
    const remote = join(scratchDir("infinitary-folder-work-origin-"), "origin.git");
    await git(dirname(remote), ["init", "--bare", "--initial-branch=main", remote]);
    harness.repos.configure(repo.id, { origin: remote, delivery: "direct-pr" });
    harness.repos.setRunsOn(repo.id, MINI);
    return { ...harness, crewmate, repo };
  }

  const intent = (goal: string) => ({
    goal,
    userWords: "bring the business folder up to date",
    constraints: [],
  });

  it("starts on this computer inside the folder with no delivery line, while an ordinary task of the project waits for the Mac mini", async () => {
    const h = await runsOnTheMini();

    // An ordinary task follows the project's Runs on and waits for that computer.
    const ordinary = await h.supervisor.intake.commission({
      title: "Edit the one-pager",
      intent: intent("Edit the one-pager."),
      repoId: h.repo.id,
    });
    expect(ordinary.crewmate).toBe("queued");
    expect(h.tasks.get(ordinary.taskId)?.deviceId).toBe(MINI);

    // Folder work starts here, in the folder itself.
    const folder = await h.supervisor.intake.commission({
      title: "Bring the business folder up to date",
      intent: intent("Bring the business folder up to date with main."),
      repoId: h.repo.id,
      shape: { in_folder: true },
    });
    await vi.waitFor(() => expect(h.crewmate.promptCalls).toHaveLength(1), REAL_GIT_WAIT);
    expect(h.tasks.get(folder.taskId)).toMatchObject({
      status: "active",
      deviceId: null,
      worktreeDir: "",
      branch: "",
    });
    expect(h.tasks.get(folder.taskId)?.shape?.in_place).toEqual({ folder: true });
    expect(h.sessionSpecs.at(-1)?.cwd).toBe(h.repo.path);
    const brief = h.crewmate.promptCalls[0] ?? "";
    expect(brief).toContain(`the folder of business at ${h.repo.path} itself`);
    expect(brief).not.toContain("Delivery:");
    expect(h.specs.at(-1)?.procedure).toEqual({ delivery: "none", rigor: "none" });
    expect(h.specs.at(-1)?.onOpenChange).toBeUndefined();
    // A crewmate on the computer keeping the folder is told the captain's
    // computers and that it runs there (INF-992: "make sure crewmates are
    // aware of the machines the user has").
    expect(h.specs.at(-1)?.computers).toEqual({ workers: [{ name: "Kun's Mac mini" }] });
    expect(h.sessionSpecs.at(-1)?.instructions.base).toContain(
      crewmateComputersNote({ workers: [{ name: "Kun's Mac mini" }] }),
    );
    // The first mate reads each task's computer (INF-992), the one the
    // queued task waits for and this one for the folder work.
    expect(h.supervisor.facts.crewStatus(ordinary.taskId)[0]?.computer).toBe("Kun's Mac mini");
    expect(h.supervisor.facts.crewStatus(folder.taskId)[0]?.computer).toBe("this computer");

    // The host's folder-repair closing never reads this task.
    await h.supervisor.inPlaceWork.closeCurrentFolders();
    expect(h.tasks.get(folder.taskId)?.status).toBe("active");
    await h.supervisor.disposeAll();
  });

  it("plans folder work with the same shape and brief, and refuses a Runs on beside it", async () => {
    const h = await runsOnTheMini();
    const planned = h.supervisor.intake.plan({
      title: "Bring the business folder up to date",
      intent: intent("Bring the business folder up to date with main."),
      repoId: h.repo.id,
      shape: { in_folder: true },
    });
    expect(planned.shape?.in_place).toEqual({ folder: true });
    expect(planned.prompt).toContain(IN_PLACE_OPENING);
    expect(planned.prompt).not.toContain("Delivery:");
    await expect(
      h.supervisor.intake.commission({
        title: "Folder work on the mini",
        intent: intent("Bring the business folder up to date with main."),
        repoId: h.repo.id,
        shape: { in_folder: true, runs_on_ask: MINI },
      }),
    ).rejects.toThrow("omit runs_on_ask");
    await h.supervisor.disposeAll();
  });
});
