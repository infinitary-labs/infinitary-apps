/**
 * An override that cites a heard direction (INF-6987's approved plan, piece
 * A2; docs/delivery-rigor.md, "The override"): update_task override may cite
 * a heard, current direction of the task's project by its d: id, on any
 * turn, a scheduled check's included; the override ends when that direction
 * is revised or retired, at once or at the next start; and the captain's own
 * words stand over it, both ways. Each case drives the first mate's own
 * update_task over the real knowledge collection and task record.
 */

import type { WorkspaceService } from "@core/workspace/workspaceService";
import { overridePasses } from "@shared/holds";
import { describe, expect, it, vi } from "vitest";
import { setup as crewSetup, fakeCrewmate, reboot } from "../../../tests/helpers/crewHarness";
import {
  bindDirections,
  fakeClockEachTest,
  setup,
  tick,
  toolsOf,
} from "../../../tests/helpers/firstmateHarness";
import { KnowledgeService } from "../knowledge/knowledgeService";
import { seedTask } from "../tasks/seedTask";
import type { TaskService } from "../tasks/taskService";
import type { RepoRegistry } from "../workspace/repoRegistry";
import { DIRECTION_REFUSED, OVERRIDE_REFUSED } from "./captainOverrides";

fakeClockEachTest();

type Harness = ReturnType<typeof setup>;

const RULE = "Release checks on Harbor may run and merge without asking me.";
const DEPLOY = "Deploy checks on Harbor may run without asking me.";

/** The first mate's update_task override, answering its text. */
async function override(
  h: Harness,
  task: string,
  value: { holds: string[]; until: "version" | "task"; from?: string },
): Promise<string> {
  const result = await toolsOf(h.specs)
    .get("update_task")
    ?.execute(`override-${task}`, { task, override: value });
  return result?.content[0]?.text ?? "";
}

/** A direction the captain's own words were heard for this turn, as app_change saves one. */
function heard(knowledge: KnowledgeService, id: string, scope: string, text: string) {
  knowledge.directions.change({
    op: "add",
    id,
    scope,
    text,
    reason: "The captain said so.",
    heard: { from: "turn" },
  });
}

/** The newest timeline line on a task whose text the check names. */
function line(tasks: TaskService, taskId: string, text: string) {
  return tasks.timeline(taskId).findLast((event) => event.text === text);
}

/** A first mate over a Harbor project whose crew reads the same knowledge, with one idle task. */
async function harbor(): Promise<{ h: Harness; knowledge: KnowledgeService; repo: string }> {
  const h = setup({ silent: true, crewKnowledge: true });
  const { repo } = await h.repos.setup({ kind: "init", name: "harbor" });
  for (const [id, title] of [
    ["t-release", "Release the harbor build"],
    ["t-deploy", "Deploy the harbor build"],
  ] as const)
    seedTask(h.tasks, { id, title, status: "idle", repoId: repo.id });
  return { h, knowledge: h.knowledge as KnowledgeService, repo: repo.id };
}

