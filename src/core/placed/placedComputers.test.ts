import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DeviceView } from "@shared/devices";
import { englishOf } from "@shared/i18n/said";
import { describe, expect, it, vi } from "vitest";
import {
  adoptHere,
  commit,
  feed,
  gitProject,
  model,
  PROVIDER,
  placedWorldHooks,
  world,
} from "../../../tests/helpers/placedWorld";
import { Computers } from "../devices/computers";
import { removeFromHome } from "../helper/fromHome";
import { seedTask } from "../tasks/seedTask";
import { git } from "../workspace/git";
import { keptRefFor } from "../workspace/workspaceService";

/**
 * A task that runs on a computer that runs work (`tests/helpers/placedWorld.ts`):
 * leftovers there, and removing a computer.
 */

// Integration budget (docs/test-cohorts.md): real git on the computer and
// here, the slowest test 1.28 s at its fastest of nineteen runs on an Apple
// silicon Mac, with git unclamped as below. A poll waits for work that
// crosses the connection and runs git on both sides - a closed task's
// working copy kept, brought home and deleted took 0.46 s alone and 1.7 s
// with sixteen copies of this file running at once - so it waits for the
// rest of the test's budget, never Vitest's 1 s (tests/helpers/waitWindow.ts).
vi.setConfig({ testTimeout: 10_000 });

// On a Mac the product runs every git below the UI (`taskpolicy -c
// utility`, utilityQos.ts), where it yields to every busier process. A case
// here runs up to about a hundred gits one after another, so on a Mac
// loaded by other runs it waited on that load rather than its own work and
// ran past its budget. This file is about placed tasks, not that clamp
// (utilityQos.test.ts holds it), so its git runs as on a Mac without
// taskpolicy, at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

/** The home's one clock: the wall clock, moved on when a case waits out a backoff. */
let ahead = 0;
const now = () => Date.now() + ahead;
placedWorldHooks({
  now,
  reset: () => {
    ahead = 0;
  },
});

/**
 * What a computer that runs work holds for a task this Mac no longer
 * records there (docs/helper.md, "Leftovers"): it goes by the rule this
 * Mac's own leftover working copies follow - its unmerged work here first,
 * on the task's kept ref in the project it was cloned from, then its
 * working copy and folder there - and stays there only while its work has
 * nowhere to go here.
 */
