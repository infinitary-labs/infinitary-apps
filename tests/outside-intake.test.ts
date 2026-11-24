import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ACCEPTED,
  NEEDS_TRIAGE,
  REQUIRED,
  syncWaiting,
  WAITING,
} from "../scripts/intake-labels.mjs";
import { applyMark, DISPOSITIONS, readMark } from "../scripts/triage-mark.mjs";
import {
  CLOSE_DAYS,
  closeComment,
  REMIND_DAYS,
  reminderComment,
  tick,
} from "../scripts/waiting-on-author.mjs";
import { FEEDBACK_FORM } from "../src/core/feedback/diagnostics";
import { loadYamlFile } from "./helpers/releaseWorkflows";

// Piece 2 of INF-6358's approved plan (docs/public-ci.md, "Intake"): issue
// forms sort each arrival, a maintainer's reply mark sets labels and closes,
// a stranger's same mark does nothing, and an item that waits on its author
// gets a reminder at 14 days and closes at 28 (the captain's pick "A reminder
// at 14 days, closed at 28").

const project = { owner: "infinitary-labs", repo: "infinitary-apps" };
const maintainer = { login: "infinitary-maintainer", id: 1001, type: "User" };
const contributor = { login: "octo-contributor", id: 98765432, type: "User" };
const stranger = { login: "drive-by", id: 55555, type: "User" };
const bot = { login: "github-actions[bot]", id: 41898282, type: "Bot" };
const permissions = new Map([[maintainer.login, "admin"]]);

type Item = {
  number: number;
  state: string;
  user: typeof contributor;
  labels: { name: string }[];
  pull_request?: { url: string };
};
const issue = (labels: string[] = [NEEDS_TRIAGE, "bug"]): Item => ({
  number: 52,
  state: "open",
  user: contributor,
  labels: labels.map((name) => ({ name })),
});
const pull = (labels: string[] = [NEEDS_TRIAGE]): Item => ({
  ...issue(labels),
  number: 50,
  pull_request: { url: "https://api.github.com/repos/infinitary-labs/infinitary-apps/pulls/50" },
});

/** GitHub's issue API for one item, in memory: its labels, state and comments. */
function gitHub(item: Item) {
  const labels = new Set(item.labels.map((label) => label.name));
  const updates: Record<string, unknown>[] = [];
  const comments: string[] = [];
  let writes = 0;
  const github = {
    rest: {
      repos: {
        getCollaboratorPermissionLevel: async ({ username }: { username: string }) => ({
          data: { permission: permissions.get(username) ?? "read" },
        }),
      },
      issues: {
        addLabels: async ({ labels: added }: { labels: string[] }) => {
          writes++;
          for (const name of added) labels.add(name);
          return { data: {} };
        },
        removeLabel: async ({ name }: { name: string }) => {
          writes++;
          // GitHub answers 404 for a label the item does not carry.
          if (!labels.delete(name))
            throw Object.assign(new Error(`Label does not exist: ${name}`), { status: 404 });
          return { data: {} };
        },
        update: async (params: Record<string, unknown>) => {
          writes++;
          updates.push(params);
          return { data: {} };
        },
        createComment: async ({ body }: { body: string }) => {
          writes++;
          comments.push(body);
          return { data: {} };
        },
      },
    },
  };
  return { github, labels, updates, comments, writes: () => writes };
}

const core = { info: () => undefined };
const commented = (item: Item, by: { login: string; id: number }, body: string) => ({
  repo: project,
  eventName: "issue_comment",
  payload: { action: "created", issue: item, comment: { user: by, body }, sender: by },
});
const mark = (disposition: string) =>
  `Thank you for the report.\n\n<!-- infinitary-triage v1 disposition=${disposition} -->`;

