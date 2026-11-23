import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  agreementVersion,
  BOT,
  check,
  hasTickedBox,
  RECORD_TITLE,
  SENTENCE,
  STATUS,
} from "../scripts/contributor-agreement.mjs";
import { loadYamlFile } from "./helpers/releaseWorkflows";

// INF-5262 builds INF-5254's approved plan (the captain's pick: "Our own
// check: the record stays in your project"): an outside contributor accepts
// CLA.md once per version, by ticking the template's box or replying with
// its sentence, and the check keeps the record in a locked issue
// (docs/public-ci.md, "Outside contributors").

const agreement = readFileSync(new URL("../CLA.md", import.meta.url), "utf8");
const template = readFileSync(
  new URL("../.github/pull_request_template.md", import.meta.url),
  "utf8",
);
const version = agreementVersion(agreement);
const project = { owner: "infinitary-labs", repo: "infinitary-apps" };

// Users and the Actions bot as GitHub's API returns them (pull request 12
// of this project, and the account an Actions token writes as).
const bot = { login: BOT, id: 41898282, type: "Bot" };
const maintainer = { login: "kunchenguid", id: 3233006, type: "User" };
const contributor = { login: "octo-contributor", id: 98765432, type: "User" };
const someoneElse = { login: "passer-by", id: 12121212, type: "User" };

type Comment = { id: number; user: typeof bot; body: string; html_url: string };

/** A pull request in GitHub's shape: from a fork unless it names this project's own branch. */
function pullRequest({
  number = 40,
  author = contributor,
  body = template,
  own = false,
}: {
  number?: number;
  author?: typeof contributor;
  body?: string;
  own?: boolean;
} = {}) {
  const head = own ? "infinitary-labs/infinitary-apps" : `${author.login}/infinitary-apps`;
  return {
    number,
    html_url: `https://github.com/infinitary-labs/infinitary-apps/pull/${number}`,
    user: author,
    body,
    head: {
      ref: own ? "infinitary-batch/3f81080a" : "fix-typo",
      sha: "13be2c2de5f22816e99d1e7b0499d5efbd262fad",
      repo: { full_name: head },
    },
    base: { ref: "main", repo: { full_name: "infinitary-labs/infinitary-apps" } },
  };
}

/**
 * The record issue as the workflow's Actions token reads it: the project's
 * issue 30, opened by a maintainer whose organization membership is private,
 * so GitHub gives the token the association CONTRIBUTOR.
 */
const recordIssue = {
  number: 30,
  title: RECORD_TITLE,
  locked: true,
  user: { login: maintainer.login, id: maintainer.id, type: "User" },
  author_association: "CONTRIBUTOR",
};
/** Each account's permission on the project, as the Actions token reads it; anyone else reads "read". */
const permissions = new Map([[maintainer.login, "admin"]]);

/** GitHub's API for this project, in memory: the record issue, pull requests and their comments, and statuses. */
function gitHub({
  record = true,
  others = [] as (typeof recordIssue)[],
  pulls = [] as ReturnType<typeof pullRequest>[],
} = {}) {
  const comments = new Map<number, Comment[]>([[recordIssue.number, []]]);
  const statuses: { sha: string; state: string; context: string; description: string }[] = [];
  let searches = 0;
  let next = 7055781193;
  const add = (issue: number, user: typeof bot, body: string) => {
    const comment = {
      id: next++,
      user,
      body,
      html_url: `https://github.com/infinitary-labs/infinitary-apps/issues/${issue}#issuecomment-${next}`,
    };
    comments.set(issue, [...(comments.get(issue) ?? []), comment]);
    return comment;
  };
  const github = {
    rest: {
      pulls: {
        get: async ({ pull_number }: { pull_number: number }) => ({
          data: pulls.find((pull) => pull.number === pull_number),
        }),
      },
      search: {
        issuesAndPullRequests: async () => {
          searches++;
          return { data: { items: [...others, ...(record ? [recordIssue] : [])] } };
        },
      },
      issues: {
        listComments: async ({ issue_number }: { issue_number: number }) => ({
          data: comments.get(issue_number) ?? [],
        }),
        createComment: async ({ issue_number, body }: { issue_number: number; body: string }) => ({
          data: add(issue_number, bot, body),
        }),
      },
      repos: {
        getCollaboratorPermissionLevel: async ({ username }: { username: string }) => ({
          data: { permission: permissions.get(username) ?? "read" },
        }),
        createCommitStatus: async (status: (typeof statuses)[number]) => {
          statuses.push(status);
          return { data: status };
        },
      },
    },
    paginate: async <T>(list: (params: T) => Promise<{ data: unknown[] }>, params: T) =>
      (await list(params)).data,
  };
  return {
    github,
    statuses,
    entries: () => comments.get(recordIssue.number) ?? [],
    commentsOn: (issue: number) => comments.get(issue) ?? [],
    add,
    searches: () => searches,
  };
}

const core = {
  failed: [] as string[],
  setFailed(why: string) {
    this.failed.push(why);
  },
};
const now = () => new Date("2026-11-20T18:00:00Z");

