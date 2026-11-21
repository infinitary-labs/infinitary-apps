import { writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { BITBUCKET } from "@shared/forges";
import { afterEach, describe, expect, it, vi } from "vitest";
import { freshDatabase } from "../../../../../tests/helpers/database";
import { allowIntegrationReads } from "../../../../../tests/helpers/integrationApprovals";
import { scratchDir } from "../../../../../tests/helpers/scratchDirs";
import { seedDelivery } from "../../../../../tests/helpers/taskDelivery";
import {
  forgeHostIntegration,
  IntegrationSettingsStore,
  IntegrationsService,
} from "../../../integrations";
import { GithubGatewayService } from "../../../orchestrator/githubGateway";
import { GITHUB_READ_TOOL, GITHUB_WRITE_TOOL } from "../../../pi/forgeTools";
import { bindTool } from "../../../session/tools";
import { seedTask } from "../../../tasks/seedTask";
import { TaskService } from "../../../tasks/taskService";
import { RepoRegistry } from "../../../workspace/repoRegistry";
import { seedProject } from "../../../workspace/seedProject";
import { BitbucketForge } from "./bitbucketForge";

/**
 * The crewmate's API tools on a Bitbucket Cloud repository (`docs/forge.md`,
 * "The gateway", "On Bitbucket"), driven through the tool entries, the
 * gateway service and the real Bitbucket forge over a local HTTP stand-in:
 * reads anywhere the key may read, writes at once only under the task's own
 * repository, raw merges, main branch moves and the task's own description
 * refused, a pipeline start that arms the run watch, a release file sent to
 * Downloads and a comment kept so it never wakes its own task.
 */

const KEY = "bitbucket-api-token-fixture";
const OWN = "/repositories/field-team/field-notes";
const cleanup: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

type Seen = { method: string; path: string; key?: string; body: string; type?: string };

/** One pull request as Bitbucket lists it, trimmed to the fields a page carries. */
function pullRequest(id: number) {
  return {
    type: "pullrequest",
    id,
    title: `fix(notes): keep field note ${id} beside its photo`,
    description: "## Why\nThe field notes lost their photo after a sync.\n\n".repeat(60),
    state: "OPEN",
    source: { branch: { name: `inf/note-${id}` }, commit: { hash: "a1b2c3d4e5f6" } },
    destination: { branch: { name: "main" }, commit: { hash: "0f9e8d7c6b5a" } },
    updated_on: "2026-11-18T09:14:12.000000+00:00",
    links: { html: { href: `https://bitbucket.org/field-team/field-notes/pull-requests/${id}` } },
  };
}

async function fixture(options: { watchRun?: (taskId: string, runId: number) => string } = {}) {
  const seen: Seen[] = [];
  let base = "";
  const server = createServer(async (req: IncomingMessage, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    seen.push({
      method: req.method ?? "",
      path: req.url ?? "",
      key: req.headers.authorization?.replace(/^Bearer /, ""),
      body,
      type: req.headers["content-type"],
    });
    const url = new URL(req.url ?? "/", base);
    // Bitbucket documents some collections with a trailing slash and answers both.
    const path = url.pathname.replace(/^\/2\.0/, "").replace(/(.)\/$/, "$1");
    const json = (value: unknown, status = 200) => {
      res.writeHead(status, { "Content-Type": "application/json", "x-request-id": "REQ-BB-1" });
      res.end(JSON.stringify(value));
    };
    if (path === `${OWN}/pullrequests` && req.method === "GET") {
      // Bitbucket's paging: pagelen (10 when unnamed) and page, the next page in `next`.
      const pagelen = Number(url.searchParams.get("pagelen") ?? 10);
      const page = Number(url.searchParams.get("page") ?? 1);
      const next = new URLSearchParams(url.searchParams);
      next.set("page", String(page + 1));
      json({
        pagelen,
        page,
        values: Array.from({ length: pagelen }, (_, index) => pullRequest(page * 100 + index)),
        next: `${base}/2.0${OWN}/pullrequests?${next}`,
      });
    } else if (path === "/repositories/acme/site/issues" || path === "/user") {
      json({ values: [{ id: 5 }] });
    } else if (path === `${OWN}/pullrequests/1/comments` && req.method === "POST") {
      json({ type: "pullrequest_comment", id: 4417, content: { raw: "read" } }, 201);
    } else if (path === `${OWN}/pipelines` && req.method === "POST") {
      json(
        {
          type: "pipeline",
          uuid: "{6a1c2a3e-5c0b-4b7e-9d43-1f0f2b9a7c11}",
          build_number: 57,
          state: { name: "PENDING", type: "pipeline_state_pending" },
          target: { type: "pipeline_ref_target", ref_type: "branch", ref_name: "main" },
        },
        201,
      );
    } else if (path === `${OWN}/downloads` && req.method === "POST") {
      res.writeHead(201);
      res.end();
    } else if (path === `${OWN}/redirect`) {
      res.writeHead(302, { location: "https://elsewhere.example/" });
      res.end();
    } else json({ type: "error", error: { message: "Resource not found" } }, 404);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanup.push(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const forge = new BitbucketForge(
    {
      kind: "bitbucket",
      host: "bitbucket.org",
      owner: "field-team",
      name: "field-notes",
      dir: "/unused",
    },
    { apiBaseUrl: `${base}/2.0`, token: async () => KEY },
  );
  // Every main-branch read names `main`.
  vi.spyOn(forge, "defaultBranch").mockResolvedValue("main");
  const dir = scratchDir("fm-bitbucket-gateway-");
  const db = freshDatabase();
  cleanup.push(() => {
    db.close();
  });
  seedProject(db, {
    id: "repo-1",
    name: "field-notes",
    path: dir,
    setupKind: "adopt",
    origin: "https://bitbucket.org/field-team/field-notes.git",
    addedAt: 1,
  });
  const tasks = new TaskService({ db, strict: true });
  seedTask(tasks, {
    id: "task-1",
    title: "Fix",
    status: "idle",
    repoId: "repo-1",
    worktreeDir: dir,
    branch: "inf/fix-notes",
  });
  const service = new GithubGatewayService({
    tasks,
    repos: new RepoRegistry(db, join(dir, "fleet")),
    forgeFor: () => forge,
    accountForge: (host) =>
      new BitbucketForge(
        { kind: "bitbucket", host: host ?? "bitbucket.org", dir: "" },
        { apiBaseUrl: `${base}/2.0`, token: async () => KEY },
      ),
    readChecks: async () => "checks pending",
    ...(options.watchRun ? { watchRun: options.watchRun } : {}),
    now: () => 1234,
    sleep: async () => {},
  });
  const read = bindTool(GITHUB_READ_TOOL, { onGithubRead: (i) => service.read("task-1", i) });
  const write = bindTool(GITHUB_WRITE_TOOL, { onGithubWrite: (i) => service.write("task-1", i) });
  return { read, write, seen, tasks, dir, service };
}

describe("the gateway on a Bitbucket Cloud repository, through crewmate tools", () => {
  it("reads with the key, and its nextPath goes on from Bitbucket's next page", async () => {
    const { read, seen } = await fixture();
    const answer = JSON.parse((await read.run({ path: `${OWN}/pullrequests?pagelen=2` })).text);
    expect(answer).toMatchObject({ status: 200, ok: true, requestId: "REQ-BB-1" });
    expect(answer.nextPath).toBe(`${OWN}/pullrequests?pagelen=2&page=2`);
    expect(seen[0]).toMatchObject({ path: `/2.0${OWN}/pullrequests?pagelen=2`, key: KEY });
    const next = JSON.parse((await read.run({ path: answer.nextPath })).text);
    expect(next.body.page).toBe(2);
    expect(JSON.stringify([answer, next])).not.toContain(KEY);
    // No read list: Bitbucket's own answer decides what the key may see.
    expect(
      JSON.parse((await read.run({ path: "/repositories/acme/site/issues" })).text),
    ).toMatchObject({ status: 200 });
  });

  it("refuses a page size Bitbucket's paging does not name, before anything is sent", async () => {
    const { read, seen } = await fixture();
    expect((await read.run({ path: `${OWN}/pullrequests?pagelen=500` })).text).toContain("pagelen");
    expect(seen).toEqual([]);
  });

  it("writes to its own repository at once and keeps a write anywhere else for the captain", async () => {
    const { write, seen, tasks } = await fixture();
    const sent = JSON.parse(
      (
        await write.run({
          method: "POST",
          path: `${OWN}/pullrequests/1/comments`,
          body: '{"content":{"raw":"read"}}',
        })
      ).text,
    );
    expect(sent).toMatchObject({ status: 201, ok: true, body: { id: 4417 } });
    // Its own comment is kept, so the comment wake never wakes it about its own words.
    expect(tasks.get("task-1")?.delivery?.sentComments).toEqual([4417]);
    const before = seen.length;
    for (const path of [
      "/repositories/acme/site/issues",
      "/repositories/%7B1b2c3d4e-0000-4000-8000-000000000000%7D/%7B9a8b7c6d-0000-4000-8000-000000000000%7D/issues",
    ]) {
      expect((await write.run({ method: "POST", path, body: "{}" })).text).toContain("Not sent");
    }
    expect(
      (
        await write.run({
          method: "POST",
          path: "/repositories/%7B1b2c3d4e-0000-4000-8000-000000000000%7D/x/issues",
          body: "{}",
        })
      ).text,
    ).toContain("workspace and repository slugs");
    expect((await write.run({ method: "DELETE", path: OWN })).text).toContain(
      "Deleting the repository itself",
    );
    expect(seen).toHaveLength(before);
  });

  it.each([
    ["POST", `${OWN}/pullrequests/1/merge`, '{"merge_strategy":"squash"}'],
    ["DELETE", `${OWN}/refs/branches/main`, undefined],
    ["PUT", OWN, '{"mainbranch":{"name":"inf/fix-notes"}}'],
    ["POST", `${OWN}/src`, '{"message":"edit"}'],
  ] as const)("refuses a raw merge or main branch move: %s %s", async (method, path, body) => {
    const { write, seen } = await fixture();
    const answer = (await write.run({ method, path, ...(body ? { body } : {}) })).text;
    expect(answer).toContain("requires the merge card");
    expect(seen).toEqual([]);
  });

  it.each([
    ["PUT", "pullrequests/36", '{"description":"Raw replacement"}'],
    ["PUT", "pullrequests/036", '{"summary":{"raw":"Raw replacement"}}'],
    ["POST", "pullrequests", '{"title":"fix","source":{"branch":{"name":"inf/fix-notes"}}}'],
  ] as const)(
    "refuses the task's own pull request story through %s %s",
    async (method, rest, body) => {
      const { write, seen, tasks } = await fixture();
      seedDelivery(tasks, "task-1", { prNumber: 36 });
      tasks.delivery.updateChangePresentation("task-1", () => ({ revisions: [], receipts: [] }));
      const answer = (await write.run({ method, path: `${OWN}/${rest}`, body })).text;
      expect(answer).toMatch(/open_change/);
      expect(seen).toEqual([]);
    },
  );

  it("arms the run watch from a started pipeline's build number", async () => {
    const watchRun = vi.fn(
      (_taskId: string, runId: number) => `The app watches pipeline ${runId}.`,
    );
    const { write } = await fixture({ watchRun });
    const answer = (
      await write.run({
        method: "POST",
        path: `${OWN}/pipelines/`,
        body: '{"target":{"type":"pipeline_ref_target","ref_type":"branch","ref_name":"main"}}',
      })
    ).text;
    expect(answer).toContain('"status": 201');
    expect(answer).toContain("The app watches pipeline 57.");
    expect(watchRun).toHaveBeenCalledWith("task-1", 57);
  });

  it("sends a release file to the repository's Downloads as one multipart upload", async () => {
    const { write, seen, dir } = await fixture();
    writeFileSync(join(dir, "app.dmg"), "bitbucket-bytes");
    const sent = JSON.parse(
      (await write.run({ method: "POST", path: `${OWN}/downloads`, file: "app.dmg" })).text,
    );
    expect(sent).toMatchObject({ status: 201, ok: true });
    expect(seen[0]).toMatchObject({ method: "POST", path: `/2.0${OWN}/downloads`, key: KEY });
    expect(seen[0]?.type).toMatch(/^multipart\/form-data; boundary=/);
    expect(seen[0]?.body).toContain('name="files"; filename="app.dmg"');
    expect(seen[0]?.body).toContain("bitbucket-bytes");
    expect(
      (await write.run({ method: "POST", path: `${OWN}/issues`, file: "app.dmg" })).text,
    ).toContain("Downloads");
    expect(seen).toHaveLength(1);
  });

  it("refuses a redirect without following it", async () => {
    const { read, seen } = await fixture();
    const answer = (await read.run({ path: `${OWN}/redirect` })).text;
    expect(answer).toContain("redirect");
    expect(seen).toHaveLength(1);
  });

  // Integrations reach every surface the same way: the Bitbucket row gets GitLab's two actions.
  it("reaches Bitbucket through its integration row, and keeps a change for one click", async () => {
    const { service, tasks, seen } = await fixture();
    const integrations = new IntegrationsService({
      bindings: [
        forgeHostIntegration("bitbucket", {
          signIns: {
            view: () => ({
              signIns: [
                {
                  host: "bitbucket.org",
                  name: "Bitbucket",
                  login: "field-lead",
                  state: "ok",
                  projects: 1,
                  since: 1,
                  server: BITBUCKET,
                },
              ],
              hosts: [],
              flow: null,
              ended: null,
            }),
            stateOf: () => "ok",
            loginOf: () => "field-lead",
            checkNow: async () => {},
            signOut: () => {},
          },
          gateway: (host) => ({
            read: (task, input) => service.read(task, input, { host }),
            write: (task, input) => service.write(task, input, { host }, true),
            readAsSeat: (input) => service.readAsSeat(input, host),
            writeAsSeat: (input) => service.writeAsSeat(input, host),
          }),
        }),
      ],
      store: new IntegrationSettingsStore(
        join(scratchDir("fm-bitbucket-integration-"), "settings"),
      ),
      asks: {
        keep: (taskId, ask) => tasks.delivery.keepWriteAsk(taskId, ask),
        keepForFirstmate: (ask) => `integration-ask-${ask.id}`,
        take: (taskId, askId) => tasks.delivery.takeWriteAsk(taskId, askId),
        record: (taskId, askId, outcome) =>
          tasks.delivery.recordWriteAskOutcome(taskId, askId, outcome),
      },
    });
    const row = integrations.view().integrations[0];
    expect(row).toMatchObject({ kind: "bitbucket", name: "Bitbucket" });
    expect(row?.actions.map((action) => action.name)).toEqual(["read", "write"]);
    allowIntegrationReads(integrations);
    const crew = integrations.forTask("task-1");
    const why = "To perform the task’s requested action.";
    const id = row?.id ?? "";
    expect(
      JSON.parse((await crew.call(id, "read", { path: "/user" }, undefined, why)).text),
    ).toMatchObject({ status: 200, body: { values: [{ id: 5 }] } });
    const before = seen.length;
    const change = {
      method: "POST",
      path: `${OWN}/pullrequests/1/comments`,
      body: '{"content":{"raw":"read"}}',
    };
    expect(await crew.call(id, "write", change, undefined, why)).toMatchObject({
      refused: "refused",
    });
    expect(seen).toHaveLength(before);
    const ask = tasks.get("task-1")?.delivery?.writeAsks?.at(-1);
    expect(await integrations.sendAsk("task-1", ask?.id ?? "")).toMatchObject({
      ok: true,
      outcome: { kind: "ran" },
    });
    await integrations.sendAsk("task-1", ask?.id ?? "");
    expect(seen.filter((request) => request.method === "POST")).toHaveLength(1);
  });
});
