import type { RepoView } from "@shared/repos";
import { describe, expect, it } from "vitest";
import type { ForgeChange, ForgePull } from "../src/core/forge/forge";
import { GitHubForge } from "../src/core/forge/providers/github/githubForge";
import { declareCheckAction, observeCheckRepair } from "../src/core/orchestrator/checkRepair";
import { MainRepairLabels } from "../src/core/orchestrator/mainRepairLabels";
import { seedTask } from "../src/core/tasks/seedTask";
import { TaskService } from "../src/core/tasks/taskService";
import { freshDatabase } from "./helpers/database";

const HEAD = "c".repeat(40);
const BRANCH = "fm/task-phone-repair";
const ISSUE = "/repos/infinitary-labs/infinitary/issues/526";
const repo: RepoView = {
  id: "infinitary",
  name: "infinitary",
  path: "/fixture/infinitary",
  setupKind: "clone",
  kind: "project",
  origin: "https://github.com/infinitary-labs/infinitary",
  host: { kind: "github", name: "github.com" },
  delivery: "direct-pr",
  autonomy: false,
  rigor: "standard",
  runsOn: null,
};

/** INF-1388 / main-repair-first: realistic phone-repair dependency, through the same
 * diagnosis writer and forge JSON interface the app uses; no title/prose inference. */
function setup() {
  const db = freshDatabase();
  const tasks = new TaskService({ db, strict: true });
  const owner = seedTask(tasks, {
    id: "phone-repair",
    title: "Repair the phone check",
    status: "running",
    repoId: repo.id,
    branch: BRANCH,
  });
  const waiter = seedTask(tasks, {
    id: "waiting-change",
    title: "Change waiting on phone checks",
    status: "running",
    repoId: repo.id,
  });
  let pull: ForgePull = {
    number: 526,
    state: "open",
    merged: false,
    branch: BRANCH,
    base: "main",
    headSha: HEAD,
    readiness: "clean",
  };
  let change: ForgeChange | null = {
    number: 526,
    url: "https://github.com/infinitary-labs/infinitary/pull/526",
    branch: BRANCH,
    headSha: HEAD,
  };
  const labels = new Set(["phone"]);
  const writes: { method: string; path: string; body?: string }[] = [];
  const problems: string[] = [];
  let fail = false;
  let loseWriteReply = false;
  const forge = new GitHubForge(
    {
      kind: "github",
      host: "github.com",
      owner: "infinitary-labs",
      name: "infinitary",
      dir: repo.path,
    },
    {
      token: async () => "fixture-sign-in",
      fetch: async (input, init) => {
        const url = new URL(String(input));
        const path = url.pathname;
        const method = init?.method ?? "GET";
        const body = typeof init?.body === "string" ? init.body : undefined;
        if (fail) throw new Error("host unavailable");
        if (path.endsWith("/pulls/526"))
          return Response.json({
            number: pull.number,
            state: pull.state,
            merged: pull.merged,
            head: { sha: HEAD, ref: BRANCH },
            base: { ref: "main" },
            mergeable_state: "clean",
          });
        if (path.endsWith("/pulls"))
          return Response.json(
            change
              ? [
                  {
                    number: 526,
                    html_url: change.url,
                    head: { sha: HEAD, ref: BRANCH },
                    base: { ref: "main" },
                    title: "fix: repair phone checks",
                    state: "open",
                  },
                ]
              : [],
          );
        if (method !== "GET") writes.push({ method, path, ...(body ? { body } : {}) });
        if (method === "POST") {
          expect(path).toBe(`${ISSUE}/labels`);
          for (const label of (JSON.parse(body ?? "") as { labels: string[] }).labels)
            labels.add(label);
        } else if (method === "DELETE") {
          expect(path).toBe(`${ISSUE}/labels/fixes-main`);
          labels.delete("fixes-main");
        } else expect(path).toBe(ISSUE);
        if (method === "POST" && loseWriteReply) {
          loseWriteReply = false;
          throw new Error("label reply lost");
        }
        return Response.json({ labels: [...labels].map((name) => ({ name })) });
      },
    },
  );
  const host = {
    tasks,
    repos: { get: () => repo },
    forgeFor: () => forge,
    problem: (_id: string, message: string) => problems.push(message),
  };
  const declare = () => {
    tasks.recordDelivery(waiter.id, {
      headSha: HEAD,
      ci: "red",
      ...observeCheckRepair(undefined, HEAD, [{ name: "phone", state: "failure" }], Date.now()),
    });
    const result = declareCheckAction(
      tasks,
      waiter.id,
      {
        diagnosis: {
          headSha: HEAD,
          check: "phone",
          classification: "baseline-blocked",
          evidence: "The same phone assertion fails on untouched main in the phone workflow.",
          dependencyTask: owner.id,
        },
      },
      Date.now(),
    );
    expect(result.text).toContain("Diagnosis recorded");
  };
  return {
    db,
    tasks,
    owner,
    waiter,
    labels,
    writes,
    problems,
    host,
    declare,
    service: new MainRepairLabels(host),
    opened: (open: boolean) => {
      change = open ? { number: 526, branch: BRANCH, headSha: HEAD, url: null } : null;
    },
    merged: () => {
      if (pull) pull = { ...pull, state: "closed", merged: true };
    },
    closed: () => {
      if (pull) pull = { ...pull, state: "closed" };
    },
    fail: (value: boolean) => {
      fail = value;
    },
    loseWriteReply: () => {
      loseWriteReply = true;
    },
  };
}