function opened(pull: ReturnType<typeof pullRequest>, sender = pull.user, action = "opened") {
  return {
    repo: project,
    eventName: "pull_request_target",
    serverUrl: "https://github.com",
    payload: { action, pull_request: pull, sender, repository: { default_branch: "main" } },
  };
}

function replied(pull: ReturnType<typeof pullRequest>, comment: Comment) {
  return {
    repo: project,
    eventName: "issue_comment",
    serverUrl: "https://github.com",
    payload: {
      action: "created",
      issue: { number: pull.number, pull_request: { url: "u" } },
      comment,
      sender: comment.user,
      repository: { default_branch: "main" },
    },
  };
}

const ticked = template.replace("- [ ]", "- [x]");

describe("the contributor agreement check", () => {
  it("records the author's ticked box and passes, without asking", async () => {
    const pull = pullRequest({ body: ticked });
    const api = gitHub({ pulls: [pull] });
    expect(await check({ ...api, core, agreement, now, context: opened(pull) })).toBe(
      "accepted now",
    );
    expect(api.entries()).toHaveLength(1);
    const entry = api.entries()[0];
    expect(entry?.user).toBe(bot);
    for (const field of [
      contributor.login,
      `${contributor.id}`,
      "#40",
      pull.html_url,
      `version ${version}`,
      now().toISOString(),
    ])
      expect(entry?.body).toContain(field);
    expect(api.commentsOn(pull.number)).toEqual([]);
    expect(api.statuses).toEqual([
      expect.objectContaining({ sha: pull.head.sha, state: "success", context: STATUS }),
    ]);
  });

  it("asks once and fails while the author has not accepted", async () => {
    const pull = pullRequest();
    const api = gitHub({ pulls: [pull] });
    expect(await check({ ...api, core, agreement, now, context: opened(pull) })).toBe("asked");
    expect(
      await check({
        ...api,
        core,
        agreement,
        now,
        context: opened(pull, pull.user, "synchronize"),
      }),
    ).toBe("asked");
    const asks = api.commentsOn(pull.number);
    expect(asks).toHaveLength(1);
    expect(asks[0]?.body).toContain(SENTENCE.replace("Contributor License Agreement", "["));
    expect(asks[0]?.body).toContain(
      "https://github.com/infinitary-labs/infinitary-apps/blob/main/CLA.md",
    );
    expect(api.entries()).toEqual([]);
    expect(api.statuses.map((s) => s.state)).toEqual(["failure", "failure"]);
  });

  it("records the author's reply with the sentence and passes the pull request's newest commit", async () => {
    const pull = pullRequest();
    const api = gitHub({ pulls: [pull] });
    await check({ ...api, core, agreement, now, context: opened(pull) });
    const reply = api.add(
      pull.number,
      contributor,
      "I agree that my submission is governed by the [Contributor License Agreement](https://github.com/infinitary-labs/infinitary-apps/blob/main/CLA.md)",
    );
    expect(await check({ ...api, core, agreement, now, context: replied(pull, reply) })).toBe(
      "accepted now",
    );
    expect(api.entries()).toHaveLength(1);
    expect(api.entries()[0]?.body).toContain(reply.html_url);
    expect(api.statuses.at(-1)).toMatchObject({ sha: pull.head.sha, state: "success" });
  });

  it("changes nothing for anyone else's reply, or the author's other words", async () => {
    const pull = pullRequest();
    const api = gitHub({ pulls: [pull] });
    for (const reply of [
      api.add(pull.number, someoneElse, SENTENCE),
      api.add(pull.number, contributor, `Thanks! ${SENTENCE} once I check with my employer.`),
    ])
      expect(await check({ ...api, core, agreement, now, context: replied(pull, reply) })).toBe(
        "no acceptance",
      );
    expect(api.entries()).toEqual([]);
    expect(api.statuses).toEqual([]);
  });

  it("does not take a maintainer's tick in the author's description", async () => {
    const pull = pullRequest({ body: ticked });
    const api = gitHub({ pulls: [pull] });
    expect(
      await check({ ...api, core, agreement, now, context: opened(pull, maintainer, "edited") }),
    ).toBe("asked");
    expect(api.entries()).toEqual([]);
  });

  it("passes a recorded author's later pull request without asking again", async () => {
    const first = pullRequest({ body: ticked });
    const later = pullRequest({ number: 41 });
    const api = gitHub({ pulls: [first, later] });
    await check({ ...api, core, agreement, now, context: opened(first) });
    expect(await check({ ...api, core, agreement, now, context: opened(later) })).toBe(
      "accepted before",
    );
    expect(api.entries()).toHaveLength(1);
    expect(api.commentsOn(later.number)).toEqual([]);
    expect(api.statuses.at(-1)).toMatchObject({ state: "success" });
  });

  it("asks a recorded author again when the agreement's version changes", async () => {
    const first = pullRequest({ body: ticked });
    const later = pullRequest({ number: 41 });
    const api = gitHub({ pulls: [first, later] });
    await check({ ...api, core, agreement, now, context: opened(first) });
    const next = agreement.replace(`Version ${version}`, `Version ${version + 1}`);
    expect(await check({ ...api, core, agreement: next, now, context: opened(later) })).toBe(
      "asked",
    );
  });

  it("reads only the bot's entries, so a forged one adds no one", async () => {
    const pull = pullRequest();
    const api = gitHub({ pulls: [pull] });
    api.add(
      recordIssue.number,
      contributor,
      `<!-- contributor-license-agreement:entry ${JSON.stringify({ login: contributor.login, id: contributor.id, version })} -->`,
    );
    expect(await check({ ...api, core, agreement, now, context: opened(pull) })).toBe("asked");
  });

  it("passes the project's own branches without reading the record", async () => {
    const pull = pullRequest({ number: 12, author: maintainer, body: "", own: true });
    const api = gitHub({ pulls: [pull] });
    expect(await check({ ...api, core, agreement, now, context: opened(pull) })).toBe("own branch");
    expect(api.searches()).toBe(0);
    expect(api.statuses).toEqual([expect.objectContaining({ state: "success", context: STATUS })]);
  });

  it("says so, and fails, when the record issue is missing", async () => {
    const pull = pullRequest({ body: ticked });
    const api = gitHub({ record: false, pulls: [pull] });
    const seen = { failed: [] as string[], setFailed: core.setFailed };
    expect(await check({ ...api, core: seen, agreement, now, context: opened(pull) })).toBe(
      "no record",
    );
    expect(seen.failed[0]).toContain(RECORD_TITLE);
    expect(api.statuses).toEqual([expect.objectContaining({ state: "error" })]);
    expect(api.entries()).toEqual([]);
  });

  it("never takes a locked issue with the record's title that someone who cannot write opened", async () => {
    const pull = pullRequest({ body: ticked });
    const impostor = {
      ...recordIssue,
      number: 5,
      user: { login: someoneElse.login, id: someoneElse.id, type: "User" },
      author_association: "NONE",
    };
    const api = gitHub({ others: [impostor], pulls: [pull] });
    expect(await check({ ...api, core, agreement, now, context: opened(pull) })).toBe(
      "accepted now",
    );
    expect(api.entries()).toHaveLength(1);
    expect(api.commentsOn(impostor.number)).toEqual([]);
  });

  it("ignores a comment on an issue that is not a pull request", async () => {
    const api = gitHub();
    const context = replied(pullRequest(), api.add(3, contributor, SENTENCE));
    context.payload.issue = { number: 3 } as typeof context.payload.issue;
    expect(await check({ ...api, core, agreement, now, context })).toBe("not a pull request");
    expect(api.statuses).toEqual([]);
  });

  it("finds the template's box only once it is ticked", () => {
    expect(hasTickedBox(template)).toBe(false);
    expect(hasTickedBox(ticked)).toBe(true);
    expect(template).toContain(
      `[${SENTENCE.split(" ").slice(-3).join(" ")}](https://github.com/infinitary-labs/infinitary-apps/blob/main/CLA.md)`,
    );
  });
});

