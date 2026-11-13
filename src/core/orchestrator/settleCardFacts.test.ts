import { SETTLE_FACT_VALUE_CLASS } from "@shared/cards";
import { checkSnapshotState, checkSnapshotSummary } from "@shared/checkSnapshot";
import {
  checksDuration,
  checksFinishedAgo,
  checksRestWords,
  checksSpanOf,
  checksSpanWords,
} from "@shared/checksSpan";
import { BATCH_CHECK_WORDS, REVIEW_WORDS, RUN_WATCH_WORDS } from "@shared/vocabulary";
import { describe, expect, it } from "vitest";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import { QUEUE_REMOVED_WORDS, QUEUE_STATUS, type WorkflowJobLine } from "../forge";
import { openInMemoryDatabase } from "../storage/db";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import type { CrewSupervisorOptions } from "./crewSupervisorOptions";
import { RUN_WATCH_TICK_MS, type RunReading, RunWatcher } from "./runWatch";
import { SettleFacts } from "./settleCardFacts";

/**
 * INF-3220: a merge card's Checks state read passed while the crewmate held
 * the card for a requested phone check, which waited 87 minutes for a free
 * phone Mac; nothing on the card showed that wait. The captain picked the
 * fix "Show watched requested checks on the card's checks line": each
 * requested run the app watches for the version on offer gets its own state
 * beside the pull request's checks, saying whether it is queued or running
 * and for how long.
 *
 * The readings are that phone run's own, as GitHub listed its jobs: the
 * request check finished at 7:25 PM, both device jobs then waited for a
 * phone Mac, and the iPhone job started at 8:52 PM.
 */
const HEAD = "5b69b7e32257d7e49adb27d02ea21019ca45d3f4";
const EARLIER = "9c551a6d0b2f4e1a8c3d5b7e9f1a2c4e6b8d0f13";
const RUN = 42_556_230_196;
const PAGE = `https://github.com/infinitary-labs/infinitary/actions/runs/${RUN}`;

function phoneRun(head: string, iPhone: string): RunReading {
  const job = (id: number, name: string, status: string, conclusion: string | null) =>
    ({ id, name, status, conclusion, failedAt: null }) satisfies WorkflowJobLine;
  return {
    run: {
      id: RUN,
      name: "phone",
      headSha: head,
      branch: "fm/task-3572be25",
      attempt: 1,
      status: "in_progress",
      conclusion: null,
      url: PAGE,
      startedAt: Date.parse("2026-11-09T03:24:27Z"),
    },
    list: {
      jobs: [
        job(128_962_436_071, "Manual request · Check phone check request", "completed", "success"),
        job(128_962_437_534, "Manual request · Export phone pictures", "completed", "skipped"),
        job(128_962_790_003, "Manual request · Phone checks (iPad)", "queued", null),
        job(128_962_790_073, "Manual request · Phone checks (iPhone)", iPhone, null),
      ],
      total: 4,
      complete: true,
    },
  };
}

describe("a merge card's requested runs (INF-3220)", () => {
  it("shows a watched run at the version on offer as queued, then running, each with how long", async () => {
    const queuedAt = Date.parse("2026-11-09T03:25:45Z");
    const iPhoneStarted = Date.parse("2026-11-09T04:52:30Z");
    let now = queuedAt;
    const db = openInMemoryDatabase();
    const tasks = new TaskService({ db, strict: true, now: () => now });
    seedTask(tasks, { id: "t1", title: "Show the card's pictures", status: "completed" });
    seedDelivery(tasks, "t1", {
      mode: "direct-pr",
      prNumber: 412,
      headSha: HEAD,
      ci: "green",
      ciAt: queuedAt,
      runWatches: [
        { runId: RUN, name: "phone", attempt: 1, since: queuedAt, nextAt: queuedAt },
        // A run for the version the pull request held before, still watched.
        {
          runId: 42_550_288_172,
          name: "journeys",
          attempt: 1,
          since: queuedAt - 30 * 60_000,
          nextAt: queuedAt + 24 * 60 * 60_000,
          reading: {
            head: EARLIER,
            url: "https://github.com/infinitary-labs/infinitary/actions/runs/42550288172",
            state: "running",
            since: queuedAt - 30 * 60_000,
            at: queuedAt - 60_000,
          },
        },
      ],
    });
    let reading = phoneRun(HEAD, "queued");
    const watcher = new RunWatcher({
      tasks,
      inbox: { woken: () => false },
      read: async () => reading,
      steer: async () => undefined,
    });
    const facts = new SettleFacts(
      {
        tasks,
        repos: { get: () => undefined },
      } as unknown as CrewSupervisorOptions,
      { now: () => now, taskDelivery: () => "direct-pr", reviewOpen: () => false },
    );
    const cells = () =>
      [
        ...(facts.strip("t1") ?? "").matchAll(
          /<span class="inf-foot-state" data-fact="run"[^>]*>.*?<span class="inf-foot-k">(.*?)<\/span> <span class="[^"]*">(.*?)<\/span><\/span>/g,
        ),
      ].map(([, label, value]) => ({ label, words: value?.replace(/<[^>]*>/g, "") }));

    await watcher.poll(now);
    // Read every minute while the device jobs wait: the wait keeps its start.
    for (now += RUN_WATCH_TICK_MS; now < iPhoneStarted; now += RUN_WATCH_TICK_MS)
      await watcher.poll(now);
    expect(cells()).toEqual([
      {
        label: "phone",
        words: `${RUN_WATCH_WORDS.queued} for ${checksDuration(now - queuedAt)}`,
      },
    ]);
    expect(facts.strip("t1")).toContain(`<a href="${PAGE}">`);
    expect(facts.strip("t1")).toContain(`class="${SETTLE_FACT_VALUE_CLASS}"`);

    // A phone Mac takes the iPhone job.
    reading = phoneRun(HEAD, "in_progress");
    const started = now;
    await watcher.poll(now);
    now += 5 * RUN_WATCH_TICK_MS;
    expect(cells()).toEqual([
      {
        label: "phone",
        words: `${RUN_WATCH_WORDS.running} for ${checksDuration(now - started)}`,
      },
    ]);

    // A newer version on offer: the run read at the earlier one leaves the strip.
    seedDelivery(tasks, "t1", { headSha: "0d4e2b6f8a1c3e5d7b9f2a4c6e8d0b1f3a5c7e9d" });
    expect(cells()).toEqual([]);
  });
});

