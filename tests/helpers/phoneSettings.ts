import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Core } from "@core/index";
import { openDatabase } from "@core/storage/db";
import { repoProjectId } from "@core/storage/projectStore";
import { UsageStore } from "@core/storage/usageStore";
import { seedTask } from "@core/tasks/seedTask";
import { TaskService } from "@core/tasks/taskService";
import type { AutomationSave } from "@shared/automation";
import type { WorkKind } from "@shared/routingPolicy";
import {
  seedAccountAuth,
  seedAccountRegistry,
  seedAccountRoot,
  seedAccountStore,
} from "../e2e/accountFixtures";
import { seedHostedOrigins, seedProject } from "../e2e/projectSeed";
import { seedQuotaFixture } from "../e2e/quotaFixtures";
import { starterFor } from "../e2e/starters";

/**
 * INF-3563: what the phone check's computer holds for the phone's Settings
 * pages (docs/ios.md, "Settings pages in the computer's words"), each
 * written by the writer the app uses before the computer starts: three
 * accounts with their allowance readings, two projects, a few weeks of
 * recorded usage, and, once it runs, four automations. Only the part that
 * reads those pages starts its computer with them; every other part's
 * computer stays as it was.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** The stand-in accounts, in the order the computer's Intelligence lists them. */
export const PHONE_SETTINGS_ACCOUNTS = {
  personal: "acct_phone_personal",
  work: "acct_phone_work",
  team: "acct_phone_team",
} as const;

/** The stand-in projects. */
export const PHONE_SETTINGS_PROJECTS = { website: "phone-website", app: "phone-app" } as const;

function gitRepo(dir: string): string {
  const git = (...args: string[]) => execFileSync("git", args, { stdio: "pipe" });
  git("init", "--initial-branch=main", dir);
  git("-C", dir, "config", "user.name", "Test");
  git("-C", dir, "config", "user.email", "test@localhost");
  git("-C", dir, "commit", "--allow-empty", "-m", "init");
  return dir;
}

/** Sign-ins as the vault lays them out, with invented credentials that expire long after the run. */
function seedAccounts(userData: string, now: number): void {
  const { personal, work, team } = PHONE_SETTINGS_ACCOUNTS;
  seedAccountRoot(userData);
  const oauth = (id: string) => {
    seedAccountStore(userData, "openai-codex", id);
    seedAccountAuth(userData, "openai-codex", id, {
      "openai-codex": {
        type: "oauth",
        access: `invented-access-${id}`,
        refresh: `invented-refresh-${id}`,
        expires: now + 30 * DAY,
      },
    });
  };
  oauth(personal);
  oauth(work);
  seedAccountStore(userData, "xai", team);
  seedAccountAuth(userData, "xai", team, { xai: { type: "api_key", key: "xai-invented-key" } });
  seedAccountRegistry(userData, [
    {
      id: personal,
      providerId: "openai-codex",
      kind: "subscription_oauth",
      label: "Personal",
      enabled: true,
      createdAt: now - 60 * DAY,
    },
    {
      id: work,
      providerId: "openai-codex",
      kind: "subscription_oauth",
      label: "Work",
      enabled: true,
      createdAt: now - 40 * DAY,
    },
    {
      id: team,
      providerId: "xai",
      kind: "api_key",
      label: "Team",
      enabled: true,
      createdAt: now - 20 * DAY,
    },
  ]);
}

/**
 * The allowance readings: one account well inside both of its windows, one
 * the provider says must sign in again, one whose last reading is stale.
 */
function seedAllowance(dir: string, now: number, session = 74): string {
  const { personal, work, team } = PHONE_SETTINGS_ACCOUNTS;
  return seedQuotaFixture(dir, {
    generatedAt: new Date(now).toISOString(),
    fetchedAt: now,
    providers: [
      {
        provider: "codex",
        label: "Codex",
        accountId: personal,
        accountLabel: "Personal",
        plan: "Plus",
        account: "ada@example.com",
        status: "ok",
        stale: false,
        windows: [
          {
            id: "session",
            label: "session",
            percentRemaining: session,
            resetText: "resets in 2h",
            pace: "behind",
            resetsAtMs: now + 2 * HOUR,
            windowSeconds: 18_000,
          },
          {
            id: "weekly",
            label: "weekly",
            percentRemaining: 62,
            resetText: "resets in 3d",
            pace: "behind",
            resetsAtMs: now + 3 * DAY,
            windowSeconds: 604_800,
          },
        ],
      },
      {
        provider: "codex",
        label: "Codex",
        accountId: work,
        accountLabel: "Work",
        status: "auth_required",
        stale: false,
        windows: [],
      },
      {
        provider: "grok",
        label: "Grok",
        accountId: team,
        accountLabel: "Team",
        plan: "SuperGrok",
        status: "ok",
        stale: true,
        windows: [{ id: "credits", label: "credits", percentRemaining: 57 }],
      },
    ],
  });
}