describe("leftovers on a computer that runs work", () => {
  it("keeps the working copy a failed start made there for the task, which its retry starts on", async () => {
    const project = await gitProject();
    const at = await world(() => project.forge(Buffer.alloc(0)));
    const home = at.home();
    const { repo } = await adoptHere(home.repos, project.home);
    home.repos.setRunsOn(repo.id, at.deviceId);
    at.refuseOpens(true);

    // That computer made the working copy, then refused the conversation:
    // the start failed behind the spawn's answer (INF-3060), the first mate
    // heard why, and the task waits here with no working copy of its own.
    const handle = await home.supervisor.intake.commission({
      title: "footer",
      intent: { goal: "Make the footer blue.", userWords: "make the footer blue" },
      repoId: repo.id,
    });
    await handle.started;
    const failed = home.wakes.find(
      (wake) => wake.facts?.kind === "queued-start-failed" && wake.facts.task.id === handle.taskId,
    )?.facts;
    expect(failed).toMatchObject({
      asked: true,
      error: expect.stringContaining(`no sign-in for ${PROVIDER} here`),
    });
    expect(home.tasks.get(handle.taskId)).toMatchObject({ status: "open", worktreeDir: "" });
    expect(feed(home)).toContain("Mac mini cloned home.");

    // The task is still open, so what it left there is its own, never an
    // orphan: once that computer takes the conversation, Start again starts
    // there on the same working copy, and nothing else is left behind.
    expect(at.holds()).toEqual({ tasks: [handle.taskId], workingCopies: [handle.taskId] });
    at.refuseOpens(false);
    model([{ text: "Started on the footer." }]);
    expect(
      await home.supervisor.starts.startQueuedNow(handle.taskId, { audience: "captain" }),
    ).toBe(`Started ${home.tasks.get(handle.taskId)?.key} "footer".`);
    expect(home.tasks.get(handle.taskId)?.status).toBe("active");
    expect(at.holds()).toEqual({ tasks: [handle.taskId], workingCopies: [handle.taskId] });
  });

  it("brings a purged task's unmerged work home onto its kept ref in the project it was cloned from, then removes its working copy and folder there", async () => {
    const project = await gitProject();
    const at = await world(() => project.forge(Buffer.alloc(0)));
    const home = at.home();
    const { repo } = await adoptHere(home.repos, project.home);
    model([{ text: "Started on the footer." }]);
    await at.start("t-purged", "Make the footer blue.", repo.id);
    await expect.poll(() => home.tasks.get("t-purged")?.activity).toBe("idle");
    const work = at.folders("t-purged").work;
    writeFileSync(join(work, "footer.html"), "<footer>blue</footer>\n");
    const tip = await commit(work, "feat: a blue footer");
    writeFileSync(join(work, "notes.txt"), "still thinking\n");

    await home.supervisor.purgeAllTasks();
    expect(home.tasks.get("t-purged")).toBeUndefined();

    await expect.poll(() => at.holds()).toEqual({ tasks: [], workingCopies: [] });
    const kept = await git(project.home, ["rev-parse", keptRefFor("t-purged")]);
    expect(await git(project.home, ["show", `${kept}:notes.txt`])).toBe("still thinking");
    expect(
      await git(project.home, ["merge-base", "--is-ancestor", tip, kept]).then(() => true),
    ).toBe(true);
    // Its work came home whole, so nothing was said.
    expect(feed(home).filter((line) => line.includes("leftover"))).toEqual([]);
  });

  it("keeps a leftover working copy there while its work has nowhere to go here, says so once, and brings it home once its project is back", async () => {
    const project = await gitProject();
    const at = await world(() => project.forge(Buffer.alloc(0)));
    const home = at.home();
    const { repo } = await adoptHere(home.repos, project.home);
    model([{ text: "Started on the footer." }]);
    await at.start("t-stays", "Make the footer blue.", repo.id);
    await expect.poll(() => home.tasks.get("t-stays")?.activity).toBe("idle");
    const work = at.folders("t-stays").work;
    const branch = home.tasks.get("t-stays")?.branch;
    writeFileSync(join(work, "footer.html"), "<footer>blue</footer>\n");
    const tip = await commit(work, "feat: a blue footer");

    // Out of reach, the record goes and so does its project here.
    await home.drop();
    await expect.poll(() => home.devices.inReach(at.deviceId)).toBe(false);
    await home.supervisor.purgeAllTasks();
    home.repos.unregister(repo.id);

    // Back: its work has nowhere to go here, so it stays there, said once,
    // named by the branch it has checked out there now that no record
    // here names it.
    const said = () => feed(home).filter((line) => line.includes("leftover"));
    await home.listen();
    await expect
      .poll(said)
      .toEqual([
        `Mac mini keeps a leftover working copy, because its work could not be saved on this computer first: ${branch}.`,
      ]);
    expect(branch).toMatch(/^inf\//);
    expect(at.holds()).toEqual({ tasks: ["t-stays"], workingCopies: ["t-stays"] });
    expect(await git(work, ["rev-parse", "HEAD"])).toBe(tip);

    // Its project is here again: the next time that computer is back, its
    // work comes home and the copy goes, with nothing said twice.
    await adoptHere(home.repos, project.home);
    await home.drop();
    await expect.poll(() => home.devices.inReach(at.deviceId)).toBe(false);
    await home.listen();
    await expect.poll(() => at.holds()).toEqual({ tasks: [], workingCopies: [] });
    const kept = await git(project.home, ["rev-parse", keptRefFor("t-stays")]);
    expect(
      await git(project.home, ["merge-base", "--is-ancestor", tip, kept]).then(() => true),
    ).toBe(true);
    expect(said()).toHaveLength(1);
  });

  it("removes the working copy a failed start left there once its task is set to run elsewhere, at that computer's next contact", async () => {
    const project = await gitProject();
    const at = await world(() => project.forge(Buffer.alloc(0)));
    const home = at.home();
    const { repo } = await adoptHere(home.repos, project.home);
    home.repos.setRunsOn(repo.id, at.deviceId);
    at.refuseOpens(true);

    // A queued start there fails after the copy was made: the record waits
    // for the captain, still placed there, and its copy stays for its next start.
    seedTask(home.tasks, { id: "t-moved", title: "footer", status: "queued", repoId: repo.id });
    await home.supervisor.starts.dispatchQueuedTask("t-moved");
    expect(home.tasks.get("t-moved")).toMatchObject({ status: "open", deviceId: at.deviceId });
    expect(at.holds().workingCopies).toEqual(["t-moved"]);

    // Set to run here before it ever ran there: the copy there is no
    // longer its own, and goes the next time that computer is back.
    home.repos.setRunsOn(repo.id, null);
    expect(home.tasks.get("t-moved")?.deviceId ?? null).toBeNull();
    await home.drop();
    await expect.poll(() => home.devices.inReach(at.deviceId)).toBe(false);
    await home.listen();
    await expect.poll(() => at.holds()).toEqual({ tasks: [], workingCopies: [] });
    expect(home.tasks.get("t-moved")?.status).toBe("open");
  });
});

describe("removing a computer that runs work", () => {
  /** Your devices over this world's home, as createServices composes them. */
  function devicesOf(
    at: Awaited<ReturnType<typeof world>>,
    removeThere?: (device: DeviceView) => Promise<boolean>,
  ) {
    const home = at.home();
    const pushed: DeviceView[][] = [];
    const problems: string[] = [];
    const computers = new Computers({
      pairing: at.pairing(),
      work: home.devices,
      tasks: home.tasks,
      repos: home.repos,
      stopTasks: (deviceId) => home.supervisor.sessions.stopTasksOn(deviceId),
      bringHome: (deviceId) => home.placed.bringHome(deviceId),
      ...(removeThere ? { removeThere } : {}),
      emit: (list) => pushed.push(list),
      onProblem: (line) => problems.push(typeof line === "string" ? line : englishOf(line)),
      now,
      bootedAt: () => 0,
    });
    return { computers, pushed, problems };
  }

  async function busyComputer(options: { remoteLogin?: string } = {}) {
    const project = await gitProject();
    const at = await world(() => project.forge(Buffer.alloc(0)), options);
    const home = at.home();
    const { repo } = await adoptHere(home.repos, project.home);
    home.repos.setRunsOn(repo.id, at.deviceId);
    model([{ text: "Started." }]);
    await at.start("t-gone", "Fix the footer.", repo.id);
    await expect.poll(() => home.tasks.get("t-gone")?.activity).toBe("idle");
    const work = at.folders("t-gone").work;
    writeFileSync(join(work, "footer.html"), "<footer></footer>\n");
    const tip = await commit(work, "feat: a footer");
    return { project, at, home, repo, work, tip };
  }

  it("stops its task, brings its unmerged work home, runs its project here, and only then takes it off the list", async () => {
    const { project, at, home, repo, work, tip } = await busyComputer();
    const { computers, pushed } = devicesOf(at);
    expect(computers.list()).toEqual([
      expect.objectContaining({ id: at.deviceId, inReach: true, tasks: 1, runs: ["home"] }),
    ]);

    const gone = await computers.remove(at.deviceId);
    expect(gone).toMatchObject({ id: at.deviceId, runs: ["home"] });
    // Its stages, in order, as Devices draws them.
    const stages = pushed
      .flatMap((list) => list.map((device) => device.removal ?? null))
      .filter((stage, index, all) => stage !== null && stage !== all[index - 1]);
    expect(stages).toEqual(["bringing-work", "cleaning-up"]);
    expect(home.tasks.get("t-gone")?.status).toBe("dropped");
    expect(home.tasks.get("t-gone")?.workspaceState).toBe("removed");
    const kept = await git(project.home, ["rev-parse", keptRefFor("t-gone")]);
    expect(
      await git(project.home, ["merge-base", "--is-ancestor", tip, kept]).then(() => true),
    ).toBe(true);
    expect(home.repos.get(repo.id)?.runsOn).toBeNull();
    expect(at.pairing().list()).toEqual([]);
    expect(computers.list()).toEqual([]);
    await expect.poll(() => existsSync(join(at.dataDir, "repos"))).toBe(false);
    expect(existsSync(work)).toBe(false);
    expect(existsSync(join(at.dataDir, "home.json"))).toBe(false);
  });

  it("refuses connected removal without falsifying retirement, and retries successfully after work history is repaired", async () => {
    const { project, at, home, work } = await busyComputer();
    const { computers } = devicesOf(at);
    writeFileSync(join(work, "only-copy.txt"), "unique work\n");
    const metadata = readFileSync(join(work, ".git"), "utf8");
    writeFileSync(join(work, ".git"), `gitdir: ${join(at.dataDir, "missing")}\n`);
    await expect(computers.remove(at.deviceId)).rejects.toThrow("It stays on your list");
    expect(home.tasks.get("t-gone")?.workspaceState).toBe("present");
    expect(
      home.tasks.timeline("t-gone").some((event) => event.text.includes("saved here first")),
    ).toBe(false);
    expect(
      at
        .pairing()
        .list()
        .map((device) => device.id),
    ).toContain(at.deviceId);
    expect(readFileSync(join(work, "only-copy.txt"), "utf8")).toBe("unique work\n");
    writeFileSync(join(work, ".git"), metadata);
    await computers.remove(at.deviceId);
    expect(home.tasks.get("t-gone")?.workspaceState).toBe("removed");
    const kept = await git(project.home, ["rev-parse", keptRefFor("t-gone")]);
    expect(await git(project.home, ["show", `${kept}:only-copy.txt`])).toBe("unique work");
    await expect.poll(() => existsSync(work)).toBe(false);
    expect(at.pairing().list()).toEqual([]);
  });

  it("out of reach, asks first, then waits until it is back and brings its work home before removing it", async () => {
    const { project, at, home, tip } = await busyComputer();
    const { computers } = devicesOf(at);
    await home.drop();
    await expect.poll(() => home.devices.inReach(at.deviceId)).toBe(false);
    expect(computers.list()[0]).toMatchObject({ inReach: false, seenAt: expect.any(Number) });
    await expect(computers.remove(at.deviceId)).rejects.toThrow("out of reach");
    expect(await computers.remove(at.deviceId, "when-back")).toMatchObject({
      removal: "when-back",
    });
    expect(computers.keep(at.deviceId).removal).toBeUndefined();
    await computers.remove(at.deviceId, "when-back");
    expect(at.pairing().list()).toHaveLength(1);

    await home.listen();
    await expect.poll(() => at.pairing().list(), { timeout: 8_000 }).toEqual([]);
    expect(home.tasks.get("t-gone")?.workspaceState).toBe("removed");
    const kept = await git(project.home, ["rev-parse", keptRefFor("t-gone")]);
    expect(
      await git(project.home, ["merge-base", "--is-ancestor", tip, kept]).then(() => true),
    ).toBe(true);
  });

  it("out of reach, removes it now, stops its task here and leaves its unmerged work there", async () => {
    const { at, home, repo, work } = await busyComputer();
    const { computers } = devicesOf(at);
    await home.drop();
    await expect.poll(() => home.devices.inReach(at.deviceId)).toBe(false);
    await computers.remove(at.deviceId, "now");
    expect(at.pairing().list()).toEqual([]);
    expect(home.tasks.get("t-gone")?.status).toBe("dropped");
    expect(home.tasks.get("t-gone")?.workspaceState).toBe("removed");
    expect(home.tasks.timeline("t-gone").at(-1)?.text).toBe(
      "working copy left on Running as Builder - it was removed while out of reach, so any unmerged work stays there",
    );
    expect(home.repos.get(repo.id)?.runsOn).toBeNull();

    await home.listen();
    await expect
      .poll(() => existsSync(join(at.dataDir, "home.json")), { timeout: 8_000 })
      .toBe(false);
    await expect.poll(() => existsSync(join(at.dataDir, "tasks"))).toBe(false);
    expect(existsSync(join(work, "footer.html"))).toBe(true);
    expect(await git(work, ["log", "-1", "--format=%s"])).toBe("feat: a footer");
  });

  it("out of reach, a Mac added by its address has what Firstmate set up there removed over Remote Login now, keeps its unmerged work there, and stops listening for it", async () => {
    const project = await gitProject();
    const at = await world(() => project.forge(Buffer.alloc(0)), {
      remoteLogin: "sam@mini.local",
    });
    const home = at.home();
    const { repo } = await adoptHere(home.repos, project.home);
    home.repos.setRunsOn(repo.id, at.deviceId);
    model([{ text: "Started." }]);
    await at.start("t-gone", "Fix the footer.", repo.id);
    await expect.poll(() => home.tasks.get("t-gone")?.activity).toBe("idle");
    const work = at.folders("t-gone").work;
    writeFileSync(join(work, "footer.html"), "<footer></footer>\n");
    await commit(work, "feat: a footer");
    // Nobody is logged in there: its run stops, and it is out of reach.
    await at.stopComputer();
    await expect.poll(() => home.devices.inReach(at.deviceId)).toBe(false);
    expect(at.pairing().list()[0]?.remoteLogin).toBe("sam@mini.local");

    // Over Remote Login the home starts the copy kept there as `work remove`.
    const reached: string[] = [];
    const removeThere = async (device: DeviceView) => {
      reached.push(device.remoteLogin ?? "");
      const outcome = await removeFromHome({
        dataDir: at.dataDir,
        background: null,
        backgroundEnv: {},
        expected: { homeKey: at.pairing().identity().pin, deviceId: device.id },
      });
      return outcome.firstmate === "removed";
    };
    const { computers } = devicesOf(at, removeThere);
    await computers.remove(at.deviceId, "now");
    expect(reached).toEqual(["sam@mini.local"]);
    expect(at.pairing().list()).toEqual([]);
    expect(home.tasks.get("t-gone")?.status).toBe("dropped");
    expect(existsSync(join(at.dataDir, "home.json"))).toBe(false);
    expect(existsSync(join(at.dataDir, "tasks"))).toBe(false);
    expect(await git(work, ["log", "-1", "--format=%s"])).toBe("feat: a footer");
    // Nothing is left there to hear it was removed, so the home listens for nothing.
    expect(at.pairing().any()).toBe(false);
  });
});

/**
 * A closed task's files on the computer that ran it (docs/task-retention.md):
 * this Mac closes its conversation there first, then asks that computer to
 * remove them, each order named for the task and its close so asked again
 * it is done once.
 */
describe("a closed task's files on a computer that runs work", () => {
  // Intent: guardrail before the placedSessions.ts split (INF-2625's plan):
  // the clean-up orders keep their order and names, and refuse a task that is
  // not closed or a computer out of reach.
  it("closes the conversation there before removing its temporary folder and its files", async () => {
    const at = await world();
    const home = at.home();
    model([{ text: "Started on the footer." }]);
    await at.start("t-clean");
    await expect.poll(() => home.tasks.get("t-clean")?.activity).toBe("idle");
    // Its turn's end brings its branch home (docs/helper.md, "Moving a task off a computer that is out of reach").
    await expect.poll(() => home.tasks.get("t-clean")?.shape?.home_copy).toBeDefined();
    const folders = at.folders("t-clean");
    writeFileSync(join(folders.temp, "bulk.txt"), "bulk working material\n");
    writeFileSync(join(folders.evidence, "proof.txt"), "a picture's stand-in\n");

    const asked = vi.spyOn(home.devices, "ask");
    await expect(home.placed.removeClosedTaskTemp(home.tasks.get("t-clean")!)).rejects.toThrow(
      "This task is not closed on another computer.",
    );
    await expect(home.placed.removeClosedTaskFiles(home.tasks.get("t-clean")!)).rejects.toThrow(
      "This task is not closed on another computer.",
    );
    expect(asked).not.toHaveBeenCalled();

    home.tasks.close("t-clean", { status: "dropped", reason: "cancelled", actor: "host" });
    const closed = home.tasks.get("t-clean")!;
    // Closing here closes its conversation there, and keeps and retires its
    // working copy, on their own and in no fixed order.
    const channels = () => asked.mock.calls.map(([, channel]) => channel).sort();
    await expect
      .poll(channels)
      .toEqual(["inf:session:close", "inf:working-copy:keep", "inf:working-copy:retire"]);
    asked.mockClear();
    await expect(home.placed.removeClosedTaskTemp(closed)).resolves.toMatchObject({
      status: "removed",
    });
    expect(existsSync(join(folders.temp, "bulk.txt"))).toBe(false);
    expect(existsSync(join(folders.evidence, "proof.txt"))).toBe(true);
    const files = await home.placed.removeClosedTaskFiles(closed);
    expect(files.removedFiles.length).toBeGreaterThan(0);
    expect(existsSync(join(folders.evidence, "proof.txt"))).toBe(false);
    // The close carries when the task started, so a program running there
    // before it is left alone (docs/leftover-programs.md).
    const closeOrder = { orderId: "close:t-clean", task: "t-clean", startedAt: closed.startedAt };
    expect(closed.startedAt).toEqual(expect.any(Number));
    expect(
      asked.mock.calls.map(([, channel, request]) => [channel, (request as unknown[])[0]]),
    ).toEqual([
      ["inf:session:close", closeOrder],
      [
        "inf:session:clean-temp",
        { orderId: `clean-temp:t-clean:${closed.closedAt}`, task: "t-clean" },
      ],
      ["inf:session:close", closeOrder],
      [
        "inf:session:clean-files",
        { orderId: `clean-files:t-clean:${closed.closedAt}`, task: "t-clean" },
      ],
    ]);

    // Out of reach, it is not reported as cleaned: the caller asks again.
    asked.mockClear();
    await at.stopComputer();
    await expect.poll(() => home.devices.inReach(at.deviceId)).toBe(false);
    await expect(home.placed.removeClosedTaskTemp(closed)).rejects.toThrow(
      "This task's computer is out of reach.",
    );
    await expect(home.placed.removeClosedTaskFiles(closed)).rejects.toThrow(
      "This task's computer is out of reach.",
    );
    expect(asked).not.toHaveBeenCalled();
  });

  // The re-review of INF-3447's piece 1: the close before a moved task's
  // working copy there is retired is the same close order as any other -
  // it carries when the task started and its report goes on the timeline
  // once - so a program running there before the task started is left
  // alone (docs/leftover-programs.md, "On a computer that runs work").
  it("closes a moved task's conversation there with its start, and notes what the close stopped", async () => {
    const at = await world();
    const home = at.home();
    model([{ text: "Started on the footer." }]);
    await at.start("t-moved");
    await expect.poll(() => home.tasks.get("t-moved")?.activity).toBe("idle");
    const startedAt = home.tasks.get("t-moved")?.startedAt;
    expect(startedAt).toEqual(expect.any(Number));
    // That computer's sweep, as its answer carries it (the sweep itself is
    // leftoverPrograms.integration.test.ts's).
    const report = {
      stops: [{ label: "scratch machine", outcome: "ran" as const }],
      programs: [],
      holders: "checked" as const,
    };
    const ask = home.devices.ask.bind(home.devices);
    const asked = vi
      .spyOn(home.devices, "ask")
      .mockImplementation(async (device, channel, args) => {
        const answer = await ask(device, channel, args);
        return channel === "inf:session:close"
          ? { ...(answer as object), leftovers: report }
          : answer;
      });

    await home.placed.retireMoved(at.deviceId, "t-moved");
    const closes = asked.mock.calls
      .filter(([, channel]) => channel === "inf:session:close")
      .map(([, , request]) => (request as unknown[])[0]);
    expect(closes).toEqual([
      { orderId: expect.stringMatching(/^move-close:t-moved:/), task: "t-moved", startedAt },
    ]);
    expect(
      home.tasks
        .timeline("t-moved")
        .filter((event) => event.text.startsWith("Leftovers at close:"))
        .map((event) => event.text),
    ).toEqual(['Leftovers at close: stop "scratch machine" ran.']);
    // INF-3497 finding 5: memory notices use the report's computer, not
    // whichever computer the task happens to be placed on when read later.
    expect(
      home.tasks.timeline("t-moved").find((event) => event.data?.leftoverPrograms)?.data,
    ).toMatchObject({
      leftoversComputerId: at.deviceId,
      leftoversUnresolved: false,
      leftoverPrograms: report,
    });
  });
});
