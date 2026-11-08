import type { AfterMergeStep } from "@shared/afterMerge";
import { RISK_DIMENSIONS } from "@shared/cards";
import { type ChangePresentation, changePresentationSchema } from "@shared/changePresentation";
import { describe, expect, it } from "vitest";
import { freshDatabase } from "../../../tests/helpers/database";
import { presentationContentHash } from "../forge/presentation";
import { afterMergeWords } from "../orchestrator/deliveryWakes";
import { seedTask } from "./seedTask";
import { TaskService } from "./taskService";

// INF-2796, the captain's Approve and build of direction A: a crewmate
// lists after-merge steps on its merge card and the app files them as
// tasks that start on their own once the merge goes through - with the
// captain's written-in rule, "we should not mandate these follow up tasks
// though. a merge can totally end without anything to continue".

const HEAD = "4f1c0d2b9e8a7c6d5e4f3a2b1c0d9e8f7a6b5c4d";
const REPAIRED = "9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b";

/**
 * DOP-299's own story at its merge, with the step its report left as text:
 * "Then INF-2779's owner sets MAC_QUEUES split/release_split".
 */
function dop299Story(
  taskId: string,
  afterMerge?: ChangePresentation["afterMerge"],
  at: Partial<Pick<ChangePresentation, "revision" | "head" | "destination">> = {},
) {
  return changePresentationSchema.parse({
    version: 1,
    taskId,
    revision: at.revision ?? 2,
    title: "feat(runners): place the split Mac jobs on the small Macs",
    destination: at.destination ?? { kind: "local", project: "dotfiles-private" },
    base: HEAD,
    head: at.head ?? HEAD,
    why: ["The split Mac check's three jobs should run on the 5-core Macs."],
    whatChanged: ["The Mac runners take the split and release_split queue labels."],
    before: ["Every Mac job waited for the one large runner."],
    after: ["The split jobs run side by side on the small Macs."],
    views: [],
    noPicture: "This changes runner labels, not a screen.",
    verification: ["Read the runner labels on each small Mac."],
    risk: Object.fromEntries(
      RISK_DIMENSIONS.map((dimension) => [dimension, { level: "low", why: "Runner labels only." }]),
    ),
    requiredActions: [],
    ...(afterMerge ? { afterMerge } : {}),
    unfinished: [],
    projectText: "",
    assets: [],
    pictures: [],
  });
}

function setup(afterMerge?: ChangePresentation["afterMerge"]) {
  const tasks = new TaskService({ db: freshDatabase(), strict: true });
  // DOP-299's own project, and the app's, where the work it waited for ran.
  tasks.projects.ensureForRepo({ id: "dotfiles", name: "dotfiles-private" }, "DOP");
  const app = tasks.projects.ensureForRepo({ id: "infinitary", name: "Infinitary" }, "INF");
  const origin = seedTask(tasks, {
    id: "dop29900",
    title: "Place the split Mac jobs",
    repoId: "dotfiles",
    status: "idle",
    branch: "fm/task-dop29900",
  });
  // INF-2779, still running when DOP-299 merged.
  const split = seedTask(tasks, {
    id: "inf27790",
    title: "Split the Mac check into three jobs",
    repoId: "infinitary",
    status: "idle",
  });
  declare(tasks, origin, afterMerge);
  return { tasks, origin, split, app };
}

function declare(
  tasks: TaskService,
  origin: { id: string },
  afterMerge?: ChangePresentation["afterMerge"],
) {
  const story = dop299Story(origin.id, afterMerge);
  tasks.delivery.updateChangePresentation(origin.id, () => ({
    revisions: [story],
    receipts: [],
    completion: {
      revision: story.revision,
      head: HEAD,
      contentHash: presentationContentHash(story),
    },
  }));
}

const DOP299_STEP = [
  {
    title: "Pull the split setup onto the Mac mini, set MAC_QUEUES",
    goal: "The Mac mini runs the split runner setup and MAC_QUEUES names split and release_split.",
    why: "INF-2779 split the Mac check into three jobs; the queue variable still names only the old journeys size, so the split jobs wait for a runner that never takes them.",
  },
];

const continueTasks = (tasks: TaskService) =>
  tasks.list().filter((record) => record.title.startsWith("Continue: "));

