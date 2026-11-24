import { createHash } from "node:crypto";
import { symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ValidationForgeWrite } from "@shared/liveValidation";
import type { ForgeWriteAsk, IntegrationAsk } from "@shared/writeAsk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fixture,
  HEAD,
  INVENTED_CLONE_TOKEN,
  INVENTED_DOWNLOAD_TOKEN,
  RUN_LISTING,
  RUNS,
  repository,
  workflowRun,
} from "../../../../../tests/helpers/githubGatewayHarness";
import { allowIntegrationReads } from "../../../../../tests/helpers/integrationApprovals";
import { scratchDir } from "../../../../../tests/helpers/scratchDirs";
import { seedDelivery } from "../../../../../tests/helpers/taskDelivery";
import {
  forgeHostIntegration,
  githubIntegration,
  IntegrationSettingsStore,
  IntegrationsService,
} from "../../../integrations";
import { CLONE_TOKEN_NOTE, DOWNLOAD_TOKEN_NOTE } from "../../../orchestrator/githubGateway";
import { writeAskStrip } from "../../../orchestrator/requestStrips";
import { API_CALLS_PER_TASK, API_RESPONSE_MAX_BYTES } from "../../api";
import { GitHubForge } from "./githubForge";

afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

describe("the GitHub gateway through crewmate tools and the app's sign-in", () => {
  // INF-1965: Enterprise text descriptions have the same owner as native-media stories.
  describe.each(["github.com", "github.example.com"])("saved descriptions on %s", (host) => {
    // INF-285 F2: equivalent GitHub paths cannot bypass the saved-story barrier.
    it.each([
      ["POST", "pulls/"],
      ["POST", "%70ulls"],
      ["PATCH", "pulls/36/"],
      ["PATCH", "pulls/%33%36"],
      ["PATCH", "issues/36/"],
      ["PATCH", "issues/%33%36/"],
      // INF-285 G1: GitHub reads pulls/036 as pull request 36.
      ["PATCH", "pulls/036"],
      ["PATCH", "issues/036"],
    ] as const)("refuses a raw description write through %s %s", async (method, rest) => {
      const f = await fixture({ host });
      seedDelivery(f.tasks, "task-1", { prNumber: 36 });
      f.tasks.delivery.updateChangePresentation("task-1", () => ({ revisions: [], receipts: [] }));
      const result = await f.write.run({
        method,
        path: `/repos/octo/meter/${rest}`,
        body: JSON.stringify({
          title: "fix: meter",
          head: "fm/task-1",
          base: "main",
          body: "Raw replacement",
        }),
      });
      expect(result.text).toContain(
        method === "POST" ? "prepare_change and open_change" : "saved story with open_change",
      );
      expect(f.seen).toEqual([]);
    });
  });

  it("cannot bypass the saved-story publication barrier, while legacy descriptions remain writable (INF-92)", async () => {
    const f = await fixture();
    const opened = await f.write.run({
      method: "POST",
      path: "/repos/octo/meter/pulls",
      body: JSON.stringify({
        title: "fix: meter",
        head: "fm/task-1",
        base: "main",
        body: "No evidence yet",
      }),
    });
    expect(opened.text).toContain("prepare_change and open_change");
    expect(f.seen).toEqual([]);
    await f.write.run({
      method: "PATCH",
      path: "/repos/octo/meter/pulls/1",
      body: JSON.stringify({ body: "Legacy description" }),
    });
    expect(f.seen).toHaveLength(1);
    seedDelivery(f.tasks, "task-1", { prNumber: 1 });
    f.tasks.delivery.updateChangePresentation("task-1", () => ({ revisions: [], receipts: [] }));
    const changed = await f.write.run({
      method: "PATCH",
      path: "/repos/octo/meter/pulls/1",
      body: JSON.stringify({ body: "Bypass the story" }),
    });
    expect(changed.text).toContain("saved story with open_change");
    expect(f.seen).toHaveLength(1);
    // INF-169 F9: GitHub accepts the issues alias for a pull request body too.
    const alias = await f.write.run({
      method: "PATCH",
      path: "/repos/octo/meter/issues/1",
      body: JSON.stringify({ body: "Bypass through issues" }),
    });
    expect(alias.text).toContain("saved story with open_change");
    expect(f.seen).toHaveLength(1);
  });

  // INF-2546, under the captain's "several changes per task, one per PR":
  // each change keeps its own story, so a raw write cannot replace either
  // one's description, whichever change is current.
  it("refuses a raw description write to every change's published story, not only the current one's (INF-2546)", async () => {
    const f = await fixture();
    const published = (number: number) => ({
      revision: 1,
      head: HEAD,
      state: "confirmed" as const,
      region: "<!-- story -->",
      regionHash: "a".repeat(64),
      number,
    });
    seedDelivery(f.tasks, "task-1", { prNumber: 1 });
    f.tasks.delivery.updateChangePresentation("task-1", () => ({
      revisions: [],
      receipts: [],
      publication: published(1),
      published: published(1),
    }));
    // check_change(pull) makes the release pull request current; its story is its own.
    const release = {
      id: "mrrelease57",
      kind: "github" as const,
      host: "github.com",
      owner: "octo",
      name: "meter",
      number: 57,
      headSha: HEAD,
      base: "main",
      branch: "release-please--branches--main",
      method: "squash" as const,
      title: "chore(main): release 0.2.0",
      at: 2,
    };
    seedDelivery(f.tasks, "task-1", {
      mergeReviews: [release],
      checkTarget: release,
      prNumber: 57,
    });
    f.tasks.delivery.updateChangePresentation("task-1", () => ({
      revisions: [],
      receipts: [],
      publication: published(57),
      published: published(57),
    }));
    expect(f.tasks.get("task-1")?.delivery?.presentations).toHaveLength(1);
    for (const number of [1, 57]) {
      const refused = await f.write.run({
        method: "PATCH",
        path: `/repos/octo/meter/pulls/${number}`,
        body: JSON.stringify({ body: "Bypass the story" }),
      });
      expect(refused.text).toContain("saved story with open_change");
    }
    expect(f.seen).toEqual([]);
  });

  it("INF-125: checks the exact declared validation write at execution, including a kept write", async () => {
    const guard = vi.fn(
      async (_task: string, _request: string, _write: ValidationForgeWrite) => {},
    );
    const { service, tasks, write, writeWithoutProject, seen } = await fixture({
      beforeValidationWrite: guard,
    });
    const body = JSON.stringify({ body: "Disposable validation record" });
    const input = {
      method: "POST" as const,
      path: "/repos/octo/meter/issues/1/comments",
      body,
      validationEffect: "shared-1",
    };
    const exact = {
      host: "github.com",
      method: input.method,
      path: input.path,
      bodyDigest: createHash("sha256").update(body).digest("hex"),
    };
    await write.run(input);
    expect(guard).toHaveBeenNthCalledWith(1, "task-1", "shared-1", exact);
    expect(seen.filter((item) => item.method === "POST")).toHaveLength(1);
    await writeWithoutProject.run({ ...input, validationEffect: "shared-2" });
    expect(guard).toHaveBeenCalledTimes(1);
    const ask = tasks.get("task-2")?.delivery?.writeAsks?.at(-1) as ForgeWriteAsk | undefined;
    expect(ask?.validationEffect).toBe("shared-2");
    await service.sendAsk("task-2", ask!.id);
    expect(guard).toHaveBeenNthCalledWith(2, "task-2", "shared-2", exact);
    expect(seen.filter((item) => item.method === "POST")).toHaveLength(2);
    guard.mockRejectedValueOnce(new Error("The validation action is no longer approved."));
    expect((await write.run({ ...input, validationEffect: "shared-3" })).text).toContain(
      "no longer approved",
    );
    expect(seen.filter((item) => item.method === "POST")).toHaveLength(2);
  });

  it("reads a project route with the app's token and hands back status, request id and a next page", async () => {
    const { read, seen } = await fixture();
    const answer = JSON.parse(
      (await read.run({ path: "/repos/octo/meter/pulls?per_page=1" })).text,
    );
    expect(answer).toMatchObject({
      status: 200,
      ok: true,
      requestId: "REQ-1",
      nextPath: "/repos/octo/meter/pulls?page=2",
      body: [{ number: 1 }],
    });
    expect(seen[0]).toMatchObject({ method: "GET", auth: "Bearer gho_fixture_owned_by_app" });
    expect(JSON.stringify(answer)).not.toContain("gho_");
  });

  it("reads another repository, the repo list and search, and keeps a write there for the captain", async () => {
    const { read, write, seen } = await fixture();
    const other = JSON.parse((await read.run({ path: "/repos/acme/site/issues" })).text);
    expect(other).toMatchObject({ status: 200, body: [{ number: 5 }] });
    for (const path of ["/user/repos?per_page=100", "/search/repositories?q=site+in:name"]) {
      expect(JSON.parse((await read.run({ path })).text)).toMatchObject({ status: 200 });
    }
    expect(seen.map((request) => request.path)).toEqual([
      "/repos/acme/site/issues",
      "/user/repos?per_page=100",
      "/search/repositories?q=site+in%3Aname",
    ]);
    const before = seen.length;
    expect(
      (await write.run({ method: "POST", path: "/repos/acme/site/issues", body: "{}" })).text,
    ).toContain("Not sent: it goes outside this task's own project");
    expect(seen).toHaveLength(before);
  });

  it("gives a task with no project the reads through the github.com sign-in, and keeps its writes for the captain", async () => {
    const { readWithoutProject, writeWithoutProject, seen } = await fixture();
    const answer = JSON.parse((await readWithoutProject.run({ path: "/user/repos" })).text);
    expect(answer).toMatchObject({ status: 200, body: { items: [{ full_name: "acme/site" }] } });
    expect(seen[0]).toMatchObject({ auth: "Bearer gho_fixture_owned_by_app" });
    expect(
      (
        await writeWithoutProject.run({
          method: "POST",
          path: "/repos/acme/site/issues",
          body: "{}",
        })
      ).text,
    ).toContain("Not sent: this task has no project");
    expect(seen).toHaveLength(1);
  });

  it("INF-1007: an unrelated project's crew and first mate reach Enterprise through its own row", async () => {
    const { service, seen, tasks } = await fixture();
    const firstmateAsks: IntegrationAsk[] = [];
    const host = "github.example.com";
    const integrations = new IntegrationsService({
      bindings: [
        forgeHostIntegration("github-enterprise", {
          signIns: {
            presentHosts: () => [host],
            view: () => ({
              signIns: [
                {
                  host,
                  name: host,
                  login: "octo",
                  state: "ok",
                  projects: 0,
                  since: 1,
                  server: { kind: "github", name: "GitHub Enterprise" },
                },
              ],
              hosts: [],
              flow: null,
              ended: null,
            }),
            stateOf: () => "ok",
            loginOf: () => "octo",
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
        join(scratchDir("fm-enterprise-integrations-"), "settings"),
      ),
      asks: {
        keep: (taskId, ask) => tasks.delivery.keepWriteAsk(taskId, ask),
        keepForFirstmate: (ask) => {
          firstmateAsks.push(ask);
          return `integration-ask-${ask.id}`;
        },
        take: (taskId, askId) => tasks.delivery.takeWriteAsk(taskId, askId),
        record: (taskId, askId, outcome) =>
          tasks.delivery.recordWriteAskOutcome(taskId, askId, outcome),
      },
    });
    const row = integrations.view().integrations[0];
    if (!row) throw new Error("Enterprise row missing");
    expect(row).toMatchObject({ host, kind: "github-enterprise", name: host });
    allowIntegrationReads(integrations);
    const crew = integrations.forTask("task-1");
    expect(
      JSON.parse(
        (
          await crew.call(
            row.id,
            "read",
            { path: "/user/repos" },
            undefined,
            "To perform the task’s requested action.",
          )
        ).text,
      ),
    ).toMatchObject({ status: 200 });
    const change = {
      method: "POST",
      path: "/repos/octo/meter/issues/1/comments",
      body: JSON.stringify({ body: "Thanks" }),
    };
    const before = seen.length;
    expect(
      await crew.call(
        row.id,
        "write",
        change,
        undefined,
        "To perform the task’s requested action.",
      ),
    ).toMatchObject({ refused: "refused" });
    expect(seen).toHaveLength(before);
    const ask = tasks.get("task-1")?.delivery?.writeAsks?.at(-1);
    expect(ask).toMatchObject({ kind: "integration", integration: row.id });
    expect(await integrations.sendAsk("task-1", ask?.id ?? "")).toMatchObject({ ok: true });
    expect(
      JSON.parse(
        (
          await integrations.call(
            { kind: "firstmate" },
            row.id,
            "read",
            { path: "/user/repos" },
            "To perform the task’s requested action.",
          )
        ).text,
      ),
    ).toMatchObject({ status: 200 });
    // INF-1108: the first mate's change waits for the captain's click, then
    // goes through the Enterprise sign-in as the seat's own call.
    let count = seen.length;
    expect(
      await integrations.call(
        { kind: "firstmate" },
        row.id,
        "write",
        change,
        "To perform the task’s requested action.",
      ),
    ).toMatchObject({
      refused: "refused",
    });
    expect(seen).toHaveLength(count);
    expect(firstmateAsks).toEqual([
      expect.objectContaining({ by: "firstmate", integration: row.id }),
    ]);
    expect(
      await integrations.sendTaken("host-row", { ask: firstmateAsks[0]! }, "once"),
    ).toMatchObject({ ok: true, outcome: { kind: "ran" } });
    expect(seen.slice(count)).toEqual([
      expect.objectContaining({ method: "POST", path: change.path }),
    ]);
    count = seen.length;
    integrations.configure(row.id, { paused: true });
    expect(
      await crew.call(
        row.id,
        "read",
        { path: "/user/repos" },
        undefined,
        "To perform the task’s requested action.",
      ),
    ).toMatchObject({
      refused: "refused",
    });
    expect(seen).toHaveLength(count);
  });

  // INF-775 piece 1: GitHub as an integration, every caller through the github.com sign-in;
  // a read runs and a change asks the captain (the captain's q5). INF-1108: the
  // first mate's change waits for the same click, then goes as its own call.
  it("reaches GitHub through the integration: reads run, and a crewmate's or the first mate's change waits for the captain's click", async () => {
    const { service, seen, tasks } = await fixture();
    const firstmateAsks: IntegrationAsk[] = [];
    const integrations = new IntegrationsService({
      bindings: [
        githubIntegration({
          signIns: {
            stateOf: () => "ok",
            loginOf: () => "octo",
            checkNow: async () => {},
            signOut: () => {},
          },
          gateway: {
            read: (task, input, through) => service.read(task, input, through),
            write: (task, input, through) => service.write(task, input, through, true),
            readAsSeat: (input) => service.readAsSeat(input),
            writeAsSeat: (input) => service.writeAsSeat(input),
          },
        }),
      ],
      store: new IntegrationSettingsStore(join(scratchDir("fm-integrations-"), "integrations")),
      asks: {
        keep: (taskId, ask) => tasks.delivery.keepWriteAsk(taskId, ask),
        keepForFirstmate: (ask) => {
          firstmateAsks.push(ask);
          return `integration-ask-${ask.id}`;
        },
        take: (taskId, askId) => tasks.delivery.takeWriteAsk(taskId, askId),
        record: (taskId, askId, outcome) =>
          tasks.delivery.recordWriteAskOutcome(taskId, askId, outcome),
      },
    });
    allowIntegrationReads(integrations);
    const crewmate = integrations.forTask("task-1");
    const other = await crewmate.call(
      "GitHub",
      "read",
      { path: "/repos/acme/site/issues" },
      undefined,
      "To perform the task’s requested action.",
    );
    expect(JSON.parse(other.text)).toMatchObject({ status: 200, body: [{ number: 5 }] });

    // Even on the task's own project, a change through the integration is kept as an ask.
    const comment = {
      method: "POST",
      path: "/repos/octo/meter/issues/1/comments",
      body: JSON.stringify({ body: "Thanks" }),
    };
    const kept = await crewmate.call(
      "github",
      "write",
      comment,
      undefined,
      "To perform the task’s requested action.",
    );
    expect(kept.text).toContain("The app raised its approval card");
    // Kept is not sent, so it answers as a refusal (the captain's INF-824 choice).
    expect(kept.refused).toBe("refused");
    expect(seen.filter((request) => request.method === "POST")).toEqual([]);
    const ask = tasks.get("task-1")?.delivery?.writeAsks?.at(-1);
    expect(ask).toMatchObject({
      kind: "integration",
      action: "write",
      input: JSON.stringify(comment),
    });
    const click = await integrations.sendAsk("task-1", ask?.id ?? "");
    expect(click).toMatchObject({ ok: true, outcome: { kind: "ran" } });
    expect(seen.filter((request) => request.method === "POST")).toEqual([
      {
        method: "POST",
        path: comment.path,
        auth: "Bearer gho_fixture_owned_by_app",
        body: comment.body,
      },
    ]);

    // The first mate reads as its seat; its change is held for the host's
    // card, then sent through the same sign-in as the seat's own call.
    const firstmate = { kind: "firstmate" } as const;
    const repos = await integrations.call(
      firstmate,
      "github",
      "read",
      { path: "/user/repos" },
      "To perform the task’s requested action.",
    );
    expect(JSON.parse(repos.text)).toMatchObject({ status: 200 });
    let before = seen.length;
    const held = await integrations.call(
      firstmate,
      "github",
      "write",
      comment,
      "The captain asked me to thank the reporter.",
    );
    expect(held).toMatchObject({ refused: "refused" });
    expect(held.text).toContain("The app raised its approval card");
    expect(seen).toHaveLength(before);
    expect(firstmateAsks).toEqual([
      expect.objectContaining({ by: "firstmate", action: "write", input: JSON.stringify(comment) }),
    ]);
    expect(
      await integrations.sendTaken("host-row", { ask: firstmateAsks[0]! }, "once"),
    ).toMatchObject({ ok: true, outcome: { kind: "ran" } });
    expect(seen.slice(before)).toEqual([
      {
        method: "POST",
        path: comment.path,
        auth: "Bearer gho_fixture_owned_by_app",
        body: comment.body,
      },
    ]);
    // GitHub's refusal comes back as refused, never as sent.
    const rejected = { ...comment, path: "/repos/octo/meter/issues/2/comments" };
    await integrations.call(firstmate, "github", "write", rejected, "Thank the other reporter.");
    expect(
      await integrations.sendTaken("host-row", { ask: firstmateAsks[1]! }, "once"),
    ).toMatchObject({ ok: false, outcome: { kind: "refused" } });
    before = seen.length;

    // An action turned off in Settings reaches nobody.
    integrations.configure("github", { actions: { read: false } });
    expect(
      await crewmate.call(
        "github",
        "read",
        { path: "/user/repos" },
        undefined,
        "To perform the task’s requested action.",
      ),
    ).toMatchObject({
      refused: "refused",
    });
    expect(seen).toHaveLength(before);
  });

  it("keeps another project's and the account's writes, refuses GraphQL and invalid JSON before any request, and leaves an account read to GitHub", async () => {
    const { read, write, seen } = await fixture();
    expect(
      (await write.run({ method: "POST", path: "/repos/octo/other/issues", body: "{}" })).text,
    ).toContain("Not sent");
    expect(
      (
        await write.run({
          method: "POST",
          path: "/orgs/octo/actions/permissions",
        })
      ).text,
    ).toContain("Not sent");
    expect((await write.run({ method: "POST", path: "/graphql", body: "{}" })).text).toContain(
      "GraphQL",
    );
    expect((await read.run({ path: "/graphql" })).text).toContain("GraphQL");
    expect(
      (await write.run({ method: "POST", path: "/repos/octo/meter/issues", body: "{nope" })).text,
    ).toContain("JSON");
    expect(seen).toEqual([]);
    // No read list: GitHub's own answer decides what the sign-in may see.
    expect(JSON.parse((await read.run({ path: "/user/keys" })).text)).toMatchObject({
      status: 404,
    });
    expect(seen.map((request) => request.path)).toEqual(["/user/keys"]);
  });

  it.each(["verify.yml", "42"])(
    "dispatches %s with a caller-selected ref and inputs without changing checks or a rerun reservation",
    async (workflow) => {
      const { write, seen, tasks, readChecks, reserve } = await fixture();
      reserve();
      const before = tasks.get("task-1")?.delivery;
      const answer = (
        await write.run({
          method: "POST",
          path: `/repos/octo/meter/actions/workflows/${workflow}/dispatches`,
          body: JSON.stringify({
            ref: "release-candidate",
            inputs: { profile: "alpha", perf: true },
          }),
        })
      ).text;
      expect(answer).toContain('"status": 204');
      expect(JSON.parse(answer)).toMatchObject({ status: 204, ok: true });
      expect(answer).not.toContain("gho_");
      expect(seen).toEqual([
        {
          method: "POST",
          path: `/repos/octo/meter/actions/workflows/${workflow}/dispatches`,
          auth: "Bearer gho_fixture_owned_by_app",
          body: '{"ref":"release-candidate","inputs":{"profile":"alpha","perf":true}}',
        },
      ]);
      expect(readChecks).not.toHaveBeenCalled();
      expect(tasks.get("task-1")?.delivery).toEqual(before);
    },
  );

  it("passes project workflow controls, workflow files, settings and permissions through unchanged", async () => {
    const { write, read, seen } = await fixture();
    const requests = [
      { method: "POST" as const, path: "/repos/octo/meter/actions/runs/9/cancel" },
      { method: "PUT" as const, path: "/repos/octo/meter/actions/workflows/verify.yml/disable" },
      {
        method: "PUT" as const,
        path: "/repos/octo/meter/contents/.github/workflows/verify.yml",
        body: '{"branch":"topic","message":"update checks","content":"bmFtZTogdmVyaWZ5"}',
      },
      { method: "PATCH" as const, path: "/repos/octo/meter", body: '{"description":"Updated"}' },
      {
        method: "PUT" as const,
        path: "/repos/octo/meter/collaborators/someone",
        body: '{"permission":"pull"}',
      },
    ];
    for (const request of requests) {
      const answer = JSON.parse((await write.run(request)).text);
      expect(answer).toMatchObject({ status: 200, ok: true });
    }
    expect(
      JSON.parse((await read.run({ path: "/repos/octo/meter/actions/secrets" })).text),
    ).toMatchObject({ status: 200, ok: true });
    expect(seen.map(({ method, path, body }) => ({ method, path, body }))).toEqual([
      ...requests.flatMap((request) => [
        ...(request.path.includes("/contents/")
          ? [{ method: "GET", path: "/repos/octo/meter", body: "" }]
          : []),
        { ...request, body: request.body ?? "" },
      ]),
      { method: "GET", path: "/repos/octo/meter/actions/secrets", body: "" },
    ]);
  });

  it("reports missing sign-in without sending a dispatch", async () => {
    const { write, seen } = await fixture({ signedOut: true });
    const answer = (
      await write.run({
        method: "POST",
        path: "/repos/octo/meter/actions/workflows/verify.yml/dispatches",
        body: '{"ref":"fm/task-1"}',
      })
    ).text;
    expect(answer).toContain("sign-in");
    expect(seen).toEqual([]);
  });

  it.each([401, 403, 404, 422, 500])(
    "does not retry a dispatch GitHub refuses with %s",
    async (dispatchStatus) => {
      const { write, seen, readChecks, onSignInRejected } = await fixture({ dispatchStatus });
      const answer = (
        await write.run({
          method: "POST",
          path: "/repos/octo/meter/actions/workflows/verify.yml/dispatches",
          body: '{"ref":"fm/task-1"}',
        })
      ).text;
      expect(answer).not.toContain("accepted");
      expect(seen).toHaveLength(1);
      expect(readChecks).not.toHaveBeenCalled();
      expect(JSON.parse(answer)).toMatchObject({ status: dispatchStatus, ok: false });
      expect(onSignInRejected).toHaveBeenCalledTimes(dispatchStatus === 401 ? 1 : 0);
    },
  );

  it("writes JSON to the project and answers a refusal from GitHub as a status, not a failure", async () => {
    const { write, seen } = await fixture();
    const created = JSON.parse(
      (
        await write.run({
          method: "POST",
          path: "/repos/octo/meter/issues/1/comments",
          body: '{"body":"hi"}',
        })
      ).text,
    );
    expect(created).toMatchObject({ status: 201, ok: true, body: { id: 7 } });
    expect(seen[0]).toMatchObject({ method: "POST", body: '{"body":"hi"}' });
    const invalid = JSON.parse(
      (await write.run({ method: "POST", path: "/repos/octo/meter/issues/2/comments", body: "{}" }))
        .text,
    );
    expect(invalid).toMatchObject({
      status: 422,
      ok: false,
      body: { message: "Validation Failed" },
    });
  });

  // Intent: INF-4445's approved plan - the crewmate's replies appear under the same sign-in as
  // the captain's own comments, so the task keeps their ids and the comment reading never wakes it
  // about its own words.
  it("keeps the id of a comment the crewmate sent, on any project, and none for one GitHub refused", async () => {
    const { write, writeWithoutProject, service, tasks } = await fixture();
    await write.run({
      method: "POST",
      path: "/repos/octo/meter/issues/1/comments",
      body: '{"body":"hi"}',
    });
    await write.run({ method: "POST", path: "/repos/octo/meter/issues/2/comments", body: "{}" });
    expect(tasks.get("task-1")?.delivery?.sentComments).toEqual([7]);
    // A reply on a project that is not the task's own, such as a fork's pull request, is its
    // crewmate's words too once the captain's click sends it.
    await writeWithoutProject.run({
      method: "POST",
      path: "/repos/octo/meter/issues/1/comments",
      body: '{"body":"hi"}',
    });
    const ask = tasks.get("task-2")?.delivery?.writeAsks?.at(-1) as ForgeWriteAsk | undefined;
    await service.sendAsk("task-2", ask?.id ?? "");
    expect(tasks.get("task-2")?.delivery?.sentComments).toEqual([7]);
  });

  it("reads a private file without saving GitHub's temporary download token", async () => {
    // Intent: a crewmate's read of a private GitHub file no longer saves the
    // download token (INF-206). Tokens already saved are left alone.
    const { read } = await fixture();
    const answer = JSON.parse(
      (await read.run({ path: "/repos/octo/meter/contents/README.md" })).text,
    );
    expect(answer).toMatchObject({
      status: 200,
      ok: true,
      note: DOWNLOAD_TOKEN_NOTE,
      body: {
        type: "file",
        path: "README.md",
        content: "aGVsbG8=",
        html_url: "https://github.com/octo/meter/blob/main/README.md",
        download_url: "https://raw.githubusercontent.com/octo/meter/main/README.md",
      },
    });
    expect(JSON.stringify(answer)).not.toContain(INVENTED_DOWNLOAD_TOKEN);
    expect(JSON.stringify(answer)).not.toContain("token=");
    const plain = JSON.parse((await read.run({ path: "/repos/octo/meter/pulls?per_page=1" })).text);
    expect(plain.note).toBeUndefined();
    expect(plain.body).toEqual([{ number: 1 }]);

    const listing = JSON.parse((await read.run({ path: "/repos/octo/meter/contents/src" })).text);
    expect(listing.body).toEqual([
      expect.objectContaining({
        path: "src/secret.ts",
        download_url: "https://raw.githubusercontent.com/octo/meter/main/src/secret.ts",
      }),
      expect.objectContaining({
        path: "src/public.ts",
        download_url: "https://raw.githubusercontent.com/octo/meter/main/src/public.ts",
      }),
    ]);
    expect(JSON.stringify(listing)).not.toContain(INVENTED_DOWNLOAD_TOKEN);
  });

  it("reads a private repository without its temporary clone token", async () => {
    // Intent: a GitHub read leaves out the private repository's clone
    // credential before a crewmate or a saved transcript sees it (INF-652).
    const { read } = await fixture();
    const answer = JSON.parse((await read.run({ path: "/repos/octo/meter" })).text);
    const { temp_clone_token: _token, ...rest } = repository("meter", "private");
    expect(answer).toMatchObject({ status: 200, ok: true, note: CLONE_TOKEN_NOTE });
    expect(answer.body).toEqual(rest);
    expect(JSON.stringify(answer)).not.toContain(INVENTED_CLONE_TOKEN);

    // A public repository's empty field holds no credential, so its answer is GitHub's own.
    const open = JSON.parse((await read.run({ path: "/repos/octo/lamp" })).text);
    expect(open.note).toBeUndefined();
    expect(open.body).toEqual(repository("lamp", "public"));
  });

  it("refuses an answer over 256 KiB and a redirect, and never echoes the token", async () => {
    const { read } = await fixture({ oversize: true });
    expect((await read.run({ path: "/repos/octo/meter/big" })).text).toContain("256 KiB");
    const redirected = (await read.run({ path: "/repos/octo/meter/redirect" })).text;
    expect(redirected).toContain("redirect");
    expect(redirected).not.toContain("gho_");
  });

  // INF-733 (INF-721 friction 7): 30 oversized reads were refused in a day, each sending the crewmate to guess a smaller page.
  it("reads a run listing over 256 KiB again at the largest page that fits, and its nextPath goes on from there", async () => {
    const { read, seen } = await fixture();
    const answer = JSON.parse(
      (await read.run({ path: "/repos/octo/meter/actions/runs?per_page=50" })).text,
    );
    const served = answer.body.workflow_runs.length;
    expect(answer).toMatchObject({ status: 200, ok: true });
    expect(served).toBeGreaterThan(0);
    expect(served).toBeLessThan(50);
    const ids = (runs: { id: number }[]) => runs.map((run) => run.id);
    expect(ids(answer.body.workflow_runs)).toEqual(ids(RUNS.slice(0, served)));
    const bytes = (count: number) =>
      Buffer.byteLength(JSON.stringify(RUN_LISTING(RUNS.slice(0, count))));
    expect(bytes(served)).toBeLessThanOrEqual(API_RESPONSE_MAX_BYTES);
    expect(bytes(served + 1)).toBeGreaterThan(API_RESPONSE_MAX_BYTES);
    expect(answer.note).toContain("at per_page=50 exceeds the 256 KiB read limit");
    expect(answer.note).toContain(`GitHub's page at per_page=${served}`);
    expect(seen.map((request) => request.path)).toEqual([
      "/repos/octo/meter/actions/runs?per_page=50",
      `/repos/octo/meter/actions/runs?per_page=${served}`,
    ]);

    const next = JSON.parse((await read.run({ path: answer.nextPath })).text);
    expect(next.status).toBe(200);
    expect(next.note).toBeUndefined();
    expect(ids(next.body.workflow_runs)).toEqual(ids(RUNS.slice(served, served * 2)));
  });

  it("keeps the asked page's place in the list when it reads a smaller page", async () => {
    const { read, seen } = await fixture();
    const answer = JSON.parse(
      (await read.run({ path: "/repos/octo/meter/actions/runs?per_page=50&page=2" })).text,
    );
    const served = answer.body.workflow_runs.length;
    expect(50 % served).toBe(0);
    expect(answer.body.workflow_runs[0].id).toBe(RUNS[50]?.id);
    expect(answer.body.workflow_runs.at(-1).id).toBe(RUNS[50 + served - 1]?.id);
    expect(seen.at(-1)?.path).toBe(
      `/repos/octo/meter/actions/runs?per_page=${served}&page=${50 / served + 1}`,
    );
  });

  it("refuses an answer no smaller page would shrink, and says why", async () => {
    const f = await fixture();
    const refusals = [
      ["/repos/octo/meter/compare/v0.4.1...main?per_page=1", "not a list", 1],
      ["/repos/octo/meter/actions/workflows/phone.yml/runs", "first item alone", 1],
      ["/repos/octo/meter/stats/contributors?per_page=100", "per_page does not page it", 2],
    ] as const;
    for (const [path, why, calls] of refusals) {
      const before = f.seen.length;
      const text = (await f.read.run({ path })).text;
      expect(text, path).toContain("Cannot call GitHub (refused): The answer exceeds the 256 KiB");
      expect(text, path).toContain(why);
      expect(f.seen.length - before, path).toBe(calls);
    }
  });

  it("answers a task with no sign-in as the sign-in failure, not a crash", async () => {
    const forge = new GitHubForge(
      { kind: "github", host: "github.com", owner: "octo", name: "meter", dir: "/unused" },
      { apiBaseUrl: "http://127.0.0.1:1", token: async () => undefined },
    );
    await expect(forge.api.call("GET", "/repos/octo/meter/pulls")).rejects.toMatchObject({
      failure: "sign-in",
    });
  });

  it("records an existing rerun reservation and watches checks without vetoing another project API request", async () => {
    const { write, tasks, seen, readChecks, reserve } = await fixture();
    const rerun = {
      method: "POST" as const,
      path: "/repos/octo/meter/actions/runs/9/rerun-failed-jobs",
    };
    reserve();
    const answer = (await write.run(rerun)).text;
    expect(seen).toHaveLength(1);
    expect(answer).toContain('"status": 201');
    expect(answer).toContain("reading 1");
    expect(readChecks).toHaveBeenCalledTimes(1);
    expect(tasks.get("task-1")?.delivery?.ciWatch).toBeDefined();
    expect(tasks.get("task-1")?.delivery?.ciRepair?.rerun?.startedAt).toBe(1234);

    const delivery = tasks.get("task-1")?.delivery?.ciRepair;
    expect((await write.run(rerun)).text).toContain('"status": 201');
    expect(seen).toHaveLength(2);
    expect(tasks.get("task-1")?.delivery?.ciRepair).toEqual(delivery);
  });

  it("allows a rerun without a reservation and does not invent repair history", async () => {
    const { write, tasks, seen, readChecks } = await fixture();
    expect(
      (
        await write.run({
          method: "POST",
          path: "/repos/octo/meter/actions/runs/9/rerun-failed-jobs",
        })
      ).text,
    ).toContain('"status": 201');
    expect(seen).toHaveLength(1);
    expect(readChecks).toHaveBeenCalledTimes(1);
    expect(tasks.get("task-1")?.delivery?.ciWatch).toBeDefined();
    expect(tasks.get("task-1")?.delivery?.ciRepair).toBeUndefined();
  });

  it("does not spend a reservation from an older head when a project rerun is accepted", async () => {
    const { write, tasks, reserve } = await fixture();
    reserve();
    const ledger = structuredClone(tasks.get("task-1")?.delivery?.ciRepair);
    if (!ledger?.rerun) throw new Error("fixture has no reservation");
    ledger.rerun.headSha = "b".repeat(40);
    seedDelivery(tasks, "task-1", { ciRepair: ledger });
    expect(
      (
        await write.run({
          method: "POST",
          path: "/repos/octo/meter/actions/runs/9/rerun-failed-jobs",
        })
      ).text,
    ).toContain('"status": 201');
    expect(tasks.get("task-1")?.delivery?.ciRepair).toEqual(ledger);
  });

  it("reads the checks again while the rerun is not yet running, then says so if it never shows", async () => {
    const first = await fixture();
    first.reserve();
    first.armOn(3);
    const rerun = {
      method: "POST" as const,
      path: "/repos/octo/meter/actions/runs/9/rerun-failed-jobs",
    };
    const answer = (await first.write.run(rerun)).text;
    expect(first.readChecks).toHaveBeenCalledTimes(3);
    expect(answer).toContain("reading 3");
    expect(answer).not.toContain("did not read as running");

    const second = await fixture();
    second.reserve();
    second.armOn(99);
    const late = (await second.write.run(rerun)).text;
    expect(second.readChecks).toHaveBeenCalledTimes(3);
    expect(late).toContain("did not read as running yet");
  });

  // INF-1428's own part (INF-1670 piece 2, the captain's Approve and build): a
  // check run a crewmate starts is watched even when its start returned no
  // run number - a dispatch without "return_run_details", as older GitHub
  // Enterprise servers answer every dispatch.
  it("watches the run a dispatch started when no run number came back, and never guesses between two new runs", async () => {
    const watchRun = vi.fn((_taskId: string, runId: number) => `The app watches run ${runId}.`);
    const { write, seen } = await fixture({ watchRun });
    const dispatch = {
      method: "POST" as const,
      path: "/repos/octo/meter/actions/workflows/verify.yml/dispatches",
      body: JSON.stringify({ ref: "fm/task-1", inputs: { profile: "alpha" } }),
    };
    const earlier = workflowRun(7).id;
    const answer = (await write.run(dispatch)).text;
    expect(answer).toContain('"status": 204');
    expect(watchRun).toHaveBeenCalledWith("task-1", earlier + 1);
    expect(answer).toContain(
      `The dispatch returned no run number; run ${earlier + 1} is the one new dispatched run of that workflow on that ref since it was sent. The app watches run ${earlier + 1}.`,
    );
    const listing =
      "GET /repos/octo/meter/actions/workflows/verify.yml/runs?event=workflow_dispatch&per_page=20";
    expect(seen.map(({ method, path }) => `${method} ${path}`)).toEqual([
      listing,
      `POST ${dispatch.path}`,
      listing,
    ]);

    seen.length = 0;
    await write.run({
      ...dispatch,
      body: JSON.stringify({ ref: "fm/task-1", return_run_details: true }),
    });
    expect(watchRun).toHaveBeenLastCalledWith("task-1", 39631227000);
    expect(seen.map(({ method, path }) => `${method} ${path}`)).toEqual([`POST ${dispatch.path}`]);

    // Someone else's dispatch on the same ref lands beside it: no run is watched.
    const raced = vi.fn((_taskId: string, runId: number) => `The app watches run ${runId}.`);
    const race = await fixture({ watchRun: raced, raceDispatch: true });
    const unwatched = (await race.write.run(dispatch)).text;
    expect(raced).not.toHaveBeenCalled();
    expect(unwatched).toContain(
      "The write was accepted, but it supplied no run number to watch. Find the run with github_read, then call read_workflow with runId alone. Do not repeat the write.",
    );
  });

  // INF-729 way D, the captain's choice: a nightly check task only answers, and its
  // run request waited on his click from 4:01 AM to 9:03 AM.
  it("sends a task that only answers' run start and rerun on its own project at once and watches the run, while every other write still asks", async () => {
    const watchRun = vi.fn((_taskId: string, runId: number) => `The app watches run ${runId}.`);
    const { writeAs, seen, readChecks } = await fixture({ watchRun });
    const answerTask = writeAs("task-3");
    const started = (
      await answerTask.run({
        method: "POST",
        path: "/repos/octo/meter/actions/workflows/verify.yml/dispatches",
        body: JSON.stringify({
          ref: "main",
          inputs: { profile: "alpha" },
          return_run_details: true,
        }),
      })
    ).text;
    expect(started).toContain('"status": 200');
    expect(started).toContain("The app watches run 39631227000.");
    expect(watchRun).toHaveBeenCalledWith("task-3", 39631227000);
    const rerun = (
      await answerTask.run({
        method: "POST",
        path: "/repos/octo/meter/actions/runs/9/rerun-failed-jobs",
      })
    ).text;
    expect(rerun).toContain('"status": 201');
    expect(watchRun).toHaveBeenCalledWith("task-3", 9);
    expect(readChecks).not.toHaveBeenCalled();
    expect(seen.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "POST /repos/octo/meter/actions/workflows/verify.yml/dispatches",
      "POST /repos/octo/meter/actions/runs/9/rerun-failed-jobs",
    ]);

    // Cancelling a run, any other write to its own project, and a start elsewhere still ask.
    const asks = [
      { method: "POST" as const, path: "/repos/octo/meter/actions/runs/9/cancel" },
      { method: "POST" as const, path: "/repos/octo/meter/issues/1/comments", body: "{}" },
      {
        method: "PUT" as const,
        path: "/repos/octo/meter/actions/workflows/verify.yml/disable",
      },
    ];
    for (const ask of asks) {
      expect((await answerTask.run(ask)).text).toContain(
        "Not sent: this task only answers, so every write it makes but a run start or rerun on its own project asks the captain",
      );
    }
    expect(
      (
        await answerTask.run({
          method: "POST",
          path: "/repos/acme/site/actions/workflows/verify.yml/dispatches",
          body: '{"ref":"main"}',
        })
      ).text,
    ).toContain("Not sent: this task only answers");

    // Through the captain's github.com sign-in, a run start still asks.
    expect(
      (
        await writeAs("task-4").run({
          method: "POST",
          path: "/repos/octo/meter/actions/workflows/verify.yml/dispatches",
          body: '{"ref":"main"}',
        })
      ).text,
    ).toContain("Not sent: this task has no project");
    expect(seen).toHaveLength(2);
  });

  it("stops a task at its call budget", async () => {
    const { read, seen } = await fixture();
    for (let call = 0; call < 200; call++) await read.run({ path: "/repos/octo/meter/pulls" });
    expect(seen).toHaveLength(200);
    expect((await read.run({ path: "/repos/octo/meter/pulls" })).text).toContain(
      "200 GitHub calls",
    );
    expect(seen).toHaveLength(200);
  });

  // INF-2334 piece 1: a panel is no task and no seat, so its reads through
  // the integration spend no allowance; the action's rule bounds them.
  it("reads as a panel past a task's whole budget, through the integration", async () => {
    const { service, seen } = await fixture();
    const integrations = new IntegrationsService({
      bindings: [
        githubIntegration({
          signIns: {
            stateOf: () => "ok",
            loginOf: () => "octo",
            checkNow: async () => {},
            signOut: () => {},
          },
          gateway: {
            read: (task, input, through) => service.read(task, input, through),
            write: (task, input, through) => service.write(task, input, through, true),
            readAsSeat: (input) => service.readAsSeat(input),
            writeAsSeat: (input) => service.writeAsSeat(input),
            readAsPanel: (panel, input) => service.readAsPanel(panel, input),
            writeAsPanel: (panel, input) => service.writeAsPanel(panel, input),
          },
        }),
      ],
      store: new IntegrationSettingsStore(join(scratchDir("fm-panel-reads-"), "integrations")),
    });
    allowIntegrationReads(integrations);
    const panel = integrations.forPanel({
      key: "installed:pr-checks",
      title: "PR checks",
      uses: [{ integration: "github", actions: ["read"], why: "Shows your pull requests." }],
    });
    for (let call = 0; call <= API_CALLS_PER_TASK; call++) {
      const answer = await panel.call("github", "read", { path: "/repos/acme/site/issues" });
      expect(answer.refused, `call ${call}`).toBeUndefined();
    }
    expect(seen).toHaveLength(API_CALLS_PER_TASK + 1);
  });

  it("INF-125: refuses to substitute release-file bytes for an approved JSON validation write", async () => {
    const guard = vi.fn(async () => {});
    const { write, seen, dir, tasks } = await fixture({ beforeValidationWrite: guard });
    writeFileSync(join(dir, "app.dmg"), "release-bytes");
    const result = await write.run({
      method: "POST",
      path: "/repos/octo/meter/releases/9/assets",
      file: "app.dmg",
      validationEffect: "shared-1",
    });
    expect(result.text).toContain("not a release file");
    expect(seen).toEqual([]);
    expect(guard).not.toHaveBeenCalled();
    expect(tasks.get("task-1")?.delivery?.writeAsks ?? []).toEqual([]);
  });

  it("streams a release file to GitHub's upload address and keeps another project's file for the captain", async () => {
    const { write, writeWithoutProject, seen, types, dir, service, tasks } = await fixture();
    writeFileSync(join(dir, "app.dmg"), "release-bytes");
    const before = seen.length;
    const sent = JSON.parse(
      (
        await write.run({
          method: "POST",
          path: "/repos/octo/meter/releases/9/assets",
          file: "app.dmg",
        })
      ).text,
    );
    expect(sent).toMatchObject({
      status: 201,
      ok: true,
      body: { id: 9, name: "app.dmg", state: "uploaded" },
    });
    expect(seen[before]).toMatchObject({
      method: "POST",
      path: "/repos/octo/meter/releases/9/assets?name=app.dmg",
      auth: "Bearer gho_fixture_owned_by_app",
      body: "release-bytes",
    });
    expect(types[before]).toBe("application/x-apple-diskimage");
    expect(JSON.stringify(sent)).not.toContain("gho_");

    const foreign = (
      await write.run({
        method: "POST",
        path: "https://evil.example/repos/octo/meter/releases/9/assets?name=app.dmg",
        file: "app.dmg",
      })
    ).text;
    expect(foreign).toContain("accepted only on GitHub's upload address");
    expect(seen).toHaveLength(before + 1);

    const kept = (
      await write.run({
        method: "POST",
        path: "/repos/acme/site/releases/3/assets?name=app.dmg",
        file: "app.dmg",
      })
    ).text;
    expect(kept).toContain("Not sent: it goes outside this task's own project");
    expect(seen).toHaveLength(before + 1);
    const askId = kept.match(/ask (wa[a-z0-9]+)/)?.[1];
    expect(askId).toBeTruthy();
    const click = await service.sendAsk("task-1", askId ?? "");
    expect(click.ok).toBe(true);
    expect(click.answer).toContain("uploaded");
    expect(seen.at(-1)).toMatchObject({
      path: "/repos/acme/site/releases/3/assets?name=app.dmg",
      body: "release-bytes",
    });
    const ask = tasks.get("task-1")?.delivery?.writeAsks?.[0] as ForgeWriteAsk | undefined;
    expect(ask?.file).toBe("app.dmg");
    expect(ask && writeAskStrip(ask)).toContain(
      "A file from this task's working copy. It is read only when you click.",
    );

    expect(
      (
        await writeWithoutProject.run({
          method: "POST",
          path: "/repos/octo/meter/releases/9/assets",
          file: "app.dmg",
        })
      ).text,
    ).toContain("no working copy");
  });

  it("refuses a link, a path outside the working copy, and a missing release file", async () => {
    const { write, seen, dir } = await fixture();
    symlinkSync(join(dir, "app.dmg"), join(dir, "linked.dmg"));
    writeFileSync(join(dir, "app.dmg"), "release-bytes");
    const refused = (file: string, body?: string) =>
      write.run({
        method: "POST",
        path: "/repos/octo/meter/releases/9/assets",
        file,
        ...(body !== undefined ? { body } : {}),
      });
    expect((await refused("linked.dmg")).text).toContain("is a link");
    expect((await refused("../secret")).text).toContain("never a link");
    expect((await refused("missing.dmg")).text).toContain("There is no missing.dmg");
    expect(
      (
        await write.run({
          method: "POST",
          path: "/repos/octo/meter/issues",
          file: "app.dmg",
          body: "{}",
        })
      ).text,
    ).toContain("leave body out");
    expect(seen).toHaveLength(0);
  });
});

// INF-1430 piece 2: named operational writes in its own project do not ask;
// writes elsewhere keep the same captain-only boundary as code changes.
it("sends an operation's own-project write but holds an outside write", async () => {
  const { writeAs, seen } = await fixture();
  const operation = writeAs("task-operation");
  const sent = await operation.run({
    method: "POST",
    path: "/repos/octo/meter/actions/runs/9/cancel",
  });
  expect(sent.text).not.toContain("Not sent");
  expect(seen.map(({ method, path }) => `${method} ${path}`)).toContain(
    "POST /repos/octo/meter/actions/runs/9/cancel",
  );
  const before = seen.length;
  expect(
    (
      await operation.run({
        method: "POST",
        path: "/repos/acme/site/issues/1/comments",
        body: '{"body":"Ready"}',
      })
    ).text,
  ).toContain("Not sent");
  expect(seen).toHaveLength(before);
});
