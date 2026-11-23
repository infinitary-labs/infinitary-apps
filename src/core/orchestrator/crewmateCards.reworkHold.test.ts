/**
 * A reworked merge card stays away until it is ready (INF-6241, the
 * captain's words on INF-6224: "ideally, i want it to come back only after
 * the update has been made, new checks passed, and the card content is
 * already updated. even if i go into the card myself half way, i should see
 * checks running accurately reflected on the card"). Each case drives a
 * real CrewSupervisor through the crew harness (tests/helpers/crewHarness.ts)
 * over a project that merges in batches of its own, so the change is a
 * pushed branch with no pull request, as INF-6224's was.
 */

import { createHash } from "node:crypto";
import { type Card, mergeEffectOf } from "@shared/cards";
import type { ChangePresentation } from "@shared/changePresentation";
import { threadWait, threadWaitWords } from "@shared/threadWait";
import { describe, expect, it, vi } from "vitest";
import {
  askedOn,
  endTurn,
  fakeCrewmate,
  fakeCrewTimersEachTest,
  intentOf,
  METER_RISK,
  reboot,
  setup,
  tick,
} from "../../../tests/helpers/crewHarness";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import { presentationCardBody, presentationContentHash, presentationMarkdown } from "../forge";
import type { TaskRecord } from "../storage/taskRecords";
import { TaskService } from "../tasks/taskService";
import { seedProject } from "../workspace/seedProject";
import type { WatchedReading } from "./checkWatch";
import type { MergeCardWalk } from "./mergeCardSteps";

fakeCrewTimersEachTest();

const HEAD = "5ca2d466ee21f9733827383f23df81f3874e0d10";
const PUSHED = "732a709e5b1c48d2a9f03e6c7d1b84a2f5e90c13";
const TITLE = "The meter reads true";

/** What the project's host holds for the task's branch: its version and that version's checks. */
type Remote = { head: string; checks: "pending" | "green" | "red" | "none" | "manual" };

/**
 * A queue-pr task in a project that merges in batches of its own, whose
 * merge card shows story revision 1 at `HEAD` with its checks passed.
 * `remote` is the pushed branch as the next read finds it; `read` mimics
 * `ChangeChecks.readWatched`, recording the reading on the task.
 */