describe("an override citing a heard direction", () => {
  it("records the direction's words with its id and revision, and names it on the row", async () => {
    const { h, knowledge, repo } = await harbor();
    heard(knowledge, "release-checks", repo, RULE);
    await h.agent.converse("Use my Harbor release rule for this release's checks.");

    const answer = await override(h, "t-release", {
      holds: ["checks"],
      until: "task",
      from: "d:release-checks",
    });
    expect(answer).toContain("from the captain's direction d:release-checks (revision 1)");
    const delivery = h.tasks.get("t-release")?.delivery;
    expect(delivery?.override).toMatchObject({
      words: RULE,
      holds: ["checks"],
      until: "task",
      direction: { id: "release-checks", revision: 1 },
    });
    expect(overridePasses(delivery, "checks")).toBe(true);
    expect(
      line(
        h.tasks,
        "t-release",
        `Your direction d:release-checks passes the holds your first mate named for the rest of this task, until it is revised or retired: “${RULE}”`,
      ),
    ).toMatchObject({ kind: "note", actor: "firstmate" });
  });

  it("refuses a direction that is no yes on the task, and records nothing", async () => {
    const { h, knowledge, repo } = await harbor();
    const { repo: other } = await h.repos.setup({ kind: "init", name: "lighthouse" });
    knowledge.directions.change({
      op: "add",
      id: "own-judgment",
      scope: repo,
      text: "Release checks may merge without asking.",
      reason: "The first mate's reading of an earlier choice.",
    });
    heard(knowledge, "everywhere", "captain", "Merge on green everywhere.");
    heard(knowledge, "lighthouse", other.id, "Lighthouse checks may merge without asking.");
    heard(knowledge, "retired", repo, "Retired rule.");
    knowledge.directions.change({
      op: "retire",
      id: "d:retired",
      reason: "The captain dropped it.",
      heard: { from: "turn" },
    });
    await h.agent.converse("Use my rules for this release's checks.");

    const attempts = [
      ["d:own-judgment", "d:own-judgment's current revision was not heard from the captain"],
      ["d:everywhere", "d:everywhere is not a direction of"],
      ["d:lighthouse", "d:lighthouse is not a direction of"],
      ["d:retired", "There is no current direction d:retired"],
      ["d:nowhere", "There is no current direction d:nowhere"],
    ] as const;
    for (const [from, why] of attempts) {
      const answer = await override(h, "t-release", { holds: ["checks"], until: "task", from });
      expect(answer).toContain(OVERRIDE_REFUSED);
      expect(answer).toContain(why);
      expect(h.tasks.get("t-release")?.delivery?.override).toBeUndefined();
    }
  });

  it("records one on a scheduled check, which cites none of the captain's own words", async () => {
    const { h, knowledge, repo } = await harbor();
    heard(knowledge, "release-checks", repo, RULE);
    h.agent.notifyOp(
      { facts: { kind: "scheduled", prompt: "check the harbor release", catchUp: false } },
      "scheduled",
    );
    await tick();
    // Each turn ends in turn until the scheduled check's own turn runs.
    for (let turns = 0; !h.session.prompts.at(-1)?.includes("check the harbor release"); turns++) {
      if (turns > 4) throw new Error("The scheduled check never ran.");
      h.session.emitTurnEnd("done");
      h.session.resolveNextPrompt();
      await tick();
    }

    expect(
      await override(h, "t-release", { holds: ["checks"], until: "task", from: "standing" }),
    ).toContain("A scheduled check records no override");
    expect(
      await override(h, "t-release", {
        holds: ["checks"],
        until: "task",
        from: "d:release-checks",
      }),
    ).toContain("Recorded an override on");
    expect(h.tasks.get("t-release")?.delivery?.override).toMatchObject({
      words: RULE,
      direction: { id: "release-checks", revision: 1 },
    });
  });

  it("ends the override when its direction is revised or retired", async () => {
    const { h, knowledge, repo } = await harbor();
    heard(knowledge, "release-checks", repo, RULE);
    heard(knowledge, "deploy-checks", repo, DEPLOY);
    await h.agent.converse("Use my Harbor rules for both builds' checks.");
    for (const [task, id] of [
      ["t-release", "release-checks"],
      ["t-deploy", "deploy-checks"],
    ] as const)
      expect(
        await override(h, task, { holds: ["checks"], until: "task", from: `d:${id}` }),
      ).toContain("Recorded an override on");

    knowledge.directions.change({
      op: "revise",
      id: "d:release-checks",
      expectedRevision: 1,
      text: "Release checks on Harbor may run without asking me; ask before merging on red.",
      reason: "The captain narrowed it.",
      heard: { from: "turn" },
    });
    knowledge.directions.change({
      op: "retire",
      id: "d:deploy-checks",
      reason: "The captain dropped it.",
      heard: { from: "turn" },
    });
    await tick();

    for (const task of ["t-release", "t-deploy"]) {
      const delivery = h.tasks.get(task)?.delivery;
      expect(delivery?.override).toBeUndefined();
      expect(overridePasses(delivery, "checks")).toBe(false);
    }
    expect(
      line(
        h.tasks,
        "t-release",
        "Your direction d:release-checks has a new revision, so the holds it passed on this task hold again.",
      ),
    ).toMatchObject({ kind: "note", actor: "host" });
    expect(
      line(
        h.tasks,
        "t-deploy",
        "Your direction d:deploy-checks no longer stands, so the holds it passed on this task hold again.",
      ),
    ).toMatchObject({ kind: "note", actor: "host" });
  });

  it("keeps the captain's own words standing over a direction, and lets theirs replace one", async () => {
    const { h, knowledge, repo } = await harbor();
    heard(knowledge, "release-checks", repo, RULE);
    const words = "Merge the harbor release once its checks finish, whatever they say.";
    await h.agent.converse(words);
    expect(await override(h, "t-release", { holds: ["checks"], until: "task" })).toContain(
      "Recorded the captain's override",
    );

    const refused = await override(h, "t-release", {
      holds: ["checks", "waits"],
      until: "task",
      from: "d:release-checks",
    });
    expect(refused).toContain(OVERRIDE_REFUSED);
    expect(refused).toContain("an override citing a direction never replaces them");
    expect(h.tasks.get("t-release")?.delivery?.override).toMatchObject({
      words,
      holds: ["checks"],
    });
    expect(h.tasks.get("t-release")?.delivery?.override?.direction).toBeUndefined();

    expect(
      await override(h, "t-deploy", { holds: ["checks"], until: "task", from: "d:release-checks" }),
    ).toContain("Recorded an override on");
    expect(await override(h, "t-deploy", { holds: ["checks", "waits"], until: "task" })).toContain(
      "Recorded the captain's override",
    );
    expect(h.tasks.get("t-deploy")?.delivery?.override).toMatchObject({
      words,
      holds: ["checks", "waits"],
    });
    expect(h.tasks.get("t-deploy")?.delivery?.override?.direction).toBeUndefined();
    // The captain's words now stand there, so revising the direction leaves them.
    knowledge.directions.change({
      op: "revise",
      id: "d:release-checks",
      expectedRevision: 1,
      text: `${RULE} Ask before red merges.`,
      reason: "The captain narrowed it.",
      heard: { from: "turn" },
    });
    await tick();
    expect(h.tasks.get("t-deploy")?.delivery?.override).toMatchObject({ words });
  });

  it("refuses a direction's words at a revision that is no longer current", async () => {
    const { h, knowledge, repo } = await harbor();
    heard(knowledge, "release-checks", repo, RULE);
    knowledge.directions.change({
      op: "revise",
      id: "d:release-checks",
      expectedRevision: 1,
      text: `${RULE} Ask before red merges.`,
      reason: "The captain narrowed it.",
      heard: { from: "turn" },
    });

    const declared = h.supervisor.overrides.declareOverride("t-release", {
      words: RULE,
      holds: ["checks"],
      until: "task",
      direction: { id: "release-checks", revision: 1 },
    });
    expect(declared.ok).toBe(false);
    expect(declared.text).toContain(
      `${OVERRIDE_REFUSED} d:release-checks is no longer at revision 1`,
    );
    expect(h.tasks.get("t-release")?.delivery?.override).toBeUndefined();
  });

  it("ends a closed task's override that its live part reads", async () => {
    const { h, knowledge, repo } = await harbor();
    heard(knowledge, "release-checks", repo, RULE);
    await h.agent.converse("Use my Harbor release rule for the release.");
    await override(h, "t-release", { holds: ["checks"], until: "task", from: "d:release-checks" });
    seedTask(h.tasks, {
      id: "t-notes",
      title: "Write the harbor release notes",
      status: "idle",
      repoId: repo,
      parentId: "t-release",
    });
    h.tasks.close("t-release", { status: "done", reason: "finished", actor: "host" });

    knowledge.directions.change({
      op: "retire",
      id: "d:release-checks",
      reason: "The captain dropped it.",
      heard: { from: "turn" },
    });
    await tick();

    expect(h.tasks.get("t-release")?.delivery?.override).toBeUndefined();
    expect(
      await override(h, "t-notes", { holds: ["checks"], until: "task", from: "standing" }),
    ).toContain(OVERRIDE_REFUSED);
    expect(h.tasks.get("t-notes")?.delivery?.override).toBeUndefined();
  });

  it("carries the direction when the standing words name more holds", async () => {
    const { h, knowledge, repo } = await harbor();
    heard(knowledge, "release-checks", repo, RULE);
    await h.agent.converse("Use my Harbor release rule for this release.");
    await override(h, "t-release", { holds: ["checks"], until: "task", from: "d:release-checks" });
    expect(
      await override(h, "t-release", {
        holds: ["checks", "waits"],
        until: "task",
        from: "standing",
      }),
    ).toContain("Recorded an override on");
    expect(h.tasks.get("t-release")?.delivery?.override).toMatchObject({
      words: RULE,
      holds: ["checks", "waits"],
      direction: { id: "release-checks", revision: 1 },
    });
  });
});

