import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../../../../tests/helpers/scratchDirs";
import { GithubGatewayService } from "../../../orchestrator/githubGateway";
import { WorkflowEvidenceService } from "../../../orchestrator/workflowEvidence";
import {
  DOWNLOAD_ARTIFACT_TOOL,
  GITHUB_READ_TOOL,
  READ_WORKFLOW_TOOL,
} from "../../../pi/forgeTools";
import { bindTool } from "../../../session/tools";
import { openInMemoryDatabase } from "../../../storage/db";
import { seedTask } from "../../../tasks/seedTask";
import { TaskService } from "../../../tasks/taskService";
import { RepoRegistry } from "../../../workspace/repoRegistry";
import { seedProject } from "../../../workspace/seedProject";
import { isArtifactStorage } from "./client";
import { GitLabForge } from "./gitlabForge";

/**
 * A GitLab project's pipeline evidence through the crewmate's own tools
 * (`docs/forge.md`, "Workflow logs and artifacts"): github_read lists a
 * version's pipelines and their jobs, read_workflow pages a job's log by
 * pipeline and job id, and download_artifact saves a job's artifacts
 * archive - all with the key made on GitLab, over a real HTTP stand-in.
 */

const KEY = "glpat-fixture-owned-by-app";
const HEAD = "a".repeat(40);
const PROJECT = "group/field-notes";
const PREFIX = `/api/v4/projects/${encodeURIComponent(PROJECT)}`;
const PIPELINE = {
  id: 10,
  iid: 3,
  sha: HEAD,
  ref: "fm/task-1",
  status: "failed",
  source: "push",
  web_url: `https://gitlab.com/${PROJECT}/-/pipelines/10`,
};
const ZIP = readFileSync("tests/fixtures/forge/measurement.zip");
const JOB = {
  id: 20,
  name: "measure",
  stage: "test",
  status: "failed",
  pipeline: { id: 10, sha: HEAD, ref: "fm/task-1", status: "failed" },
  commit: { id: HEAD },
  artifacts_file: { filename: "measurements.zip", size: ZIP.length },
  artifacts: [
    { file_type: "archive", size: ZIP.length, filename: "measurements.zip", file_format: "zip" },
    { file_type: "trace", size: 120, filename: "job.log", file_format: null },
  ],
  artifacts_expire_at: "2026-11-09T12:00:00.000Z",
};
/** A log the way GitLab keeps it: colour codes and its own section markers. */
const TRACE = [
  "\u001b[0Ksection_start:1760000000:prepare_script\r\u001b[0K\u001b[0K\u001b[36;1mPreparing\u001b[0;m",
  "\u001b[32;1m$ pnpm measure\u001b[0;m",
  "Measure pairs: exit 1",
  "\u001b[31;1mMissing measurement input\u001b[0;m",
  "section_end:1760000009:prepare_script\r\u001b[0K",
].join("\n");

const cleanup: (() => Promise<void> | void)[] = [];
beforeEach(() => {
  // Regression: missing and expired archives must not change meaning with the real date.
  // Keep the fixture's default expiry ahead of its clock without faking HTTP timers.
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(JOB.artifacts_expire_at) - 1);
});
afterEach(async () => {
  try {
    for (const close of cleanup.splice(0)) await close();
  } finally {
    vi.restoreAllMocks();
  }
});