describe("the triage mark", () => {
  it("reads only a disposition on the closed list", () => {
    expect(readMark(mark("accepted"))).toBe("accepted");
    expect(readMark("<!-- infinitary-triage v1 disposition=answered round=3 -->")).toBe("answered");
    expect(readMark(mark("merged"))).toBeNull();
    expect(readMark(mark("__proto__"))).toBeNull();
    expect(readMark("<!-- infinitary-triage v2 disposition=accepted -->")).toBeNull();
    expect(readMark(undefined)).toBeNull();
  });

  const cases: [string, Item, { labels: string[]; close?: Record<string, unknown> }][] = [
    [
      "duplicate",
      issue(),
      {
        labels: ["bug", "duplicate"],
        close: { state: "closed", state_reason: "not_planned" },
      },
    ],
    ["needs-info", issue(), { labels: ["bug", WAITING] }],
    ["accepted", issue([NEEDS_TRIAGE, WAITING, "bug"]), { labels: ["bug", ACCEPTED] }],
    [
      "declined",
      issue([NEEDS_TRIAGE, "idea"]),
      { labels: ["idea"], close: { state: "closed", state_reason: "not_planned" } },
    ],
    [
      "answered",
      issue([NEEDS_TRIAGE, "question"]),
      { labels: ["question"], close: { state: "closed", state_reason: "completed" } },
    ],
    ["changes-requested", pull(), { labels: [WAITING] }],
    [
      "released",
      { ...issue([ACCEPTED, "bug"]), state: "closed" },
      { labels: ["bug", ACCEPTED, "released"] },
    ],
  ];

  it("covers every disposition on the list", () => {
    expect(cases.map(([name]) => name).toSorted()).toEqual(Object.keys(DISPOSITIONS).toSorted());
  });

  for (const [disposition, item, want] of cases)
    it(`applies ${disposition} from a maintainer's comment, and nothing from a stranger's`, async () => {
      const api = gitHub(item);
      expect(
        await applyMark({
          github: api.github,
          context: commented(item, maintainer, mark(disposition)),
          core,
        }),
      ).toBe(disposition);
      expect([...api.labels].toSorted()).toEqual(want.labels.toSorted());
      expect(api.updates).toEqual(want.close ? [expect.objectContaining(want.close)] : []);

      // The author's own reply to an item waiting on them re-queues it, which
      // the author-reply case owns; here the author's mark must do nothing.
      const waits = item.labels.some((label) => label.name === WAITING);
      for (const who of waits ? [stranger] : [stranger, contributor]) {
        const untouched = gitHub(item);
        expect(
          await applyMark({
            github: untouched.github,
            context: commented(item, who, mark(disposition)),
            core,
          }),
        ).toBe("not a maintainer");
        expect(untouched.writes(), who.login).toBe(0);
      }
    });

  it("closes a pull request with no reason, which GitHub keeps for issues", async () => {
    const api = gitHub(pull());
    await applyMark({
      github: api.github,
      context: commented(pull(), maintainer, mark("declined")),
      core,
    });
    expect(api.updates).toEqual([{ ...project, issue_number: 50, state: "closed" }]);
  });

  it("asks for changes only on a pull request", async () => {
    const api = gitHub(issue());
    expect(
      await applyMark({
        github: api.github,
        context: commented(issue(), maintainer, mark("changes-requested")),
        core,
      }),
    ).toBe("not a pull request");
    expect(api.writes()).toBe(0);
  });

  it("puts an item back in triage when its own author replies while it waits on them", async () => {
    const waiting = issue([WAITING, "bug"]);
    const api = gitHub(waiting);
    expect(
      await applyMark({
        github: api.github,
        context: commented(waiting, contributor, "It happens on version 0.8.6 too."),
        core,
      }),
    ).toBe("author replied");
    expect([...api.labels].toSorted()).toEqual(["bug", NEEDS_TRIAGE]);
    // Anyone else's reply leaves it waiting.
    const other = gitHub(waiting);
    expect(
      await applyMark({
        github: other.github,
        context: commented(waiting, stranger, "Same here."),
        core,
      }),
    ).toBe("no mark");
    expect(other.writes()).toBe(0);
  });
});

type Status = { context: string; state: string };
/** GitHub's pull request and status API for one outside pull request, in memory. */
function pullWithStatuses(labels: string[], statuses: Status[], own = false) {
  const api = gitHub(pull(labels));
  const data = {
    number: 50,
    state: "open",
    user: contributor,
    labels: labels.map((name) => ({ name })),
    head: {
      sha: "4f1c2d9e8b7a6f5e4d3c2b1a0f9e8d7c6b5a4f3e",
      repo: {
        full_name: own ? "infinitary-labs/infinitary-apps" : "octo-contributor/infinitary-apps",
      },
    },
  };
  const github = {
    ...api.github,
    rest: {
      ...api.github.rest,
      pulls: { get: async () => ({ data }) },
      repos: {
        ...api.github.rest.repos,
        listCommitStatusesForRef: async () => ({ data: statuses }),
      },
    },
    paginate: async <T>(list: (params: T) => Promise<{ data: unknown[] }>, params: T) =>
      (await list(params)).data,
  };
  return { ...api, github };
}
const [agreement, careful] = REQUIRED as [string, string];
const pushed = (by = contributor) => ({
  repo: project,
  eventName: "pull_request_target",
  payload: { action: "synchronize", pull_request: { number: 50 }, sender: by },
});

