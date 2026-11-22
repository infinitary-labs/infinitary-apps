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
import { DataCenterForge } from "./dataCenterForge";

/**
 * The crewmate's API tools on a Bitbucket Data Center repository
 * (`docs/forge.md`, "The gateway", "On Bitbucket Data Center"), the task's
 * intent being the captain's "adding bitbucket as another forge integration
 * just like github and gitlab, reaching parity as much as possible". Driven
 * through the tool entries, the gateway service and the real Data Center
 * forge over a local HTTP stand-in answering in the server's published REST
 * shapes (8.19): reads anywhere the token may read, paged by `start`; writes
 * at once only under the task's own repository; raw merges, main branch
 * moves and the task's own description refused; a comment kept so it never
 * wakes its own task; and a release file refused in words saying the server
 * keeps none.
 */

const HOST = "bitbucket.example.com";
const KEY = "BBDC-MTIzNDU2Nzg5MDEy+disposable/test=";
const OWN = "/rest/api/latest/projects/PRJ/repos/app";
const cleanup: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

type Seen = { method: string; path: string; key?: string; body: string };

function pullRequest(id: number) {
  return {
    id,
    version: 0,
    title: `fix(notes): keep field note ${id} beside its photo`,
    state: "OPEN",
    fromRef: { id: `refs/heads/inf/note-${id}`, latestCommit: "a1b2c3d4e5f6" },
    toRef: { id: "refs/heads/main", latestCommit: "0f9e8d7c6b5a" },
  };
}

async function fixture() {
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
    });
    const url = new URL(req.url ?? "/", base);
    const json = (value: unknown, status = 200) => {
      res.writeHead(status, { "Content-Type": "application/json", "X-AREQUESTID": "REQ-DC-1" });
      res.end(JSON.stringify(value));
    };
    if (url.pathname === `${OWN}/pull-requests` && req.method === "GET") {
      // Data Center's paging: limit (25 when unnamed) and start, the next start in nextPageStart.
      const limit = Number(url.searchParams.get("limit") ?? 25);
      const start = Number(url.searchParams.get("start") ?? 0);
      json({
        size: limit,
        limit,
        start,
        isLastPage: false,
        nextPageStart: start + limit,
        values: Array.from({ length: limit }, (_, index) => pullRequest(start + index + 1)),
      });
    } else if (url.pathname === "/rest/api/latest/projects/ACME/repos/site/pull-requests") {
      json({ size: 0, limit: 25, start: 0, isLastPage: true, values: [] });
    } else if (url.pathname === `${OWN}/pull-requests/1/comments` && req.method === "POST") {
      json({ id: 4417, version: 0, text: "read" }, 201);
    } else if (url.pathname === `${OWN}/redirect`) {
      res.writeHead(302, { location: "https://elsewhere.example/" });
      res.end();
    } else
      json({ errors: [{ message: "no such path", exceptionName: "NoSuchEntityException" }] }, 404);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanup.push(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const dataCenter = (owner?: string, name?: string) =>
    new DataCenterForge(
      { kind: "bitbucket", host: HOST, dir: "", ...(owner && name ? { owner, name } : {}) },
      { token: async () => KEY, serverUrl: base },
    );
  const forge = dataCenter("scm/prj", "app");
  // Every main-branch read names `main`.
  vi.spyOn(forge, "defaultBranch").mockResolvedValue("main");
  const dir = scratchDir("fm-dc-gateway-");
  const db = freshDatabase();
  cleanup.push(() => {
    db.close();
  });
  seedProject(db, {
    id: "repo-1",
    name: "app",
    path: dir,
    setupKind: "adopt",
    origin: `https://${HOST}/scm/prj/app.git`,
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
    accountForge: () => dataCenter(),
    readChecks: async () => "checks pending",
    now: () => 1234,
    sleep: async () => {},
  });
  const read = bindTool(GITHUB_READ_TOOL, { onGithubRead: (i) => service.read("task-1", i) });
  const write = bindTool(GITHUB_WRITE_TOOL, { onGithubWrite: (i) => service.write("task-1", i) });
  return { read, write, seen, tasks, dir, service };
}