async function fixture(
  options: {
    token?: string | null;
    host?: string;
    status?: number;
    /** GitLab no longer answers for the key: a 401 is then a sign-in. */
    keyRefused?: boolean;
    job?: Partial<typeof JOB> & Record<string, unknown>;
    route?: (req: IncomingMessage, res: ServerResponse) => boolean;
  } = {},
) {
  const seen: { path: string; key?: string }[] = [];
  let base = "";
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", base);
    const key = req.headers.authorization?.replace(/^Bearer /, "");
    seen.push({ path: req.url ?? "", key: typeof key === "string" ? key : undefined });
    if (options.route?.(req, res)) return;
    const json = (value: unknown, status = 200) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (url.pathname === "/api/v4/user") {
      json(
        options.keyRefused ? { message: "401 Unauthorized" } : { username: "octo" },
        options.keyRefused ? 401 : 200,
      );
      return;
    }
    if (url.pathname.startsWith(PREFIX) && options.status) {
      json({ message: "Evidence unavailable" }, options.status);
      return;
    }
    if (url.pathname === `${PREFIX}/pipelines` && url.searchParams.get("sha") === HEAD) {
      json([PIPELINE]);
      return;
    }
    if (url.pathname === `${PREFIX}/pipelines/10`) {
      json(PIPELINE);
      return;
    }
    // A later pipeline on the same version, whose jobs are not job 20.
    if (url.pathname === `${PREFIX}/pipelines/11`) {
      json({ ...PIPELINE, id: 11, status: "success" });
      return;
    }
    if (url.pathname === `${PREFIX}/pipelines/10/jobs`) {
      json([JOB]);
      return;
    }
    if (url.pathname === `${PREFIX}/jobs/20`) {
      json({ ...JOB, ...options.job });
      return;
    }
    if (url.pathname === `${PREFIX}/jobs/20/trace`) {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(TRACE);
      return;
    }
    if (url.pathname === `${PREFIX}/jobs/20/artifacts`) {
      res.writeHead(302, { location: `${base}/storage/zip?signed=test-only` });
      res.end();
      return;
    }
    if (url.pathname === "/storage/zip") {
      res.end(ZIP);
      return;
    }
    json({ message: `Unexpected request ${req.url}` }, 404);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanup.push(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const rejected = vi.fn();
  const host = options.host ?? "gitlab.com";
  const forge = new GitLabForge(
    { kind: "gitlab", host, owner: "group", name: "field-notes", dir: "/unused" },
    {
      apiBaseUrl: `${base}/api/v4`,
      token: async () => (options.token === null ? undefined : (options.token ?? KEY)),
      onSignInRejected: rejected,
    },
  );
  const cwd = scratchDir("fm-gitlab-evidence-");
  const db = openInMemoryDatabase();
  cleanup.push(() => {
    db.close();
  });
  seedProject(db, {
    id: "repo-1",
    name: "field-notes",
    path: cwd,
    setupKind: "adopt",
    origin: `https://${host}/${PROJECT}.git`,
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
  const service = new WorkflowEvidenceService({ tasks, repos, forgeFor: () => forge });
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
  return { forge, list, read, download, tasks, cwd, seen, rejected };
}

const project = `/projects/${encodeURIComponent(PROJECT)}`;

describe("GitLab pipeline evidence through crewmate tools and the key made there", () => {
  it("lists a version's pipelines and jobs, pages a job's log as plain lines, then saves the unchanged archive", async () => {
    const { list, read, download, cwd, seen, tasks } = await fixture();
    const before = tasks.get("task-1")?.delivery;
    const pipelines = JSON.parse(
      (await list.run({ path: `${project}/pipelines?sha=${HEAD}` })).text,
    );
    expect(pipelines.body[0]).toMatchObject({ id: 10, sha: HEAD, status: "failed" });
    const jobs = JSON.parse((await list.run({ path: `${project}/pipelines/10/jobs` })).text);
    expect(jobs.body[0]).toMatchObject({ id: 20, name: "measure", status: "failed" });

    const log = JSON.parse((await read.run({ runId: 10, jobId: 20, offset: 2, limit: 2 })).text);
    expect(log.run).toMatchObject({
      id: 10,
      headSha: HEAD,
      status: "failed",
      conclusion: "failed",
    });
    expect(log.job).toMatchObject({ id: 20, runId: 10, stage: "test", conclusion: "failed" });
    expect(log.lines).toEqual(["$ pnpm measure", "Measure pairs: exit 1"]);
    expect(log.nextOffset).toBe(4);
    const rest = JSON.parse((await read.run({ runId: 10, jobId: 20, offset: 1 })).text);
    expect(rest.lines[0]).toBe("Preparing");
    expect(rest.lines[3]).toBe("Missing measurement input");
    expect(rest.lines.join("\n")).not.toContain("\u001b");
    expect(rest.lines.join("\n")).not.toContain("section_");

    const receipt = JSON.parse((await download.run({ runId: 10, artifactId: 20 })).text);
    expect(receipt).toMatchObject({
      run: { id: 10, headSha: HEAD },
      artifact: { id: 20, name: "measurements.zip", sizeBytes: ZIP.length, expired: false },
      path: ".infinitary-artifacts/run-10/artifact-20.zip",
      bytes: ZIP.length,
      sha256: createHash("sha256").update(ZIP).digest("hex"),
      extracted: false,
    });
    expect(readFileSync(join(cwd, receipt.path))).toEqual(ZIP);
    expect(statSync(join(cwd, receipt.path)).mode & 0o777).toBe(0o600);
    // The key goes to GitLab's API alone; signed storage never sees it.
    expect(
      seen.filter((entry) => entry.path.startsWith("/api/v4")).every((entry) => entry.key === KEY),
    ).toBe(true);
    expect(seen.filter((entry) => entry.path.startsWith("/storage/"))).toEqual([
      { path: "/storage/zip?signed=test-only", key: undefined },
    ]);
    expect(JSON.stringify(receipt)).not.toMatch(/glpat-|signed=/);
    expect(tasks.get("task-1")?.delivery).toEqual(before);
  });

  it.each([403, 404, 503])(
    "answers GitLab's %s as an explanatory refusal without pretending evidence was read",
    async (status) => {
      const { read, rejected } = await fixture({ status });
      const result = (await read.run({ runId: 10, jobId: 20 })).text;
      expect(result).toContain("Cannot read workflow evidence");
      expect(result).toContain(String(status));
      expect(rejected).not.toHaveBeenCalled();
    },
  );

  it("treats a 401 as a sign-in only when GitLab no longer answers for the key", async () => {
    const answered = await fixture({ status: 401 });
    expect((await answered.read.run({ runId: 10, jobId: 20 })).text).toContain("(permission)");
    expect(answered.rejected).not.toHaveBeenCalled();
    const refusedKey = await fixture({ status: 401, keyRefused: true });
    expect((await refusedKey.read.run({ runId: 10, jobId: 20 })).text).toContain("(sign-in)");
    expect(refusedKey.rejected).toHaveBeenCalledTimes(1);
  });

  it("asks nothing without the app's sign-in, and names the self-hosted server", async () => {
    const { read, seen } = await fixture({ token: null, host: "gitlab.example.com" });
    expect((await read.run({ runId: 10, jobId: 20 })).text).toContain(
      "Not signed in to gitlab.example.com",
    );
    expect(seen).toEqual([]);
  });

  it("refuses a job from another pipeline, and a missing, expired or oversized archive, before downloading", async () => {
    const { read, seen, forge } = await fixture();
    expect((await read.run({ runId: 11, jobId: 20 })).text).toContain("different pipeline");
    await expect(forge.workflows.download(11, 20)).rejects.toThrow("different pipeline");
    for (const [job, words] of [
      [{ artifacts_file: undefined, artifacts: [] }, "kept no artifacts archive"],
      [
        { artifacts_file: undefined, artifacts: [], artifacts_expire_at: "2026-01-01T00:00:00Z" },
        "have expired",
      ],
      [{ artifacts_file: { filename: "big.zip", size: 64 * 1024 * 1024 + 1 } }, "64 MiB"],
    ] as [Record<string, unknown>, string][]) {
      const other = await fixture({ job });
      expect((await other.download.run({ runId: 10, artifactId: 20 })).text).toContain(words);
      expect(other.seen.some((entry) => entry.path.endsWith("/artifacts"))).toBe(false);
    }
    expect(seen.some((entry) => /\/trace|\/artifacts/.test(entry.path))).toBe(false);
  });

  it("bounds a log's streamed bytes and marks long lines as clipped", async () => {
    const streamed = await fixture({
      route: (req, res) => {
        if (req.url?.endsWith("/jobs/20/trace")) {
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
        if (req.url?.endsWith("/jobs/20/trace")) {
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

  it("never follows a redirect to an unknown address, or repeats its signed address", async () => {
    const { download, seen } = await fixture({
      route: (req, res) => {
        if (req.url?.endsWith("/jobs/20/artifacts")) {
          res.writeHead(302, { location: "https://attacker.invalid/leak?signed=secret" });
          res.end();
          return true;
        }
        return false;
      },
    });
    const result = (await download.run({ runId: 10, artifactId: 20 })).text;
    expect(result).toContain("unsafe download address");
    expect(result).not.toMatch(/attacker|secret|glpat-/);
    expect(seen.some((entry) => entry.path.includes("/leak"))).toBe(false);
  });

  it("follows GitLab's artifact storage over HTTPS without the key, and asks again when it refuses", async () => {
    let status = 200;
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/jobs/20")) return Response.json(JOB);
      if (url.endsWith("/jobs/20/artifacts"))
        return new Response(null, {
          status: 302,
          headers: { location: "https://cdn.artifacts.gitlab-static.net/a/b?sig=private" },
        });
      expect(url).toBe("https://cdn.artifacts.gitlab-static.net/a/b?sig=private");
      expect(init?.headers).toEqual({});
      return new Response(ZIP, { status });
    });
    const forge = new GitLabForge(
      { kind: "gitlab", host: "gitlab.com", owner: "group", name: "field-notes", dir: "/r" },
      { token: async () => KEY, apiBaseUrl: "https://gitlab.com/api/v4", fetch: fetcher },
    );
    expect(Buffer.from((await forge.workflows.download(10, 20)).bytes)).toEqual(ZIP);
    expect(fetcher.mock.calls[1]?.[1]?.headers).toEqual({ Authorization: `Bearer ${KEY}` });
    status = 403;
    await expect(forge.workflows.download(10, 20)).rejects.toThrow("ask for it again");
  });

  it("knows the artifact storage gitlab.com and self-hosted servers send downloads to, over HTTPS only", () => {
    for (const address of [
      "https://cdn.artifacts.gitlab-static.net/x",
      "https://storage.googleapis.com/gitlab-gprd-artifacts/x",
      "https://bucket.storage.googleapis.com/x",
      "https://artifacts.s3.us-east-1.amazonaws.com/x",
      "https://s3.eu-west-2.amazonaws.com/artifacts/x",
      "https://artifacts.s3-accelerate.amazonaws.com/x",
      "https://store.blob.core.windows.net/artifacts/x",
    ]) {
      expect(isArtifactStorage(new URL(address))).toBe(true);
    }
    for (const address of [
      "http://storage.googleapis.com/x",
      "https://ec2-1-2-3-4.compute-1.amazonaws.com/x",
      "https://storage.googleapis.com.attacker.invalid/x",
      "https://user:pass@storage.googleapis.com/x",
      "https://minio.internal.example/x",
    ]) {
      expect(isArtifactStorage(new URL(address))).toBe(false);
    }
  });
});
