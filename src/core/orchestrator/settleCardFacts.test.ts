import { type Card, SETTLE_FACT_VALUE_CLASS, type TaskFactsPart } from "@shared/cards";
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
import type { WorkflowJobLine } from "../forge";
import { openInMemoryDatabase } from "../storage/db";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import { CHECK_VERDICT_WORDS } from "./checkVerdicts";
import type { CrewSupervisorOptions } from "./crewSupervisorOptions";
import { RUN_WATCH_TICK_MS, type RunReading, RunWatcher } from "./runWatch";
import { emittedSettleFacts, SettleFacts, settleCardFacts } from "./settleCardFacts";

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
  const strip = (review: Parameters<typeof seedDelivery>[2] = {}) => {
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
      ...review,
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

  // INF-6536 finding 3: a pass a takeover carries from the task that earned
  // it names that task on the merge card.
  it("names the task that earned a carried pass", () => {
    const line = states(
      strip({
        reviewVerdict: "pass",
        reviewFrom: {
          taskId: "t0",
          key: "INF-6468",
          title: "Show the card's pictures",
          proof: false,
        },
      }),
    );
    expect(line.find(({ fact }) => fact === "review")).toMatchObject({
      level: "ok",
      words: "Review passed in INF-6468",
    });
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

// Intent: INF-5097 piece 1: the merge card's Batch check says how many times the
// change was sent back from its batches, with each reason and the checks that never
// ran there in its details.
describe("a merge card's batch check for a change sent back before (INF-5097)", () => {
  const now = Date.parse("2026-11-19T09:00:00Z");
  const strip = () => {
    const db = openInMemoryDatabase();
    const tasks = new TaskService({ db, strict: true, now: () => now });
    seedTask(tasks, { id: "t1", title: "Read dates with a time zone", status: "completed" });
    seedDelivery(tasks, "t1", {
      mode: "queue-pr",
      headSha: HEAD,
      ci: "green",
      ciAt: now,
      checks: {
        headSha: HEAD,
        absenceDeclared: false,
        items: [{ name: "typecheck-lint-build", state: "success" as const }],
      },
      queueStatus: {
        head: HEAD,
        sentBack: [
          {
            head: EARLIER,
            reason: "Its date test fails on the batch's version.",
            at: now - 3_600_000,
            notRun: ["journeys", "browser-tests"],
            change: "#31",
            link: "https://github.com/acme/meter/pull/31",
          },
          {
            head: "7c3e9a1f5b2d8c4a0e6f1b9d3a7c5e2f8b4d0a6c",
            reason: "Its repair still fails the leap-year <date> test.",
            at: now - 600_000,
            notRun: [],
            change: "#33",
          },
          // A batch whose checks were read only in part: which never ran is not known.
          {
            head: "9e1b5d3f7a2c8e4b0d6a1f9c3e7b5d2a8f4c0e6b",
            reason: "Its repair breaks the export of dates.",
            at: now - 300_000,
            change: "#35",
          },
        ],
      },
    });
    const facts = new SettleFacts(
      { tasks, repos: { get: () => undefined } } as unknown as CrewSupervisorOptions,
      { now: () => now, taskDelivery: () => "queue-pr", reviewOpen: () => false },
    );
    return facts.strip("t1") ?? "";
  };

  it("says how many times on the status line and each reason with its never-run checks in its details", () => {
    const html = strip();
    expect(html).toMatch(
      new RegExp(`data-fact="batch" data-level="warn"[^>]*>.*?${BATCH_CHECK_WORDS.sentBack(3)}`),
    );
    expect(html).toContain(
      `<details class="inf-foot-why" data-history="batch"><summary>${BATCH_CHECK_WORDS.sentBackSummary(3)}</summary><ul>` +
        `<li><a href="https://github.com/acme/meter/pull/31">#31</a>: Its date test fails on the batch's version. ${BATCH_CHECK_WORDS.neverRan(["journeys", "browser-tests"])}</li>` +
        "<li>#33: Its repair still fails the leap-year &lt;date&gt; test.</li>" +
        `<li>#35: Its repair breaks the export of dates. ${BATCH_CHECK_WORDS.neverRanUnknown}</li></ul></details>`,
    );
  });
});

// Intent: a Review finding card asks the captain about the work itself, so its
// strip shows none of the checks, their causes or the review's own state, which
// stay on the builder's merge card. The readings are a real review's: four
// checks failed at the reviewed version, three diagnosed as caused by the
// change and one as broken on main too, beside the review's findings.
describe("a Review finding card's strip", () => {
  const now = Date.parse("2026-11-21T20:34:00Z");
  const failedAt = now - 26 * 3_600_000;
  const failed = [
    "Manual request · Selected app journeys (Mac)",
    "Branch push · Code, build, affected tests and critical path (Linux)",
    "Manual request · Install and run the Windows app (fresh Windows 11)",
    "Manual request · Selected journeys (Linux; part 3/5)",
  ];
  const reading = () => {
    const db = openInMemoryDatabase();
    const tasks = new TaskService({ db, strict: true, now: () => now });
    seedTask(tasks, {
      id: "builder",
      title: "Make the address the default way to add a computer",
      status: "completed",
    });
    seedDelivery(tasks, "builder", {
      mode: "queue-pr",
      changeLabel: "inf/ssh-address-default-add-computer",
      headSha: HEAD,
      ci: "red",
      ciAt: failedAt,
      ciFinishedAt: failedAt,
      checks: {
        headSha: HEAD,
        absenceDeclared: false,
        items: failed.map((name) => ({ name, state: "failure" as const })),
      },
      ciRepair: {
        failures: [{ headSha: HEAD, checks: failed }],
        diagnoses: failed.map((check, index) => ({
          headSha: HEAD,
          check,
          classification: index === 1 ? ("baseline-blocked" as const) : ("own-regression" as const),
          evidence: "The failed step names an assertion this change added.",
          at: failedAt,
        })),
        repairs: [],
      },
      changeLines: { base: EARLIER, head: HEAD, added: 6673, deleted: 558, at: now },
      reviewVerdict: "findings",
      reviewSha: HEAD,
      reviewRisk: "medium",
    });
    const facts = new SettleFacts(
      { tasks, repos: { get: () => undefined } } as unknown as CrewSupervisorOptions,
      { now: () => now, taskDelivery: () => "queue-pr", reviewOpen: () => false },
    );
    return {
      facts: (part: TaskFactsPart) => facts.strip("builder", part),
      othersOpen: () => true,
      followups: () => undefined,
    };
  };
  const finding = {
    title: "Review of the address change: notices during a folder move or a second launch",
    body: "<p>If two launches are refused at once, should the second show its own question?</p>",
    reviewTaskId: "review",
    actions: [
      { id: "send", label: "Send choices", default: true },
      { id: "not-now", label: "Not now", declines: true as const },
    ],
  };
  const states = ["checks", "run", "batch", "review", "override"];
  const factsOf = (body: string) =>
    [...body.matchAll(/data-fact="(\w+)"/g)].map(([, fact]) => fact ?? "");

  it("names the change it asks about and none of its checks, which its merge card keeps", () => {
    const read = reading();
    const card = emittedSettleFacts(finding, read).body;
    expect(factsOf(card)).toEqual(["project", "change", "lines"]);
    expect(card).not.toContain("inf-foot-needs");
    for (const verdict of Object.values(CHECK_VERDICT_WORDS)) expect(card).not.toContain(verdict);

    const merge = emittedSettleFacts(
      {
        ...finding,
        title: "The address is the default way to add a computer",
        reviewTaskId: undefined,
        actions: [{ id: "merge", label: "Merge", effect: { kind: "merge", after: "close" } }],
      },
      read,
    ).body;
    expect(factsOf(merge).filter((fact) => states.includes(fact))).toEqual(["checks", "review"]);
    expect(merge.split(CHECK_VERDICT_WORDS["own-regression"])).toHaveLength(4);
    expect(merge).toContain(CHECK_VERDICT_WORDS["baseline-blocked"]);
  });

  it("drops the checks from a card that went up with the whole strip on its next refresh", () => {
    const read = reading();
    const shown: Card = {
      ...finding,
      id: "card-review-1",
      taskId: "review",
      author: "crewmate",
      meta: "crewmate",
      priority: 40,
      status: "ready",
      createdAt: now - 60_000,
      body: `${finding.body}${read.facts("whole")}`,
    };
    expect(factsOf(shown.body)).toContain("checks");
    const refreshed = settleCardFacts(shown, read).body;
    expect(factsOf(refreshed)).toEqual(["project", "change", "lines"]);
    expect(refreshed).toBe(`${finding.body}${read.facts("reference")}`);
  });
});