describe("the gateway on a Bitbucket Data Center repository, through crewmate tools", () => {
  it("reads with the token, and its nextPath goes on from the server's next page start", async () => {
    const { read, seen } = await fixture();
    const answer = JSON.parse((await read.run({ path: `${OWN}/pull-requests?limit=2` })).text);
    expect(answer).toMatchObject({ status: 200, ok: true, requestId: "REQ-DC-1" });
    expect(answer.nextPath).toBe(`${OWN}/pull-requests?limit=2&start=2`);
    expect(seen[0]).toMatchObject({ path: `${OWN}/pull-requests?limit=2`, key: KEY });
    const next = JSON.parse((await read.run({ path: answer.nextPath })).text);
    expect(next.body.start).toBe(2);
    expect(next.body.values[0].id).toBe(3);
    expect(JSON.stringify([answer, next])).not.toContain(KEY);
    // No read list: the server's own answer decides what the token may see.
    expect(
      JSON.parse(
        (await read.run({ path: "/rest/api/latest/projects/ACME/repos/site/pull-requests" })).text,
      ),
    ).toMatchObject({ status: 200 });
  });

  it("refuses a path outside the server's REST API, before anything is sent", async () => {
    const { read, seen } = await fixture();
    expect((await read.run({ path: "/projects/PRJ/repos/app/browse" })).text).toContain(
      "/rest/api/latest/",
    );
    expect(seen).toEqual([]);
  });

  it("writes to its own repository at once and keeps a write anywhere else for the captain", async () => {
    const { write, seen, tasks } = await fixture();
    const sent = JSON.parse(
      (
        await write.run({
          method: "POST",
          // The project key is read in any case, as the server does.
          path: "/rest/api/latest/projects/prj/repos/app/pull-requests/1/comments",
          body: '{"text":"read"}',
        })
      ).text,
    );
    expect(sent).toMatchObject({ status: 201, ok: true, body: { id: 4417 } });
    expect(seen.at(-1)).toMatchObject({
      method: "POST",
      path: `${OWN}/pull-requests/1/comments`,
    });
    // Its own comment is kept, so the comment wake never wakes it about its own words.
    expect(tasks.get("task-1")?.delivery?.sentComments).toEqual([4417]);
    const before = seen.length;
    for (const path of [
      "/rest/api/latest/projects/ACME/repos/site/pull-requests",
      "/rest/api/latest/users/jane.doe/repos/app/pull-requests",
    ]) {
      expect((await write.run({ method: "POST", path, body: "{}" })).text).toContain("Not sent");
    }
    expect((await write.run({ method: "DELETE", path: OWN })).text).toContain(
      "Deleting the repository itself",
    );
    expect(seen).toHaveLength(before);
  });

  it.each([
    ["POST", `${OWN}/pull-requests/1/merge?version=0`, undefined],
    ["POST", "/rest/git/latest/projects/PRJ/repos/app/pull-requests/1/rebase", '{"version":0}'],
    ["POST", `${OWN}/pull-requests/1/auto-merge`, undefined],
    [
      "POST",
      "/rest/sync/latest/projects/PRJ/repos/app/synchronize",
      '{"refId":"refs/heads/main","action":"MERGE"}',
    ],
    ["PUT", OWN, '{"defaultBranch":"inf/fix-notes"}'],
    ["PUT", `${OWN}/default-branch`, '{"id":"refs/heads/inf/fix-notes"}'],
    [
      "DELETE",
      "/rest/branch-utils/latest/projects/PRJ/repos/app/branches",
      '{"name":"refs/heads/main"}',
    ],
    ["PUT", `${OWN}/browse/README.md`, '{"message":"edit","content":"x"}'],
  ] as const)("refuses a raw merge or main branch move: %s %s", async (method, path, body) => {
    const { write, seen } = await fixture();
    const answer = (await write.run({ method, path, ...(body ? { body } : {}) })).text;
    expect(answer).toContain("requires the merge card");
    expect(seen).toEqual([]);
  });

  it.each([
    ["PUT", "pull-requests/36", '{"description":"Raw replacement","version":2}'],
    ["POST", "pull-requests", '{"title":"fix","fromRef":{"id":"refs/heads/inf/fix-notes"}}'],
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

  it("refuses a release file in words saying the server keeps none, sending nothing", async () => {
    const { write, seen, dir } = await fixture();
    writeFileSync(join(dir, "app.dmg"), "data-center-bytes");
    const answer = (
      await write.run({ method: "POST", path: `${OWN}/attachments`, file: "app.dmg" })
    ).text;
    expect(answer).toContain("keeps no runs, logs or release files of its own");
    expect(seen).toEqual([]);
  });

  it("refuses a redirect without following it", async () => {
    const { read, seen } = await fixture();
    const answer = (await read.run({ path: `${OWN}/redirect` })).text;
    expect(answer).toContain("redirect");
    expect(seen).toHaveLength(1);
  });

  // Integrations reach every surface the same way: the Data Center row gets the same two actions.
  it("reaches the server through its integration row, and keeps a change for one click", async () => {
    const { service, tasks, seen } = await fixture();
    const integrations = new IntegrationsService({
      bindings: [
        forgeHostIntegration("bitbucket", {
          signIns: {
            view: () => ({
              signIns: [
                {
                  host: HOST,
                  name: HOST,
                  login: "jane.doe",
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
            loginOf: () => "jane.doe",
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
      store: new IntegrationSettingsStore(join(scratchDir("fm-dc-integration-"), "settings")),
      asks: {
        keep: (taskId, ask) => tasks.delivery.keepWriteAsk(taskId, ask),
        keepForFirstmate: (ask) => `integration-ask-${ask.id}`,
        take: (taskId, askId) => tasks.delivery.takeWriteAsk(taskId, askId),
        record: (taskId, askId, outcome) =>
          tasks.delivery.recordWriteAskOutcome(taskId, askId, outcome),
      },
    });
    const row = integrations.view().integrations[0];
    expect(row?.actions.map((action) => action.name)).toEqual(["read", "write"]);
    allowIntegrationReads(integrations);
    const crew = integrations.forTask("task-1");
    const why = "To perform the task’s requested action.";
    const id = row?.id ?? "";
    expect(
      JSON.parse(
        (
          await crew.call(
            id,
            "read",
            { path: "/rest/api/latest/projects/ACME/repos/site/pull-requests" },
            undefined,
            why,
          )
        ).text,
      ),
    ).toMatchObject({ status: 200, body: { isLastPage: true } });
    const before = seen.length;
    const change = {
      method: "POST",
      path: `${OWN}/pull-requests/1/comments`,
      body: '{"text":"read"}',
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
