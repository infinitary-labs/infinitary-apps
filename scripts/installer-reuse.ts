import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  createReadStream,
  createWriteStream,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { assertInstallerEnvironment } from "./installer-environment.ts";
import { openModuleRunner, REPO_ROOT } from "./moduleRunner.ts";

const commit = z.string().regex(/^[a-f0-9]{40}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const installerReusePlan = z
  .object({
    runId: z.number().int().positive(),
    artifactId: z.number().int().positive(),
    artifactSha256: digest,
    sourceHead: commit,
    checkHead: commit,
    changedPaths: z
      .array(z.string().min(1))
      .refine((paths) => new Set(paths).size === paths.length),
    // This is the reviewing agent's judgment, not a path-name heuristic in the host.
    sameApplication: z.literal(true),
    applicability: z.string().trim().min(1),
  })
  .strict();
export type InstallerReusePlan = z.infer<typeof installerReusePlan>;

type Versions = Record<
  "alphaBefore" | "alphaAfter" | "promotedStable" | "nextAlpha" | "nextStable",
  string
>;
const versionsSchema = z
  .object({
    alphaBefore: z.string(),
    alphaAfter: z.string(),
    promotedStable: z.string(),
    nextAlpha: z.string(),
    nextStable: z.string(),
  })
  .strict();

export function fixtureNames(versions: Versions): string[] {
  return [
    ...Object.values(versions).map((version) => `Infinitary-${version}-universal.zip`),
    ...[versions.alphaBefore, versions.promotedStable].map(
      (version) => `Infinitary-${version}-mac-universal.dmg`,
    ),
    "invalid-signature.zip",
    "digests.json",
    "versions.json",
  ].sort();
}

export function checkReuseTree(
  plan: InstallerReusePlan,
  root: string,
  env: NodeJS.ProcessEnv,
): void {
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, env, encoding: "utf8" });
  assert.equal(
    git(["rev-parse", "HEAD"]).trim(),
    plan.checkHead,
    "The reuse declaration names another checked version",
  );
  assert.equal(
    git(["status", "--porcelain", "--untracked-files=normal"]),
    "",
    "Reuse requires a clean checked tree",
  );
  const changed = git([
    "diff",
    "--name-only",
    "--no-renames",
    "-z",
    plan.sourceHead,
    plan.checkHead,
  ])
    .split("\0")
    .filter(Boolean)
    .sort();
  assert.deepEqual(
    changed,
    [...plan.changedPaths].sort(),
    "Every source difference must be in the reviewed reuse declaration",
  );
}

export function checkReuseMetadata(
  plan: InstallerReusePlan,
  runValue: unknown,
  artifactValue: unknown,
  jobsValue: unknown,
) {
  const run = z
    .object({
      id: z.number(),
      head_sha: commit,
      status: z.string(),
      run_attempt: z.number().int().positive(),
    })
    .parse(runValue);
  const artifact = z
    .object({
      id: z.number(),
      name: z.string(),
      expired: z.boolean(),
      digest: z.string(),
      size_in_bytes: z.number().int().positive(),
      created_at: z.string().datetime(),
      workflow_run: z.object({ id: z.number(), head_sha: commit }),
    })
    .parse(artifactValue);
  const jobs = z
    .array(
      z.object({
        id: z.number(),
        name: z.string(),
        run_attempt: z.number().int().positive(),
        head_sha: commit,
        status: z.string(),
        conclusion: z.string().nullable(),
        started_at: z.string().datetime(),
        completed_at: z.string().datetime().nullable(),
      }),
    )
    .parse(jobsValue);
  assert.equal(run.id, plan.runId, "The original run does not match");
  assert.equal(run.status, "completed", "The original run has not ended");
  assert.equal(artifact.id, plan.artifactId, "The artifact does not match");
  assert.equal(
    artifact.name,
    "signed-installer-fixtures",
    "This is not the signed fixture artifact",
  );
  assert.equal(
    artifact.expired,
    false,
    "The signed fixture artifact has expired; do not silently rebuild",
  );
  assert.equal(
    artifact.digest,
    `sha256:${plan.artifactSha256}`,
    "The artifact digest differs from the reviewed declaration",
  );
  assert.equal(artifact.workflow_run.id, run.id, "The artifact belongs to another run");
  assert.equal(
    artifact.workflow_run.head_sha,
    run.head_sha,
    "The artifact's workflow version differs",
  );
  const builds = jobs.filter(
    (job) => job.name === "Verify signed installer and updater / Build signed verification copies",
  );
  assert.equal(builds.length, 1, "The original signed build must be identified exactly once");
  const build = builds[0];
  assert(build, "The original signed build is missing");
  assert.equal(
    build.head_sha,
    run.head_sha,
    "The original build belongs to another workflow version",
  );
  assert.equal(build.status, "completed");
  assert.equal(build.conclusion, "success", "The original signed build did not pass");
  assert(build.completed_at, "The signed build has no completion time");
  const created = Date.parse(artifact.created_at);
  assert(
    created >= Date.parse(build.started_at) && created <= Date.parse(build.completed_at),
    "The artifact was not created during the successful signed build",
  );
  return { run, artifact, build };
}

