import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { FmEvent } from "@shared/events";
import { afterEach, describe, expect, it } from "vitest";
import { scratchDir } from "../../../../../tests/helpers/scratchDirs";
import {
  FileIntegrationSecrets,
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
  conclusion: "success" | "failure" | null;
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
  conclusion: "success" | "failure" | "skipped" | null,
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

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

async function setup() {
  /** What GitHub holds now, newest first as it lists runs. */
  const github = { runs: [BEFORE, PASSING] as StandInRun[], jobs: new Map<number, unknown[]>() };
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
    const jobs = url.pathname.match(/\/actions\/runs\/(\d+)\/jobs$/);
    if (url.pathname === `/repos/${REPO}/actions/runs`) listed(github.runs);
    else if (url.pathname === `/repos/${REPO}/actions/workflows/${VERIFY}/runs`)
      listed(github.runs.filter((r) => r.workflow_id === VERIFY));
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
    secrets: new FileIntegrationSecrets(join(root, "secrets")),
  });
  const store = new ScheduleStore(db);
  const inbox = new InboxStore(db);
  const scheduler = new Scheduler({
    store,
    notify: (wake, origin) => inbox.enqueue(FIRSTMATE_RECIPIENT, wake, undefined, origin),
    inbox,
    broadcastEvent: (_event: FmEvent) => {},
    now: () => now,
    events: {
      find: (integration, event) => integrations.listenable(integration, event),
      look: (integration, event, cursor, filter, connection) =>
        integrations.look(integration, event, cursor, filter, connection),
    },
  });
  /** The app's tick, two minutes on (the events' cadence), with its looks answered. */
  const tick = async () => {
    for (const _ of [1, 2]) {
      now += 60_000;
      scheduler.tick(now);
      await scheduler.settled();
    }
  };
  const served = () => inbox.allFor(FIRSTMATE_RECIPIENT).map((row) => renderWake(row));
  const rule = (event: string, filter: Record<string, string>) =>
    scheduler.create(
      { kind: "event", integration: "GitHub", event, filter },
      "Main's full run: {{events}}",
      true,
      "Main's full run",
    );
  return { github, sent, gateway, integrations, scheduler, tick, served, rule };
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