/**
 * INF-3709: the captain said of the merge card's foot, eleven equal cells
 * beside the buttons, that it threw too much information at the reader with
 * no arrangement, and approved the plan's status line with the answers
 * "check counts: on rest" and "layout: status line". These tests hold what
 * that plan promises of the strip's own markup: one state per fact, sorted
 * by how much it needs the captain; the counts, duration and read times on
 * rest; and every state with words on rest reached with Tab.
 *
 * The record is the phone run's own pull request once its checks passed: the
 * three skipped jobs and the one passing check GitHub listed, the phone run
 * still waiting for a phone Mac, and an independent review that came back
 * with findings.
 */
describe("a merge card's status line (INF-3709)", () => {
  const startedAt = Date.parse("2026-11-09T03:11:20Z");
  const finishedAt = Date.parse("2026-11-09T03:18:52Z");
  const readAt = Date.parse("2026-11-09T03:25:45Z");
  const now = readAt + 4 * 60_000;
  const checks = {
    headSha: HEAD,
    absenceDeclared: false,
    items: [
      { name: "journey-repeats", state: "skipped" as const },
      { name: "phone-affected", state: "skipped" as const },
      { name: "replay-gate", state: "skipped" as const },
      { name: "typecheck-lint-build", state: "success" as const, startedAt, finishedAt },
    ],
  };
  const strip = () => {
    const db = openInMemoryDatabase();
    const tasks = new TaskService({ db, strict: true, now: () => now });
    seedTask(tasks, { id: "t1", title: "Show the card's pictures", status: "completed" });
    seedDelivery(tasks, "t1", {
      mode: "direct-pr",
      prNumber: 412,
      headSha: HEAD,
      ci: "green",
      ciAt: readAt,
      ciStartedAt: startedAt,
      ciFinishedAt: finishedAt,
      checks,
      runWatches: [
        {
          runId: RUN,
          name: "phone",
          attempt: 1,
          since: readAt,
          nextAt: now + RUN_WATCH_TICK_MS,
          reading: { head: HEAD, url: PAGE, state: "queued", since: readAt, at: now - 60_000 },
        },
      ],
      reviewVerdict: "findings",
      reviewSha: HEAD,
      reviewRisk: "medium",
      reviewRiskNote: "one production line moves.",
    });
    const facts = new SettleFacts(
      { tasks, repos: { get: () => undefined } } as unknown as CrewSupervisorOptions,
      { now: () => now, taskDelivery: () => "direct-pr", reviewOpen: () => false },
    );
    return facts.strip("t1") ?? "";
  };
  /** Each state of the line in the order drawn: its fact, level, opening tag and words. */
  const states = (html: string) =>
    [
      ...html.matchAll(
        /(<span class="inf-foot-state[^"]*" data-fact="(\w+)" data-level="(\w+)"[^>]*>)<svg.*?<\/svg>(.*?)<\/span><\/span>/g,
      ),
    ].map(([, tag, fact, level, words]) => ({
      fact,
      level,
      tag: tag ?? "",
      words: (words ?? "").replace(/<[^>]*>/g, ""),
    }));

  it("draws one state per fact, the one that needs the captain first and the passed one last", () => {
    const line = states(strip());
    // The record holds them checks, run, review: the line sorts them.
    expect(line.map(({ fact, level }) => `${fact} ${level}`)).toEqual([
      "review warn",
      "run waiting",
      "checks ok",
    ]);
    expect(line.map(({ words }) => words)).toEqual([
      `Review ${REVIEW_WORDS.findings}`,
      `phone ${RUN_WATCH_WORDS.queued} for ${checksDuration(now - readAt)}`,
      `Checks ${checkSnapshotState(checks)} · ${checksFinishedAgo(finishedAt, now)}`,
    ]);
    // The reference follows the states, on the same line.
    const html = strip();
    expect(html.indexOf('class="inf-foot-ref"')).toBeGreaterThan(
      html.lastIndexOf('class="inf-foot-state'),
    );
    expect(html.match(/<p class="inf-foot-line">/g)).toHaveLength(1);
  });

  it("keeps the counts, how long the checks took and when they were read for rest", () => {
    const span = checksSpanOf({
      ci: "green",
      checks,
      headSha: HEAD,
      ciStartedAt: startedAt,
      ciFinishedAt: finishedAt,
    });
    if (!span) throw new Error("the passed checks have a span");
    const rest = checksRestWords(
      span,
      readAt,
      checksSpanWords(checkSnapshotSummary(checks).words, span, now),
    );
    expect(rest).toContain(checksDuration(finishedAt - startedAt));
    const html = strip();
    const state = states(html).find(({ fact }) => fact === "checks");
    expect(state?.tag).toContain(`title="${rest}"`);
    // In the open the state says one word and its age, never the counts.
    expect(state?.words).not.toContain("skipped");
    // The same words stand on the line a keyboard's focus shows under the states.
    expect(html).toContain(
      `<span class="inf-foot-rest" data-rest="checks" aria-hidden="true">${rest}</span>`,
    );
  });

  it("makes each state with words on rest a Tab stop, by itself or through its link", () => {
    const line = states(strip());
    const tag = (fact: string) => line.find((state) => state.fact === fact)?.tag ?? "";
    expect(tag("checks")).toContain('tabindex="0"');
    expect(tag("review")).toContain('tabindex="0"');
    // The run's words are a link to its page, which is the Tab stop.
    expect(tag("run")).not.toContain("tabindex");
    expect(strip()).toContain(`<a href="${PAGE}">${RUN_WATCH_WORDS.queued} for`);
  });
});