describe("waiting on author from the required checks", () => {
  it("labels a pull request while either required check fails", async () => {
    const api = pullWithStatuses(
      [NEEDS_TRIAGE],
      [
        { context: careful, state: "success" },
        { context: agreement, state: "failure" },
      ],
    );
    expect(await syncWaiting({ github: api.github, context: pushed() })).toBe("waiting");
    expect([...api.labels].toSorted()).toEqual([NEEDS_TRIAGE, WAITING]);
  });

  it("reads each check's newest status, so a pass after a failure counts as a pass", async () => {
    // GitHub lists a commit's statuses newest first.
    const api = pullWithStatuses(
      [WAITING],
      [
        { context: agreement, state: "success" },
        { context: careful, state: "success" },
        { context: agreement, state: "failure" },
      ],
    );
    expect(await syncWaiting({ github: api.github, context: pushed() })).toBe("back to triage");
    expect([...api.labels]).toEqual([NEEDS_TRIAGE]);
  });

  it("leaves the label on when both pass on a maintainer's event", async () => {
    const api = pullWithStatuses(
      [WAITING],
      [
        { context: agreement, state: "success" },
        { context: careful, state: "success" },
      ],
    );
    expect(await syncWaiting({ github: api.github, context: pushed(maintainer) })).toBe(
      "unchanged",
    );
    expect(api.writes()).toBe(0);
  });

  it("takes the label off once when both checks clear it at the same time", async () => {
    const api = pullWithStatuses(
      [WAITING, NEEDS_TRIAGE],
      [
        { context: agreement, state: "success" },
        { context: careful, state: "success" },
      ],
    );
    // Both runs read the pull request before either writes.
    const both = await Promise.all([
      syncWaiting({ github: api.github, context: pushed() }),
      syncWaiting({ github: api.github, context: pushed() }),
    ]);
    expect(both).toEqual(["back to triage", "back to triage"]);
    expect([...api.labels]).toEqual([NEEDS_TRIAGE]);
  });

  it("waits for the other check before taking the label off", async () => {
    const api = pullWithStatuses([WAITING], [{ context: careful, state: "success" }]);
    expect(await syncWaiting({ github: api.github, context: pushed() })).toBe("unchanged");
    expect(api.writes()).toBe(0);
  });

  it("leaves the project's own pull requests alone", async () => {
    const api = pullWithStatuses([], [{ context: agreement, state: "failure" }], true);
    expect(await syncWaiting({ github: api.github, context: pushed() })).toBe("own branch");
    expect(api.writes()).toBe(0);
  });
});

const DAY = 24 * 60 * 60 * 1000;
const start = Date.parse("2026-11-02T17:00:00Z");
const day = (n: number) => new Date(start + n * DAY).toISOString();
const labeled = {
  event: "labeled",
  label: { name: WAITING },
  actor: maintainer,
  created_at: day(0),
};

/** The timer's view of the project: open items labeled waiting on author and their timelines. */
function project_(items: { item: Item; timeline: Record<string, unknown>[] }[]) {
  const comments = new Map<number, string[]>();
  const closed: Record<string, unknown>[] = [];
  const github = {
    rest: {
      issues: {
        listForRepo: async () => ({ data: items.map((each) => each.item) }),
        listEventsForTimeline: async ({ issue_number }: { issue_number: number }) => ({
          data: items.find((each) => each.item.number === issue_number)?.timeline ?? [],
        }),
        createComment: async ({ issue_number, body }: { issue_number: number; body: string }) => {
          comments.set(issue_number, [...(comments.get(issue_number) ?? []), body]);
          return { data: {} };
        },
        update: async (params: Record<string, unknown>) => {
          closed.push(params);
          return { data: {} };
        },
      },
    },
    paginate: async <T>(list: (params: T) => Promise<{ data: unknown[] }>, params: T) =>
      (await list(params)).data,
  };
  const run = (at: number) =>
    tick({ github, context: { repo: project }, core, now: () => new Date(start + at * DAY) });
  return { run, comments, closed };
}

