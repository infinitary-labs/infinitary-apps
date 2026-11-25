import { join } from "node:path";
import { CLAUDE_PROVIDER_ID } from "@shared/providers";
import { heartbeatBeat } from "../../src/core/orchestrator/heartbeat.ts";
import { Scheduler } from "../../src/core/orchestrator/scheduler.ts";
import { standingWork } from "../../src/core/orchestrator/standingWork.ts";
import { FIRSTMATE_USAGE_TASK_ID } from "../../src/core/storage/usageStore.ts";
import { seedTask } from "../../src/core/tasks/seedTask.ts";
import { HEARTBEAT_RULE_ID } from "../../src/shared/heartbeat.ts";
import type { ApprovalCase } from "./approvalHandoff.ts";
import { NUMBER_LIKE_ID, volatile } from "./firstmateSignOff.ts";
import { approvalHost } from "./host.ts";

/**
 * The Heartbeat runbook's guide on real first mate turns (INF-6692; the captain chose a required
 * live check of all four behaviors on its review). Each case turns the runbook on, seeds a
 * disposable record, and lets the real Scheduler and heartbeat decision deliver one beat to the
 * production first mate, so the model reads the turn exactly as the app serves it. What the model
 * does with it is read independently from its calls, final text and the host's state.
 */
export type HeartbeatCase = ApprovalCase & {
  /** What the standing list holds when the beat goes. */
  list: "empty" | "new-last-part" | "told-last-part";
  /**
   * A conversation summary the turn opens with, in the words the Claude client continues a
   * summarized conversation with: the case where the guide asks for open work to be read first.
   */
  summary?: string;
  /** What the guide asks of this turn, for the independent reading. */
  guideAsks: string;
};

const heartbeatCase = (
  id: string,
  list: HeartbeatCase["list"],
  expected: ApprovalCase["expected"],
  maxCalls: number,
  guideAsks: string,
  summary?: string,
): HeartbeatCase => ({
  id,
  role: "firstmate",
  expected,
  maxCalls,
  context: "",
  tasks: {},
  runbooks: { heartbeat: true },
  list,
  guideAsks,
  ...(summary ? { summary } : {}),
});

const SUMMARY = `This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.

Summary:
1. The captain asked for the 2.0 release. It is planned as "Ship the 2.0 release" with two parts: "Update the changelog" and "Write the release checklist".
2. The captain asked to keep "Write the release checklist" waiting in the backlog for now.
3. At the last turn "Update the changelog" was still being built.`;

export const heartbeatCases: HeartbeatCase[] = [
  heartbeatCase(
    "quiet-beat",
    "empty",
    "wait",
    2,
    "No row is new: the turn is one line that starts with Found, and no tool is called.",
  ),
  heartbeatCase(
    "new-last-part",
    "new-last-part",
    "clarify",
    4,
    "A parked part is new and now the last open part its parent waits on: ask the captain once on one heartbeat card, and start nothing.",
  ),
  heartbeatCase(
    "told-last-part",
    "told-last-part",
    "wait",
    3,
    "The same part is listed but not new, and the heartbeat card about it is still open: no second ask, no new card, a Found line.",
  ),
  heartbeatCase(
    "after-summary",
    "new-last-part",
    "clarify",
    5,
    "The conversation was summarized: read open work before acting on the new row, then ask once and start nothing.",
    SUMMARY,
  ),
];

/** A quiet first mate request, the plan's median: mostly read from the cache. */
const WARM = { input: 3, output: 56, cacheRead: 157_398, cacheWrite: 2_326 };
const MINUTE_MS = 60_000;

type Host = Awaited<ReturnType<typeof approvalHost>>;

/**
 * The plan, its built part and its parked last part, as the standing list
 * reads them. The captain stopped the checklist a day ago while the changelog
 * was still being built, and the changelog merged five minutes ago, so the
 * stopped part became the last one since the captain decided: news the guide
 * asks about once. A stop recorded after the last close says nothing new
 * (docs/report-sort.md, "The last part the captain stopped"). The close stays
 * inside the next-move check's settle (`STALL_WAKE_MS`, ten minutes): past
 * it the app would already have raised its own last-part card, and the
 * guide would leave the part to that card.
 */
