import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { printErrors } from "./github-errors.ts";

/**
 * Announces each stable release in the project's Discord channel, once
 * (docs/alpha.md, "Announcing a stable"). release-announce.yml runs it after
 * every release run and on request. Every check comes before the post, and
 * the first one that fails stops the run with nothing posted.
 *
 * A post happens at most once per version because the claim is a git ref
 * GitHub creates only once: whoever creates refs/announcements/discord/v<v>
 * is the only run that may post it. Nothing here asks a list whether a
 * version was announced, since an incomplete list read as "never posted" is
 * how a list-based announcer posts the same release twice. An answer from
 * Discord that does not say whether the message exists (a timeout, a server
 * error, a lost connection) keeps the claim and is never retried on its own:
 * a person checks the channel, then replays.
 *
 * Plain Node type stripping and node:* only, so the workflow runs it with
 * nothing installed.
 *
 *   node scripts/release-announce.ts --release-run <id>              after a release run
 *   node scripts/release-announce.ts --mode normal --version 0.8.7   the newest stable, by hand
 *   node scripts/release-announce.ts --mode preview --version 0.8.7  print the message, post nothing
 *   node scripts/release-announce.ts --mode replay --version 0.8.7   after a person checked the channel
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const CLAIM_PREFIX = "refs/announcements/discord/";
export const POSTED_PREFIX = "refs/announcements/discord-posted/";
/** The release jobs' trigger for a live stable (scripts/ci-job-names.mjs); a rehearsal's is "Requested stable rehearsal". */
export const STABLE_JOB_LEAD = "Requested stable · ";
export const HIGHLIGHTS_LINE = /^Highlights picked, lead first: (.+)$/m;
export const WHATS_NEW_URL = "https://docs.getinfinitary.com/whats-new/";
export const DOWNLOAD_URL = "https://getinfinitary.com/downloads/";
/** How long a release run's announcement waits for the docs site to list the version. */
export const WHATS_NEW_WAIT_MS = 30 * 60_000;
const WHATS_NEW_EVERY_MS = 30_000;
const DISCORD_TIMEOUT_MS = 30_000;
/** Discord's documented limits for a webhook message's embed. */
export const DISCORD_LIMITS = { title: 256, description: 4096, embedTotal: 6000 } as const;

export type Mode = "normal" | "preview" | "replay";
export type Http = (url: string, init?: RequestInit) => Promise<Response>;

export type LedgerEntry = {
  id: string;
  title: string;
  body?: string;
  picture?: { dark?: string };
};

export type Options = {
  mode: Mode;
  /** The release run this follows; only after a release run. */
  releaseRun?: string;
  /** X.Y.Z; required on a request, read from the release otherwise. */
  version?: string;
  repository: string;
  apiUrl: string;
  token: string;
  webhook?: string;
};

export type Deps = {
  fetch: Http;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** The release-notes entries as they stand at the stable's tag. */
  loadLedger: (version: string) => Map<string, LedgerEntry>;
  log: (line: string) => void;
};

export type Outcome = {
  exit: 0 | 1;
  /** One stable word for the run's summary and the tests. */
  result:
    | "not_stable"
    | "no_release"
    | "not_latest"
    | "invalid"
    | "no_webhook"
    | "whats_new_not_listed"
    | "preview"
    | "already_announced"
    | "ambiguous"
    | "refused"
    | "github_error"
    | "posted";
  message: string;
  version?: string;
  payload?: WebhookMessage;
  messageId?: string;
};

export type WebhookMessage = {
  username: string;
  avatar_url: string;
  allowed_mentions: { parse: string[] };
  embeds: {
    title: string;
    url: string;
    description: string;
    image?: { url: string };
  }[];
};

export type Release = {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
  body: string | null;
};

const STABLE_TAG = /^v(\d+\.\d+\.\d+)$/;
const STABLE_VERSION = /^\d+\.\d+\.\d+$/;

/** Whether a release run published a live stable, from its latest jobs' names. */
export function isStableRun(jobNames: readonly string[]): boolean {
  return jobNames.some((name) => name.startsWith(STABLE_JOB_LEAD));
}

/** The stable version a release record names, or null when it is an alpha, a draft or not vX.Y.Z. */
export function stableVersion(release: Release): string | null {
  if (release.draft || release.prerelease) return null;
  return STABLE_TAG.exec(release.tag_name)?.[1] ?? null;
}

/** The highlights the captain picked for the stable, lead first, as release.yml writes them into its record. */
export function pickedHighlights(body: string | null): string[] {
  const line = HIGHLIGHTS_LINE.exec(body ?? "")?.[1];
  return line
    ? line
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean)
    : [];
}