describe("main repairs' GitHub label (INF-1388)", () => {
  it("labels only a typed repair, preserves other labels, and removes its label at merge", async () => {
    const f = setup();
    try {
      await f.service.reconcile();
      expect(f.writes).toEqual([]);
      f.declare();
      f.tasks.recordDelivery(f.owner.id, { prNumber: 526 });
      await f.service.reconcile();
      await f.service.reconcile();
      expect([...f.labels]).toEqual(["phone", "fixes-main"]);
      expect(f.writes).toEqual([
        {
          method: "POST",
          path: `${ISSUE}/labels`,
          body: JSON.stringify({ labels: ["fixes-main"] }),
        },
      ]);
      // A dependent moving on does not strip the still-open repair's priority.
      f.tasks.recordDelivery(f.waiter.id, { headSha: "d".repeat(40), ci: "green" });
      await f.service.reconcile();
      expect(f.labels.has("fixes-main")).toBe(true);
      // Reclassifying a dependent must not lose the already-applied effect's cleanup.
      f.tasks.recordDelivery(f.waiter.id, {
        ciRepair: { failures: [], diagnoses: [], repairs: [] },
      });
      f.merged();
      await new MainRepairLabels(f.host).reconcile();
      await f.service.reconcile();
      expect([...f.labels]).toEqual(["phone"]);
      expect(f.writes.at(-1)).toEqual({ method: "DELETE", path: `${ISSUE}/labels/fixes-main` });
      expect(f.writes).toHaveLength(2);
      console.info("Main-repair lifecycle through the real GitHub forge (disposable transport):", {
        requests: f.writes,
        labelsAfterMerge: [...f.labels],
        savedReceipt: f.tasks.get(f.owner.id)?.delivery?.mainRepairLabel,
      });
    } finally {
      f.db.close();
    }
  });

  it("discovers a PR opened after the diagnosis and recovers merged cleanup after restart", async () => {
    const f = setup();
    try {
      f.opened(false);
      f.declare();
      await f.service.reconcile();
      expect(f.writes).toEqual([]);
      f.opened(true);
      await f.service.reconcile();
      expect(f.labels.has("fixes-main")).toBe(true);
      f.tasks.recordDelivery(f.owner.id, { prNumber: 526 });
      f.opened(false);
      f.merged();
      await new MainRepairLabels(f.host).reconcile();
      expect([...f.labels]).toEqual(["phone"]);
    } finally {
      f.db.close();
    }
  });

  it("reads back an uncertain label write before retry and leaves closed unmerged PRs alone", async () => {
    const f = setup();
    try {
      f.declare();
      f.fail(true);
      await f.service.reconcile();
      expect(f.problems).toHaveLength(1);
      expect(f.problems[0]).toContain("host unavailable");
      f.fail(false);
      f.loseWriteReply();
      await f.service.reconcile();
      expect(f.labels.has("fixes-main")).toBe(true);
      expect(f.problems.at(-1)).toContain("label reply lost");
      expect(f.tasks.get(f.owner.id)?.delivery?.mainRepairLabel?.number).toBe(526);
      await new MainRepairLabels(f.host).reconcile();
      expect(f.writes).toHaveLength(1);
      f.closed();
      await f.service.reconcile();
      expect(f.writes).toHaveLength(1);
    } finally {
      f.db.close();
    }
  });

  it("never labels a referenced PR instead of the repair's own branch", async () => {
    const f = setup();
    try {
      f.declare();
      f.tasks.recordDelivery(f.owner.id, {
        checkTarget: {
          id: "review",
          relationship: "referenced",
          kind: "github",
          headSha: HEAD,
          base: "main",
          method: "squash",
          title: "fix: repair phone checks",
          at: Date.now(),
          number: 526,
          branch: BRANCH,
          host: "github.com",
          owner: "infinitary-labs",
          name: "infinitary",
        },
      });
      await f.service.reconcile();
      expect(f.writes).toEqual([]);
    } finally {
      f.db.close();
    }
  });
});
