import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { scratchDir } from "./scratchDirs";

const root = join(import.meta.dirname, "..", "..");

/** The machine's git, without host git or publication configuration. */
export function baseEnv(dir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^(GIT_|HOMEBREW_|GH_|GITHUB_|PRERELEASE$|LATEST$)/.test(key)) env[key] = value;
  }
  return {
    ...env,
    HOME: join(dir, "home"),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "tap",
    GIT_AUTHOR_EMAIL: "tap@localhost",
    GIT_COMMITTER_NAME: "tap",
    GIT_COMMITTER_EMAIL: "tap@localhost",
  };
}

/**
 * A stand-in `gh` keeping releases under a scratch folder:
 * `<state>/<owner>__<repo>/<tag>/` holds the release's assets and its
 * `.release.json` (the creation flags, the tag's commit, its id, creation
 * order and whether it is a prerelease); `<state>/<owner>__<repo>/.latest`
 * names the release marked latest. Every call is recorded in
 * `<state>/calls.jsonl`.
 *
 * Its latest badge follows GitHub's rule as the tap showed it with 0.1.25: a
 * release marked latest (created without --latest=false, or updated with
 * make_latest=true) keeps the badge, a prerelease never takes it, and while
 * none is marked the newest full release shows as latest - so --latest=false
 * alone leaves a new full release on the badge. STANDIN_GH_CROWNS_NEW=1
 * stands in for a GitHub that marks every new full release whatever it is
 * asked.
 *
 * STANDIN_GH_CREATE_ERRORS stands in for GitHub answering a release's
 * creates with HTTP 500, one comma-separated word per create of that tag in
 * order: `lost` makes nothing, as release run 42122748351 met it, and `made`
 * makes the release before answering; an empty word or none creates it.
 */
export function standInGh(COMMIT: string) {
  const dir = scratchDir("infinitary-release-assets-");
  const state = join(dir, "state");
  mkdirSync(state);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "gh"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const state = ${JSON.stringify(state)};
const args = process.argv.slice(2);
fs.appendFileSync(path.join(state, "calls.jsonl"), JSON.stringify(args) + "\\n");
const flag = (name) => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; };
const repoDir = (repo) => path.join(state, repo.replace("/", "__"));
const releaseDir = (repo, tag) => path.join(repoDir(repo), tag);
const fail = (message) => { process.stderr.write(message + "\\n"); process.exit(1); };
const releases = (repo) =>
  fs.existsSync(repoDir(repo))
    ? fs.readdirSync(repoDir(repo)).filter((tag) => tag !== ".latest").map((tag) => ({
        tag, ...JSON.parse(fs.readFileSync(path.join(releaseDir(repo, tag), ".release.json"), "utf8")),
      }))
    : [];