async function shown(options: { checks?: boolean } = {}) {
  const crewmate = fakeCrewmate();
  const remote: Remote = { head: HEAD, checks: "green" };
  let story: ChangePresentation | undefined;
  let fail = false;
  /** How long the host takes to answer a read, on the fake clock. */
  let answerAfter = 0;
  /** Whether a background job of the crewmate's runs, as the job store reports it. */
  let jobRunning = false;
  const completionPresentation = vi.fn(async (_taskId: string, revision: number) => {
    if (!story) throw new Error("No story yet");
    return {
      title: story.title,
      body: presentationCardBody(story),
      riskDeclaration: story.risk,
      requiredActions: story.requiredActions,
      pictures: story.pictures,
      revision,
    };
  });
  let next: MergeCardWalk = {
    did: ["Published the story on the branch and read it back."],
    ready: { revision: 1, title: TITLE, head: HEAD },
  };
  const mergeCardSteps = vi.fn(async () => structuredClone(next));
  const reads: string[] = [];
  /** The task record the read writes to: a restart opens it again. */
  let record: TaskService;
  const readCheckWatch = vi.fn(async (taskId: string): Promise<WatchedReading> => {
    reads.push(remote.head);
    if (answerAfter > 0) await new Promise((resolve) => setTimeout(resolve, answerAfter));
    if (fail) return { kind: "failed", transient: true, problem: "The host did not answer." };
    const { checks, head } = remote;
    const ci = checks === "none" || checks === "manual" ? "pending" : checks;
    seedDelivery(record, taskId, { headSha: head, ci, ciAt: Date.now() });
    const change = `branch ${head.slice(0, 7)}`;
    if (checks === "pending")
      return { kind: "pending", head, change, pending: [{ name: "linux", state: "pending" }] };
    if (checks === "none") return { kind: "pending", head, change, pending: [], noneStarted: true };
    if (checks === "manual")
      return {
        kind: "pending",
        head,
        change,
        pending: [{ name: "deploy", state: "pending", manual: true }],
      };
    return {
      kind: "finished",
      head,
      change,
      checks: [{ name: "linux", state: checks === "green" ? "success" : "failure" }],
    };
  });
  const at = setup(crewmate, {
    checkCi: async () => "green",
    completionPresentation,
    prepareChange: async () => "Prepared presentation 1.",
    openChange: async () => "Opened the change.",
    checkChange: async () => "Checks passed.",
    mergeCardSteps,
    hasRunningJobs: () => jobRunning,
    ...(options.checks === false ? {} : { readCheckWatch }),
  });
  record = at.tasks;
  const repoId = seedProject(at.db, {
    id: "meter",
    name: "meter",
    path: scratchDir("infinitary-meter-"),
    origin: "https://github.com/octo/meter.git",
    delivery: "queue-pr",
  }).id;
  const { taskId } = await at.supervisor.intake.commission({
    title: "Share the meter fix",
    intent: intentOf("share the meter fix"),
    repoId,
    shape: { rigor_ask: "quick" },
  });
  await tick();
  vi.spyOn(at.supervisor.facts, "taskAutonomy").mockReturnValue(false);
  const destination = {
    host: "github.com",
    projectId: 1,
    fullName: "octo/meter",
    visibility: "private",
  } as const;
  /** The crewmate's story revision at `head`, saved, published and read back. */
  const publish = (revision: number, head: string) => {
    const saved: ChangePresentation = {
      version: 1,
      taskId,
      revision,
      destination,
      title: TITLE,
      base: HEAD,
      head,
      why: ["The meter read high."],
      whatChanged: ["The meter reads the true value."],
      before: ["The meter read high."],
      after: [revision === 1 ? "The meter reads true." : "The meter reads true at night too."],
      views: [],
      noPicture: "This changes a reading, not a view.",
      verification: ["The meter test passed."],
      risk: METER_RISK,
      requiredActions: [],
      unfinished: [],
      projectText: "",
      assets: [],
      pictures: [],
    };
    story = saved;
    const region = presentationMarkdown(saved, new Map(), "passed");
    const publication = {
      revision,
      head,
      state: "confirmed" as const,
      region,
      regionHash: createHash("sha256").update(region).digest("hex"),
      contentHash: presentationContentHash(saved),
    };
    at.tasks.delivery.updateChangePresentation(taskId, (current) => ({
      revisions: [...(current?.revisions ?? []), saved],
      receipts: [],
      publication,
      published: publication,
    }));
  };
  publish(1, HEAD);
  seedDelivery(at.tasks, taskId, { headSha: HEAD, ci: "green", ciAt: Date.now() });
  const call = async (walk?: MergeCardWalk, reply?: { text: string; answers: number }) => {
    if (walk) next = walk;
    const show = at.specs[0]?.onShowMergeCard;
    if (!show) throw new Error("show_merge_card is not served");
    return show({
      card: {
        id: "merge-meter",
        ...(reply ? { reply: reply.text, answersMessage: reply.answers } : {}),
      },
    });
  };
  await call();
  await tick();
  await endTurn(crewmate, taskId);
  const card = at.cards().find((entry) => entry.title === TITLE) as Card;
  expect(merges(card)).toHaveLength(1);

  /** The captain's reply under the card, and the crewmate's answer naming it in the thread. */
  const replyAndAnswer = async (words: string, answer: string) => {
    at.supervisor.cardActions.replyToCard(card.id, words);
    await tick();
    at.specs[0]?.onReply?.({
      cardId: card.id,
      text: answer,
      answersMessage: askedOn(at.supervisor, card.id),
    });
    await tick();
  };
  /** The shared tick a minute on: watches read, held cards rechecked. */
  const minute = async () => {
    await vi.advanceTimersByTimeAsync(60_000);
    await at.supervisor.watch.pollCheckWatches(Date.now());
    await tick();
  };
  return {
    ...at,
    crewmate,
    taskId,
    cardId: card.id,
    remote,
    reads,
    readCheckWatch,
    publish,
    call,
    replyAndAnswer,
    minute,
    reopen: (tasks: TaskService) => {
      record = tasks;
    },
    failReads: (now: boolean) => {
      fail = now;
    },
    answerReadsAfter: (ms: number) => {
      answerAfter = ms;
    },
    runJob: (running: boolean) => {
      jobRunning = running;
    },
    /** The card as the captain's stage shows it. */
    onStage: () => at.cards().find((entry) => entry.id === card.id),
    /** Whether the card still waits in its close-out, kept from the captain. */
    held: () => at.supervisor.cards.get(card.id)?.awaiting === "close-out",
    /** The hold's notes on the timeline, read from `tasks` (the record a restart opens). */
    holdNotes: (tasks: TaskService = at.tasks) =>
      tasks
        .timeline(taskId)
        .filter(
          (event) =>
            event.kind === "note" && event.data?.cardId === card.id && "held" in (event.data ?? {}),
        ),
    raised: () =>
      at.tasks
        .timeline(taskId)
        .filter((event) => event.kind === "card_raised" && event.ref === card.id),
  };
}

