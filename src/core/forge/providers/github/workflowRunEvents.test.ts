import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { FmEvent } from "@shared/events";
import { afterEach, describe, expect, it } from "vitest";
import { scratchDir } from "../../../../../tests/helpers/scratchDirs";
import {
  githubIntegration,
  IntegrationSettingsStore,
  IntegrationsService,
} from "../../../integrations";
import { GithubGatewayService } from "../../../orchestrator/githubGateway";
import { Scheduler } from "../../../orchestrator/scheduler";
import { renderWake } from "../../../orchestrator/wakes";
import { openInMemoryDatabase } from "../../../storage/db";
import { FIRSTMATE_RECIPIENT, InboxStore } from "../../../storage/inboxStore";
import { ScheduleStore } from "../../../storage/scheduleStore";
import { TaskService } from "../../../tasks/taskService";
import { RepoRegistry } from "../../../workspace/repoRegistry";
import { API_CALLS_PER_TASK } from "../../api";
import { GitHubForge } from "./githubForge";

/**
 * INF-2146's plan, the captain's answer to its question 4 ("i don't want to
 * hard code this behavior ... as an automation?"): the GitHub integration
 * tells "A workflow run fails" and "A workflow run finishes", and the
 * captain's own Automation rule says what happens. These drive a rule
 * through the real Scheduler, integrations service, GitHub binding and
 * gateway against a stand-in GitHub that answers in GitHub's shapes. The
 * runs are this project's verify runs as GitHub listed them on Oct 31
 * (run 77, its jobs, and the newest passing run 60), trimmed to the fields
 * GitHub sends that matter here.
 */

const REPO = "infinitary-labs/infinitary";
const VERIFY = 386227725;

type StandInRun = {
  id: number;
  name: string;
  path: string;
  head_branch: string;
  head_sha: string;
  event: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: "success" | "failure" | "cancelled" | null;
  workflow_id: number;
  html_url: string;
  created_at: string;
  run_attempt: number;
  repository: { full_name: string };
  head_repository: { full_name: string };
};

const run = (
  id: number,
  fields: Partial<StandInRun> & Pick<StandInRun, "head_sha" | "created_at">,
): StandInRun => ({
  id,
  name: "verify",
  path: ".github/workflows/verify.yml",
  head_branch: "main",
  event: "workflow_dispatch",
  status: "completed",
  conclusion: "failure",
  workflow_id: VERIFY,
  html_url: `https://github.com/${REPO}/actions/runs/${id}`,
  run_attempt: 1,
  repository: { full_name: REPO },
  head_repository: { full_name: REPO },
  ...fields,
});

/** Verify run 60 on Oct 25, the newest that passed on main. */
const PASSING = run(40187206927, {
  head_sha: "98940cea7b83d23e25e735db03c8f1782cc6af47",
  created_at: "2026-10-25T11:02:23Z",
  conclusion: "success",
});
/** Verify run 76 on Oct 28, which failed before the rule listened. */
const BEFORE = run(40676811733, {
  head_sha: "66d9491a0fded020f09c19510b4a27dae2d85718",
  created_at: "2026-10-28T11:02:17Z",
});
const RED_HEAD = "41163dc192c032c622880d19e1ecc3759cf276ad";
const RED_ID = 40862271620;
/** Verify run 77, created once the rule listens, as it ran and as it ended. */
const red = (ended: boolean) =>
  run(RED_ID, {
    head_sha: RED_HEAD,
    created_at: "2026-10-31T16:02:31Z",
    status: ended ? "completed" : "in_progress",
    conclusion: ended ? "failure" : null,
  });

const job = (
  name: string,
  conclusion: "success" | "failure" | "skipped" | "cancelled" | null,
  step?: string,
) => ({
  name,
  status: conclusion ? "completed" : "in_progress",
  conclusion,
  steps: step ? [{ name: step, status: "completed", conclusion }] : [],
});
/** Run 77's jobs while it ran: the Mac job had failed, the rest still went. */
const MAC = job(
  "mac",
  "failure",
  "Run pnpm exec electron-builder --mac dir --universal --config electron-builder.dev.yml",
);
const RED_JOBS_RUNNING = [
  MAC,
  job("linux-e2e / journeys (desktop 3/4)", null),
  job("linux-checks", "success"),
];
const RED_JOBS_ENDED = [
  MAC,
  job(
    "linux-e2e / journeys (desktop 3/4)",
    "failure",
    "Run the journeys with the sandbox on, and affected resize callers on Mac",
  ),
  job("Verify signed installer and updater", "skipped"),
  job("linux-checks", "success"),
];

