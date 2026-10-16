import { createHash } from "node:crypto";
import { readFileSync, statSync, symlinkSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
const PREFIX = "/repos/octo/meter";
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

async function fixture(
  options: {
    token?: string | null;
    status?: number;
    artifact?: Partial<typeof ARTIFACT>;
    route?: (req: IncomingMessage, res: ServerResponse) => boolean;
  } = {},
) {
  const seen: { path: string; auth?: string }[] = [];
  let base = "";
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", base);
    seen.push({ path: req.url ?? "", auth: req.headers.authorization });
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
      json({ ...ARTIFACT, ...options.artifact });
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
  db.prepare("INSERT INTO repos (id, path, name, added_at, origin) VALUES (?, ?, ?, ?, ?)").run(
    "repo-1",
    cwd,
    "meter",
    1,
    "https://github.com/octo/meter.git",
  );
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
  return { forge, list, read, download, service, tasks, cwd, seen, rejected };
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
