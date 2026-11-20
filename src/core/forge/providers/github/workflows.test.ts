import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, symlinkSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { crc32, inflateRawSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestDeadlinesOnLoadClock, unitLoadClock } from "../../../../../tests/helpers/budgets";
import { expectBytesEqual } from "../../../../../tests/helpers/expectBytes";
import { scratchDir } from "../../../../../tests/helpers/scratchDirs";
import { PlacedTasks } from "../../../helper/placedTasks";
import { GithubGatewayService } from "../../../orchestrator/githubGateway";
import { WorkflowEvidenceService } from "../../../orchestrator/workflowEvidence";
import {
  DOWNLOAD_ARTIFACT_TOOL,
  GITHUB_READ_TOOL,
  READ_WORKFLOW_TOOL,
} from "../../../pi/forgeTools";
import { sendSourceFile } from "../../../placed/sourceFiles";
import type { WorkDevices } from "../../../placed/workDevices";
import { bindTool } from "../../../session/tools";
import { openInMemoryDatabase } from "../../../storage/db";
import { seedTask } from "../../../tasks/seedTask";
import { TaskService } from "../../../tasks/taskService";
import { RepoRegistry } from "../../../workspace/repoRegistry";
import { seedProject } from "../../../workspace/seedProject";
import { ZIP_FILE_CHUNK_BYTES } from "../../zipFile";
import { GitHubForge } from "./githubForge";

const HEAD = "a".repeat(40);
const RUN = {
  id: 10,
  name: "Test-speed experiment",
  head_sha: HEAD,
  head_branch: "fm/task-1",
  run_attempt: 2,
  status: "completed",
  conclusion: "failure",
  html_url: "https://github.com/octo/meter/actions/runs/10",
};
const JOB = {
  id: 20,
  run_id: 10,
  head_sha: HEAD,
  run_attempt: 2,
  name: "test-speed-experiment",
  status: "completed",
  conclusion: "failure",
  steps: [{ number: 3, name: "Measure pairs", status: "completed", conclusion: "failure" }],
};
const ZIP = readFileSync("tests/fixtures/forge/measurement.zip");
const ARTIFACT = {
  id: 30,
  name: "test-speed-measurements",
  size_in_bytes: ZIP.length,
  expired: false,
  expires_at: "2026-10-14T00:00:00Z",
  workflow_run: { id: 10 },
};
/**
 * Nine entries copied byte for byte from a real phone-logs artifact, which
 * actions/upload-artifact@v4 packed: deflated, each followed by a data
 * descriptor, two of them in folders.
 */
const SAMPLE = readFileSync("tests/fixtures/forge/phone-logs-sample.zip");
/** Four of those files packed again by Info-ZIP with its 64-bit records, as an archive past 65,535 files or 4 GiB has. */
const SAMPLE_ZIP64 = readFileSync("tests/fixtures/forge/phone-logs-zip64.zip");
const PREFIX = "/repos/octo/meter";
const cleanup: (() => Promise<void> | void)[] = [];
// The forge's request deadlines count the time this worker runs, as the
// test's own limit does: a runner that stalls the worker past one does not
// end a stand-in server's request (docs/test-cohorts.md, "Budgets").
beforeEach(() => requestDeadlinesOnLoadClock(unitLoadClock()));
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

