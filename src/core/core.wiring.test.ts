import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { FeedLine } from "@shared/feed";
import { providerLabel } from "@shared/modelSlots";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mockModelsJson } from "../../tests/e2e/mockModels";
import { type MockProviderServer, startMockProvider } from "../../tests/e2e/mockProvider";
import { latestContext } from "../../tests/e2e/providerRequest";
import { fakeHost, quotaFixture, waitFor } from "../../tests/helpers/bootedCore";
import { scratchDir } from "../../tests/helpers/scratchDirs";
import { interruptedJobNote } from "./bootRecovery";
import { ForgeSignInStore } from "./forge/signIns";
import { type Core, startCore } from "./index";
import { catalogRefreshesSettled } from "./pi/modelRuntime";
import { openDatabase } from "./storage/db";
import { type InterruptedJob, JobStore } from "./storage/jobStore";
import { FIRSTMATE_USAGE_TASK_ID, UsageStore } from "./storage/usageStore";
import { seedTask } from "./tasks/seedTask";
import { TaskService } from "./tasks/taskService";

// The core boots real git and is not about the utility-QoS clamp, so what
// the product spawns runs at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("./utilityQos", async (importOriginal) =>
  (await import("../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

/**
 * What the app wiring (`src/core/services.ts`) answers with logic of its
 * own, held through the whole booted core before the wiring is split into
 * its owners (INF-2625's plan): the boot notes for background jobs the last
 * run left, the open changes and projects read from every signed-in forge,
 * the names Usage gives what it counts, and the first mate's quota line.
 * Each is read the way the window or the first mate reads it, so the same
 * cases hold whichever module the logic moves to.
 */

/** A GitHub and a GitLab API on loopback, answering as each host does for these reads. */
function forgeStandIn(): Promise<{ server: Server; url: string; gitlabFails: { now: boolean } }> {
  const gitlabFails = { now: false };
  const json = (response: ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const path = request.url ?? "";
    if (request.method === "POST" && path === "/github/graphql") {
      json(response, 200, {
        data: {
          viewer: {
            pullRequests: {
              nodes: [
                {
                  repository: { nameWithOwner: "acme/older" },
                  number: 7,
                  title: "Older pull request",
                  url: "https://github.com/acme/older/pull/7",
                  isDraft: false,
                  updatedAt: "2026-10-01T00:00:00Z",
                  commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
                },
                {
                  repository: { nameWithOwner: "acme/newest" },
                  number: 9,
                  title: "Newest pull request",
                  url: "https://github.com/acme/newest/pull/9",
                  isDraft: true,
                  updatedAt: "2026-10-03T00:00:00Z",
                  commits: { nodes: [] },
                },
              ],
            },
          },
        },
      });
      return;
    }
    if (request.method === "GET" && path.startsWith("/github/user/repos")) {
      json(response, 200, [
        {
          full_name: "acme/newest",
          clone_url: "https://github.com/acme/newest.git",
          html_url: "https://github.com/acme/newest",
          updated_at: "2026-10-03T00:00:00Z",
          private: true,
        },
      ]);
      return;
    }
    if (gitlabFails.now && path.startsWith("/gitlab/")) {
      json(response, 500, { message: "down" });
      return;
    }
    if (request.method === "GET" && path.startsWith("/gitlab/merge_requests?")) {
      json(response, 200, [
        {
          iid: 4,
          project_id: 11,
          title: "Middle merge request",
          web_url: "https://gitlab.com/group/middle/-/merge_requests/4",
          updated_at: "2026-10-02T00:00:00Z",
          references: { full: "group/middle!4" },
        },
      ]);
      return;
    }
    if (request.method === "GET" && path === "/gitlab/projects/11/merge_requests/4") {
      json(response, 200, { iid: 4, project_id: 11, head_pipeline: { status: "failed" } });
      return;
    }
    json(response, 404, { message: `no stand-in for ${request.method} ${path}` });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}`, gitlabFails });
    });
  });
}

describe("the app wiring's own answers, through the booted core", () => {
  const CUSTOM_PROVIDER = "fm-custom-0123456789abcdef";
  const LONG_COMMAND = `pnpm vitest run ${"src/core/a-long-path/".repeat(6)}`;
  let userDataDir: string;
  let quotaDir: string;
  let core: Core;
  let mock: MockProviderServer;
  let forge: Awaited<ReturnType<typeof forgeStandIn>>;
  let forgeStore: ForgeSignInStore;

  beforeAll(async () => {
    process.env.PI_OFFLINE = "1";
    userDataDir = scratchDir("infinitary-core-wiring-");
    // What the last run left: a job its quit stopped, and one still running
    // when it ended without its quit; a task that owns the second; and
    // usage recorded on models of three kinds of provider.
    const db = openDatabase(userDataDir);
    seedTask(new TaskService({ db }), {
      id: "build-task",
      title: "Speed up the build",
      status: "completed",
    });
    const jobs = new JobStore(db);
    jobs.add({ id: "job-1", ownerId: "firstmate", command: "pnpm dev", startedAt: 1 });
    jobs.markStoppedByQuit("job-1");
    jobs.add({ id: "job-2", ownerId: "build-task", command: LONG_COMMAND, startedAt: 2 });
    const usage = new UsageStore(db);
    for (const provider of [CUSTOM_PROVIDER, "anthropic", "nobody-knows"])
      usage.record({
        taskId: FIRSTMATE_USAGE_TASK_ID,
        model: { provider, id: `${provider}-model` },
        usage: { input: 10, output: 5 },
        at: Date.now(),
      });
    db.close();
    quotaDir = quotaFixture("infinitary-core-wiring-quota-", [
      {
        provider: "codex",
        label: "Codex",
        accountLabel: "work",
        status: "ok",
        stale: false,
        windows: [{ id: "weekly", label: "weekly", percentRemaining: 62 }],
      },
      {
        provider: "claude",
        label: "Claude",
        status: "ok",
        stale: false,
        windows: [{ id: "weekly", label: "weekly", percentRemaining: 40.4 }],
      },
      {
        provider: "gemini",
        label: "Gemini",
        status: "error",
        stale: false,
        windows: [{ id: "weekly", label: "weekly", percentRemaining: 90 }],
      },
    ]);
    forge = await forgeStandIn();
    process.env.INFINITARY_GITHUB_API_URL = `${forge.url}/github`;
    process.env.INFINITARY_GITLAB_API_URL = `${forge.url}/gitlab`;
    mock = await startMockProvider();
    mkdirSync(join(userDataDir, "auth"), { recursive: true, mode: 0o700 });
    writeFileSync(join(userDataDir, "auth", "models.json"), mockModelsJson(mock.port));
    core = await startCore(fakeHost(userDataDir).host);
    forgeStore = new ForgeSignInStore(core.paths.forgesDir);
  }, 120_000);

  afterAll(async () => {
    await core?.dispose();
    await core?.services.workspace.poolSettled();
    await core?.services.workspace.deletionsSettled();
    await catalogRefreshesSettled();
    await mock?.close();
    await new Promise((resolve) => forge?.server.close(resolve));
    delete process.env.INFINITARY_GITHUB_API_URL;
    delete process.env.INFINITARY_GITLAB_API_URL;
    delete process.env.INFINITARY_QUOTA_FIXTURE_DIR;
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(quotaDir, { recursive: true, force: true });
  }, 30_000);

  it("says once at boot which background job the last quit stopped, and which it may have left running", async () => {
    const notes = ((await core.dispatch("inf:feed:recent", [])) as FeedLine[]).filter((line) =>
      line.text.includes("background job"),
    );
    const key = core.services.tasks.get("build-task")?.key;
    // Both notes land in the same moment, so the feed's order between them says nothing.
    const said = notes
      .map((line) => ({ text: line.text, taskKey: line.taskKey ?? null }))
      .sort((a, b) => a.text.localeCompare(b.text));
    // The words are bootRecovery.test.ts's; this holds that the wiring says each
    // stranded job once, under its task's title and on its task's record.
    const titleOf = (id: string) => (id === "build-task" ? "Speed up the build" : undefined);
    const note = (job: InterruptedJob) => interruptedJobNote(job, titleOf).text;
    expect(said).toEqual([
      {
        text: note({ ownerId: "build-task", command: LONG_COMMAND, stoppedByQuit: false }),
        taskKey: key,
      },
      {
        text: note({ ownerId: "firstmate", command: "pnpm dev", stoppedByQuit: true }),
        taskKey: null,
      },
    ]);
  });

  it("lists open changes from every signed-in GitHub and GitLab host newest first, and says when a host could not be read", async () => {
    expect(await core.dispatch("inf:forges:changes", [])).toEqual({
      signedIn: false,
      reachable: true,
      changes: [],
    });
    for (const host of ["github.com", "gitlab.com"])
      forgeStore.write(host, {
        token: "disposable-forge-sign-in",
        scopes: [],
        login: "fixture",
        createdAt: 1,
      });
    const read = await core.dispatch("inf:forges:changes", []);
    expect(read.signedIn).toBe(true);
    expect(read.reachable).toBe(true);
    expect(read.changes.map((row) => [row.host, row.label, row.project, row.checks])).toEqual([
      ["github.com", "#9", "acme/newest", "none"],
      ["gitlab.com", "!4", "group/middle", "failed"],
      ["github.com", "#7", "acme/older", "passed"],
    ]);

    forge.gitlabFails.now = true;
    const partial = await core.dispatch("inf:forges:changes", []);
    forge.gitlabFails.now = false;
    expect(partial.reachable).toBe(false);
    expect(partial.changes.map((row) => row.label)).toEqual(["#9", "#7"]);
  });

  it("lists a signed-in host's projects and refuses a host the app does not know", async () => {
    forgeStore.write("github.com", {
      token: "disposable-forge-sign-in",
      scopes: [],
      login: "fixture",
      createdAt: 1,
    });
    expect(
      (await core.dispatch("inf:forges:projects", ["github.com"])).map((row) => row.fullName),
    ).toEqual(["acme/newest"]);
    await expect(core.dispatch("inf:forges:projects", ["git.example.org"])).rejects.toThrow(
      "This app does not know that project host yet. Ask your first mate to add it.",
    );
  });

  it("names each model's provider in Usage as Settings does: a custom API's by its kind, any other by its name", async () => {
    const summary = await core.dispatch("inf:usage:summary", [{ period: "all", scope: "all" }]);
    // The first mate's own turns on the stand-in model may add a row of their own.
    const seeded = new Set<string | null>([CUSTOM_PROVIDER, "anthropic", "nobody-knows"]);
    const names = Object.fromEntries(
      summary.models
        .filter((model) => seeded.has(model.provider))
        .map((model) => [model.provider, [model.providerName, model.name]]),
    );
    expect(names).toEqual({
      [CUSTOM_PROVIDER]: ["Custom API", `${CUSTOM_PROVIDER}-model`],
      anthropic: [providerLabel("anthropic"), "anthropic-model"],
      "nobody-knows": ["nobody-knows", "nobody-knows-model"],
    });
  });

  it("tells the first mate each readable account's quota left in one line", async () => {
    const before = mock.requestBodies().length;
    await core.dispatch("inf:converse", ["hello there, all well?"]);
    let quota: unknown;
    await waitFor(() => {
      quota = mock
        .requestBodies()
        .slice(before)
        // What the model holds on that request: a fact goes again only when it changed.
        .map((body) => (latestContext(body) as Record<string, unknown> | undefined)?.quota)
        .find((line) => line !== undefined);
      return quota !== undefined && !core.services.firstmate.isBusy();
    }, 60_000);
    expect(quota).toBe("codex/work 62%; claude 40%");
  }, 120_000);
});