async function fileDigests(path: string) {
  const sha256 = createHash("sha256");
  const sha512 = createHash("sha512");
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    size += chunk.length;
    sha256.update(chunk);
    sha512.update(chunk);
  }
  return { size, sha256: sha256.digest("hex"), sha512: sha512.digest("base64") };
}

export async function verifyFixtureFiles(folder: string, expected: Versions): Promise<void> {
  assert.deepEqual(
    versionsSchema.parse(JSON.parse(readFileSync(join(folder, "versions.json"), "utf8"))),
    expected,
    "The fixture roles or versions changed",
  );
  const files = z
    .record(
      z.string(),
      z.object({ size: z.number().int().positive(), sha256: digest, sha512: z.string() }).strict(),
    )
    .parse(JSON.parse(readFileSync(join(folder, "digests.json"), "utf8")));
  const names = fixtureNames(expected).filter((name) => /\.(zip|dmg)$/.test(name));
  assert.deepEqual(Object.keys(files).sort(), names, "The fixture digest inventory differs");
  for (const name of names)
    assert.deepEqual(
      await fileDigests(join(folder, name)),
      files[name],
      `The fixture bytes changed: ${name}`,
    );
}

// Streaming extraction with the runner's standard ZIP64 reader. The archive is
// authenticated before opening, and only the producer's exact flat inventory is
// accepted. No archive member can overwrite another member or escape the folder.
export const extractInstallerArchive = String.raw`
import json, pathlib, shutil, stat, sys, zipfile
archive, destination, names_json, source = sys.argv[1:]
names = json.loads(names_json)
with zipfile.ZipFile(archive) as outer:
    entries = outer.infolist()
    actual = [entry.filename for entry in entries]
    if len(actual) != len(set(actual)) or sorted(actual) != sorted(names):
        raise ValueError("The signed artifact inventory differs")
    for entry in entries:
        if pathlib.PurePosixPath(entry.filename).name != entry.filename or entry.filename in (".", ".."):
            raise ValueError("The signed artifact contains a non-flat path")
        kind = stat.S_IFMT(entry.external_attr >> 16)
        if kind not in (0, stat.S_IFREG) or entry.flag_bits & 1:
            raise ValueError("The signed artifact contains a non-regular or encrypted entry")
    target = pathlib.Path(destination)
    target.mkdir()
    for entry in entries:
        with outer.open(entry) as incoming, (target / entry.filename).open("xb") as outgoing:
            shutil.copyfileobj(incoming, outgoing)
# The source record remains the original one, including in the deliberately
# damaged signature fixture. No signed archive or embedded record is rewritten.
for name in names:
    if name.endswith(".zip"):
        with zipfile.ZipFile(target / name) as app:
            location = "Infinitary.app/Contents/Resources/self-map.json"
            if len([entry for entry in app.infolist() if entry.filename == location]) != 1:
                raise ValueError("The app has no unique embedded source record")
            if json.loads(app.read(location))["commit"] != source:
                raise ValueError("The signed app's embedded source differs")
`;

type ReuseOptions = {
  plan: InstallerReusePlan;
  root: string;
  folder: string;
  evidence: string;
  repository: string;
  api: string;
  token: string;
  env: NodeJS.ProcessEnv;
  fetcher?: typeof fetch;
};