async function fixture(
  options: {
    token?: string | null;
    status?: number;
    artifact?: Partial<typeof ARTIFACT>;
    /** The archive storage keeps, served in parts as Azure Blob storage serves a Range. */
    archive?: Buffer;
    route?: (req: IncomingMessage, res: ServerResponse) => boolean;
  } = {},
) {
  const seen: { path: string; auth?: string; range?: string }[] = [];
  const archive = options.archive ?? ZIP;
  const served = { bytes: 0 };
  let base = "";
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", base);
    seen.push({ path: req.url ?? "", auth: req.headers.authorization, range: req.headers.range });
    if (options.route?.(req, res)) return;
    const json = (value: unknown, status = 200) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (url.pathname.startsWith(PREFIX) && options.status) {
      json({ message: "Evidence unavailable" }, options.status);
      return;
    }
    if (url.pathname === `${PREFIX}/actions/runs`) {
      json({ total_count: 101, workflow_runs: [RUN] });
      return;
    }
    if (url.pathname === `${PREFIX}/actions/runs/10`) {
      json(RUN);
      return;
    }
    if (url.pathname === `${PREFIX}/actions/runs/10/attempts/2/jobs`) {
      json({ total_count: 1, jobs: [JOB] });
      return;
    }
    if (url.pathname === `${PREFIX}/actions/runs/10/artifacts`) {
      json({ total_count: 1, artifacts: [ARTIFACT] });
      return;
    }
    if (url.pathname === `${PREFIX}/actions/jobs/20`) {
      json(JOB);
      return;
    }
    if (url.pathname === `${PREFIX}/actions/artifacts/30`) {
      json({ ...ARTIFACT, size_in_bytes: archive.length, ...options.artifact });
      return;
    }
    if (
      url.pathname.startsWith(PREFIX) &&
      (url.pathname.endsWith("/logs") || url.pathname.endsWith("/zip"))
    ) {
      res.writeHead(302, {
        location: `${base}/storage/${url.pathname.endsWith("/logs") ? "log" : "zip"}?signed=test-only`,
      });
      res.end();
      return;
    }
    if (url.pathname === "/storage/log") {
      res.end("prepare\nMeasure pairs: exit 1\nMissing measurement input\n");
      return;
    }
    if (url.pathname === "/storage/zip") {
      const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? "");
      if (!range) {
        served.bytes += archive.length;
        res.end(archive);
        return;
      }
      const start = Number(range[1]);
      const end = Math.min(Number(range[2]), archive.length - 1);
      served.bytes += end - start + 1;
      res.writeHead(206, { "content-range": `bytes ${start}-${end}/${archive.length}` });
      res.end(archive.subarray(start, end + 1));
      return;
    }
    json({ message: `Unexpected request ${req.url}` }, 404);
  });
  // The stand-in keeps an idle connection open until the test closes it. Its
  // own idle close counts the wall clock, so a runner that stalls this worker
  // past it would close a connection the forge has just sent its next request
  // on, and that request would fail with a reset (docs/test-cohorts.md, "Budgets").
  server.keepAliveTimeout = 0;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanup.push(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const rejected = vi.fn();
  const forge = new GitHubForge(
    { kind: "github", host: "github.com", owner: "octo", name: "meter", dir: "/unused" },
    {
      apiBaseUrl: base,
      token: async () =>
        options.token === null ? undefined : (options.token ?? "gho_fixture_owned_by_app"),
      onSignInRejected: rejected,
    },
  );
  const cwd = scratchDir("fm-workflow-evidence-");
  const db = openInMemoryDatabase();
  cleanup.push(() => {
    db.close();
  });
  seedProject(db, {
    id: "repo-1",
    name: "meter",
    path: cwd,
    setupKind: "adopt",
    origin: "https://github.com/octo/meter.git",
    addedAt: 1,
  });
  const tasks = new TaskService({ db, strict: true });
  seedTask(tasks, {
    id: "task-1",
    title: "Measure",
    status: "idle",
    repoId: "repo-1",
    worktreeDir: cwd,
  });
  const repos = new RepoRegistry(db, join(cwd, "fleet"));
  const evidence = scratchDir("fm-workflow-files-");
  const service = new WorkflowEvidenceService({
    tasks,
    repos,
    forgeFor: () => forge,
    evidenceDir: () => join(evidence, "evidence"),
    tempDir: () => join(evidence, "temp"),
  });
  // The listing half of the evidence: runs, jobs and artifacts are github_read's.
  const gateway = new GithubGatewayService({
    tasks,
    repos,
    forgeFor: () => forge,
    readChecks: async () => "unused",
    now: () => 1,
  });
  const list = bindTool(GITHUB_READ_TOOL, {
    onGithubRead: (input) => gateway.read("task-1", input),
  });
  const read = bindTool(READ_WORKFLOW_TOOL, {
    onReadWorkflow: (input) => service.read("task-1", input),
  });
  const download = bindTool(DOWNLOAD_ARTIFACT_TOOL, {
    onDownloadArtifact: (input) => service.download("task-1", input),
  });
  return { forge, list, read, download, service, tasks, cwd, evidence, seen, served, rejected };
}

