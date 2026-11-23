import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { check, PASSED_COMMENT, readRecord, STATUS } from "../scripts/careful-review-check.mjs";
import {
  neutralizePipelineAttestation,
  pipelineAttestationSection,
} from "../src/core/forge/pipelineAttestation";
import { presentationRegionMarkers } from "../src/core/forge/presentation";
import { loadYamlFile } from "./helpers/releaseWorkflows";

// INF-6302 builds piece 1 of INF-6297's approved plan (the captain: "for
// infinitary-apps' repo, i want to enforce outside PRs must be raised with
// infinitary's careful review"; picks "(a) contributor" and "Only Infinitary's
// Careful record"): an outside pull request passes only when its description
// carries the record Infinitary writes for its newest version
// (docs/public-ci.md, "The Careful review check").

const project = { owner: "infinitary-labs", repo: "infinitary-apps" };
const bot = { login: "github-actions[bot]", type: "Bot" };
const contributor = { login: "octo-contributor", id: 98765432, type: "User" };
// Two consecutive versions of this project's main line.
const older = "be0528a626a9949f61156fdf4c74262eb8a9daff";
const newer = "bed13ef93a8a685b38c9fff6000ecd4a2806f07f";

/**
 * A description as a contributor's Infinitary publishes it: the project's
 * template words above the saved story's region, and the record at its end
 * once the review and live proof cover `head` (changePresentations.ts).
 */
function story(head: string | null, above = "Fixes the typo in the keyboard page.") {
  const { start, end } = presentationRegionMarkers("1ba0d5a0");
  const record = head
    ? `\n\n${pipelineAttestationSection(head, {
        label: "Passed live",
        reason: "Every scenario passed live.",
        revision: 2,
        verdict: "go",
        live: 2,
        total: 2,
        rows: [],
      })}`
    : "";
  return `${above}\n\n${start}\n\n## Why\n\nThe keyboard page named the wrong key.${record}\n\n${end}`;
}

/**
 * no-mistakes' own record as it wrote it on kunchenguid/no-mistakes#1533, an
 * outside pull request: every step it ran, a live validation of its own, and no producer.
 */
const noMistakes = (head: string) =>
  [
    "## Pipeline",
    "Updates from [git push no-mistakes](https://github.com/kunchenguid/no-mistakes)",
    `<!-- no-mistakes-pipeline-attestation:v1 {"head_sha":"${head}","steps":[{"step":"intent","status":"completed"},{"step":"rebase","status":"completed"},{"step":"review","status":"completed"},{"step":"test","status":"completed"},{"step":"document","status":"completed"},{"step":"lint","status":"completed"},{"step":"push","status":"completed"},{"step":"pr","status":"running"},{"step":"ci","status":"pending"}],"live_validation":{"verdict":"go","live":3,"total":3}} -->`,
  ].join("\n\n");

/** A pull request in GitHub's shape: from a fork unless it names this project's own branch. */
function pullRequest({
  number = 41,
  body = story(newer),
  head = newer,
  own = false,
}: {
  number?: number;
  body?: string;
  head?: string;
  own?: boolean;
} = {}) {
  return {
    number,
    user: contributor,
    body,
    head: {
      ref: own ? "infinitary-batch/3f81080a" : "fix-typo",
      sha: head,
      repo: {
        full_name: own ? "infinitary-labs/infinitary-apps" : `${contributor.login}/infinitary-apps`,
      },
    },
    base: { ref: "main", repo: { full_name: "infinitary-labs/infinitary-apps" } },
  };
}

type Pull = ReturnType<typeof pullRequest>;
type Comment = { id: number; user: typeof bot; body: string };

