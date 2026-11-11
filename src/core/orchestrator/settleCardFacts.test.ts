import { SETTLE_FACT_VALUE_CLASS } from "@shared/cards";
import { checksDuration } from "@shared/checksSpan";
import { RUN_WATCH_WORDS } from "@shared/vocabulary";
import { describe, expect, it } from "vitest";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import type { WorkflowJobLine } from "../forge";
import { openInMemoryDatabase } from "../storage/db";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import type { CrewSupervisorOptions } from "./crewSupervisorOptions";
import { RUN_WATCH_TICK_MS, type RunReading, RunWatcher } from "./runWatch";
import { SettleFacts } from "./settleCardFacts";

/**
 * INF-3220: a merge card's Checks cell read passed while the crewmate held
 * the card for a requested phone check, which waited 87 minutes for a free
 * phone Mac; nothing on the card showed that wait. The captain picked the
 * fix "Show watched requested checks on the card's checks line": each
 * requested run the app watches for the version on offer gets its own cell
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
          /<span class="inf-fact" data-fact="run"[^>]*><span class="inf-fact-k">(.*?)<\/span><span class="[^"]*">(.*?)<\/span><\/span>/g,
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