// The workflow that runs it holds a write token for an outside pull request,
// so it never runs the pull request's own code (docs/public-ci.md).
describe("contributor-agreement.yml", () => {
  type Step = { uses?: string; with?: Record<string, unknown>; run?: string };
  const workflow = loadYamlFile(".github/workflows/contributor-agreement.yml") as {
    on: Record<string, unknown>;
    jobs: Record<
      string,
      { "runs-on"?: string; permissions?: Record<string, string>; steps: Step[] }
    >;
  };
  const text = readFileSync(
    new URL("../.github/workflows/contributor-agreement.yml", import.meta.url),
    "utf8",
  );

  it("runs from the project's default branch, never from the pull request's files", () => {
    expect(Object.keys(workflow.on).toSorted()).toEqual(["issue_comment", "pull_request_target"]);
    const steps = Object.values(workflow.jobs).flatMap((job) => job.steps);
    const checkouts = steps.filter((step) => step.uses?.startsWith("actions/checkout@"));
    expect(checkouts).toHaveLength(1);
    for (const step of checkouts) {
      // No ref or repository: the event's own commit, which for both events
      // is this project's base or default branch.
      expect(Object.keys(step.with ?? {}).toSorted()).toEqual([
        "persist-credentials",
        "sparse-checkout",
        "sparse-checkout-cone-mode",
      ]);
      expect(step.with?.["persist-credentials"]).toBe(false);
      expect(String(step.with?.["sparse-checkout"]).trim().split("\n").toSorted()).toEqual([
        "CLA.md",
        "scripts/contributor-agreement.mjs",
        "scripts/intake-labels.mjs",
      ]);
    }
    expect(steps.filter((step) => step.run)).toEqual([]);
  });

  it("holds only the writes it needs, and no secret", () => {
    expect(Object.values(workflow.jobs).map((job) => job.permissions)).toEqual([
      { contents: "read", issues: "write", "pull-requests": "write", statuses: "write" },
    ]);
    expect(text).not.toMatch(/secrets\./);
    // No expression inside the script, so the contributor's words reach it only as data.
    for (const step of Object.values(workflow.jobs).flatMap((job) => job.steps))
      expect(String(step.with?.script ?? ""), step.uses).not.toContain("${{");
  });
});