/** GitHub's API for this project, in memory: the live pull request, its comments and the statuses written. */
function gitHub(live: Pull) {
  let pull = live;
  let comments: Comment[] = [];
  const statuses: { sha: string; state: string; context: string; description: string }[] = [];
  const writes: string[] = [];
  let next = 7055781193;
  const github = {
    rest: {
      pulls: {
        get: async ({ pull_number }: { pull_number: number }) => {
          if (pull_number !== pull.number) throw new Error(`No pull request ${pull_number}`);
          return { data: pull };
        },
      },
      issues: {
        listComments: async () => ({ data: comments }),
        createComment: async ({ body }: { body: string }) => {
          writes.push("create");
          comments = [...comments, { id: next++, user: bot, body }];
          return { data: comments.at(-1) };
        },
        updateComment: async ({ comment_id, body }: { comment_id: number; body: string }) => {
          writes.push("update");
          comments = comments.map((each) => (each.id === comment_id ? { ...each, body } : each));
          return { data: {} };
        },
      },
      repos: {
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
    writes,
    comments: () => comments,
    push: (change: Partial<Pull> & { head?: Pull["head"] }) => {
      pull = { ...pull, ...change };
    },
    lastStatus: () => statuses.at(-1),
  };
}

function makeCore() {
  const core = {
    failed: [] as string[],
    summaries: [] as string[],
    setFailed(why: string) {
      core.failed.push(why);
    },
    summary: {
      addRaw(text: string) {
        core.summaries.push(text);
        return core.summary;
      },
      write: async () => undefined,
    },
  };
  return core;
}

/** The pull_request_target event GitHub delivers, carrying the payload as it stood then. */
const event = (pull: Pull, action = "opened") => ({
  repo: project,
  eventName: "pull_request_target",
  serverUrl: "https://github.com",
  payload: { action, pull_request: pull, repository: { default_branch: "main" } },
});
const byHand = {
  repo: project,
  eventName: "workflow_dispatch",
  serverUrl: "https://github.com",
  payload: { repository: { default_branch: "main" } },
};

describe("the Careful review check on an outside pull request", () => {
  it("passes the record Infinitary writes for the newest version, naming its live validation", async () => {
    const pull = pullRequest();
    const api = gitHub(pull);
    expect(await check({ ...api, core: makeCore(), context: event(pull) })).toBe("passed");
    expect(api.statuses).toEqual([
      expect.objectContaining({ sha: newer, state: "success", context: STATUS }),
    ]);
    expect(api.lastStatus()?.description).toContain("go, 2 of 2 passed live");
    expect(api.comments()).toEqual([]);
  });

  it("fails a record for an older version, naming both versions in one comment", async () => {
    const pull = pullRequest({ body: story(older) });
    const api = gitHub(pull);
    expect(await check({ ...api, core: makeCore(), context: event(pull, "synchronize") })).toBe(
      "failed: another version",
    );
    expect(api.lastStatus()).toMatchObject({ sha: newer, state: "failure", context: STATUS });
    expect(api.lastStatus()?.description.length).toBeLessThanOrEqual(140);
    expect(api.comments()).toHaveLength(1);
    expect(api.comments()[0]?.body).toContain(`\`${older.slice(0, 12)}\``);
    expect(api.comments()[0]?.body).toContain(`\`${newer.slice(0, 12)}\``);
  });

  it("fails no-mistakes' own record, since only Infinitary's Careful record counts", async () => {
    const pull = pullRequest({ body: `Fixes the typo.\n\n${noMistakes(newer)}` });
    const api = gitHub(pull);
    expect(await check({ ...api, core: makeCore(), context: event(pull) })).toBe(
      "failed: not careful",
    );
    expect(api.lastStatus()?.state).toBe("failure");
    expect(api.comments()[0]?.body).toContain("only the record Infinitary writes");
  });

  it("keeps one comment through repeated failures, then says the newest version passes", async () => {
    const pull = pullRequest({ body: story(null) });
    const api = gitHub(pull);
    const core = makeCore();
    expect(await check({ ...api, core, context: event(pull) })).toBe("failed: no record");
    // The author edits the description without adding a record.
    api.push({ body: story(null, "Fixes the typo in the keyboard page, and its heading.") });
    expect(await check({ ...api, core, context: event(pull, "edited") })).toBe("failed: no record");
    expect(api.writes).toEqual(["create"]);
    // Infinitary's review and live proof cover the version, and it republishes the story.
    api.push({ body: story(newer) });
    expect(await check({ ...api, core, context: event(pull, "edited") })).toBe("passed");
    expect(api.writes).toEqual(["create", "update"]);
    expect(api.comments().map((each) => each.body)).toEqual([PASSED_COMMENT]);
    expect(api.statuses.map((status) => status.state)).toEqual(["failure", "failure", "success"]);
  });

  it("reads the description and version live, not the event's stale payload", async () => {
    // A rerun replays the first push's event, whose record matched its version.
    const first = pullRequest({ body: story(older), head: older });
    const api = gitHub(first);
    api.push({ head: { ...first.head, sha: newer } });
    expect(await check({ ...api, core: makeCore(), context: event(first) })).toBe(
      "failed: another version",
    );
    expect(api.lastStatus()?.sha).toBe(newer);
  });

  it("fails a record whose steps are not all completed", async () => {
    const skipped = story(newer).replace(
      '{"step":"test","status":"completed"}',
      '{"step":"test","status":"skipped"}',
    );
    const pull = pullRequest({ body: skipped });
    const api = gitHub(pull);
    expect(await check({ ...api, core: makeCore(), context: event(pull) })).toBe(
      "failed: steps incomplete",
    );
  });

  it("reads Infinitary's record past a quoted one the app made inert", async () => {
    // A template that quotes another pull request's record, as Infinitary publishes it.
    const quoted = neutralizePipelineAttestation(noMistakes(older));
    const pull = pullRequest({ body: story(newer, quoted) });
    expect(readRecord(pull.body, newer)).toMatchObject({ ok: true });
  });

  it("names only a version's hexadecimal characters when a record's version carries other words", async () => {
    const forged = story(newer).replace(
      `"head_sha":"${newer}"`,
      '"head_sha":"abc [click](https://example.com) @someone"',
    );
    const pull = pullRequest({ body: forged });
    const api = gitHub(pull);
    await check({ ...api, core: makeCore(), context: event(pull) });
    const body = api.comments()[0]?.body ?? "";
    expect(body).toContain("`abccceaecee`");
    expect(body).not.toContain("example.com");
    expect(body).not.toContain("@someone");
  });

  it("names only a verdict's letters and hyphens when a record's verdict carries other words", async () => {
    const forged = story(newer).replace(
      '"verdict":"go"',
      '"verdict":"go [click](https://example.com) @someone"',
    );
    const pull = pullRequest({ body: forged });
    const api = gitHub(pull);
    const core = makeCore();
    expect(await check({ ...api, core, context: event(pull) })).toBe("passed");
    for (const text of [api.lastStatus()?.description ?? "", core.summaries.join("")]) {
      expect(text).toContain("live validation goclickhttpsexamplecomsomeone, 2 of 2");
      expect(text).not.toContain("example.com");
      expect(text).not.toContain("@someone");
    }
  });
});

describe("the Careful review check on the project's own pull requests", () => {
  it("passes a pull request from the project's own branch at once, with no comment", async () => {
    const pull = pullRequest({ own: true, body: "A merge batch." });
    const api = gitHub(pull);
    expect(await check({ ...api, core: makeCore(), context: event(pull) })).toBe("own branch");
    expect(api.statuses).toEqual([
      expect.objectContaining({ sha: newer, state: "success", context: STATUS }),
    ]);
    expect(api.comments()).toEqual([]);
  });

  it("started by hand on one, reads its record into the summary and writes nothing to it", async () => {
    const pull = pullRequest({ own: true, body: story(newer) });
    const api = gitHub(pull);
    const core = makeCore();
    expect(await check({ ...api, core, context: byHand, pullNumber: "41" })).toBe("read passed");
    expect(api.statuses).toEqual([]);
    expect(api.comments()).toEqual([]);
    expect(core.summaries.join("")).toContain("go, 2 of 2 passed live");
  });

  it("started by hand on an outside one, writes as its event would", async () => {
    const pull = pullRequest({ body: story(null) });
    const api = gitHub(pull);
    expect(await check({ ...api, core: makeCore(), context: byHand, pullNumber: "41" })).toBe(
      "failed: no record",
    );
    expect(api.lastStatus()?.state).toBe("failure");
    expect(api.comments()).toHaveLength(1);
  });

  it("started by hand without a pull request number, fails and reads nothing", async () => {
    const api = gitHub(pullRequest());
    const core = makeCore();
    expect(await check({ ...api, core, context: byHand, pullNumber: "" })).toBe("no pull request");
    expect(core.failed).toHaveLength(1);
    expect(api.statuses).toEqual([]);
  });
});

// The workflow holds a write token for an outside pull request, so it never
// runs the pull request's own code (docs/public-ci.md).
describe("careful-review-check.yml", () => {
  type Step = { uses?: string; with?: Record<string, unknown>; run?: string };
  const workflow = loadYamlFile(".github/workflows/careful-review-check.yml") as {
    on: Record<string, unknown>;
    jobs: Record<string, { permissions?: Record<string, string>; steps: Step[] }>;
  };
  const text = readFileSync(
    new URL("../.github/workflows/careful-review-check.yml", import.meta.url),
    "utf8",
  );

  it("runs from the project's default branch, never from the pull request's files", () => {
    expect(Object.keys(workflow.on).toSorted()).toEqual([
      "pull_request_target",
      "workflow_dispatch",
    ]);
    const steps = Object.values(workflow.jobs).flatMap((job) => job.steps);
    const checkouts = steps.filter((step) => step.uses?.startsWith("actions/checkout@"));
    expect(checkouts).toHaveLength(1);
    for (const step of checkouts) {
      // No ref or repository: the event's own commit, which is this project's default branch.
      expect(Object.keys(step.with ?? {}).toSorted()).toEqual([
        "persist-credentials",
        "sparse-checkout",
        "sparse-checkout-cone-mode",
      ]);
      expect(step.with?.["persist-credentials"]).toBe(false);
      expect(String(step.with?.["sparse-checkout"]).trim().split("\n").toSorted()).toEqual([
        "scripts/careful-review-check.mjs",
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
    // No expression inside the script, so the description reaches it only as data.
    for (const step of Object.values(workflow.jobs).flatMap((job) => job.steps))
      expect(String(step.with?.script ?? ""), step.uses).not.toContain("${{");
  });
});