/**
 * Merge batch run 33 on Nov 21, which stopped its own jobs once a test
 * group failed again: GitHub ended it cancelled with three failed jobs.
 */
const STOPPED_ID = 44963568384;
const STOPPED = run(STOPPED_ID, {
  name: "batch",
  path: ".github/workflows/batch-pull-request.yml",
  head_branch: "infinitary-batch/73a07a49",
  head_sha: "ca1f10d1c1eb0ba55521a9ff808986c643b2352c",
  event: "pull_request",
  conclusion: "cancelled",
  workflow_id: 424213309,
  created_at: "2026-11-21T23:48:25Z",
});
const GROUP = "Merge batch · Batch checks / Merge batch · Desktop checks / Merge batch ·";
const STOPPED_JOBS = [
  job(
    `${GROUP} Integration tests (Linux; group 1/2)`,
    "failure",
    'Run pnpm test $PROJECTS --shard="$SHARD/$SHARDS"',
  ),
  job(
    `${GROUP} Integration tests (Linux; group 2/2)`,
    "cancelled",
    'Run pnpm test $PROJECTS --shard="$SHARD/$SHARDS"',
  ),
  job("Merge batch · Batch checks / Merge batch · Code checks (Linux)", "success"),
];
/** A branch's ci run on Nov 22, cancelled by its branch's next push with no failed job. */
const SUPERSEDED = run(44985522751, {
  name: "ci",
  path: ".github/workflows/ci.yml",
  head_branch: "inf/ssh-address-default-add-computer-247f",
  head_sha: "ee9b2a33cae700abccc6fd6269e910a5b83bb53d",
  event: "push",
  conclusion: "cancelled",
  workflow_id: 424213310,
  created_at: "2026-11-22T04:32:43Z",
});
const SUPERSEDED_JOBS = [
  job("Branch push · Code checks (Linux)", "success"),
  job(
    "Branch push · Tests a change reaches (Linux)",
    "cancelled",
    "Unit, integration and browser tests that read a changed file",
  ),
  job("Manual request · Unit tests (Linux)", "skipped"),
];

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

/**
 * The project's address before it moved, and the repository's number,
 * which GitHub's redirect from the old address names.
 */
const OLD_REPO = "infinitary-labs/firstmate-3000";
const REPO_NUMBER = 1061840823;