describe("the waiting-on-author timer", () => {
  const waiting = issue([WAITING, "bug"]);

  it(`reminds at ${REMIND_DAYS} days, once`, async () => {
    const timeline = [labeled];
    const timer = project_([{ item: waiting, timeline }]);
    expect((await timer.run(REMIND_DAYS - 1)).reminded).toEqual([]);
    expect((await timer.run(REMIND_DAYS)).reminded).toEqual([52]);
    expect(timer.comments.get(52)).toEqual([reminderComment(waiting)]);
    timeline.push({
      event: "commented",
      actor: bot,
      body: reminderComment(waiting),
      created_at: day(REMIND_DAYS),
    } as typeof labeled & { body: string });
    expect((await timer.run(REMIND_DAYS + 1)).reminded).toEqual([]);
    expect(timer.comments.get(52)).toHaveLength(1);
  });

  it(`closes at ${CLOSE_DAYS} days, ${CLOSE_DAYS - REMIND_DAYS} days after the reminder`, async () => {
    const reminder = {
      event: "commented",
      actor: bot,
      body: reminderComment(waiting),
      created_at: day(REMIND_DAYS),
    };
    const timer = project_([{ item: waiting, timeline: [labeled, reminder] }]);
    expect((await timer.run(CLOSE_DAYS - 1)).closed).toEqual([]);
    expect((await timer.run(CLOSE_DAYS)).closed).toEqual([52]);
    expect(timer.comments.get(52)).toEqual([closeComment(waiting)]);
    expect(timer.closed).toEqual([
      { ...project, issue_number: 52, state: "closed", state_reason: "not_planned" },
    ]);
  });

  it("starts the count again on anything the author does", async () => {
    const reminder = {
      event: "commented",
      actor: bot,
      body: reminderComment(pull()),
      created_at: day(REMIND_DAYS),
    };
    const pushedLater = {
      event: "committed",
      committer: { date: day(REMIND_DAYS + 3) },
    };
    const timer = project_([{ item: pull([WAITING]), timeline: [labeled, reminder, pushedLater] }]);
    // The push came after the reminder, so it no longer counts, and a new one waits its 14 days.
    expect(await timer.run(CLOSE_DAYS)).toEqual({ reminded: [], closed: [] });
    expect(await timer.run(REMIND_DAYS * 2 + 3)).toEqual({ reminded: [50], closed: [] });
  });

  it("never counts a stranger's comment as the author's", async () => {
    const drive = { event: "commented", actor: stranger, body: "bump", created_at: day(13) };
    const timer = project_([{ item: waiting, timeline: [labeled, drive] }]);
    expect((await timer.run(REMIND_DAYS)).reminded).toEqual([52]);
  });

  it("closes a pull request with no reason", async () => {
    const reminder = {
      event: "commented",
      actor: bot,
      body: reminderComment(pull()),
      created_at: day(REMIND_DAYS),
    };
    const timer = project_([{ item: pull([WAITING]), timeline: [labeled, reminder] }]);
    await timer.run(CLOSE_DAYS);
    expect(timer.closed).toEqual([{ ...project, issue_number: 50, state: "closed" }]);
  });
});

// INF-6394's finding: an issue /feedback files through the API carries no
// form, so its label workflow puts it in triage itself, or the intake round
// never reads it.
describe("feedback-labels.yml", () => {
  const workflow = loadYamlFile(".github/workflows/feedback-labels.yml") as {
    jobs: Record<string, { steps: { with?: { script?: string } }[] }>;
  };
  const script = String(Object.values(workflow.jobs)[0]?.steps[0]?.with?.script);
  const run = async (body: string) => {
    const added: string[][] = [];
    const github = {
      rest: {
        issues: {
          addLabels: async ({ labels }: { labels: string[] }) => {
            added.push(labels);
            return { data: {} };
          },
        },
      },
    };
    const context = { repo: project, payload: { issue: { number: 55, body } } };
    const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor;
    await new AsyncFunction("github", "context", "core", script)(github, context, core);
    return added;
  };

  it("puts an issue /feedback filed in triage beside from-app and its kind", async () => {
    const body =
      "The card moved after the checks finished.\n\n<!-- infinitary-feedback v1 kind=bug version=0.8.7-alpha.31 -->";
    expect(await run(body)).toEqual([["from-app", "bug", NEEDS_TRIAGE]]);
    expect(await run("No mark here.")).toEqual([]);
  });
});