describe("a direction's own words", () => {
  it("never hear a direction change cited from the override that rests on them", async () => {
    const { h, knowledge, repo } = await harbor();
    bindDirections(h.agent, knowledge);
    heard(knowledge, "release-checks", repo, RULE);
    await h.agent.converse("Use my Harbor release rule for this release.");
    await override(h, "t-release", { holds: ["checks"], until: "task", from: "d:release-checks" });
    const key = h.tasks.get("t-release")?.key ?? "t-release";

    const result = await toolsOf(h.specs)
      .get("app_change")
      ?.execute("direction-widen", {
        action: "direction",
        value: {
          op: "revise",
          id: "d:release-checks",
          expectedRevision: 1,
          text: `${RULE} Deploys too.`,
          from: "standing",
          task: key,
        },
        evidence: "Cited the standing override on the release.",
      });
    expect(result?.content[0]?.text).toContain(
      `${DIRECTION_REFUSED} The override standing on ${key} cites direction d:release-checks`,
    );
    const read = knowledge.directions.read({ id: "release-checks" });
    expect(read.state === "ready" && read.direction.revision).toBe(1);
  });
});

describe("a direction changed while the app was closed", () => {
  it("ends the override that cited it when the app next starts", async () => {
    let knowledge: KnowledgeService | undefined;
    const opened = (repos: RepoRegistry) => {
      knowledge = new KnowledgeService({
        projects: { get: (id) => repos.get(id), list: () => repos.list() },
      });
      return knowledge;
    };
    const crewmate = fakeCrewmate();
    const first = crewSetup(crewmate, { knowledge: opened });
    if (!knowledge) throw new Error("No knowledge.");
    const { repo } = await first.repos.setup({ kind: "init", name: "harbor" });
    seedTask(first.tasks, {
      id: "t-release",
      title: "Release the harbor build",
      status: "idle",
      repoId: repo.id,
    });
    heard(knowledge, "release-checks", repo.id, RULE);
    const cited = first.supervisor.overrides.citedDirection("t-release", "d:release-checks");
    if (!cited.ok) throw new Error(cited.text);
    expect(
      first.supervisor.overrides.declareOverride("t-release", {
        words: cited.words,
        holds: ["checks"],
        until: "task",
        direction: cited.direction,
      }).ok,
    ).toBe(true);
    void first.supervisor.disposeAll();

    // The captain retires the rule in Knowledge while the crew is closed.
    knowledge.directions.change({
      op: "retire",
      id: "d:release-checks",
      reason: "The captain dropped it.",
      heard: { from: "turn" },
    });
    await tick();
    expect(first.tasks.get("t-release")?.delivery?.override).toMatchObject({ words: RULE });

    const next = reboot(
      {
        paths: first.paths,
        db: first.db,
        workspace: first.workspace as unknown as WorkspaceService,
      },
      vi.fn(async () => crewmate),
      { tasks: first.tasks, repos: first.repos, knowledge },
    );
    next.setFirstmateHooks({
      notifyOp: vi.fn(),
      notifyCaptainChoice: vi.fn(),
      retryConverse: vi.fn(),
    });
    await tick();
    expect(first.tasks.get("t-release")?.delivery?.override).toBeUndefined();
    expect(
      line(
        first.tasks,
        "t-release",
        "Your direction d:release-checks no longer stands, so the holds it passed on this task hold again.",
      ),
    ).toMatchObject({ kind: "note", actor: "host" });
    void next.disposeAll();
  });
});