describe("workflow evidence through crewmate tools and the app's sign-in", () => {
  it("lists a version's runs, failed steps and artifacts with github_read, pages the job log, then persists the unchanged measurement ZIP with provenance", async () => {
    const { list, read, download, cwd, seen, tasks } = await fixture();
    const before = tasks.get("task-1")?.delivery;
    const runs = JSON.parse(
      (await list.run({ path: `${PREFIX}/actions/runs?head_sha=${HEAD}` })).text,
    );
    expect(runs.body.workflow_runs[0]).toMatchObject({ id: 10, head_sha: HEAD, run_attempt: 2 });
    const jobs = JSON.parse(
      (await list.run({ path: `${PREFIX}/actions/runs/10/attempts/2/jobs` })).text,
    );
    expect(jobs.body.jobs[0]).toMatchObject({ id: 20, run_attempt: 2 });
    expect(jobs.body.jobs[0].steps[0]).toMatchObject({
      name: "Measure pairs",
      conclusion: "failure",
    });
    const artifacts = JSON.parse(
      (await list.run({ path: `${PREFIX}/actions/runs/10/artifacts` })).text,
    );
    expect(artifacts.body.artifacts[0]).toMatchObject({ id: 30, expired: false });
    const log = JSON.parse((await read.run({ runId: 10, jobId: 20, offset: 2, limit: 1 })).text);
    expect(log.lines).toEqual(["Measure pairs: exit 1"]);
    expect(log.nextOffset).toBe(3);
    const next = JSON.parse(
      (await read.run({ runId: 10, jobId: 20, offset: log.nextOffset })).text,
    );
    expect(next.lines[0]).toBe("Missing measurement input");
    expect(next.nextOffset).toBeNull();
    const receipt = JSON.parse((await download.run({ runId: 10, artifactId: 30 })).text);
    expect(receipt.run.headSha).toBe(HEAD);
    expect(receipt.bytes).toBe(ZIP.length);
    expect(receipt.sha256).toBe(createHash("sha256").update(ZIP).digest("hex"));
    expect(readFileSync(join(cwd, receipt.path))).toEqual(ZIP);
    expect(statSync(join(cwd, receipt.path)).mode & 0o777).toBe(0o600);
    expect(receipt.extracted).toBe(false);
    expect(
      seen
        .filter((entry) => entry.path.startsWith(PREFIX))
        .every((entry) => entry.auth === "Bearer gho_fixture_owned_by_app"),
    ).toBe(true);
    expect(
      seen
        .filter((entry) => entry.path.startsWith("/storage/"))
        .every((entry) => entry.auth === undefined),
    ).toBe(true);
    expect(JSON.stringify(receipt)).not.toMatch(/gho_|signed=/);
    expect(tasks.get("task-1")?.delivery).toEqual(before);
  });

  it.each([401, 403, 404, 410, 503])(
    "returns an actionable refusal for HTTP %s without pretending evidence was read",
    async (status) => {
      const { read, rejected } = await fixture({ status });
      const result = (await read.run({ runId: 10, jobId: 20 })).text;
      expect(result).toContain("Cannot read workflow evidence");
      expect(result).toContain(String(status));
      expect(rejected).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
    },
  );

  it("does not make a request without the app's sign-in", async () => {
    const { read, seen } = await fixture({ token: null });
    expect((await read.run({ runId: 10, jobId: 20 })).text).toContain("Not signed in to GitHub");
    expect(seen).toEqual([]);
  });

  it("refuses expired, oversized and wrong-run artifacts before downloading", async () => {
    for (const artifact of [
      { expired: true },
      { size_in_bytes: 64 * 1024 * 1024 + 1 },
      { workflow_run: { id: 11 } },
    ]) {
      const { download, seen } = await fixture({ artifact });
      expect((await download.run({ runId: 10, artifactId: 30 })).text).toContain(
        "Cannot read workflow evidence",
      );
      expect(seen.some((entry) => entry.path.endsWith("/zip"))).toBe(false);
    }
  });

  it("does not read a different run's job or overwrite an artifact, including a linked folder", async () => {
    const { read, download, cwd, seen } = await fixture();
    expect((await read.run({ runId: 11, jobId: 20 })).text).toContain(
      "Cannot read workflow evidence",
    );
    // Direct provider call also checks membership before reaching the logs endpoint.
    const { forge } = await fixture();
    await expect(forge.workflows.jobLog(11, 20)).rejects.toThrow("different workflow run");
    expect(seen.some((entry) => entry.path.endsWith("/logs"))).toBe(false);
    await download.run({ runId: 10, artifactId: 30 });
    expect((await download.run({ runId: 10, artifactId: 30 })).text).toContain("not overwritten");
    const other = await fixture();
    const outside = scratchDir("fm-workflow-outside-");
    symlinkSync(outside, join(other.cwd, ".infinitary-artifacts"));
    expect((await other.download.run({ runId: 10, artifactId: 30 })).text).toContain("not a link");
    expect(readFileSync(join(cwd, ".infinitary-artifacts/run-10/artifact-30.zip"))).toEqual(ZIP);
  });

  it("refuses invalid ids and unsupported hosts before asking a provider", async () => {
    const { read, seen, service, tasks } = await fixture();
    expect((await read.run({ runId: -1, jobId: 20 })).text).toContain("runId must be an integer");
    expect((await read.run({ runId: 10, jobId: 0 })).text).toContain("jobId must be an integer");
    expect((await read.run({ runId: 10, jobId: 20, limit: 501 })).text).toContain(
      "limit must be an integer",
    );
    expect(seen).toEqual([]);
    expect(await service.read("gone", { runId: 10, jobId: 20 })).toContain("no longer available");
    const plain = new WorkflowEvidenceService({
      tasks,
      repos: { get: () => ({ path: "/unused" }) } as never,
      forgeFor: () => ({ workflows: undefined }) as never,
    });
    expect(await plain.read("task-1", { runId: 10, jobId: 20 })).toContain(
      "no workflow log or artifact reader",
    );
  });

  it("bounds actual streamed bytes and marks long log lines as clipped", async () => {
    const oversized = await fixture({
      route: (req, res) => {
        if (req.url?.startsWith("/storage/zip")) {
          res.writeHead(200, { "content-length": String(64 * 1024 * 1024 + 1) });
          res.end();
          return true;
        }
        return false;
      },
    });
    expect((await oversized.download.run({ runId: 10, artifactId: 30 })).text).toContain("64 MiB");
    const streamed = await fixture({
      route: (req, res) => {
        if (req.url?.startsWith("/storage/log")) {
          res.writeHead(200);
          res.write("x".repeat(8 * 1024 * 1024 + 1));
          res.end();
          return true;
        }
        return false;
      },
    });
    expect((await streamed.read.run({ runId: 10, jobId: 20 })).text).toContain("8 MiB");
    const long = await fixture({
      route: (req, res) => {
        if (req.url?.startsWith("/storage/log")) {
          res.end("x".repeat(3000));
          return true;
        }
        return false;
      },
    });
    const log = JSON.parse((await long.read.run({ runId: 10, jobId: 20 })).text);
    expect(log.longLinesClipped).toBe(true);
    expect(log.lines[0]).toHaveLength(2000);
  });

  it("follows GitHub's HTTPS storage without forwarding sign-in headers and keeps expired signed URLs private", async () => {
    let status = 200;
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/jobs/20")) return Response.json(JOB);
      if (url.endsWith("/jobs/20/logs"))
        return new Response(null, {
          status: 302,
          headers: {
            location: "https://results-receiver.actions.githubusercontent.com/job?sig=private",
          },
        });
      expect(url).toBe("https://results-receiver.actions.githubusercontent.com/job?sig=private");
      expect(init?.headers).toEqual({});
      return new Response("job output", { status });
    });
    const forge = new GitHubForge(
      { kind: "github", host: "github.com", owner: "octo", name: "meter", dir: "/unused" },
      { token: async () => "gho_fixture_owned_by_app", fetch: fetcher },
    );
    expect((await forge.workflows.jobLog(10, 20)).text).toBe("job output");
    expect(fetcher.mock.calls[1]?.[1]?.headers).toMatchObject({
      Authorization: "Bearer gho_fixture_owned_by_app",
    });
    status = 403;
    await expect(forge.workflows.jobLog(10, 20)).rejects.toThrow("request a fresh download");
  });

  it("never follows an untrusted redirect or returns its signed address", async () => {
    const { read, seen } = await fixture({
      route: (req, res) => {
        if (req.url?.endsWith("/logs")) {
          res.writeHead(302, { location: "https://attacker.invalid/leak?signed=secret" });
          res.end();
          return true;
        }
        return false;
      },
    });
    const result = (await read.run({ runId: 10, jobId: 20 })).text;
    expect(result).toContain("unsafe download address");
    expect(result).not.toMatch(/attacker|secret|gho_/);
    expect(seen.some((entry) => entry.path.includes("/leak"))).toBe(false);
  });
});