/** The recorded work: title, project, saved kind, tokens, estimate. */
const WORK: readonly [string, keyof typeof PHONE_SETTINGS_PROJECTS, WorkKind, number, number][] = [
  ["Refresh the homepage", "website", "implement", 2_100_000, 3.75],
  ["Repair the sign-up form", "app", "fix", 5_400_000, 8.2],
  ["Compare hosting options", "website", "research", 170_000, 0.26],
  ["Add offline drafts", "app", "implement", 6_800_000, 10.5],
  ["Review the page index", "website", "review", 140_000, 0.2],
  ["Plan the pricing page", "website", "plan", 280_000, 0.42],
  ["Fix the empty state", "app", "fix", 350_000, 0.51],
  ["Update dependencies", "app", "chore", 1_200_000, 1.9],
];

/**
 * Two projects and a few weeks of recorded usage, through the registry's
 * and the ledger's own writers: tasks a crewmate started and finished three
 * days apart, the first mate's own conversation and one model call made for
 * no task.
 */
function seedWork(userData: string, now: number): void {
  const db = openDatabase(userData);
  const { website, app } = PHONE_SETTINGS_PROJECTS;
  seedProject(db, {
    id: website,
    path: gitRepo(join(userData, "website")),
    name: "Website",
    origin: "https://github.com/example/website.git",
    runsOn: null,
    delivery: "direct-pr",
    addedAt: now - 50 * DAY,
    key: "WEB",
  });
  seedProject(db, {
    id: app,
    path: gitRepo(join(userData, "field-notes")),
    name: "Field notes",
    setupKind: "init",
    runsOn: null,
    delivery: "local-only",
    addedAt: now - 30 * DAY,
    key: "NOTE",
  });
  seedHostedOrigins(db, userData);
  mkdirSync(join(userData, "worktrees"), { recursive: true });
  let clock = now - (WORK.length * 3 + 1) * DAY;
  const tasks = new TaskService({ db, strict: true, now: () => clock });
  const usage = new UsageStore(db);
  const model = { provider: "openai-codex", id: starterFor("openai-codex", "medium") };
  WORK.forEach(([title, project, kind, tokens, usd], index) => {
    clock += 3 * DAY;
    const id = `phone-usage-${index}`;
    seedTask(tasks, {
      id,
      title,
      status: "completed",
      repoId: PHONE_SETTINGS_PROJECTS[project],
      shape: { kind },
      accountId: PHONE_SETTINGS_ACCOUNTS.personal,
      model,
    });
    tasks.close(id, { status: "done", reason: "finished", actor: "host" });
    usage.record({
      taskId: id,
      accountId: PHONE_SETTINGS_ACCOUNTS.personal,
      model,
      usage: {
        input: Math.round(tokens * 0.1),
        output: Math.round(tokens * 0.025),
        cacheRead: Math.round(tokens * 0.825),
        cacheWrite: Math.round(tokens * 0.05),
        cost: usd,
        costSource: "listed-prices",
        costParts: {
          input: usd * 0.1,
          output: usd * 0.05,
          cacheRead: usd * 0.8,
          cacheWrite: usd * 0.05,
        },
      },
      at: clock + 20 * 60_000,
    });
  });
  usage.record({
    taskId: "firstmate",
    accountId: PHONE_SETTINGS_ACCOUNTS.personal,
    model,
    usage: {
      input: 240_000,
      output: 60_000,
      cacheRead: 2_000_000,
      cacheWrite: 100_000,
      cost: 3.8,
      costSource: "listed-prices",
      costParts: { input: 0.6, output: 0.6, cacheRead: 2.5, cacheWrite: 0.1 },
    },
    at: now - 2 * HOUR,
  });
  usage.record({
    taskId: "routing",
    model,
    usage: { input: 150_000, output: 10_000 },
    at: now - 3 * HOUR,
  });
  db.close();
}

