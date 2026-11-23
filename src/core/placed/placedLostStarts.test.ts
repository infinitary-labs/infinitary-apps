/**
 * A start that loses its computer (INF-5142 part 4) and a task that branches
 * from work kept here starting on a computer that runs work (part 5), over
 * the real connection (`tests/helpers/placedWorld.ts`): the real home and
 * task record, the computer's own work mode, real git on both sides. The
 * captain's words: "it shouldn't have required any user intervention".
 * The scripted cases for each step are in `starts.lost.test.ts`; these show
 * the same over the wire, where only the connection itself can say a
 * computer went.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  adoptHere,
  api,
  commit,
  gitProject,
  model,
  placedWorldHooks,
  world,
} from "../../../tests/helpers/placedWorld";
import { lostStartLine } from "../orchestrator/lostStarts";
import { seedTask } from "../tasks/seedTask";
import { git } from "../workspace/git";

// Integration budget (docs/test-cohorts.md): real git on the computer and
// here and a connection that goes and comes back; a poll waits for the rest
// of the test's budget, never Vitest's 1 s (tests/helpers/waitWindow.ts).
vi.setConfig({ testTimeout: 10_000 });

// The product runs git at utility priority on a Mac; this file is about
// starts, not that clamp (utilityQos.test.ts holds it).
vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

let ahead = 0;
const now = () => Date.now() + ahead;
placedWorldHooks({
  now,
  reset: () => {
    ahead = 0;
  },
});

type Home = ReturnType<Awaited<ReturnType<typeof world>>["home"]>;

/**
 * What the first mate heard of a task's start: its start failing or its
 * queued start beginning. None is the quiet the captain asked for; the
 * crewmate's own report at its turn's end is the work, not the start.
 */
const startWakesOf = (home: Home, taskId: string) =>
  home.wakes.filter(
    (wake) =>
      JSON.stringify(wake.facts).includes(taskId) &&
      (wake.facts.kind === "queued-start-failed" || wake.facts.kind === "queued-started"),
  );

/**
 * The connection goes while the home's `channel` order is on its way to the
 * computer, the first time it is sent: the order leaves, then the home's
 * side of the connection closes before any answer comes back. Answers the
 * session id of each conversation the computer said it opened.
 */
function dropDuring(home: Home, channel: string): string[] {
  const ask = home.devices.ask.bind(home.devices);
  const opened: string[] = [];
  let dropped = false;
  vi.spyOn(home.devices, "ask").mockImplementation(((deviceId, sent, args, options) => {
    const answer = ask(deviceId, sent, args, options);
    if (sent === "inf:session:open")
      void answer.then(
        (said) => opened.push((said as { state: { sessionId: string } }).state.sessionId),
        () => {},
      );
    if (sent === channel && !dropped) {
      dropped = true;
      void home.drop();
    }
    return answer;
  }) as typeof home.devices.ask);
  return opened;
}

describe("a start whose computer goes mid-start, over the real connection", () => {
  for (const [channel, step] of [
    ["inf:working-copy:prepare", "working-copy"],
    ["inf:session:open", "conversation"],
  ] as const) {
    it(`goes back in line when the connection goes during ${step}, and starts by itself once it is back`, async () => {
      const project = await gitProject();
      const at = await world(() => project.forge(Buffer.alloc(0)));
      const home = at.home();
      const { repo } = await adoptHere(home.repos, project.home);
      model([{ text: "Started on the footer." }]);
      seedTask(home.tasks, {
        id: "t-lost",
        title: "website",
        prompt: "Fix the footer.",
        status: "queued",
        deviceId: at.deviceId,
        repoId: repo.id,
      });
      const first = api.requests.length;
      dropDuring(home, channel);
      await home.supervisor.starts.dispatchQueuedTask("t-lost");
      // Back in line, its record saying why, and not a failure.
      expect(home.tasks.get("t-lost")).toMatchObject({
        status: "open",
        startPolicy: "when-ready",
        startNotice: null,
      });
      expect(home.tasks.timeline("t-lost").map((event) => event.text)).toContain(
        lostStartLine("Mac mini", step),
      );
      await expect.poll(() => home.devices.inReach(at.deviceId)).toBe(false);
      await home.supervisor.starts.dispatchQueuedTask("t-lost");
      expect(home.tasks.get("t-lost")?.status).toBe("open");

      await home.listen();
      await at.inReach("t-lost");
      await expect.poll(() => home.tasks.get("t-lost")?.status).toBe("active");
      await expect.poll(() => home.tasks.get("t-lost")?.activity).toBe("idle");
      // One working copy and one conversation there, and the brief reached it once.
      expect(at.holds()).toEqual({ tasks: ["t-lost"], workingCopies: ["t-lost"] });
      expect(
        api.requests
          .slice(first)
          .filter((request) => JSON.stringify(request.body).includes("Fix the footer.")),
      ).toHaveLength(1);
      // The first mate heard nothing of the start: neither the loss nor the recovery.
      expect(startWakesOf(home, "t-lost")).toEqual([]);
    });
  }
});