/** A note's first sentence: up to the first full stop, question or exclamation mark that ends a sentence. */
export function firstSentence(text: string): string {
  const match = /^.*?[.!?](?=\s|$)/s.exec(text.trim());
  return (match ? match[0] : text.trim()).replace(/\s+/g, " ");
}

/** A stable's own page on the docs site, as scripts/docs-site-whats-new.ts names it: 0.8.7 is /whats-new/0-8-7/. */
export function whatsNewPage(version: string): string {
  return `${WHATS_NEW_URL}${version.replaceAll(".", "-")}/`;
}

/** Text with nothing Discord's markdown would read as its own markup. */
function plain(text: string): string {
  return text.replace(/[\\*_~`|[\]<>#]/g, (character) => `\\${character}`);
}

function rawFile(repository: string, version: string, path: string): string {
  return `https://raw.githubusercontent.com/${repository}/v${version}/${path}`;
}

/** The one message a stable posts: its highlights, the lead's picture and two links, notifying nobody. */
export function renderMessage(
  version: string,
  highlights: readonly LedgerEntry[],
  repository: string,
): WebhookMessage {
  const whatsNew = whatsNewPage(version);
  const lines = highlights.map(
    (entry) => `**${plain(entry.title)}**\n${plain(firstSentence(entry.body ?? ""))}`.trimEnd(),
  );
  lines.push(`[What's new in ${version}](${whatsNew}) · [Download Infinitary](${DOWNLOAD_URL})`);
  const lead = highlights[0]?.picture?.dark;
  return {
    username: "Infinitary",
    avatar_url: rawFile(repository, version, "packaging/build/icon.png"),
    allowed_mentions: { parse: [] },
    embeds: [
      {
        title: `Infinitary ${version} is out`,
        url: whatsNew,
        description: lines.join("\n\n"),
        ...(lead ? { image: { url: rawFile(repository, version, `release-notes/pictures/${lead}`) } } : {}),
      },
    ],
  };
}

/** What in a message Discord would refuse for its length; empty when it fits. */
export function limitProblems(message: WebhookMessage): string[] {
  const problems: string[] = [];
  for (const embed of message.embeds) {
    if (embed.title.length > DISCORD_LIMITS.title)
      problems.push(`The embed title is ${embed.title.length} characters; Discord takes ${DISCORD_LIMITS.title}.`);
    if (embed.description.length > DISCORD_LIMITS.description)
      problems.push(
        `The embed description is ${embed.description.length} characters; Discord takes ${DISCORD_LIMITS.description}.`,
      );
    const total = embed.title.length + embed.description.length;
    if (total > DISCORD_LIMITS.embedTotal)
      problems.push(`The embed is ${total} characters; Discord takes ${DISCORD_LIMITS.embedTotal}.`);
  }
  return problems;
}

/** The picked entries, lead first, or the problem with them. */
export function highlightEntries(
  picks: readonly string[],
  ledger: Map<string, LedgerEntry>,
): { entries: LedgerEntry[] } | { problem: string } {
  if (picks.length === 0) return { problem: "The release record names no picked highlights." };
  const entries: LedgerEntry[] = [];
  for (const id of picks) {
    const entry = ledger.get(id);
    if (!entry) return { problem: `Highlight ${id} is not in release-notes/changes at the stable's tag.` };
    entries.push(entry);
  }
  if (!entries[0]?.picture?.dark) return { problem: `The lead highlight ${picks[0]} has no dark hero picture.` };
  return { entries };
}

/** The release-notes entries a checked-out tree holds, by id. */
export function readLedger(root: string): Map<string, LedgerEntry> {
  const entries = new Map<string, LedgerEntry>();
  const dir = join(root, "release-notes", "changes");
  for (const name of readdirSync(dir).filter((file) => file.endsWith(".json")).sort()) {
    const file = JSON.parse(readFileSync(join(dir, name), "utf8")) as { entries?: LedgerEntry[] };
    for (const entry of file.entries ?? []) entries.set(entry.id, entry);
  }
  return entries;
}

class GitHub {
  private readonly options: Options;
  private readonly http: Http;

  constructor(options: Options, http: Http) {
    this.options = options;
    this.http = http;
  }

  async call(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    const response = await this.http(`${this.options.apiUrl}/repos/${this.options.repository}${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${this.options.token}`,
        "x-github-api-version": "2022-11-28",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: response.status, json };
  }

  async read<T>(path: string): Promise<T> {
    const { status, json } = await this.call("GET", path);
    if (status !== 200) throw new GitHubError(`GET ${path} answered ${status}.`);
    return json as T;
  }
}

class GitHubError extends Error {}

async function jobNames(github: GitHub, run: string): Promise<string[]> {
  const names: string[] = [];
  for (let page = 1; ; page++) {
    const { jobs, total_count } = await github.read<{ jobs: { name: string }[]; total_count: number }>(
      `/actions/runs/${run}/jobs?filter=latest&per_page=100&page=${page}`,
    );
    names.push(...jobs.map((job) => job.name));
    if (jobs.length === 0 || names.length >= total_count) return names;
  }
}

/** Whether the docs site serves the version's own What's new page, read past any edge cache. */
async function whatsNewLists(version: string, deps: Deps): Promise<boolean> {
  try {
    const response = await deps.fetch(`${whatsNewPage(version)}?announce=${deps.now()}`, {
      headers: { "cache-control": "no-cache" },
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function refExists(github: GitHub, ref: string): Promise<boolean> {
  const { status } = await github.call("GET", `/git/ref/${ref.slice("refs/".length)}`);
  if (status === 200) return true;
  if (status === 404) return false;
  throw new GitHubError(`GET ${ref} answered ${status}.`);
}

/** The commit a stable's tag names. */
async function tagCommit(github: GitHub, version: string): Promise<string> {
  const ref = await github.read<{ object: { sha: string; type: string } }>(`/git/ref/tags/v${version}`);
  if (ref.object.type === "commit") return ref.object.sha;
  const tag = await github.read<{ object: { sha: string } }>(`/git/tags/${ref.object.sha}`);
  return tag.object.sha;
}

type Posted = { kind: "posted"; id: string } | { kind: "refused"; status: number } | { kind: "unclear"; why: string };

/** One post, with ?wait=true so Discord answers with the message it created. */
async function postOnce(webhook: string, message: WebhookMessage, deps: Deps): Promise<Posted | { kind: "slow"; after: number }> {
  let response: Response;
  try {
    response = await deps.fetch(`${webhook}${webhook.includes("?") ? "&" : "?"}wait=true`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(DISCORD_TIMEOUT_MS),
    });
  } catch (error) {
    return { kind: "unclear", why: `no answer (${error instanceof Error ? error.name : "error"})` };
  }
  const text = await response.text().catch(() => "");
  if (response.status === 429) {
    let after = Number(response.headers.get("retry-after") ?? "1");
    try {
      const seconds = (JSON.parse(text) as { retry_after?: number }).retry_after;
      if (typeof seconds === "number") after = seconds;
    } catch {}
    return { kind: "slow", after: Math.max(after, 0) * 1000 };
  }
  if (response.status >= 400 && response.status < 500) return { kind: "refused", status: response.status };
  if (response.status >= 200 && response.status < 300) {
    try {
      const id = (JSON.parse(text) as { id?: unknown }).id;
      if (typeof id === "string" && /^\d+$/.test(id)) return { kind: "posted", id };
    } catch {}
    return { kind: "unclear", why: `answered ${response.status} without a message id` };
  }
  return { kind: "unclear", why: `answered ${response.status}` };
}

/** Posts once; a rate limit waits its retry_after once and tries again, since Discord created nothing. */
async function post(webhook: string, message: WebhookMessage, deps: Deps): Promise<Posted> {
  const first = await postOnce(webhook, message, deps);
  if (first.kind !== "slow") return first;
  deps.log(`Discord asked to wait ${Math.ceil(first.after / 1000)} s; posting once more after it.`);
  await deps.sleep(first.after);
  const second = await postOnce(webhook, message, deps);
  return second.kind === "slow" ? { kind: "refused", status: 429 } : second;
}

function replayCommand(version: string): string {
  return `gh workflow run release-announce.yml --ref main -f mode=replay -f version=${version}`;
}

export async function announce(options: Options, deps: Deps): Promise<Outcome> {
  const github = new GitHub(options, deps.fetch);
  try {
    return await run(options, deps, github);
  } catch (error) {
    if (error instanceof GitHubError)
      return { exit: 1, result: "github_error", message: `${error.message} Nothing was posted.` };
    throw error;
  }
}

async function run(options: Options, deps: Deps, github: GitHub): Promise<Outcome> {
  const { mode } = options;
  let version: string;
  let release: Release;

  if (options.releaseRun) {
    if (mode !== "normal") return { exit: 1, result: "invalid", message: "A release run's announcement is mode normal." };
    if (!isStableRun(await jobNames(github, options.releaseRun)))
      return { exit: 0, result: "not_stable", message: `Release run ${options.releaseRun} was not a stable release. Nothing posted.` };
    const runTimes = await github.read<{ run_started_at: string; updated_at: string }>(
      `/actions/runs/${options.releaseRun}`,
    );
    release = await github.read<Release>("/releases/latest");
    const found = stableVersion(release);
    const published = Date.parse(release.published_at ?? "");
    if (
      !found ||
      !(published >= Date.parse(runTimes.run_started_at) && published <= Date.parse(runTimes.updated_at))
    )
      return {
        exit: 1,
        result: "no_release",
        message: `The latest release, ${release.tag_name}, is not a stable published during release run ${options.releaseRun}. Nothing posted.`,
      };
    version = found;
  } else {
    if (!options.version || !STABLE_VERSION.test(options.version))
      return { exit: 1, result: "invalid", message: "A request names a stable version, X.Y.Z." };
    version = options.version;
    const { status, json } = await github.call("GET", `/releases/tags/v${version}`);
    if (status === 404) return { exit: 1, result: "no_release", message: `No release is tagged v${version}. Nothing posted.` };
    if (status !== 200) throw new GitHubError(`GET /releases/tags/v${version} answered ${status}.`);
    release = json as Release;
    if (stableVersion(release) !== version)
      return { exit: 1, result: "no_release", message: `v${version} is not a published stable release. Nothing posted.` };
    if (mode === "normal") {
      const latest = stableVersion(await github.read<Release>("/releases/latest"));
      if (latest !== version)
        return {
          exit: 1,
          result: "not_latest",
          message: `Mode normal announces only the newest stable, ${latest ?? "none"}, not ${version}. Nothing posted.`,
        };
    }
  }

  const picked = highlightEntries(pickedHighlights(release.body), deps.loadLedger(version));
  if ("problem" in picked) return { exit: 1, result: "invalid", version, message: `${picked.problem} Nothing posted.` };
  const payload = renderMessage(version, picked.entries, options.repository);
  const tooLong = limitProblems(payload);
  if (tooLong.length > 0) return { exit: 1, result: "invalid", version, payload, message: `${tooLong.join(" ")} Nothing posted.` };

  if (mode === "preview") {
    const listed = await whatsNewLists(version, deps);
    return {
      exit: 0,
      result: "preview",
      version,
      payload,
      message: `Preview of ${version}'s message; nothing posted. ${listed ? `What's new lists ${version}.` : `What's new does not list ${version} yet.`}`,
    };
  }

  const webhook = options.webhook?.trim();
  if (!webhook)
    return {
      exit: 1,
      result: "no_webhook",
      version,
      payload,
      message: "No Discord webhook is set in the release-announcement environment. Nothing claimed or posted.",
    };

  const claim = `${CLAIM_PREFIX}v${version}`;
  const posted = `${POSTED_PREFIX}v${version}`;
  const commit = await tagCommit(github, version);

  if (mode === "replay") {
    if (await refExists(github, posted))
      return { exit: 0, result: "already_announced", version, message: `${version} was already announced. Nothing posted.` };
    if (!(await refExists(github, claim)))
      return {
        exit: 1,
        result: "invalid",
        version,
        message: `${version} has no claim, so nothing is waiting for a replay; run mode normal. Nothing posted.`,
      };
  } else {
    const deadline = deps.now() + WHATS_NEW_WAIT_MS;
    while (!(await whatsNewLists(version, deps))) {
      if (deps.now() >= deadline)
        return {
          exit: 1,
          result: "whats_new_not_listed",
          version,
          message: `What's new did not list ${version} within 30 minutes. Nothing claimed or posted.`,
        };
      await deps.sleep(WHATS_NEW_EVERY_MS);
    }
    const created = await github.call("POST", "/git/refs", { ref: claim, sha: commit });
    // GitHub answers 422 for an invalid name or a rule too, so only a claim that reads back means "already claimed".
    if (created.status === 422 && (await refExists(github, claim))) {
      if (await refExists(github, posted))
        return { exit: 0, result: "already_announced", version, message: `${version} was already announced. Nothing posted.` };
      return {
        exit: 1,
        result: "ambiguous",
        version,
        message: `${version} is claimed but has no posted marker: an earlier post's outcome is unknown. Check the Discord channel; if ${version} is not there, run ${replayCommand(version)}.`,
      };
    }
    if (created.status !== 201) throw new GitHubError(`Creating ${claim} answered ${created.status}.`);
  }

  const answer = await post(webhook, payload, deps);
  if (answer.kind === "refused") {
    if (mode === "replay")
      return {
        exit: 1,
        result: "refused",
        version,
        message: `Discord refused the replay with ${answer.status}. The claim stays; fix the webhook, then replay again.`,
      };
    const released = await github.call("DELETE", `/git/refs/${claim.slice("refs/".length)}`);
    return {
      exit: 1,
      result: "refused",
      version,
      message:
        released.status === 204
          ? `Discord refused the post with ${answer.status}, so nothing was posted and the claim is released; a normal run may try again.`
          : `Discord refused the post with ${answer.status}, and releasing the claim answered ${released.status}; ${version} now needs ${replayCommand(version)}.`,
    };
  }
  if (answer.kind === "unclear")
    return {
      exit: 1,
      result: "ambiguous",
      version,
      message: `Discord ${answer.why}, so whether ${version} posted is unknown. The claim stays and nothing retries on its own. Check the Discord channel; if ${version} is not there, run ${replayCommand(version)}.`,
    };

  // Printed before the marker writes, so a failure or hang there still leaves the id in the log.
  deps.log(`Discord created message ${answer.id} for ${version}.`);
  const digest = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  const tag = await github.call("POST", "/git/tags", {
    tag: `announced-discord-v${version}`,
    message: `Discord message ${answer.id}\nPayload sha256 ${digest}\n`,
    object: commit,
    type: "commit",
  });
  const marker =
    tag.status === 201
      ? await github.call("POST", "/git/refs", { ref: posted, sha: (tag.json as { sha: string }).sha })
      : tag;
  if (marker.status !== 201)
    return {
      exit: 1,
      result: "posted",
      version,
      payload,
      messageId: answer.id,
      message: `Posted ${version} as Discord message ${answer.id}, but writing ${posted} answered ${marker.status}. The claim stays, so nothing posts it again; write the marker by hand (docs/alpha.md, "Announcing a stable").`,
    };
  return {
    exit: 0,
    result: "posted",
    version,
    payload,
    messageId: answer.id,
    message: `Posted ${version} as Discord message ${answer.id}.`,
  };
}

/** The ledger at a stable's tag, from a scratch export of that tag's release-notes. */
function gitLedger(version: string): Map<string, LedgerEntry> {
  const scratch = mkdtempSync(join(tmpdir(), "release-announce-"));
  try {
    // Never --depth: a depth fetch in a full clone makes that clone shallow at the tag.
    execFileSync("git", ["-C", ROOT, "fetch", "--quiet", "--no-tags", "origin", `+refs/tags/v${version}:refs/tags/v${version}`], {
      stdio: "inherit",
    });
    const archive = join(scratch, "release-notes.tar");
    execFileSync("git", ["-C", ROOT, "archive", "--format=tar", `--output=${archive}`, `v${version}`, "release-notes/changes"]);
    execFileSync("tar", ["-x", "-f", archive, "-C", scratch]);
    return readLedger(scratch);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function parseArgs(argv: readonly string[]): { mode: Mode; version?: string; releaseRun?: string } {
  const value = (flag: string) => {
    const at = argv.indexOf(flag);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  const mode = (value("--mode") ?? "normal") as Mode;
  if (!["normal", "preview", "replay"].includes(mode)) throw new Error(`Unknown mode ${mode}.`);
  return { mode, version: value("--version") || undefined, releaseRun: value("--release-run") || undefined };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? "";
  const source = JSON.parse(readFileSync(join(ROOT, "packaging/release-source.json"), "utf8")) as { repository: string };
  const outcome = await announce(
    {
      ...args,
      repository: process.env.GITHUB_REPOSITORY || source.repository,
      apiUrl: process.env.GITHUB_API_URL || "https://api.github.com",
      token,
      webhook: process.env.INFINITARY_DISCORD_RELEASE_WEBHOOK_URL,
    },
    {
      fetch: (url, init) => fetch(url, init),
      sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
      now: () => Date.now(),
      loadLedger: gitLedger,
      log: (line) => console.log(line),
    },
  );
  if (outcome.payload && outcome.result !== "posted") console.log(JSON.stringify(outcome.payload, null, 2));
  if (outcome.exit === 0) console.log(outcome.message);
  else printErrors([outcome.message], { title: `Discord announcement: ${outcome.result}` });
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## Discord announcement: ${outcome.result}\n\n${outcome.message}\n${
        outcome.payload ? `\n\`\`\`json\n${JSON.stringify(outcome.payload, null, 2)}\n\`\`\`\n` : ""
      }`,
    );
  process.exitCode = outcome.exit;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