export async function reuseInstallerFixtures(options: ReuseOptions): Promise<void> {
  const { plan, root, folder, evidence, repository, api, token, env } = options;
  const fetcher = options.fetcher ?? fetch;
  checkReuseTree(plan, root, env);
  mkdirSync(evidence, { recursive: true });
  writeFileSync(join(evidence, "reuse-request.json"), JSON.stringify(plan, null, 2), {
    flag: "wx",
  });
  assert(/^[\w.-]+\/[\w.-]+$/.test(repository), "The repository name is invalid");
  const base = new URL(api);
  assert.equal(base.protocol, "https:");
  async function request(path: string) {
    // Never print the token, a signed download address, or the response body.
    try {
      return await fetcher(new URL(path, base), {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
        redirect: "manual",
      });
    } catch {
      throw new Error("The original artifact could not be read from GitHub");
    }
  }
  async function json(path: string) {
    const response = await request(path);
    assert.equal(response.status, 200, "GitHub did not return the original verification record");
    return response.json();
  }
  const prefix = `/repos/${repository}/actions`;
  const run = await json(`${prefix}/runs/${plan.runId}`);
  const jobs: unknown[] = [];
  // GitHub's documented per_page maximum, not a cap on the jobs we inspect.
  for (let page = 1; ; page++) {
    const result = z
      .object({ jobs: z.array(z.unknown()), total_count: z.number() })
      .parse(
        await json(`${prefix}/runs/${plan.runId}/jobs?filter=latest&per_page=100&page=${page}`),
      );
    jobs.push(...result.jobs);
    if (jobs.length >= result.total_count) break;
    assert(result.jobs.length > 0, "GitHub omitted jobs from the original run");
  }
  const metadata = checkReuseMetadata(
    plan,
    run,
    await json(`${prefix}/artifacts/${plan.artifactId}`),
    jobs,
  );
  const expected = versionsSchema.parse(
    JSON.parse(readFileSync(join(root, "tests/fixtures/installed-updates/versions.json"), "utf8")),
  );
  const archive = `${folder}.zip`;
  let failed = false;
  let ownsArchive = false;
  try {
    let response = await request(`${prefix}/artifacts/${plan.artifactId}/zip`);
    if (response.status === 302) {
      let location: URL;
      try {
        location = new URL(response.headers.get("location") ?? "");
      } catch {
        throw new Error("GitHub returned an invalid artifact download address");
      }
      assert.equal(location.protocol, "https:", "The artifact download must use HTTPS");
      try {
        response = await fetcher(location, { redirect: "error" });
      } catch {
        throw new Error("The signed artifact download failed; no build was started");
      }
    }
    assert.equal(
      response.status,
      200,
      "The signed artifact could not be downloaded; no build was started",
    );
    assert(response.body, "The signed artifact download has no body");
    const hash = createHash("sha256");
    let size = 0;
    const fd = openSync(archive, "wx", 0o600);
    ownsArchive = true;
    await pipeline(
      Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
      new Transform({
        transform(chunk, _encoding, callback) {
          size += chunk.length;
          if (size > metadata.artifact.size_in_bytes) {
            callback(new Error("The download exceeds the recorded artifact size"));
            return;
          }
          hash.update(chunk);
          callback(null, chunk);
        },
      }),
      createWriteStream(archive, { fd }),
    );
    assert.equal(size, metadata.artifact.size_in_bytes, "The artifact download size differs");
    assert.equal(hash.digest("hex"), plan.artifactSha256, "The downloaded archive digest differs");
    execFileSync(
      "/usr/bin/python3",
      [
        "-c",
        extractInstallerArchive,
        archive,
        folder,
        JSON.stringify(fixtureNames(expected)),
        plan.sourceHead,
      ],
      { env, stdio: "pipe" },
    );
    await verifyFixtureFiles(folder, expected);
    mkdirSync(evidence, { recursive: true });
    writeFileSync(
      join(evidence, "reuse-provenance.json"),
      JSON.stringify(
        {
          ...plan,
          repository,
          workflowHead: metadata.run.head_sha,
          originalAttempt: metadata.build.run_attempt,
          readRunAttempt: metadata.run.run_attempt,
          buildJobId: metadata.build.id,
          artifactBytes: size,
          embeddedSourceChecked: true,
          archiveDigestChecked: true,
          fixtureDigestsChecked: true,
          note: "Original signed copies and embedded source retained; only the verification uses checkHead. No signing or Apple submission occurred.",
        },
        null,
        2,
      ),
      { flag: "wx" },
    );
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try {
      if (ownsArchive) rmSync(archive, { force: true });
    } catch (error) {
      if (!failed) throw error;
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assertInstallerEnvironment();
  const plan = installerReusePlan.parse(JSON.parse(process.env.INSTALLER_REUSE ?? ""));
  const {
    INSTALLER_FIXTURES: folder,
    INSTALLER_EVIDENCE: evidence,
    GITHUB_REPOSITORY: repository,
    GITHUB_API_URL: api,
    GITHUB_TOKEN: token,
    GITHUB_OUTPUT: output,
  } = process.env;
  assert(
    folder && evidence && repository && api && token && output,
    "The reuse job's paths and read access are required",
  );
  const runner = await openModuleRunner();
  try {
    const { hostEnv } = await runner.import<typeof import("../src/core/hostEnv")>(
      join(REPO_ROOT, "src/core/hostEnv.ts"),
    );
    await reuseInstallerFixtures({
      plan,
      root: REPO_ROOT,
      folder,
      evidence,
      repository,
      api,
      token,
      env: hostEnv(),
    });
    appendFileSync(output, `source=${plan.sourceHead}\n`);
    console.log(
      "Verified and reused the original signed copies; no signing or Apple submission occurred.",
    );
  } finally {
    await runner.close();
  }
}