function seedLastPart(host: Host, clock: { offset: number }): string {
  clock.offset = -26 * 60 * MINUTE_MS;
  seedTask(host.tasks, { id: "plan", title: "Ship the 2.0 release", status: "queued" });
  seedTask(host.tasks, {
    id: "changelog",
    title: "Update the changelog",
    parentId: "plan",
    status: "completed",
  });
  seedTask(host.tasks, {
    id: "checklist",
    title: "Write the release checklist",
    parentId: "plan",
    status: "queued",
    startPolicy: "on-request",
  });
  clock.offset = -24 * 60 * MINUTE_MS;
  const stop = host.tasks.starts.declareCaptainStop("checklist", "firstmate");
  if (!stop.ok) throw new Error("The parked part could not be stopped");
  clock.offset = -5 * MINUTE_MS;
  host.tasks.close("changelog", { status: "done", reason: "merged", actor: "host" });
  clock.offset = 0;
  return "checklist";
}

async function serveBeat(
  test: HeartbeatCase,
  dir: string,
  model: { provider: string; id: string },
  protectedDirs: readonly string[],
) {
  const clock = { offset: 0 };
  const host = await approvalHost(
    { ...test, taskClock: () => Date.now() + clock.offset },
    dir,
    model,
    protectedDirs,
  );
  // Preparation's own message stays open on the stand-in seat; a beat carries no captain message.
  for (const ask of host.tasks.capture.openThreadAsks(true)) {
    host.tasks.capture.closeAsk(ask.id, "closed");
    host.tasks.capture.markAnswered(ask.id, null);
  }
  const now = Date.now();
  const { schedules, usage } = host;
  if (test.list !== "empty") seedLastPart(host, clock);
  if (test.list !== "new-last-part") {
    // No row is new, so only the quiet reason sends this beat: a Claude request 52 minutes ago.
    usage.record({
      taskId: FIRSTMATE_USAGE_TASK_ID,
      model: { provider: CLAUDE_PROVIDER_ID, id: model.id },
      usage: WARM,
      at: now - 52 * MINUTE_MS,
    });
  }
  if (test.list === "told-last-part") {
    for (const row of standingWork(host, now).rows) host.inbox.recordOnce(row.taskId, row.once);
    // The earlier beat's card, shown through the production tool as the first mate's own.
    const emit = host.spec.tools.find((tool) => tool.name === "emit_card");
    if (!emit) throw new Error("The production first mate has no emit_card");
    await emit.run({
      id: "heartbeat",
      title: "A release part waits for you",
      body: "<p>Write the release checklist is the last part Ship the 2.0 release waits on. You asked it to wait.</p>",
      actions: [
        { id: "start", label: "Start it now", default: true },
        { id: "wait", label: "Keep it waiting", declines: true },
      ],
      asking: true,
    });
  }
  const scheduler = new Scheduler({
    store: schedules,
    inbox: host.inbox,
    notify: (wake, origin) => host.firstmate.notifyOp(wake, origin),
    broadcastEvent: () => {},
    heartbeat: (at) => heartbeatBeat({ schedules, usage, tasks: host.tasks, inbox: host.inbox }, at),
  });
  scheduler.keepBrought(true);
  schedules.setNextFire(HEARTBEAT_RULE_ID, now);
  const before = host.served.length;
  scheduler.tick(now);
  for (let wait = 0; host.served.length === before && wait < 100; wait++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  const served = host.served.at(-1);
  if (host.served.length === before || !served) {
    await host.close();
    throw new Error("The heartbeat delivered no beat to the first mate");
  }
  return { host, turn: served };
}

export const heartbeatHost: typeof approvalHost = async (test, dir, model, protectedDirs) => {
  const beat = test as HeartbeatCase;
  let shown = await serveBeat(beat, join(dir, "attempt-1"), model, protectedDirs);
  // Fresh ids each attempt; five number-like draws in a row are vanishingly rare.
  for (let attempt = 2; NUMBER_LIKE_ID.test(shown.turn) && attempt <= 5; attempt++) {
    await shown.host.close();
    shown = await serveBeat(beat, join(dir, `attempt-${attempt}`), model, protectedDirs);
  }
  if (NUMBER_LIKE_ID.test(shown.turn)) throw new Error("Every attempt drew an id that reads as a number");
  const { host, turn } = shown;
  return {
    ...host,
    prompt: beat.summary ? `${beat.summary}\n\n${turn}` : turn,
    ids: { ...host.ids, ...volatile(turn) },
    state: () => ({
      ...host.state(),
      guideAsks: beat.guideAsks,
      started: [...host.starts],
      shownCards: host.supervisor.cards
        .snapshot()
        .map(({ id, title, body, actions }) => ({ id, title, body, actions })),
      checklist: host.tasks.get("checklist")?.status ?? "missing",
    }),
  };
};

export const evaluation = {
  name: "heartbeat-guide",
  cases: heartbeatCases,
  host: heartbeatHost,
};