const markLatest = (repo, tag) => fs.writeFileSync(path.join(repoDir(repo), ".latest"), tag);
const latest = (repo) => {
  const full = releases(repo).filter((release) => !release.prerelease).sort((a, b) => b.order - a.order);
  const marked = path.join(repoDir(repo), ".latest");
  const tag = fs.existsSync(marked) ? fs.readFileSync(marked, "utf8") : undefined;
  return full.find((release) => release.tag === tag) ?? full[0];
};
const record = (repo, tag, fields) => {
  const counter = path.join(state, "counter");
  const order = (fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0) + 1;
  fs.writeFileSync(counter, String(order));
  fs.mkdirSync(releaseDir(repo, tag), { recursive: true });
  fs.writeFileSync(
    path.join(releaseDir(repo, tag), ".release.json"),
    JSON.stringify({ id: 1000 + order, order, prerelease: false, ...fields }),
  );
};
if (args[0] === "api") {
  const [, owner, repo, kind, rest] = args.find((arg) => arg.startsWith("repos/")).split("/");
  const name = owner + "/" + repo;
  if (kind === "commits") {
    const file = path.join(releaseDir(name, rest), ".release.json");
    if (!fs.existsSync(file)) fail("Not Found");
    process.stdout.write(JSON.parse(fs.readFileSync(file, "utf8")).commit + "\\n");
  } else if (rest === "latest" && flag("--jq") === '"\\\\(.id) \\\\(.tag_name)"') {
    const shown = latest(name);
    if (!shown) {
      process.stdout.write('{"message":"Not Found","status":"404"}');
      fail("gh: Not Found (HTTP 404)");
    }
    process.stdout.write(shown.id + " " + shown.tag + "\\n");
  } else if (kind === "releases" && flag("--method") === "PATCH" && flag("-f") === "make_latest=true") {
    const release = releases(name).find((each) => String(each.id) === rest);
    if (!release) fail("gh: Not Found (HTTP 404)");
    if (!release.prerelease) markLatest(name, release.tag);
  } else if (kind === "releases?per_page=100" && args.includes("--paginate")) {
    const full = releases(name).filter((release) => !release.prerelease);
    process.stdout.write(full.map((release) => release.tag + "\\n").join(""));
  } else fail("unexpected gh call: " + args.join(" "));
  process.exit(0);
}
const [, verb, tag] = args;
const dir = releaseDir(flag("--repo"), tag);
const exists = fs.existsSync(path.join(dir, ".release.json"));
const assets = () => (exists ? fs.readdirSync(dir).filter((name) => name !== ".release.json") : []);
if (verb === "view") {
  if (!exists) fail("release not found");
  if (flag("--json") === "assets") process.stdout.write(assets().map((name) => name + "\\n").join(""));
} else if (verb === "create") {
  const tries = path.join(state, "creates." + flag("--repo").replace("/", "__") + "." + tag);
  const tried = fs.existsSync(tries) ? Number(fs.readFileSync(tries, "utf8")) : 0;
  fs.writeFileSync(tries, String(tried + 1));
  const serverError = (process.env.STANDIN_GH_CREATE_ERRORS ?? "").split(",")[tried];
  if (exists) fail("a release with the same tag name already exists");
  if (serverError !== "lost") {
    const named = flag("--target");
    const commit = /^[0-9a-f]{40}$/.test(named) ? named : "f".repeat(40);
    const prerelease = args.includes("--prerelease");
    record(flag("--repo"), tag, { commit, args, prerelease });
    const marks = !args.includes("--latest=false") || process.env.STANDIN_GH_CROWNS_NEW === "1";
    if (marks && !prerelease) markLatest(flag("--repo"), tag);
  }
  // What gh printed when GitHub answered release run 42122748351's create.
  if (serverError) fail("HTTP 500 (https://api.github.com/repos/" + flag("--repo") + "/releases)");
} else if (verb === "upload") {
  if (!exists) fail("release not found");
  for (const file of args.slice(3).filter((arg, at, all) => !arg.startsWith("--") && all[at - 1] !== "--repo")) {
    if (assets().includes(path.basename(file)) && !args.includes("--clobber")) fail("asset already exists");
    fs.copyFileSync(file, path.join(dir, path.basename(file)));
  }
} else if (verb === "download") {
  // Every asset any --pattern names, as gh downloads them; none is a failure.
  const named = args.flatMap((arg, at) => (args[at - 1] === "--pattern" ? [arg] : []));
  const found = assets().filter((name) => named.includes(name));
  if (found.length === 0) fail("no assets match the file pattern");
  for (const name of found) fs.copyFileSync(path.join(dir, name), path.join(flag("--dir"), name));
} else fail("unexpected gh call: " + args.join(" "));
`,
  );
  chmodSync(join(bin, "gh"), 0o755);

  /** A zip's worth of bytes for a version and build. */
  const zip = (version: string, build: string) => {
    const folder = scratchDir("infinitary-release-zip-");
    const file = join(folder, `Infinitary-${version}-universal.zip`);
    writeFileSync(file, `${version} ${build}`);
    return file;
  };

  /**
   * Seeds an already published release, as an earlier attempt or another
   * product left it; `marked` makes it the release marked latest.
   */
  const seed = (
    repo: string,
    tag: string,
    commit: string,
    files: Record<string, string>,
    { prerelease = false, marked = false } = {},
  ) => {
    const release = join(state, repo.replace("/", "__"), tag);
    mkdirSync(release, { recursive: true });
    const counter = join(state, "counter");
    const order = (existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0) + 1;
    writeFileSync(counter, String(order));
    writeFileSync(
      join(release, ".release.json"),
      JSON.stringify({ id: 1000 + order, order, prerelease, commit, args: ["seeded"] }),
    );
    if (marked) writeFileSync(join(state, repo.replace("/", "__"), ".latest"), tag);
    for (const [name, content] of Object.entries(files))
      writeFileSync(join(release, name), content);
  };

  const run = (
    mode: "adopt" | "match",
    repo: string,
    tag: string,
    file: string,
    extra: Record<string, string> & { PRERELEASE: "true" | "false" },
  ) => {
    const work = scratchDir("infinitary-release-work-");
    const notes = join(work, "notes.md");
    writeFileSync(notes, "notes\n");
    const output = join(work, "output");
    writeFileSync(output, "");
    const result = spawnSync(
      join(root, "scripts", "publish-release-asset.sh"),
      [mode, repo, tag, file],
      {
        env: {
          ...baseEnv(dir),
          PATH: `${bin}:${process.env.PATH}`,
          WORK: work,
          GITHUB_OUTPUT: output,
          TITLE: "Infinitary",
          NOTES_FILE: notes,
          TARGET: COMMIT,
          SOURCE_COMMIT: COMMIT,
          ...extra,
        },
        encoding: "utf8",
      },
    );
    const outputs = Object.fromEntries(
      readFileSync(output, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
    return { status: result.status, stderr: result.stderr, outputs };
  };

  const published = (repo: string, tag: string) => {
    const release = join(state, repo.replace("/", "__"), tag);
    return existsSync(release)
      ? Object.fromEntries(
          readdirSync(release)
            .filter((name) => name !== ".release.json")
            .map((name) => [name, readFileSync(join(release, name), "utf8")]),
        )
      : null;
  };
  /** A release's assets as bytes, for binary files `published` would decode. */
  const publishedBytes = (repo: string, tag: string) => {
    const release = join(state, repo.replace("/", "__"), tag);
    return existsSync(release)
      ? Object.fromEntries(
          readdirSync(release)
            .filter((name) => name !== ".release.json")
            .map((name) => [name, readFileSync(join(release, name))]),
        )
      : null;
  };
  const created = (repo: string, tag: string) =>
    (
      JSON.parse(
        readFileSync(join(state, repo.replace("/", "__"), tag, ".release.json"), "utf8"),
      ) as { args: string[] }
    ).args;
  const calls = () =>
    existsSync(join(state, "calls.jsonl"))
      ? readFileSync(join(state, "calls.jsonl"), "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as string[])
      : [];
  /** Runs the stand-in `gh` directly, the way a person at the repository would. */
  const gh = (...args: string[]) =>
    spawnSync(join(bin, "gh"), args, { env: baseEnv(dir), encoding: "utf8" });
  /** The tag the repository shows as latest, or null when it shows none. */
  const latest = (repo: string) => {
    const shown = gh("api", `repos/${repo}/releases/latest`, "--jq", '"\\(.id) \\(.tag_name)"');
    return shown.status === 0 ? shown.stdout.trim().split(" ")[1] : null;
  };
  return { bin, zip, seed, run, published, publishedBytes, created, calls, gh, latest };
}
