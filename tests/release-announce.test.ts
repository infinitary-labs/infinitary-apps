import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  announce,
  CLAIM_PREFIX,
  type Deps,
  limitProblems,
  type Options,
  POSTED_PREFIX,
  type Release,
  readLedger,
  renderMessage,
  type WebhookMessage,
} from "../scripts/release-announce.ts";

/**
 * The Discord announcement of each stable (docs/alpha.md, "Announcing a
 * stable"; part 1 of INF-6319's approved plan). Intents: an alpha or a
 * rehearsal posts nothing and a stable posts one message (INF-1104); a second run for a
 * claimed version posts nothing, and a Discord answer that does not say
 * whether the message exists is never retried (SSHH-34, where a
 * list-based announcer posted a release twice). Only the network is stood
 * in for: GitHub's API, the docs site and Discord's webhook. The runs, the
 * release records and the highlights are 0.8.7's and 0.8.7-alpha.31's own.
 */

const FIXTURES = join(import.meta.dirname, "fixtures", "release-announce");
const fixture = <T>(name: string) => JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as T;
type RunFixture = {
  run: { id: number; run_started_at: string; updated_at: string };
  jobs: string[];
};
const STABLE_RUN = fixture<RunFixture>("release-run-45219209472.json");
const ALPHA_RUN = fixture<RunFixture>("release-run-45177463244.json");
const REHEARSAL_RUN = fixture<RunFixture>("release-run-44898655966.json");
const STABLE = fixture<Release>("release-v0.8.7.json");
const ALPHA = fixture<Release>("release-v0.8.7-alpha.31.json");
const LEDGER = readLedger(FIXTURES);
const REPOSITORY = "infinitary-labs/infinitary-apps";
const API = "https://api.github.test";
const WEBHOOK = "https://discord.test/api/webhooks/1/secret";
const TAG_COMMIT = "aa091719c3b5e9cd99652ef0bd8f3bd9b8391110";

type DiscordAnswer = () => Response | Promise<Response>;

/** GitHub, the docs site and Discord as the script reaches them, holding the refs it creates. */
function network(discord: DiscordAnswer, { claimRule = false } = {}) {
  const refs = new Map<string, string>();
  const runs = new Map(
    [STABLE_RUN, ALPHA_RUN, REHEARSAL_RUN].map((fixture) => [String(fixture.run.id), fixture]),
  );
  const posts: WebhookMessage[] = [];
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  const fetch: Deps["fetch"] = async (url, init) => {
    const method = init?.method ?? "GET";
    if (url.startsWith(WEBHOOK)) {
      posts.push(JSON.parse(String(init?.body)) as WebhookMessage);
      return discord();
    }
    if (url.startsWith("https://docs.getinfinitary.com/whats-new/"))
      return new Response('<h2 id="087">0.8.7</h2><h2 id="086">0.8.6</h2>');
    const path = url.slice(`${API}/repos/${REPOSITORY}`.length);
    const jobs = /^\/actions\/runs\/(\d+)\/jobs\?/.exec(path);
    if (jobs) {
      const run = runs.get(jobs[1]!)!;
      const page = Number(new URL(url).searchParams.get("page"));
      return json(200, {
        total_count: run.jobs.length,
        jobs: page === 1 ? run.jobs.map((name) => ({ name })) : [],
      });
    }
    const run = /^\/actions\/runs\/(\d+)$/.exec(path);
    if (run) return json(200, runs.get(run[1]!)!.run);
    if (path === "/releases/latest") return json(200, STABLE);
    if (path === `/releases/tags/${STABLE.tag_name}`) return json(200, STABLE);
    if (path === `/releases/tags/${ALPHA.tag_name}`) return json(200, ALPHA);
    if (path === "/git/ref/tags/v0.8.7")
      return json(200, { object: { sha: TAG_COMMIT, type: "commit" } });
    if (method === "GET" && path.startsWith("/git/ref/")) {
      const ref = `refs/${path.slice("/git/ref/".length)}`;
      return refs.has(ref) ? json(200, { ref, object: { sha: refs.get(ref) } }) : json(404, {});
    }
    if (method === "POST" && path === "/git/refs") {
      const { ref, sha } = JSON.parse(String(init?.body)) as { ref: string; sha: string };
      if (refs.has(ref)) return json(422, { message: "Reference already exists" });
      if (claimRule) return json(422, { message: "Repository rule violations found" });
      refs.set(ref, sha);
      return json(201, { ref });
    }
    if (method === "DELETE" && path.startsWith("/git/refs/")) {
      refs.delete(`refs/${path.slice("/git/refs/".length)}`);
      return new Response(null, { status: 204 });
    }
    if (method === "POST" && path === "/git/tags") return json(201, { sha: "f".repeat(40) });
    return json(404, { message: `no stand-in for ${method} ${path}` });
  };
  const deps: Deps = {
    fetch,
    sleep: async () => {},
    now: () => 0,
    loadLedger: () => LEDGER,
    log: () => {},
  };
  return { deps, refs, posts };
}