function merges(card: Card | undefined) {
  return (card?.actions ?? []).filter((action) => mergeEffectOf(action));
}

describe("a reworked merge card's return (INF-6241)", () => {
  // INF-6224's record: the captain asked for a change under the merge card;
  // the crewmate answered in the thread, pushed from its shell and ended its
  // turn; the card came back at once on its first version, its strip and
  // Merge reading as ready while the new version's checks ran.
  it("replays INF-6224: stays away through the push and its checks, then returns once at the new version", async () => {
    const at = await shown();
    await at.replyAndAnswer(
      "make it read true at night too",
      "On it: reading the night meter too, then the checks run again.",
    );
    // The crewmate pushes from its shell, which tells the app nothing, and
    // starts the journeys run on the pushed version, which the app watches.
    at.remote.head = PUSHED;
    at.remote.checks = "pending";
    const startedAt = Date.now();
    seedDelivery(at.tasks, at.taskId, {
      runWatches: [
        {
          runId: 42_551_000_001,
          name: "journeys",
          attempt: 1,
          since: startedAt,
          nextAt: startedAt + 24 * 60 * 60_000,
          reading: {
            head: PUSHED,
            url: "https://github.com/octo/meter/actions/runs/42551000001",
            state: "running",
            since: startedAt,
            at: startedAt,
          },
        },
      ],
    });
    await endTurn(at.crewmate, at.taskId);
    await tick();
    // The turn's end read the branch at once and found the push running.
    expect(at.reads).toContain(PUSHED);
    expect(at.tasks.get(at.taskId)?.delivery).toMatchObject({ headSha: PUSHED });
    expect(at.tasks.get(at.taskId)?.delivery?.ciWatch?.head).toBe(PUSHED);
    expect(at.held()).toBe(true);
    // Opened half way, the card offers no Merge on the earlier version and
    // its strip reads the new version's checks as running.
    const halfWay = at.onStage();
    expect(halfWay?.body).toMatch(
      /data-fact="checks" data-level="waiting"[^>]*>.*?<span class="inf-foot-v">running<\/span>/,
    );
    expect(halfWay?.body).toContain(
      `Requested run 42551000001 at ${PUSHED.slice(0, 7)}, which the app watches`,
    );
    expect(merges(halfWay)).toEqual([]);
    expect(halfWay?.body).toContain("A newer version was pushed after this card went up.");
    expect(
      at.tasks
        .timeline(at.taskId)
        .filter((event) => event.kind === "note")
        .map((event) => event.text),
    ).toContain(`Kept the merge card “${TITLE}” from you until its new version's checks end.`);
    // The checks pass and the run finishes: the watches end and wake the
    // crewmate, whose turn still holds the card.
    at.remote.checks = "green";
    seedDelivery(at.tasks, at.taskId, { runWatches: [] });
    await at.minute();
    expect(at.tasks.get(at.taskId)?.delivery?.ciWatch).toBeUndefined();
    expect(at.held()).toBe(true);
    // The crewmate redraws the card at the new version and ends its turn.
    at.publish(2, PUSHED);
    await at.call({
      did: ["Published the story on the branch and read it back."],
      ready: { revision: 2, title: TITLE, head: PUSHED },
    });
    await tick();
    await endTurn(at.crewmate, at.taskId);
    await tick();
    expect(at.held()).toBe(false);
    const back = at.onStage();
    expect(merges(back)).toHaveLength(1);
    expect(back?.body).toContain("The meter reads true at night too.");
    expect(at.raised().map((event) => event.data)).toEqual([
      expect.anything(),
      expect.objectContaining({ returned: true, heldFor: expect.any(String) }),
    ]);
  });

  // The host answers a read seconds later, never in the same pass, so a
  // recheck can land while the read is out.
  it("waits for a slow read without rechecking in a loop, through a record change", async () => {
    const at = await shown();
    await at.replyAndAnswer("make it read true at night too", "On it.");
    at.remote.head = PUSHED;
    at.remote.checks = "pending";
    at.answerReadsAfter(5_000);
    const original = at.supervisor.cards.recheckHeld.bind(at.supervisor.cards);
    let rechecks = 0;
    vi.spyOn(at.supervisor.cards, "recheckHeld").mockImplementation((reason) => {
      rechecks += 1;
      if (rechecks > 50) throw new Error("recheckHeld runs in a loop");
      original(reason);
    });
    await endTurn(at.crewmate, at.taskId);
    await tick();
    expect(at.held()).toBe(true);
    expect(at.reads).toEqual([PUSHED]);
    // A record change lands while the read is out.
    at.tasks.note(at.taskId, "An unrelated line on the timeline.", { news: false });
    await tick();
    expect(rechecks).toBeLessThan(10);
    await vi.advanceTimersByTimeAsync(5_000);
    await tick();
    expect(at.tasks.get(at.taskId)?.delivery).toMatchObject({ headSha: PUSHED });
    expect(at.tasks.get(at.taskId)?.delivery?.ciWatch?.head).toBe(PUSHED);
    expect(at.reads).toEqual([PUSHED]);
    expect(rechecks).toBeLessThan(10);
    expect(at.held()).toBe(true);
  });

  // A crewmate may push from a background job that outlives its turn: a
  // read at that turn's end finds the earlier version, and the push lands
  // only when the job ends and wakes it.
  it("stays away while the crewmate's background job runs, then reads the push the job made", async () => {
    const at = await shown();
    await at.replyAndAnswer("make it read true at night too", "On it.");
    at.runJob(true);
    await endTurn(at.crewmate, at.taskId);
    await tick();
    expect(at.held()).toBe(true);
    expect(at.holdNotes()).toEqual([]);
    const card = at.supervisor.cards.get(at.cardId) as Card;
    const posture = at.supervisor.postures.workPosture(at.tasks.get(at.taskId) as TaskRecord);
    expect(threadWait(card, posture)).toEqual({ on: "rework", checks: false });
    // The shared tick reads the branch while the job still runs: the push
    // has not landed, and that read settles nothing.
    await at.minute();
    expect(at.reads).toContain(HEAD);
    expect(at.held()).toBe(true);
    // The job pushes and ends, and a record change rechecks the card before
    // any later read: the read after the work is owed, and it finds the push.
    at.remote.head = PUSHED;
    at.remote.checks = "pending";
    at.runJob(false);
    at.supervisor.cards.recheckHeld();
    await tick();
    expect(at.tasks.get(at.taskId)?.delivery?.headSha).toBe(PUSHED);
    expect(at.held()).toBe(true);
    expect(at.holdNotes()).toHaveLength(1);
  });

  it("returns at turn end after a reply that pushed nothing, with or without a watch standing", async () => {
    const at = await shown();
    await at.replyAndAnswer("does it read true at night?", "Yes; the night test covers it.");
    await endTurn(at.crewmate, at.taskId);
    await tick();
    expect(at.reads).toEqual([HEAD]);
    expect(at.held()).toBe(false);
    expect(merges(at.onStage())).toHaveLength(1);
    expect(at.holdNotes()).toEqual([]);

    // Again with a watch standing on the version the card shows.
    const again = await shown();
    seedDelivery(again.tasks, again.taskId, {
      ciWatch: { head: HEAD, since: Date.now(), nextAt: Date.now() + 60_000, tries: 0 },
    });
    again.remote.checks = "pending";
    await again.replyAndAnswer("does it read true at night?", "Yes; the night test covers it.");
    await endTurn(again.crewmate, again.taskId);
    await tick();
    expect(again.held()).toBe(false);
    expect(again.holdNotes()).toEqual([]);
  });

  it("returns at turn end on a project with no checks or only checks a person starts", async () => {
    for (const checks of ["none", "manual"] as const) {
      const at = await shown();
      await at.replyAndAnswer("rename the flag", "Renamed and pushed.");
      at.remote.head = PUSHED;
      at.remote.checks = checks;
      await endTurn(at.crewmate, at.taskId);
      await tick();
      expect(at.tasks.get(at.taskId)?.delivery?.headSha).toBe(PUSHED);
      expect(at.tasks.get(at.taskId)?.delivery?.ciWatch).toBeUndefined();
      // The push woke the crewmate to bring its card up to date (INF-4031):
      // the card waits for that turn, not for checks no one runs.
      expect(at.held()).toBe(true);
      await endTurn(at.crewmate, at.taskId);
      await tick();
      expect(at.held()).toBe(false);
      // Back behind its change, never offering Merge on the earlier version.
      expect(merges(at.onStage())).toEqual([]);
    }
  });

  it("returns at turn end when the app reads no checks for the project", async () => {
    const at = await shown({ checks: false });
    await at.replyAndAnswer("rename the flag", "Renamed and pushed.");
    await endTurn(at.crewmate, at.taskId);
    await tick();
    expect(at.held()).toBe(false);
  });

  it("holds nothing on a failed read", async () => {
    const at = await shown();
    at.failReads(true);
    await at.replyAndAnswer("rename the flag", "Renamed and pushed.");
    at.remote.head = PUSHED;
    await endTurn(at.crewmate, at.taskId);
    await tick();
    expect(at.held()).toBe(false);
  });

  it("returns with failed checks, once, without a crewmate turn when its lane cannot deliver", async () => {
    const at = await shown();
    await at.replyAndAnswer("rename the flag", "Renamed and pushed.");
    at.remote.head = PUSHED;
    at.remote.checks = "pending";
    await endTurn(at.crewmate, at.taskId);
    await tick();
    expect(at.held()).toBe(true);
    await endTurn(at.crewmate, at.taskId);
    await tick();
    expect(at.held()).toBe(true);
    // biome-ignore lint/complexity/useLiteralKeys: the ladder is private, and only an element access reaches it
    const ladder = at.supervisor["ladder"];
    const witnesses = ladder.witnesses.bind(ladder);
    // The account is now held. The stand-ins are the lane's two facts: its
    // witness says so, and the checks' wake starts no turn, as a held lane's
    // does not.
    vi.spyOn(ladder, "witnesses").mockImplementation((taskId, now) => ({
      ...witnesses(taskId, now),
      accountHeld: true,
    }));
    vi.spyOn(at.supervisor.steer, "steerInternal").mockResolvedValue(undefined as never);
    at.remote.checks = "red";
    await at.minute();
    expect(at.held()).toBe(false);
    const back = at.onStage();
    expect(merges(back)).toEqual([]);
    expect(at.raised()).toHaveLength(2);
    await at.minute();
    expect(at.raised()).toHaveLength(2);
  });

  it("holds only the merge card: a question the rework raises arrives at once", async () => {
    const at = await shown();
    await at.replyAndAnswer("rename the flag", "Renamed and pushed.");
    at.remote.head = PUSHED;
    at.remote.checks = "pending";
    await at.specs[0]?.onCard?.({
      title: "Which name should the flag take?",
      body: "<p>Two names fit.</p>",
      actions: [
        { id: "short", label: "Short name", default: true },
        { id: "long", label: "Long name" },
      ],
      requiredActions: [],
    });
    await endTurn(at.crewmate, at.taskId);
    await tick();
    expect(at.held()).toBe(true);
    const question = at.cards().find((entry) => entry.title === "Which name should the flag take?");
    expect(question?.awaiting).toBeUndefined();
  });

  it("keeps a held card held across a restart, then returns it when its checks end", async () => {
    const at = await shown();
    await at.replyAndAnswer("rename the flag", "Renamed and pushed.");
    at.remote.head = PUSHED;
    at.remote.checks = "pending";
    await endTurn(at.crewmate, at.taskId);
    await endTurn(at.crewmate, at.taskId);
    expect(at.held()).toBe(true);
    expect(at.tasks.get(at.taskId)?.activity).toBe("idle");
    expect(at.holdNotes()).toHaveLength(1);
    at.supervisor.disposeAll();
    // The launch opens the task record again, as the app does.
    const tasks = new TaskService({ db: at.db, strict: true });
    at.reopen(tasks);
    const resumed = fakeCrewmate();
    const restarted = reboot(at, async () => resumed, {
      tasks,
      readCheckWatch: at.readCheckWatch,
      checkCi: async () => "green",
    });
    restarted.setFirstmateHooks({ notifyOp: vi.fn(), retryConverse: vi.fn() });
    await tick();
    expect(restarted.cards.get(at.cardId)?.awaiting).toBe("close-out");
    expect(at.holdNotes(tasks)).toHaveLength(1);
    vi.spyOn(restarted.steer, "steerInternal").mockResolvedValue(undefined as never);
    at.remote.checks = "green";
    await vi.advanceTimersByTimeAsync(60_000);
    await restarted.watch.pollCheckWatches(Date.now());
    await tick();
    // The restored card behind its change wakes the crewmate again (INF-4031):
    // the card waits for that turn's end too.
    expect(restarted.cards.get(at.cardId)?.awaiting).toBe("close-out");
    await endTurn(resumed, at.taskId);
    await tick();
    expect(restarted.cards.get(at.cardId)?.awaiting).toBeUndefined();
    expect(at.holdNotes(tasks)).toHaveLength(1);
    restarted.disposeAll();
  });

  it("ends the thread with a waiting line while held", async () => {
    const at = await shown();
    await at.replyAndAnswer("rename the flag", "Renamed and pushed.");
    at.remote.head = PUSHED;
    at.remote.checks = "pending";
    await endTurn(at.crewmate, at.taskId);
    await tick();
    await endTurn(at.crewmate, at.taskId);
    await tick();
    expect(at.held()).toBe(true);
    const card = at.supervisor.cards.get(at.cardId) as Card;
    const posture = at.supervisor.postures.workPosture(at.tasks.get(at.taskId) as TaskRecord);
    const wait = threadWait(card, posture);
    expect(wait).toEqual({ on: "rework", checks: true });
    expect(threadWaitWords({ on: "rework", checks: true }, "crewmate 1", Date.now())).toBe(
      "Answered. Checks are running on the new version, and this card comes back to you when they finish.",
    );
  });
});