/**
 * The phone-logs sample with a 65 MiB screen recording stored after its
 * files: an archive past the download limit, as phone-results is
 * (INF-1932: its artifacts were 94 MB, 122 MB and 345 MB).
 */
function withRecording(sample: Buffer): Buffer {
  const at = sample.length - 22;
  const count = sample.readUInt16LE(at + 10);
  const directorySize = sample.readUInt32LE(at + 12);
  const directoryStart = sample.readUInt32LE(at + 16);
  const name = Buffer.from("ipad/join/recording.mov");
  const data = Buffer.alloc(65 * 1024 * 1024, 0x2a);
  const sum = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(sum, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(0x0314, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(sum, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(directoryStart, 42);
  const directory = Buffer.concat([
    sample.subarray(directoryStart, directoryStart + directorySize),
    central,
    name,
  ]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(count + 1, 8);
  end.writeUInt16LE(count + 1, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(directoryStart + local.length + name.length + data.length, 16);
  return Buffer.concat([sample.subarray(0, directoryStart), local, name, data, directory, end]);
}

/** Every file of a ZIP archive unpacked by its central directory, each checked against its CRC. */
function unzipped(zip: Buffer): Map<string, Buffer> {
  const at = zip.length - 22;
  expect(zip.readUInt32LE(at)).toBe(0x06054b50);
  const files = new Map<string, Buffer>();
  let p = zip.readUInt32LE(at + 16);
  for (let i = 0; i < zip.readUInt16LE(at + 10); i++) {
    expect(zip.readUInt32LE(p)).toBe(0x02014b50);
    const method = zip.readUInt16LE(p + 10);
    const sum = zip.readUInt32LE(p + 16);
    const packed = zip.readUInt32LE(p + 20);
    const nameLength = zip.readUInt16LE(p + 28);
    const name = zip.subarray(p + 46, p + 46 + nameLength).toString();
    const local = zip.readUInt32LE(p + 42);
    expect(zip.readUInt32LE(local)).toBe(0x04034b50);
    const from = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const raw = zip.subarray(from, from + packed);
    const bytes = method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
    expect(crc32(bytes), name).toBe(sum);
    files.set(name, bytes);
    p += 46 + nameLength + zip.readUInt16LE(p + 30) + zip.readUInt16LE(p + 32);
  }
  return files;
}

describe("an artifact read in parts through the crewmate tool (INF-1932)", () => {
  it("lists an archive past the download limit and saves only the named folder and file, reading only their parts", async () => {
    const archive = withRecording(SAMPLE);
    const { download, cwd, seen, served } = await fixture({ archive });
    // The whole archive is refused, and the refusal names the way on.
    const whole = (await download.run({ runId: 10, artifactId: 30 })).text;
    expect(whole).toContain("64 MiB download limit; list its files with list true");
    expect(served.bytes).toBe(0);

    const listing = (await download.run({ runId: 10, artifactId: 30, list: true })).text;
    const lines = listing.split("\n");
    expect(lines[0]).toBe(
      `test-speed-measurements (artifact 30) from Test-speed experiment run 10, version ${HEAD}`,
    );
    expect(lines[1]).toMatch(new RegExp(`^archive: ${archive.length} bytes; files: 10, `));
    expect(lines[3]).toBe("files 1-10 of 10");
    const paths = lines.slice(4).map((line) => line.split(" ")[2]);
    expect(paths).toEqual([
      "11-xcrun.log",
      "12-xcrun.log",
      "2-node.log",
      "35-xcrun.log",
      "7-xcodebuild.log",
      "ipad/join/recording.mov",
      "ipad/photos-stream.log",
      "ipad/rest/1-plutil.log",
      "ipad/rest/2-plutil.log",
      "iphone/rest/1-plutil.log",
    ]);
    const recording = lines.find((line) => line.endsWith(" ipad/join/recording.mov"));
    expect(Number(recording?.split(" ")[0])).toBeGreaterThan(64 * 1024 * 1024);
    expect(Number(recording?.split(" ")[1])).toBe(65 * 1024 * 1024);
    // Listing read the archive's last 64 KiB, which hold its central directory: never the recording.
    expect(served.bytes).toBeLessThan(1024 * 1024);

    const narrowed = (
      await download.run({ runId: 10, artifactId: 30, list: true, files: ["ipad/rest"], offset: 2 })
    ).text.split("\n");
    expect(narrowed[1]).toContain("files under the named paths: 2");
    expect(narrowed.slice(3)).toEqual([
      "files 2-2 of 2",
      expect.stringMatching(/^\d+ 0 ipad\/rest\/2-plutil\.log$/),
    ]);

    const before = served.bytes;
    const receipt = JSON.parse(
      (
        await download.run({
          runId: 10,
          artifactId: 30,
          files: ["ipad/rest/", "12-xcrun.log", "missing.log"],
        })
      ).text,
    );
    expect(receipt.path).toMatch(/^\.infinitary-artifacts\/run-10\/artifact-30-[0-9a-f]{12}\.zip$/);
    expect(receipt.path).toContain(`artifact-30-${receipt.sha256.slice(0, 12)}.zip`);
    expect(receipt.selected).toEqual({
      files: 3,
      size: 5779 + 0 + 37,
      paths: [
        { path: "ipad/rest/", files: 2 },
        { path: "12-xcrun.log", files: 1 },
        { path: "missing.log", files: 0 },
      ],
    });
    const saved = readFileSync(join(cwd, receipt.path));
    expect(saved.length).toBe(receipt.bytes);
    expect(createHash("sha256").update(saved).digest("hex")).toBe(receipt.sha256);
    expect(statSync(join(cwd, receipt.path)).mode & 0o777).toBe(0o600);
    const original = unzipped(SAMPLE);
    const files = unzipped(saved);
    expect([...files.keys()]).toEqual([
      "12-xcrun.log",
      "ipad/rest/1-plutil.log",
      "ipad/rest/2-plutil.log",
    ]);
    for (const [name, bytes] of files)
      expect(bytes.equals(original.get(name) as Buffer)).toBe(true);
    // Only the archive's end and the chosen records were read: never the recording.
    expect(served.bytes - before).toBeLessThan(1024 * 1024);
    const storage = seen.filter((entry) => entry.path.startsWith("/storage/zip"));
    expect(storage.every((entry) => entry.range && entry.auth === undefined)).toBe(true);
    expect(
      seen
        .filter((entry) => entry.path.startsWith(PREFIX))
        .every((entry) => entry.auth === "Bearer gho_fixture_owned_by_app"),
    ).toBe(true);
    expect(JSON.stringify(receipt)).not.toMatch(/gho_|signed=/);

    // The same selection again is the same file, never written over.
    expect(
      (
        await download.run({
          runId: 10,
          artifactId: 30,
          files: ["ipad/rest/", "12-xcrun.log", "missing.log"],
        })
      ).text,
    ).toContain("not overwritten");
  });

  it("refuses a selection past 64 MiB, or one that names nothing in the archive, before reading any file", async () => {
    const { download, served, cwd } = await fixture({ archive: withRecording(SAMPLE) });
    const big = (
      await download.run({ runId: 10, artifactId: 30, files: ["ipad/join/", "12-xcrun.log"] })
    ).text;
    expect(big).toContain("over the 64 MiB limit; select fewer");
    const none = (await download.run({ runId: 10, artifactId: 30, files: ["phone/ipad/"] })).text;
    expect(none).toContain("None of the named files is in the artifact; list it with list true");
    expect(served.bytes).toBeLessThan(1024 * 1024);
    expect(statSync(cwd).isDirectory()).toBe(true);
    expect(() => statSync(join(cwd, ".infinitary-artifacts"))).toThrow();
  });

  it("saves a selection on the computer a task runs on only when that computer writes one", async () => {
    for (const writes of [false, true]) {
      const { forge, tasks, served } = await fixture({ archive: SAMPLE });
      seedTask(tasks, {
        id: "task-there",
        title: "Measure",
        status: "idle",
        repoId: "repo-1",
        deviceId: "mini",
      });
      const sent: { part?: string; bytes: Uint8Array }[] = [];
      const service = new WorkflowEvidenceService({
        tasks,
        repos: { get: () => ({ id: "repo-1", path: "/unused", name: "meter" }) } as never,
        forgeFor: () => forge,
        writeElsewhere: async (_task, _device, artifact) => {
          sent.push(artifact);
          return `.infinitary-artifacts/run-10/artifact-30-${artifact.part}.zip`;
        },
        partsElsewhere: () => writes,
      });
      const answer = await service.download("task-there", {
        runId: 10,
        artifactId: 30,
        files: ["12-xcrun.log"],
      });
      if (!writes) {
        expect(answer).toContain(
          "needs an update before it can save selected files. Nothing was downloaded.",
        );
        expect(served.bytes).toBe(0);
        expect(sent).toEqual([]);
        continue;
      }
      expect(sent).toHaveLength(1);
      expect(sent[0]?.part).toBe(
        createHash("sha256")
          .update(sent[0]?.bytes ?? "")
          .digest("hex")
          .slice(0, 12),
      );
      expect([...unzipped(Buffer.from(sent[0]?.bytes ?? [])).keys()]).toEqual(["12-xcrun.log"]);
      expect(JSON.parse(answer).path).toBe(
        `.infinitary-artifacts/run-10/artifact-30-${sent[0]?.part}.zip`,
      );
    }
  });

  it("reads an archive with 64-bit records", async () => {
    const { download, cwd } = await fixture({ archive: SAMPLE_ZIP64 });
    const listing = (await download.run({ runId: 10, artifactId: 30, list: true })).text;
    expect(
      listing
        .split("\n")
        .slice(4)
        .map((line) => line.split(" ").slice(1).join(" ")),
    ).toEqual([
      "37 12-xcrun.log",
      "33 7-xcodebuild.log",
      "5779 ipad/rest/1-plutil.log",
      "0 ipad/rest/2-plutil.log",
    ]);
    const receipt = JSON.parse(
      (await download.run({ runId: 10, artifactId: 30, files: ["ipad/rest"] })).text,
    );
    const files = unzipped(readFileSync(join(cwd, receipt.path)));
    const original = unzipped(SAMPLE);
    expect([...files.keys()]).toEqual(["ipad/rest/1-plutil.log", "ipad/rest/2-plutil.log"]);
    for (const [name, bytes] of files)
      expect(bytes.equals(original.get(name) as Buffer)).toBe(true);
  });

  it("refuses storage that sends the whole archive for a part, without reading it", async () => {
    const { download, cwd } = await fixture({
      archive: SAMPLE,
      route: (req, res) => {
        if (req.url?.startsWith("/storage/zip")) {
          res.writeHead(200, { "content-length": String(SAMPLE.length) });
          res.end(SAMPLE);
          return true;
        }
        return false;
      },
    });
    const listing = (await download.run({ runId: 10, artifactId: 30, list: true })).text;
    expect(listing).toContain("did not send the part of the archive asked for");
    const saved = (await download.run({ runId: 10, artifactId: 30, files: ["12-xcrun.log"] })).text;
    expect(saved).toContain("cannot be read in parts");
    expect(() => statSync(join(cwd, ".infinitary-artifacts"))).toThrow();
  });
});

// INF-2330: a single recording beyond the buffered ZIP bound must reach task evidence.
describe("one workflow file streamed into task evidence", () => {
  it("retrieves a member beyond 64 MiB with bounded ranges and no credentials in storage or its receipt", async () => {
    const { download, evidence, cwd, seen } = await fixture({ archive: withRecording(SAMPLE) });
    const receipt = JSON.parse(
      (await download.run({ runId: 10, artifactId: 30, file: "ipad/join/recording.mov" })).text,
    );
    const saved = readFileSync(receipt.path);
    expect(receipt).toMatchObject({
      extracted: true,
      member: "ipad/join/recording.mov",
      bytes: 65 * 1024 * 1024,
    });
    expect(receipt.path.startsWith(join(evidence, "evidence"))).toBe(true);
    expectBytesEqual(saved, Buffer.alloc(receipt.bytes, 0x2a));
    expect(receipt.sha256).toBe(createHash("sha256").update(saved).digest("hex"));
    expect(statSync(receipt.path).mode & 0o777).toBe(0o600);
    expect(readdirSync(cwd)).toEqual([]);
    expect(readdirSync(join(evidence, "evidence"))).toHaveLength(1);
    for (const request of seen.filter((request) => request.path.startsWith("/storage/"))) {
      expect(request.auth).toBeUndefined();
      const range = /^bytes=(\d+)-(\d+)$/.exec(request.range ?? "");
      expect(range).not.toBeNull();
      expect(Number(range?.[2]) - Number(range?.[1]) + 1).toBeLessThanOrEqual(ZIP_FILE_CHUNK_BYTES);
    }
    expect(JSON.stringify(receipt)).not.toMatch(/gho_|signed=/);
    expect(
      (await download.run({ runId: 10, artifactId: 30, file: receipt.member })).text,
    ).toContain("not overwritten");
  });

  it.each([SAMPLE, SAMPLE_ZIP64])(
    "unpacks a real deflated phone log, including ZIP64 metadata",
    async (archive) => {
      const { download } = await fixture({ archive });
      const receipt = JSON.parse(
        (await download.run({ runId: 10, artifactId: 30, file: "ipad/rest/1-plutil.log" })).text,
      );
      expectBytesEqual(readFileSync(receipt.path), unzipped(SAMPLE).get(receipt.member) as Buffer);
    },
  );

  it("refuses an older work computer before requesting the artifact", async () => {
    const { forge, tasks, seen, evidence } = await fixture({ archive: SAMPLE });
    seedTask(tasks, {
      id: "task-there",
      title: "Inspect",
      status: "idle",
      repoId: "repo-1",
      deviceId: "mini",
    });
    const service = new WorkflowEvidenceService({
      tasks,
      repos: { get: () => ({ id: "repo-1", path: "/unused", name: "meter" }) } as never,
      forgeFor: () => forge,
      evidenceDir: () => evidence,
      tempDir: () => evidence,
      filesElsewhere: () => false,
    });
    expect(
      await service.download("task-there", {
        runId: 10,
        artifactId: 30,
        file: "ipad/rest/1-plutil.log",
      }),
    ).toContain("need an update");
    expect(seen).toEqual([]);
  });

  it("refuses an ambiguous selection, a missing file and a folder without writing evidence", async () => {
    const { download, evidence } = await fixture({ archive: SAMPLE });
    for (const input of [
      { file: "ipad/rest/1-plutil.log", files: ["ipad/rest"] },
      { file: "ipad/rest/" },
      { file: "missing.mp4" },
    ])
      expect((await download.run({ runId: 10, artifactId: 30, ...input })).text).toContain(
        "Cannot read workflow evidence",
      );
    expect(readdirSync(evidence)).toEqual([]);
  });

  it("deletes incomplete output after corrupted content or an interrupted range", async () => {
    for (const interrupt of [false, true]) {
      const archive = withRecording(SAMPLE);
      // Corrupt the member's stored data, without changing its declared checksum.
      if (!interrupt) {
        const byte =
          archive.indexOf(Buffer.from("ipad/join/recording.mov")) +
          "ipad/join/recording.mov".length +
          100;
        archive[byte] = (archive[byte] ?? 0) ^ 1;
      }
      const { download, evidence } = await fixture({
        archive,
        route: (req, res) => {
          const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? "");
          if (
            interrupt &&
            req.url?.startsWith("/storage/") &&
            range &&
            Number(range[1]) >= ZIP_FILE_CHUNK_BYTES &&
            Number(range[2]) - Number(range[1]) + 1 === ZIP_FILE_CHUNK_BYTES
          ) {
            res.writeHead(503);
            res.end();
            return true;
          }
          return false;
        },
      });
      const result = (
        await download.run({ runId: 10, artifactId: 30, file: "ipad/join/recording.mov" })
      ).text;
      expect(result).toContain("Cannot read workflow evidence");
      expect(result).not.toMatch(/gho_|signed=/);
      expect(readdirSync(join(evidence, "evidence"))).toEqual([]);
    }
  });

  it("sends the verified file through the existing piece transport to remote task evidence, then removes home staging", async () => {
    const { forge, tasks, evidence } = await fixture({ archive: SAMPLE });
    const remote = new PlacedTasks(scratchDir("fm-evidence-receiver-"));
    const devices = {
      ask: async (
        _machine: string,
        _channel: string,
        [input]: Parameters<PlacedTasks["sourceFile"]>,
      ) => remote.sourceFile(input),
    } as unknown as WorkDevices;
    seedTask(tasks, {
      id: "task-there",
      title: "Inspect",
      status: "idle",
      repoId: "repo-1",
      deviceId: "mini",
    });
    const service = new WorkflowEvidenceService({
      tasks,
      repos: { get: () => ({ id: "repo-1", path: "/unused", name: "meter" }) } as never,
      forgeFor: () => forge,
      evidenceDir: () => join(evidence, "evidence"),
      tempDir: () => join(evidence, "temp"),
      filesElsewhere: () => true,
      fileElsewhere: (task, device, name, file) =>
        sendSourceFile(devices, device, task, name, file, undefined, true),
    });
    const receipt = JSON.parse(
      await service.download("task-there", {
        runId: 10,
        artifactId: 30,
        file: "ipad/rest/1-plutil.log",
      }),
    );
    expect(receipt.path.startsWith(remote.folders("task-there").evidence)).toBe(true);
    expectBytesEqual(readFileSync(receipt.path), unzipped(SAMPLE).get(receipt.member) as Buffer);
    expect(readdirSync(join(evidence, "temp"))).toEqual([]);
    expect(
      readdirSync(remote.folders("task-there").temp).filter((name) => name.endsWith(".part")),
    ).toEqual([]);
  });
});