/** Work kept here on release/1.2, a task that branches from it set to run on the computer, and its source's commit. */
async function branchingTask() {
  const project = await gitProject();
  await git(project.home, ["checkout", "--quiet", "-b", "release/1.2"]);
  writeFileSync(join(project.home, "footer.html"), "<footer>release</footer>\n");
  const tip = await commit(project.home, "fix: the release footer");
  await git(project.home, ["checkout", "--quiet", "main"]);
  const at = await world(() => project.forge(Buffer.alloc(0)));
  const home = at.home();
  const { repo } = await adoptHere(home.repos, project.home);
  const source = seedTask(home.tasks, {
    id: "t-source",
    title: "Release footer",
    repoId: repo.id,
    prompt: "p",
    status: "completed",
    worktreeDir: project.home,
    branch: "release/1.2",
  });
  seedTask(home.tasks, {
    id: "t-next",
    title: "website",
    prompt: "Finish the release footer.",
    status: "queued",
    deviceId: at.deviceId,
    repoId: repo.id,
    shape: { kind: "chore", deliverable: "change", branch_from: source.key },
  });
  return { project, at, home, tip };
}

/** The private refs starting work arrived under in the task's working copy there. */
const carriedRefs = async (work: string) =>
  (await git(work, ["for-each-ref", "--format=%(refname)", "refs/infinitary/sources/"]))
    .split("\n")
    .filter(Boolean);

describe("a task that branches from work kept here, over the real connection", () => {
  it("starts on the computer with work kept on release/1.2 carried there, and its brief says where", async () => {
    const { project, at, home, tip } = await branchingTask();
    model([{ text: "Started from the release footer." }]);
    await home.supervisor.starts.dispatchQueuedTask("t-next");
    await expect.poll(() => home.tasks.get("t-next")?.status).toBe("active");
    await expect.poll(() => home.tasks.get("t-next")?.activity).toBe("idle");

    const work = at.folders("t-next").work;
    const carried = await carriedRefs(work);
    expect(carried).toHaveLength(1);
    expect(await git(work, ["rev-parse", carried[0] as string])).toBe(tip);
    // The brief the crewmate there read names that ref and the guarded reset.
    const brief = JSON.stringify(api.requests.at(-1)?.body);
    expect(brief).toContain(`git reset --hard ${carried[0]}`);
    expect(brief).toContain("git status --porcelain");
    // Here the branch is untouched and no stand-in is left.
    expect(await git(project.home, ["rev-parse", "release/1.2"])).toBe(tip);
    expect(await git(project.home, ["for-each-ref", "refs/infinitary/kept/"])).toBe("");
    expect(
      startWakesOf(home, "t-next").filter((wake) => wake.facts.kind === "queued-start-failed"),
    ).toEqual([]);
  });

  it("goes back in line when the connection goes while that work is carried, and starts by itself on the same conversation", async () => {
    const { at, home, tip } = await branchingTask();
    model([{ text: "Started from the release footer." }]);
    const first = api.requests.length;
    const opened = dropDuring(home, "inf:working-copy:source-ref");
    await home.supervisor.starts.dispatchQueuedTask("t-next");
    expect(home.tasks.get("t-next")).toMatchObject({
      status: "open",
      startPolicy: "when-ready",
      startNotice: null,
    });
    expect(home.tasks.timeline("t-next").map((event) => event.text)).toContain(
      lostStartLine("Mac mini", "brief"),
    );
    // The lost start had opened its conversation there before the work was carried.
    expect(opened).toHaveLength(1);

    await home.listen();
    await at.inReach("t-next");
    await expect.poll(() => home.tasks.get("t-next")?.status).toBe("active");
    await expect.poll(() => home.tasks.get("t-next")?.activity).toBe("idle");
    const work = at.folders("t-next").work;
    const carried = await carriedRefs(work);
    expect(carried).toHaveLength(1);
    expect(await git(work, ["rev-parse", carried[0] as string])).toBe(tip);
    // The retry opened that same conversation again, by the session id the
    // computer answered, and it took the brief once; the first mate heard
    // nothing of the start.
    expect(opened.length).toBeGreaterThanOrEqual(2);
    expect(new Set(opened)).toEqual(new Set([opened[0]]));
    expect(
      api.requests
        .slice(first)
        .filter((request) => JSON.stringify(request.body).includes("Finish the release footer.")),
    ).toHaveLength(1);
    expect(startWakesOf(home, "t-next")).toEqual([]);
  });
});