/**
 * INF-4018, the captain's answer 3 on its plan: the app takes its queue
 * mark off a version while the captain's newer words hold the approval, and
 * the Batch check state then says "on hold" with one line naming what it
 * waits for, never "failed". The reading is PR #1660's at its approved
 * version, as the app now records the removal status.
 */
describe("the Batch check state after the app removed its queue mark (INF-4018)", () => {
  const APPROVED = "091ae0a6c2f84d1b9e3a5c7d0f2b4e6a8c1d3f50";
  function strip(guidance?: { latest: number; declared: number; at: number }) {
    const db = openInMemoryDatabase();
    const tasks = new TaskService({ db, strict: true, now: () => 1 });
    seedTask(tasks, { id: "t1", title: "Ship it", status: "completed", branch: "fm/task-t1" });
    seedDelivery(tasks, "t1", {
      prNumber: 1660,
      headSha: APPROVED,
      ci: "green",
      ciAt: 1,
      checks: {
        headSha: APPROVED,
        prNumber: 1660,
        items: [
          { name: "typecheck-lint-build", state: "success" },
          { name: QUEUE_STATUS, state: "skipped" },
        ],
        absenceDeclared: false,
      },
      queueStatus: { head: APPROVED, words: QUEUE_REMOVED_WORDS },
      ...(guidance
        ? {
            mergeAuthorization: {
              version: 1 as const,
              id: "kept-1660",
              generation: 1,
              issuer: "captain" as const,
              at: 1,
              card: { id: "card-t1-merge", offerId: "offer-1", actionId: "merge" },
              target: {
                repoId: "infinitary",
                host: "github.com",
                owner: "octo",
                name: "infinitary",
                prNumber: 1660,
                branch: "fm/task-t1",
                delivery: "direct-pr" as const,
                method: "squash" as const,
              },
              approvedHead: APPROVED,
              lineage: [],
              proceedWithOpen: false,
              status: "standing" as const,
              guidance,
            },
          }
        : {}),
    });
    const facts = new SettleFacts(
      { tasks, repos: { get: () => undefined } } as unknown as CrewSupervisorOptions,
      { now: () => 1, taskDelivery: () => "queue-pr", reviewOpen: () => false },
    );
    return facts.strip("t1") ?? "";
  }
  const batch = (html: string) =>
    new RegExp(
      `data-fact="batch" data-level="(\\w+)"[^>]*>.*?<span class="${SETTLE_FACT_VALUE_CLASS}">(.*?)</span></span>`,
    )
      .exec(html)
      ?.slice(1);
  const why = (html: string) =>
    /<p class="inf-foot-why" data-why="batch">(.*?)<\/p>/.exec(html)?.[1];

  it("reads waiting for your approval, with no line under it, when no approval stands", () => {
    const html = strip();
    expect(batch(html)).toEqual(["waiting", BATCH_CHECK_WORDS.approval]);
    expect(why(html)).toBeUndefined();
  });

  it("reads on hold, with the line naming what it waits for, while newer words hold the approval", () => {
    const html = strip({ latest: 1, declared: 0, at: 1 });
    expect(batch(html)).toEqual(["waiting", BATCH_CHECK_WORDS.held]);
    expect(why(html)).toBe(BATCH_CHECK_WORDS.heldWhy);
  });
});