async function setup() {
  /**
   * What GitHub holds now, newest first as it lists runs. `moved` answers
   * the old address with GitHub's redirect to the repository by its number;
   * `gone` answers every read of the repository's runs with GitHub's 404.
   */
  const github = {
    runs: [BEFORE, PASSING] as StandInRun[],
    jobs: new Map<number, unknown[]>(),
    moved: false,
    gone: false,
  };
  const sent: string[] = [];
  const server = createServer(async (req, res) => {
    for await (const _ of req);
    const url = new URL(req.url ?? "/", "http://stand-in");
    sent.push(`${req.method} ${url.pathname}${url.search}`);
    const json = (value: unknown, status = 200) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    const query = url.searchParams;
    const listed = (runs: StandInRun[]) => {
      const created = query.get("created");
      const since = created?.startsWith(">=") ? Date.parse(created.slice(2)) : undefined;
      const workflow_runs = runs
        .filter((r) => !query.get("branch") || r.head_branch === query.get("branch"))
        .filter((r) => !query.get("status") || r.conclusion === query.get("status"))
        .filter((r) => since === undefined || Date.parse(r.created_at) >= since)
        .slice(0, Number(query.get("per_page") ?? 30));
      json({ total_count: workflow_runs.length, workflow_runs });
    };
    if (github.moved && url.pathname.startsWith(`/repos/${OLD_REPO}/`)) {
      const rest = url.pathname.slice(`/repos/${OLD_REPO}`.length);
      res.writeHead(301, {
        "Content-Type": "application/json",
        Location: `http://${req.headers.host}/repositories/${REPO_NUMBER}${rest}${url.search}`,
      });
      res.end(JSON.stringify({ message: "Moved Permanently" }));
      return;
    }
    if (github.moved && url.pathname === `/repositories/${REPO_NUMBER}`) {
      json({ id: REPO_NUMBER, full_name: REPO });
      return;
    }
    if (github.gone && url.pathname.startsWith(`/repos/${REPO}/`)) {
      json({ message: "Not Found" }, 404);
      return;
    }
    const jobs = url.pathname.match(/\/actions\/runs\/(\d+)\/jobs$/);
    const workflow = url.pathname.match(/^\/repos\/[^/]+\/[^/]+\/actions\/workflows\/(\d+)\/runs$/);
    if (url.pathname === `/repos/${REPO}/actions/runs`) listed(github.runs);
    else if (workflow) listed(github.runs.filter((r) => r.workflow_id === Number(workflow[1])));
    else if (jobs) {
      const all = github.jobs.get(Number(jobs[1])) ?? [];
      json({ total_count: all.length, jobs: all });
    } else json({ message: "Not Found" }, 404);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const root = scratchDir("fm-github-events-");
  const db = openInMemoryDatabase();
  cleanup.push(() => {
    db.close();
  });
  // The rule is turned on at 9:00 AM Pacific on Oct 31.
  let now = Date.parse("2026-10-31T16:00:00Z");
  const tasks = new TaskService({ db, strict: true, now: () => now });
  const gateway = new GithubGatewayService({
    tasks,
    repos: new RepoRegistry(db, join(root, "fleet")),
    forgeFor: () => {
      throw new Error("no project forge in this test");
    },
    accountForge: (host = "github.com") =>
      new GitHubForge(
        { kind: "github", host, dir: "" },
        {
          apiBaseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
          token: async () => "gho_fixture_owned_by_app",
        },
      ),
    readChecks: async () => "",
    now: () => now,
    sleep: async () => {},
  });
  const integrations = new IntegrationsService({
    bindings: [
      githubIntegration({
        signIns: {
          stateOf: () => "ok",
          loginOf: () => "kunchenguid",
          checkNow: async () => {},
          signOut: () => {},
        },
        gateway: {
          read: (task, input, through) => gateway.read(task, input, through),
          write: (task, input, through) => gateway.write(task, input, through, true),
          readAsSeat: (input) => gateway.readAsSeat(input),
          writeAsSeat: (input) => gateway.writeAsSeat(input),
          readForLook: (input) => gateway.readForLook(input),
        },
        now: () => now,
      }),
    ],
    store: new IntegrationSettingsStore(join(root, "integrations")),
  });
  const store = new ScheduleStore(db);
  const inbox = new InboxStore(db);
  // The first mate's notices go through the inbox as the app sends them,
  // so a notice told once is never queued again.
  const started = () =>
    new Scheduler({
      store,
      notify: (wake, origin) => inbox.enqueueWake(FIRSTMATE_RECIPIENT, wake, origin),
      inbox,
      broadcastEvent: (_event: FmEvent) => {},
      now: () => now,
      events: {
        find: (integration, event) => integrations.listenable(integration, event),
        look: (integration, event, cursor, filter, connection) =>
          integrations.look(integration, event, cursor, filter, connection),
      },
    });
  let scheduler = started();
  /** The app's tick, two minutes on (the events' cadence), with its looks answered. */
  const tick = async () => {
    for (const _ of [1, 2]) {
      now += 60_000;
      scheduler.tick(now);
      await scheduler.settled();
    }
  };
  /** The app starts again: a new scheduler over the same saved rules and inbox. */
  const restart = () => {
    scheduler = started();
    return scheduler;
  };
  const served = () => inbox.allFor(FIRSTMATE_RECIPIENT).map((row) => renderWake(row));
  const rule = (event: string, filter: Record<string, string>) =>
    scheduler.create(
      { kind: "event", integration: "GitHub", event, filter },
      "Main's full run: {{events}}",
      true,
      "Main's full run",
    );
  return {
    github,
    sent,
    gateway,
    integrations,
    get scheduler() {
      return scheduler;
    },
    tick,
    restart,
    served,
    rule,
  };
}

const MAIN_VERIFY = { repository: REPO, workflow: "verify.yml", branch: "main" };

describe("GitHub's workflow run events (INF-2146)", () => {
  it("lists both events with the repository, workflow and branch as filters", async () => {
    const { integrations } = await setup();
    const listened = integrations.listenable("github", "workflow_run_failed");
    expect(listened).toMatchObject({ label: "A workflow run fails", every: 2 });
    expect(listened?.filters?.map((f) => [f.name, f.required ?? false])).toEqual([
      ["repository", true],
      ["workflow", false],
      ["branch", false],
    ]);
    expect(integrations.listenable("github", "workflow_run_finished")?.label).toBe(
      "A workflow run finishes",
    );
  });

  it("tells a red run once, at its first failed job, with the run's facts and the newest passing version", async () => {
    const { github, tick, served, rule, scheduler } = await setup();
    const record = rule("workflow_run_failed", MAIN_VERIFY);
    await tick();
    // Run 76 failed before the rule listened: it is never told.
    expect(served()).toEqual([]);

    // Run 77 starts; its Mac job fails while the Linux journeys still go.
    github.runs.unshift(red(false));
    github.jobs.set(RED_ID, RED_JOBS_RUNNING);
    await tick();
    expect(served()).toHaveLength(1);
    expect(served()[0]).toContain(
      `Run ${RED_ID} of workflow "verify" (.github/workflows/verify.yml) in ${REPO} on branch main, from workflow_dispatch: has a failed job and is still running, attempt 1, at version ${RED_HEAD}. Failed jobs: mac at step "${MAC.steps[0]?.name}". Newest passing run of this workflow on main: ${PASSING.id} at version ${PASSING.head_sha}. https://github.com/${REPO}/actions/runs/${RED_ID} (id ${RED_ID})`,
    );

    // It ends red with a second failed job: still the one delivery, told once.
    github.runs[0] = red(true);
    github.jobs.set(RED_ID, RED_JOBS_ENDED);
    await tick();
    await tick();
    expect(served()).toHaveLength(1);
    expect(scheduler.history(record.id).flatMap((r) => r.events?.map((e) => e.id) ?? [])).toEqual([
      String(RED_ID),
    ]);
  });

  it("tells only the named workflow and branch, and leaves out passing runs and a fork's", async () => {
    const { github, tick, served, rule } = await setup();
    rule("workflow_run_failed", MAIN_VERIFY);
    await tick();
    const at = "2026-10-31T16:03:00Z";
    github.runs.unshift(
      run(1, {
        head_sha: "a".repeat(40),
        created_at: at,
        name: "ci",
        path: ".github/workflows/ci.yml",
      }),
      run(2, { head_sha: "b".repeat(40), created_at: at, head_branch: "fm/task-6546d318" }),
      run(3, { head_sha: "c".repeat(40), created_at: at, conclusion: "success" }),
      run(4, {
        head_sha: "d".repeat(40),
        created_at: at,
        head_repository: { full_name: "someone/infinitary" },
      }),
    );
    await tick();
    expect(served()).toEqual([]);
  });

  it("tells a run cancelled after a job failed, as one that stops its own jobs ends, and not one cancelled with none", async () => {
    const { github, tick, served, rule } = await setup();
    rule("workflow_run_failed", { repository: REPO });
    await tick();
    github.runs.unshift(SUPERSEDED, STOPPED);
    github.jobs.set(STOPPED.id, STOPPED_JOBS);
    github.jobs.set(SUPERSEDED.id, SUPERSEDED_JOBS);
    await tick();
    expect(served()).toHaveLength(1);
    expect(served()[0]).toContain(
      `Run ${STOPPED_ID} of workflow "batch" (.github/workflows/batch-pull-request.yml) in ${REPO} on branch infinitary-batch/73a07a49, from pull_request: ended cancelled, attempt 1, at version ${STOPPED.head_sha}. Failed jobs: ${STOPPED_JOBS[0]?.name} at step "${STOPPED_JOBS[0]?.steps[0]?.name}".`,
    );
    expect(served()[0]).not.toContain(String(SUPERSEDED.id));
  });

  it("tells a finished run once it ends, whatever its conclusion, holding its place while it runs", async () => {
    const { github, tick, served, rule } = await setup();
    rule("workflow_run_finished", { repository: REPO, workflow: "verify", branch: "main" });
    await tick();
    github.runs.unshift(red(false));
    github.jobs.set(RED_ID, RED_JOBS_RUNNING);
    await tick();
    expect(served()).toEqual([]);
    // A passing run started after it ends first; run 77 is still read until it ends.
    github.runs.unshift(
      run(40900000001, {
        head_sha: "e".repeat(40),
        created_at: "2026-10-31T16:30:00Z",
        conclusion: "success",
      }),
    );
    await tick();
    expect(served()).toHaveLength(1);
    expect(served()[0]).toContain('Run 40900000001 of workflow "verify"');
    expect(served()[0]).toContain("ended success");
    expect(served()[0]).not.toContain("Newest passing run");
    github.runs[1] = red(true);
    github.jobs.set(RED_ID, RED_JOBS_ENDED);
    await tick();
    expect(served()[0]).toContain(`Run ${RED_ID} of workflow "verify"`);
    expect(served()[0]).toContain(
      `ended failure, attempt 1, at version ${RED_HEAD}. Failed jobs: mac at step "${MAC.steps[0]?.name}"; linux-e2e / journeys (desktop 3/4) at step "Run the journeys with the sandbox on, and affected resize callers on Mac".`,
    );
  });

  it("follows a repository that moved, telling its red run under its new name", async () => {
    const { github, tick, served, rule, scheduler } = await setup();
    github.moved = true;
    const record = rule("workflow_run_failed", { ...MAIN_VERIFY, repository: OLD_REPO });
    await tick();
    github.runs.unshift(red(true));
    github.jobs.set(RED_ID, RED_JOBS_ENDED);
    await tick();
    expect(served()).toHaveLength(1);
    expect(served()[0]).toContain(
      `Run ${RED_ID} of workflow "verify" (.github/workflows/verify.yml) in ${REPO} on branch main`,
    );
    expect(scheduler.lookingFails(scheduler.rule(record.id))).toBeUndefined();
  });

  it("shows a rule as failing once every look has failed for an hour, and tells the first mate once", async () => {
    const { github, tick, restart, served, rule, scheduler } = await setup();
    const record = rule("workflow_run_failed", MAIN_VERIFY);
    await tick();
    github.gone = true;
    // One failed look changes nothing.
    await tick();
    expect(scheduler.lookingFails(scheduler.rule(record.id))).toBeUndefined();
    // Two minutes short of an hour of failed looks: still nothing.
    for (let look = 1; look < 29; look++) await tick();
    expect(scheduler.lookingFails(scheduler.rule(record.id))).toBeUndefined();
    expect(served()).toEqual([]);
    await tick();
    const failing = scheduler.lookingFails(scheduler.rule(record.id));
    expect(failing?.reason).toContain(`GitHub answered 404 for /repos/${REPO}/actions/runs`);
    expect(served()).toHaveLength(1);
    expect(served()[0]).toContain(
      `[fm-op] the automation "Main's full run" (rule id ${record.id}) gets nothing new: every look at GitHub for "A workflow run fails" has failed since ${new Date(failing?.since ?? 0).toISOString()}, 30 looks in a row.`,
    );
    // Another hour of failed looks, and a restart that counts them again, tell nothing new.
    for (let look = 0; look < 30; look++) await tick();
    const again = restart();
    for (let look = 0; look < 31; look++) await tick();
    expect(again.lookingFails(again.rule(record.id))).toBeDefined();
    expect(served()).toHaveLength(1);
    // The first look that answers clears it.
    github.gone = false;
    await tick();
    expect(again.lookingFails(again.rule(record.id))).toBeUndefined();
  });

  it("refuses a rule that names no repository", async () => {
    const { rule } = await setup();
    expect(() => rule("workflow_run_failed", { workflow: "verify.yml", branch: "main" })).toThrow(
      "Name the Repository (owner/name) for this event.",
    );
  });

  it("looks without spending the first mate's own GitHub allowance", async () => {
    const { gateway, rule, tick } = await setup();
    rule("workflow_run_failed", MAIN_VERIFY);
    // More looks than the first mate's whole allowance.
    for (let look = 0; look <= API_CALLS_PER_TASK; look++)
      await gateway.readForLook({ path: `/repos/${REPO}/actions/runs?per_page=1` });
    await tick();
    expect(
      JSON.parse(await gateway.readAsSeat({ path: `/repos/${REPO}/actions/runs?per_page=1` })),
    ).toMatchObject({
      status: 200,
    });
  });
});