describe("the issue forms", () => {
  const folder = ".github/ISSUE_TEMPLATE";
  const forms = readdirSync(new URL(`../${folder}`, import.meta.url)).filter(
    (name) => name !== "config.yml",
  );

  it("offers a problem, an idea and a question, each sorted into triage by its kind", () => {
    const labels = Object.fromEntries(
      forms.map((name) => [
        name,
        (loadYamlFile(`${folder}/${name}`) as { labels: string[] }).labels,
      ]),
    );
    expect(labels).toEqual({
      "bug.yml": ["bug", NEEDS_TRIAGE],
      "from-app.yml": [NEEDS_TRIAGE],
      "idea.yml": ["idea", NEEDS_TRIAGE],
      "question.yml": ["question", NEEDS_TRIAGE],
    });
  });

  // INF-6394's finding: with blank issues off, GitHub's plain new-issue page
  // drops a prefilled body, so /feedback's no-sign-in link opens this form.
  it("holds the field the app's no-sign-in feedback link fills", () => {
    const form = loadYamlFile(`${folder}/${FEEDBACK_FORM.file}`) as {
      body: { type: string; id?: string }[];
    };
    expect(form.body.filter((field) => field.id === FEEDBACK_FORM.field)).toEqual([
      expect.objectContaining({ type: "textarea" }),
    ]);
  });

  it("turns blank issues off and sends security reports to the private address", () => {
    const config = loadYamlFile(`${folder}/config.yml`) as {
      blank_issues_enabled: boolean;
      contact_links: { about: string }[];
    };
    expect(config.blank_issues_enabled).toBe(false);
    const address = /help@getinfinitary\.com/;
    expect(readFileSync(new URL("../CONTRIBUTING.md", import.meta.url), "utf8")).toMatch(address);
    expect(config.contact_links.map((link) => link.about).join("\n")).toMatch(address);
  });
});

// Both workflows hold a write token where strangers write, so they run no
// pull request's code (docs/public-ci.md, "Outside contributors").
describe.each([
  ["triage-mark.yml", ["issue_comment"], "scripts/triage-mark.mjs"],
  ["waiting-on-author.yml", ["schedule", "workflow_dispatch"], "scripts/waiting-on-author.mjs"],
])("%s", (file, events, script) => {
  type Step = { uses?: string; with?: Record<string, unknown>; run?: string };
  const workflow = loadYamlFile(`.github/workflows/${file}`) as {
    on: Record<string, unknown>;
    jobs: Record<
      string,
      { "runs-on"?: string; permissions?: Record<string, string>; steps: Step[] }
    >;
  };
  const text = readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), "utf8");
  const steps = Object.values(workflow.jobs).flatMap((job) => job.steps);

  it("checks out only its scripts from the default branch, on GitHub's machines", () => {
    expect(Object.keys(workflow.on).toSorted()).toEqual(events);
    expect(Object.values(workflow.jobs).map((job) => job["runs-on"])).toEqual(["ubuntu-24.04"]);
    const checkouts = steps.filter((step) => step.uses?.startsWith("actions/checkout@"));
    expect(checkouts).toHaveLength(1);
    for (const step of checkouts) {
      expect(Object.keys(step.with ?? {}).toSorted()).toEqual([
        "persist-credentials",
        "sparse-checkout",
        "sparse-checkout-cone-mode",
      ]);
      expect(step.with?.["persist-credentials"]).toBe(false);
      expect(String(step.with?.["sparse-checkout"]).trim().split("\n").toSorted()).toEqual(
        [script, "scripts/intake-labels.mjs"].toSorted(),
      );
    }
    expect(steps.filter((step) => step.run)).toEqual([]);
  });

  it("holds only issue and pull request writes, and no secret", () => {
    expect(Object.values(workflow.jobs).map((job) => job.permissions)).toEqual([
      { contents: "read", issues: "write", "pull-requests": "write" },
    ]);
    expect(text).not.toMatch(/secrets\./);
    for (const step of steps)
      expect(String(step.with?.script ?? ""), step.uses).not.toContain("${{");
  });
});