describe("after-merge steps at the merge", () => {
  it("files each declared step as a Continue task that starts on its own once merged", () => {
    const { tasks, origin } = setup(DOP299_STEP);
    expect(continueTasks(tasks)).toEqual([]);

    tasks.close(origin.id, { status: "done", reason: "merged", actor: "host" });

    const [filed] = continueTasks(tasks);
    expect(filed).toMatchObject({
      title: "Continue: Pull the split setup onto the Mac mini, set MAC_QUEUES",
      goal: DOP299_STEP[0]?.goal,
      kind: "work",
      status: "open",
      startPolicy: "when-ready",
      projectId: origin.projectId,
    });
    expect(filed?.prompt).toContain(DOP299_STEP[0]?.why);
    expect(tasks.graph.discoveredOrigins(filed?.id ?? "").map((row) => row.id)).toEqual([
      origin.id,
    ]);
    // Nothing else holds it: the ready sweep after the close starts it.
    expect(tasks.graph.listReady().map((row) => row.id)).toContain(filed?.id);
    expect(tasks.delivery.filedAfterMergeSteps(origin.id)).toEqual([
      { key: filed?.key, title: filed?.title },
    ]);
  });

  it("files a step once, however often the merge is activated again", () => {
    const { tasks, origin } = setup(DOP299_STEP);
    tasks.close(origin.id, { status: "done", reason: "merged", actor: "host" });
    tasks.delivery.activateAfterMergeSteps(origin.id);
    expect(continueTasks(tasks)).toHaveLength(1);
  });

  it("files nothing for a story that lists no steps", () => {
    const { tasks, origin } = setup();
    const before = tasks.list().length;
    tasks.close(origin.id, { status: "done", reason: "merged", actor: "host" });
    expect(tasks.list()).toHaveLength(before);
    expect(tasks.delivery.filedAfterMergeSteps(origin.id)).toEqual([]);
  });

  it("files the steps of a GitHub pull request's story the host republished at a later version", () => {
    const { tasks, origin } = setup();
    // The author's revision 2 was published on the pull request; a repair
    // pushed a later version and the host republished the same words as
    // revision 3 (INF-2509's refresh, which copies the whole story).
    const github = {
      host: "github.com",
      projectId: 1421542804,
      fullName: "example/dotfiles-private",
      visibility: "private" as const,
    };
    const authored = dop299Story(origin.id, DOP299_STEP, { destination: github });
    const refreshed = dop299Story(origin.id, DOP299_STEP, {
      destination: github,
      revision: 3,
      head: REPAIRED,
    });
    const publication = {
      revision: 3,
      head: REPAIRED,
      state: "confirmed" as const,
      region: "",
      regionHash: "",
      contentHash: presentationContentHash(authored),
      refreshOf: 2,
      number: 41,
    };
    tasks.delivery.updateChangePresentation(origin.id, () => ({
      revisions: [authored, refreshed],
      receipts: [],
      publication,
      published: publication,
    }));

    tasks.close(origin.id, { status: "done", reason: "merged", actor: "host" });

    expect(continueTasks(tasks).map((record) => record.title)).toEqual([
      "Continue: Pull the split setup onto the Mac mini, set MAC_QUEUES",
    ]);
  });

  it("files a step in the project it names, held until the work it waits for merges", () => {
    // DOP-299's step belonged to the app's project and could only run once
    // INF-2779 merged as well (captain's "Build them in this change").
    const { tasks, origin, split, app } = setup([
      { ...DOP299_STEP[0], project: "INF", blockedBy: ["INF-1"] } as AfterMergeStep,
    ]);
    expect(split.key).toBe("INF-1");

    tasks.close(origin.id, { status: "done", reason: "merged", actor: "host" });

    const [filed] = continueTasks(tasks);
    expect(filed).toMatchObject({ projectId: app.id, repoId: "infinitary", status: "open" });
    expect(filed?.key).toMatch(/^INF-/);
    expect(tasks.graph.listReady().map((row) => row.id)).not.toContain(filed?.id);

    tasks.close(split.id, { status: "done", reason: "merged", actor: "host" });
    expect(tasks.graph.listReady().map((row) => row.id)).toContain(filed?.id);
  });

  it("starts an existing unstarted task the step names, once the work it waits for merges", () => {
    const { tasks, origin, split } = setup();
    const queues = seedTask(tasks, {
      id: "dop30000",
      title: "Set MAC_QUEUES to the split queue labels",
      repoId: "dotfiles",
      status: "queued",
      startPolicy: "on-request",
    });
    const step = { task: queues.key, blockedBy: [split.key] } as AfterMergeStep;
    expect(tasks.delivery.afterMergeRefusal(origin.id, [step])).toBeUndefined();
    expect(tasks.delivery.afterMergeShown([step])).toEqual([
      { key: queues.key, title: queues.title, waitsFor: [split.key] },
    ]);
    declare(tasks, origin, [step]);

    tasks.close(origin.id, { status: "done", reason: "merged", actor: "host" });

    expect(continueTasks(tasks)).toEqual([]);
    expect(tasks.get(queues.id)).toMatchObject({ status: "open", startPolicy: "when-ready" });
    expect(tasks.graph.listReady().map((row) => row.id)).not.toContain(queues.id);
    expect(tasks.delivery.filedAfterMergeSteps(origin.id)).toEqual([
      { key: queues.key, title: queues.title },
    ]);
    tasks.close(split.id, { status: "done", reason: "merged", actor: "host" });
    expect(tasks.graph.listReady().map((row) => row.id)).toContain(queues.id);
  });

  it("refuses a step naming a running or closed task, an unknown project or an unknown wait", () => {
    const { tasks, origin, split } = setup();
    const closed = seedTask(tasks, {
      id: "dop29800",
      title: "Label the small Macs",
      repoId: "dotfiles",
      status: "idle",
    });
    tasks.close(closed.id, { status: "done", reason: "merged", actor: "host" });
    const refusal = (step: AfterMergeStep) => tasks.delivery.afterMergeRefusal(origin.id, [step]);

    expect(refusal({ task: split.key })).toContain("already running");
    expect(refusal({ task: closed.key })).toContain("closed");
    expect(refusal({ task: origin.key })).toContain("this task itself");
    expect(refusal({ ...DOP299_STEP[0], project: "NOPE" } as AfterMergeStep)).toContain(
      'no project "NOPE"',
    );
    expect(refusal({ ...DOP299_STEP[0], blockedBy: ["INF-404"] } as AfterMergeStep)).toContain(
      'no task "INF-404"',
    );
    expect(refusal({ title: "Set MAC_QUEUES" })).toContain("needs a title, a goal and why");
  });

  // Re-review of INF-2812: a wait that would close a cycle, and a named task
  // that could start before the merge, are refused when the story is prepared.
  it("refuses a named task already set to start on its own, or a wait that would close a cycle", () => {
    const { tasks, origin, split } = setup();
    const queues = seedTask(tasks, {
      id: "dop30000",
      title: "Set MAC_QUEUES to the split queue labels",
      repoId: "dotfiles",
      status: "queued",
      startPolicy: "when-ready",
    });
    const refusal = (step: AfterMergeStep) => tasks.delivery.afterMergeRefusal(origin.id, [step]);
    expect(refusal({ task: queues.key })).toContain("already set to start on its own");
    // Waiting on the origin already, it cannot start before the merge.
    tasks.graph.insertLink(origin.id, queues.id, "blocks", "host", 1);
    expect(refusal({ task: queues.key })).toBeUndefined();

    // INF-1 waits for the named task, so the named task cannot wait for INF-1.
    tasks.graph.insertLink(queues.id, split.id, "blocks", "host", 1);
    expect(refusal({ task: queues.key, blockedBy: [split.key] })).toContain(
      "nothing could ever start",
    );
  });

  it("records the merge and notes a wait that closed a cycle after the card was shown", () => {
    const { tasks, origin, split } = setup();
    const queues = seedTask(tasks, {
      id: "dop30000",
      title: "Set MAC_QUEUES to the split queue labels",
      repoId: "dotfiles",
      status: "queued",
      startPolicy: "on-request",
    });
    declare(tasks, origin, [{ task: queues.key, blockedBy: [split.key] }]);
    // After the card was shown, INF-1 came to wait for the named task.
    tasks.graph.insertLink(queues.id, split.id, "blocks", "host", 1);

    tasks.close(origin.id, { status: "done", reason: "merged", actor: "host" });

    expect(tasks.get(origin.id)?.status).toBe("done");
    expect(tasks.get(queues.id)?.startPolicy).toBe("when-ready");
    expect(tasks.graph.blockers(queues.id)).toEqual([]);
    expect(
      tasks.timeline(queues.id).some((event) => event.text.startsWith("could not wait for")),
    ).toBe(true);
  });

  it("leaves a wait on closed work off the merge card", () => {
    const { tasks, split } = setup();
    tasks.close(split.id, { status: "done", reason: "merged", actor: "host" });
    expect(
      tasks.delivery.afterMergeShown([
        { ...DOP299_STEP[0], blockedBy: [split.key] } as AfterMergeStep,
      ]),
    ).toEqual([{ title: `Continue: ${DOP299_STEP[0]?.title}`, goal: DOP299_STEP[0]?.goal }]);
  });

  it("starts nothing for a named task that closed between the card and the merge", () => {
    const { tasks, origin } = setup();
    const queues = seedTask(tasks, {
      id: "dop30000",
      title: "Set MAC_QUEUES to the split queue labels",
      repoId: "dotfiles",
      status: "queued",
      startPolicy: "on-request",
    });
    declare(tasks, origin, [{ task: queues.key }]);
    tasks.close(queues.id, { status: "dropped", reason: "cancelled", actor: "captain" });

    tasks.close(origin.id, { status: "done", reason: "merged", actor: "host" });

    expect(tasks.get(queues.id)?.status).toBe("dropped");
    expect(tasks.delivery.filedAfterMergeSteps(origin.id)).toEqual([
      { key: queues.key, title: queues.title, skipped: "closed" },
    ]);
    // The first mate's settled wake says so instead of claiming it started.
    expect(afterMergeWords(tasks.delivery.filedAfterMergeSteps(origin.id))).toBe(
      `It started nothing for ${queues.key} "${queues.title}", closed before the merge; decide whether its work still needs a task.`,
    );
  });

  // INF-3060's finding 4, the captain's "an after-merge step names its
  // doer, and app changes go to the first mate": INF-2959's merge card
  // listed deleting an Automation rule, which started a crewmate (INF-3014)
  // that could only report it had no access to Automation.
  const INF2959_RULE_STEP = {
    doer: "firstmate",
    title: "Delete the Automation rule that repaired batches",
    goal: "Automation no longer has the rule that started a repair when a merge batch failed.",
    why: "The shipped queue now starts its own repair, so the old rule would start a second one.",
  } satisfies AfterMergeStep;

  it("files no task for the first mate's app change and hands it over in the settled wake", () => {
    const { tasks, origin } = setup([INF2959_RULE_STEP, ...DOP299_STEP]);
    expect(tasks.delivery.afterMergeRefusal(origin.id, [INF2959_RULE_STEP])).toBeUndefined();
    expect(tasks.delivery.afterMergeShown([INF2959_RULE_STEP])).toEqual([
      { title: INF2959_RULE_STEP.title, goal: INF2959_RULE_STEP.goal, doer: "firstmate" },
    ]);

    tasks.close(origin.id, { status: "done", reason: "merged", actor: "host" });

    // Only the crewmate's step is filed; nothing holds the rule's deletion.
    const filed = continueTasks(tasks);
    expect(filed.map((record) => record.title)).toEqual([
      "Continue: Pull the split setup onto the Mac mini, set MAC_QUEUES",
    ]);
    expect(tasks.list().some((record) => record.title.includes(INF2959_RULE_STEP.title))).toBe(
      false,
    );
    const crew = tasks.delivery.filedAfterMergeSteps(origin.id);
    const firstmate = tasks.delivery.firstmateAfterMergeSteps(origin.id);
    expect(firstmate).toEqual([
      { title: INF2959_RULE_STEP.title, goal: INF2959_RULE_STEP.goal, why: INF2959_RULE_STEP.why },
    ]);
    const words = afterMergeWords(crew, firstmate);
    expect(words).toContain(`${filed[0]?.key} "${filed[0]?.title}"`);
    expect(words).toContain(`"${INF2959_RULE_STEP.title}": ${INF2959_RULE_STEP.goal}`);
    expect(words).toContain("no task was filed for them");
  });

  it("refuses a first mate's step that names a task, a project or a wait", () => {
    const { tasks, origin, split } = setup();
    const refusal = (step: AfterMergeStep) => tasks.delivery.afterMergeRefusal(origin.id, [step]);
    const firstMates = "is the first mate's change in the app";
    expect(refusal({ doer: "firstmate", task: split.key })).toContain(firstMates);
    expect(refusal({ ...INF2959_RULE_STEP, project: "INF" })).toContain(firstMates);
    expect(refusal({ ...INF2959_RULE_STEP, blockedBy: [split.key] })).toContain(firstMates);
    expect(refusal({ doer: "firstmate", title: INF2959_RULE_STEP.title })).toContain(
      "needs a title, a goal and why",
    );
  });

  it("files nothing when the change is discarded", () => {
    const { tasks, origin } = setup(DOP299_STEP);
    tasks.close(origin.id, { status: "dropped", reason: "discarded", actor: "host" });
    expect(continueTasks(tasks)).toEqual([]);
  });
});