const options = (more: Partial<Options>): Options => ({
  mode: "normal",
  repository: REPOSITORY,
  apiUrl: API,
  token: "token",
  webhook: WEBHOOK,
  ...more,
});
const afterRun = (fixture: RunFixture) => options({ releaseRun: String(fixture.run.id) });
const created = () => new Response(JSON.stringify({ id: "1442250000000000000" }), { status: 200 });

describe("which release runs post", () => {
  it.each([
    ["an alpha's", ALPHA_RUN],
    ["a stable rehearsal's", REHEARSAL_RUN],
  ] as [string, RunFixture][])("posts nothing after %s release run", async (_, run) => {
    const { deps, refs, posts } = network(created);
    const outcome = await announce(afterRun(run), deps);
    expect(outcome).toMatchObject({ exit: 0, result: "not_stable" });
    expect(posts).toHaveLength(0);
    expect(refs.size).toBe(0);
  });

  it("posts one message after a stable's release run, with its picked highlights and nobody notified", async () => {
    const { deps, refs, posts } = network(created);
    const outcome = await announce(afterRun(STABLE_RUN), deps);
    expect(outcome).toMatchObject({ exit: 0, result: "posted", version: "0.8.7" });
    expect(posts).toHaveLength(1);
    const [post] = posts;
    expect(post!.allowed_mentions).toEqual({ parse: [] });
    const titles = ["feedback-command", "welcome-asks-where", "usage-cost-per-task"].map(
      (id) => LEDGER.get(id)!.title,
    );
    const description = post!.embeds[0]!.description;
    const at = titles.map((title) => description.indexOf(`**${title}**`));
    expect(at.every((index) => index >= 0)).toBe(true);
    expect(at).toEqual(at.toSorted((a, b) => a - b));
    expect(post!.embeds[0]!.image?.url).toBe(
      `https://raw.githubusercontent.com/${REPOSITORY}/v0.8.7/release-notes/pictures/${LEDGER.get("feedback-command")!.picture!.dark}`,
    );
    expect(new Set(refs.keys())).toEqual(
      new Set([`${CLAIM_PREFIX}v0.8.7`, `${POSTED_PREFIX}v0.8.7`]),
    );
  });

  it("renders the stable's message within Discord's limits", () => {
    const highlights = ["feedback-command", "welcome-asks-where", "usage-cost-per-task"].map(
      (id) => LEDGER.get(id)!,
    );
    expect(limitProblems(renderMessage("0.8.7", highlights, REPOSITORY))).toEqual([]);
  });
});

describe("one post per version", () => {
  it("posts nothing on a second run for a version already announced", async () => {
    const { deps, posts } = network(created);
    await announce(afterRun(STABLE_RUN), deps);
    const again = await announce(options({ version: "0.8.7" }), deps);
    expect(again).toMatchObject({ exit: 0, result: "already_announced" });
    expect(posts).toHaveLength(1);
  });

  it.each([
    ["a server error", () => new Response("", { status: 503 })],
    [
      "no answer",
      () => {
        throw new DOMException("The operation timed out.", "TimeoutError");
      },
    ],
  ] as [string, DiscordAnswer][])(
    "never retries after %s from Discord, until a person replays",
    async (_, answer) => {
      let discord = answer;
      const { deps, refs, posts } = network(() => discord());
      const first = await announce(afterRun(STABLE_RUN), deps);
      expect(first).toMatchObject({ exit: 1, result: "ambiguous" });
      expect(refs.has(`${CLAIM_PREFIX}v0.8.7`)).toBe(true);

      const second = await announce(options({ version: "0.8.7" }), deps);
      expect(second).toMatchObject({ exit: 1, result: "ambiguous" });
      expect(posts).toHaveLength(1);

      discord = created;
      const replay = await announce(options({ mode: "replay", version: "0.8.7" }), deps);
      expect(replay).toMatchObject({ exit: 0, result: "posted" });
      expect(posts).toHaveLength(2);
      expect(refs.has(`${POSTED_PREFIX}v0.8.7`)).toBe(true);
    },
  );

  // The plan's "any other answer" rule: a 422 that is not an existing claim, such as a rule refusing the name, posts nothing.
  it("posts nothing when GitHub refuses the claim for another reason", async () => {
    const { deps, refs, posts } = network(created, { claimRule: true });
    const outcome = await announce(afterRun(STABLE_RUN), deps);
    expect(outcome).toMatchObject({ exit: 1, result: "github_error" });
    expect(posts).toHaveLength(0);
    expect(refs.size).toBe(0);
  });

  it("releases the claim when Discord refuses the post, so a later run posts once", async () => {
    let discord: DiscordAnswer = () => new Response("{}", { status: 400 });
    const { deps, refs, posts } = network(() => discord());
    const refused = await announce(afterRun(STABLE_RUN), deps);
    expect(refused).toMatchObject({ exit: 1, result: "refused" });
    expect(refs.size).toBe(0);

    discord = created;
    const next = await announce(options({ version: "0.8.7" }), deps);
    expect(next).toMatchObject({ exit: 0, result: "posted" });
    expect(posts).toHaveLength(2);
  });
});