const allowanceDir = (root: string) => join(root, "allowance");

/** Before the computer starts: its accounts, their readings, its projects and its recorded usage. */
export function seedPhoneSettings(root: string, userData: string): void {
  const now = Date.now();
  mkdirSync(userData, { recursive: true });
  seedAccounts(userData, now);
  // Read once the computer's allowance reader starts, in place of every provider's own address.
  process.env.INFINITARY_QUOTA_FIXTURE_DIR = seedAllowance(allowanceDir(root), now);
  seedWork(userData, now);
}

/** What is left of the first account's session window once the computer reads its allowance again. */
export const PHONE_SETTINGS_SESSION_LATER = 41;

/**
 * The computer reads its allowance again, as it does on its own clock, and
 * finds the first account's session window further used.
 */
export async function readPhoneAllowanceAgain(core: Core, root: string): Promise<void> {
  seedAllowance(allowanceDir(root), Date.now(), PHONE_SETTINGS_SESSION_LATER);
  await core.dispatch("inf:quota:refresh", []);
}

/** The prompt of the one automation that has run, with the detail the computer fills in as it runs. */
export const PHONE_SETTINGS_REMINDER =
  "Remind me to send the release notes. It is {{scheduled time}}.";

/**
 * Once the computer runs: its automations, each saved through the action
 * Settings → Automation saves with. One runs each morning, one is paused,
 * one is a draft waiting for its review, and one was due once and has run:
 * the computer's own schedule pass fires it at its minute, with no wait.
 */
export async function seedPhoneAutomations(core: Core): Promise<Record<string, string>> {
  // A rule names its project as the tasks do, by the project's own id.
  const website = repoProjectId(PHONE_SETTINGS_PROJECTS.website);
  const save = (rule: AutomationSave) => core.dispatch("inf:automation:save", [rule]);
  const morning = await save({
    name: "Morning summary",
    spec: { kind: "daily", hour: 8, minute: 0, timeZone: "America/Los_Angeles" },
    prompt: "Summarize what changed in the project since yesterday. It is {{scheduled time}}.",
    projectId: website,
    enable: true,
  });
  const weekly = await save({
    name: "Check for outdated packages",
    spec: { kind: "weekly", days: [1], hour: 9, minute: 30, timeZone: "America/Los_Angeles" },
    prompt: "List the packages with a newer version and what each update changes.",
    projectId: website,
    enable: true,
  });
  await core.dispatch("inf:automation:state", [weekly.id, "pause"]);
  const draft = await save({
    name: "Friday wrap-up",
    spec: { kind: "weekly", days: [5], hour: 16, minute: 0, timeZone: "America/Los_Angeles" },
    prompt: "Write a short summary of this week's finished tasks.",
  });
  const due = Date.now() + 60_000;
  const once = await save({
    name: "Release notes reminder",
    spec: { kind: "once", at: due },
    prompt: PHONE_SETTINGS_REMINDER,
    enable: true,
  });
  core.services.scheduler.tick(due + 1_000);
  return { morning: morning.id, weekly: weekly.id, draft: draft.id, once: once.id };
}

/** What the computer holds now, for a journey to compare with what the phone asked it to change. */
export async function phoneSettingsState(core: Core, rules: Record<string, string>) {
  const list = await core.dispatch("inf:automation:list", []);
  const repos = await core.dispatch("inf:repos:list", []);
  const books = await core.dispatch("inf:settings:runbooks:get", []);
  return {
    rules: Object.fromEntries(
      Object.entries(rules).map(([name, id]) => [
        name,
        { id, state: list.rules.find((rule) => rule.id === id)?.state ?? null },
      ]),
    ),
    projects: Object.fromEntries(
      repos.map((repo) => [
        repo.id,
        {
          delivery: repo.delivery,
          autonomy: repo.autonomy,
          rigor: repo.rigor ?? null,
          costLimit: repo.costLimit ?? null,
        },
      ]),
    ),
    runbooks: Object.fromEntries(books.map((book) => [book.id, book.enabled])),
  };
}
