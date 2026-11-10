/**
 * A crewmate's brief as `CrewBrief` builds it: the project's directions
 * and knowledge served on the first turn, and a finding's context that is
 * not starting code.
 * Each case drives a real CrewSupervisor through the crew harness
 * (tests/helpers/crewHarness.ts) and reads what it answers, the cards and the record.
 * The cases drive real git.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Card } from "@shared/cards";
import { describe, expect, it, vi } from "vitest";
import {
  fakeCrewmate,
  fakeCrewTimersEachTest,
  intentOf,
  setup,
  tick,
} from "../../../tests/helpers/crewHarness";
import { gitRepo } from "../../../tests/helpers/crewHarnessGit";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { renderReferenceImport } from "../knowledge/context";
import { KnowledgeService } from "../knowledge/knowledgeService";
import { PI_CONTROL_PROFILE } from "../pi/controlProfile";
import type { CrewMachines } from "../placed/crewMachines";
import { couldNotStartOf, seedTask } from "../tasks/seedTask";
import { TaskProtocol } from "../tasks/taskProtocol";

// This file chains real git and is not about the utility-QoS clamp, so what
// the product spawns runs at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

fakeCrewTimersEachTest();

describe("CrewSupervisor direction context", () => {
  it("serves active project directions with their authority once on the first turn", async () => {
    const { dir } = gitRepo();
    try {
      const crewmate = fakeCrewmate();
      let knowledge: KnowledgeService | undefined;
      const { supervisor, repos } = setup(crewmate, {
        knowledge: (registry) => {
          knowledge = new KnowledgeService({
            projects: { get: (id) => registry.get(id), list: () => registry.list() },
          });
          return knowledge;
        },
      });
      const { repo } = await repos.setup({ kind: "adopt", path: dir, name: "firstmate-3000" });
      knowledge?.directions.change({
        op: "add",
        id: "smoke-check",
        scope: repo.id,
        text: "Check package smoke before publishing.",
        reason: "captain said so",
      });
      await supervisor.intake.commission({
        title: "Fix smoke",
        intent: intentOf("Fix the flaky package-smoke."),
        repoId: repo.id,
      });
      await tick();
      const minted = crewmate.promptCalls[0] ?? "";
      expect(minted).toContain("Fix the flaky package-smoke.");
      expect(minted).toContain("Standing directions");
      expect(minted).toContain('"authority":"instruction"');
      expect(minted).toContain("Check package smoke before publishing.");
      expect(minted).toContain("d:smoke-check");
      expect(minted.split("Standing directions.")).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leads a local crewmate's brief with its project's knowledge and hands it the knowledge pair", async () => {
    const { dir } = gitRepo();
    let knowledge: KnowledgeService | undefined;
    const crewmate = fakeCrewmate();
    const { supervisor, repos, specs } = setup(crewmate, {
      knowledge: (registry) => {
        knowledge = new KnowledgeService({
          projects: { get: (id) => registry.get(id), list: () => registry.list() },
        });
        return knowledge;
      },
    });
    const { repo } = await repos.setup({ kind: "adopt", path: dir, name: "firstmate-3000" });
    knowledge?.directions.change({
      op: "add",
      scope: repo.id,
      text: "Always squash-merge smoke fixes.",
      reason: "told",
    });
    const recorded = await knowledge?.record(
      { kind: "firstmate", origin: "captain-turn", canCreate: true },
      {
        action: "publish",
        requestId: "smoke",
        kind: "concept",
        title: "Package smoke",
        aliases: ["packaging check"],
        explanation: "The packaged app's first-launch check.",
        appliesTo: [repo.id],
      },
    );
    const conceptId = recorded?.ids[0] as string;
    await supervisor.intake.commission({
      title: "Fix the packaging check",
      intent: intentOf("Make the packaging check pass on first launch."),
      repoId: repo.id,
    });
    await tick();
    const minted = crewmate.promptCalls[0] ?? "";
    expect(minted).toContain("knowledge for firstmate-3000 (candidates");
    expect(minted).toContain(`${conceptId} concept "Package smoke"`);
    expect(minted).toContain("Always squash-merge smoke fixes.");
    expect(minted).not.toContain("package-smoke flakes on first run");
    // All crewmates can read and write factual knowledge on request.
    const bound = specs[0]?.knowledge;
    expect(bound).toBeDefined();
    expect(await bound?.read({ action: "search", query: "packaging" })).toContain(conceptId);
    const written = await bound?.record({
      action: "publish",
      requestId: "r1",
      kind: "concept",
      title: "Requested idea",
      explanation: "An idea the captain asked to keep.",
    });
    expect(written).toContain("Recorded");
  });

  it("serves common saving guidance as its own paragraph after knowledge candidates", async () => {
    const { dir } = gitRepo();
    const crewmate = fakeCrewmate();
    const { supervisor, repos } = setup(crewmate, {
      knowledge: (registry) =>
        new KnowledgeService({
          projects: { get: (id) => registry.get(id), list: () => registry.list() },
        }),
    });
    const { repo } = await repos.setup({ kind: "adopt", path: dir, name: "firstmate-3000" });
    await supervisor.intake.commission({
      title: "Save the retries article",
      intent: intentOf("Save the article about inbox retries as a reference."),
      repoId: repo.id,
    });
    await tick();
    const paragraphs = (crewmate.promptCalls[0] ?? "").split("\n\n");
    const knowledge = paragraphs.findIndex((text) =>
      text.startsWith("knowledge for firstmate-3000"),
    );
    expect(knowledge).toBeGreaterThanOrEqual(0);
    expect(paragraphs[knowledge]).not.toContain(renderReferenceImport());
    expect(paragraphs[knowledge + 1]).toBe(renderReferenceImport());
  });

  it("gives a task with no project the same knowledge pair and common guidance", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, specs } = setup(crewmate, {
      knowledge: (registry) =>
        new KnowledgeService({
          projects: { get: (id) => registry.get(id), list: () => registry.list() },
        }),
    });
    await supervisor.intake.commission({
      title: "Scratch work",
      intent: intentOf("Explain an article."),
    });
    await tick();
    expect(crewmate.promptCalls[0]).toContain("knowledge for this task");
    expect(crewmate.promptCalls[0]).toContain(renderReferenceImport());
    const bound = specs[0]?.knowledge;
    expect(bound).toBeDefined();
    // Reading an article can proceed without a knowledge call. A later reply
    // asks this same author to keep it; no new task or access grant is needed.
    await specs[0]?.onCard?.({
      title: "Article explained",
      body: "<p>The article describes bounded caches.</p>",
      actions: [],
    });
    await tick();
    const card = supervisor.cards
      .snapshot()
      .find((entry) => entry.title === "Article explained") as Card;
    supervisor.cardActions.replyToCard(card.id, "Save its concepts and findings with the source.");
    await tick();
    expect(crewmate.steer.mock.calls.at(-1)?.[0]).toContain(
      "Save its concepts and findings with the source.",
    );
    const article = {
      kind: "article" as const,
      url: "https://example.com/cache",
      title: "Bounded caches",
      excerpt: "Clients keep a bounded cache.",
    };
    const saved = await bound?.record({
      action: "publish",
      requestId: "later-source",
      kind: "concept",
      title: article.title,
      explanation: "A reusable cache idea.",
      sources: [article],
    });
    const concept = /c-[a-z0-9]{6}/.exec(saved ?? "")?.[0] as string;
    expect(concept).toBeDefined();
    const written = await bound?.record({
      action: "publish",
      requestId: "later-finding",
      kind: "finding",
      statement: "Clients keep a bounded cache.",
      basis: "observation",
      about: [concept],
      conditions: "The saved article",
      sources: [article],
    });
    const finding = /f-[a-z0-9]{6}/.exec(written ?? "")?.[0] as string;
    expect(finding).toBeDefined();
    const read = await bound?.read({ action: "get", ids: [finding] });
    expect(read).toContain(article.url);
    expect(read).toContain(article.excerpt);
  });
});

// INF-1964 regression, reproduced in INF-1953. Source: the captain's SSHH-50/51 Backlog report,
// SSHH-49/48 timeline refusals, INF-1789 event 150648's saved ref.
// Fresh task database; production writer, start path and panel projection.
// Session, working-copy acquisition and remote transport are stand-ins.
describe("finding context is not starting code (INF-1964)", () => {
  it.each([
    { label: "cross-project saved origin on worker", remote: true, moved: true, saved: true },
    { label: "same-project saved origin on worker", remote: true, moved: false, saved: true },
    {
      label: "cross-project origin without code on worker",
      remote: true,
      moved: true,
      saved: false,
    },
    { label: "cross-project saved origin on home", remote: false, moved: true, saved: true },
    {
      label: "cross-project live remote origin",
      remote: true,
      moved: true,
      saved: false,
      live: true,
    },
    {
      label: "same-project live remote origin",
      remote: true,
      moved: false,
      saved: false,
      live: true,
    },
    {
      label: "same-project basis retains recovery",
      remote: true,
      moved: false,
      saved: true,
      recovery: "basis",
    },
    {
      label: "cross-project basis still refuses code",
      remote: true,
      moved: true,
      saved: true,
      recovery: "basis",
    },
    {
      label: "replacement retains recovery",
      remote: true,
      moved: false,
      saved: true,
      recovery: "replacement",
    },
  ])("$label", async ({ label, remote, moved, saved, live = false, recovery }) => {
    const { nowGroupOf } = await import("@shared/nowPanel");
    const crew = fakeCrewmate();
    const sourceRef = vi.fn(async () => "refs/infinitary/sources/filing-origin");
    const machine = "875ece86-3e09-4c54-a108-15fafad9b31b";
    const work = scratchDir("inf1953-worker-");
    const prepare = vi.fn(async (_machine: string, id: string) => ({
      cwd: work,
      branch: `fm/task-${id}`,
    }));
    const bringBranchHome = vi.fn(async () => {
      throw new Error("Provenance must not retrieve source code");
    });
    const sourceFile = vi.fn(async (_machine: string, _id: string, name: string, _file: string) =>
      join(work, name),
    );
    const machines = {
      computers: () => [machine],
      nameOf: () => "Kun’s Mac mini",
      placeOf: () => ({ who: "Kun’s Mac mini", where: "on Kun’s Mac mini" }),
      ready: () => true,
      signInsOf: async () => null,
      signInWait: () => undefined,
      accountOf: () => undefined,
      cutOffOf: () => undefined,
      servingAccount: () => undefined,
      takesCheckDeclarations: () => true,
      folders: () => ({
        work,
        sessions: join(work, "sessions"),
        evidence: join(work, "evidence"),
        temp: join(work, "temp"),
      }),
      prepare,
      bringBranchHome,
      factories: () => ({
        pi: { backend: "pi", controlProfile: PI_CONTROL_PROFILE, open: async () => crew },
      }),
      sourceFile,
      sourceRef,
      install: async () => ({ outcome: "skipped" }),
    } as unknown as CrewMachines;
    const h = setup(crew, { machines });
    const { supervisor, tasks, repos, cardStore } = h;
    const addRepo = async (name: string) => {
      const path = scratchDir(`inf1953-${name}-`);
      execFileSync("git", ["-C", path, "init", "--initial-branch=main"], { stdio: "ignore" });
      // An origin makes the scratch project eligible for a worker; no network call follows.
      execFileSync(
        "git",
        ["-C", path, "remote", "add", "origin", `https://github.com/infinitary-labs/${name}.git`],
        { stdio: "ignore" },
      );
      return (await repos.setup({ kind: "adopt", path, name })).repo;
    };
    const inf = await addRepo("infinitary");
    const ssh = await addRepo("sshhip");
    const origin = seedTask(tasks, {
      id: "1189fbc8",
      title: "Continue: switch the image and push the iOS 27.0 pin",
      repoId: inf.id,
      prompt: "p",
      status: "completed",
      ...(live ? { deviceId: machine, worktreeDir: "/source/work", branch: "fm/task-source" } : {}),
      shape: { kind: "chore", deliverable: "change" },
    });
    const finding =
      "The count races detached cleanup; await the probe disconnect before asserting the count.";
    tasks.turns.recordReport(origin.id, { text: finding });
    cardStore.upsert({
      id: "origin-finding",
      taskId: origin.id,
      author: "crewmate",
      priority: 1,
      title: "Wait for disconnect",
      meta: "",
      body: "<p>The probe disconnect must settle before counting.</p>",
      actions: [],
      status: "ready",
      createdAt: Date.now(),
    });
    if (!live) tasks.close(origin.id, { status: "done", reason: "merged", actor: "host" });
    else
      expect(tasks.get(origin.id)).toMatchObject({ deviceId: machine, workspaceState: "present" });
    if (saved)
      tasks.note(origin.id, "working copy removed; saved code reference", {
        news: false,
        data: {
          saved: {
            ref: "refs/infinitary/kept/1189fbc8",
            sha: "4b7db06c9dfeb7018e0dd259a5d44fab12e22f1c",
            dirty: false,
            unlandedCommits: 5,
          },
        },
      });
    const filing = tasks.fileFollowup({
      id: "34d536a9",
      originId: origin.id,
      title: "sshhip: guided draft test races the detached disconnect",
      goal: "Wait for the probe disconnect",
      why: "The count races detached cleanup",
      prompt: "Wait for the probe disconnect",
    }).record;
    if (moved) tasks.moveToProject(filing.id, tasks.projects.forRepo(ssh.id)!.id, "firstmate");
    tasks.placement.recordShape(filing.id, { kind: "fix", deliverable: "change" }, null);
    if (recovery === "basis") {
      tasks.updateFields(filing.id, { basis: origin.key }, "firstmate");
      expect(tasks.get(filing.id)?.shape?.basis).toBe(origin.key);
    }
    if (recovery === "replacement")
      tasks.graph.link(origin.id, filing.id, "replaced-by", "firstmate");
    if (remote)
      tasks.updateFields(
        filing.id,
        { runsOn: { ask: machine, words: "Kun’s Mac mini (This task)" } },
        "firstmate",
      );
    const protocol = new TaskProtocol({
      tasks,
      repos,
      cards: { listOpen: () => [], snapshot: () => [] },
      startAttempt: (id) => tasks.starts.startAttemptOf(id),
      broadcastEvent: () => {},
      emit: () => {},
    });
    const stages: string[] = [];
    const capture = () => {
      const row = protocol.board().tasks.find((row) => row.id === filing.id)!;
      const value = `${row.status}/${row.activity ?? "none"}/${row.startAttempt?.phase ?? "none"} => ${nowGroupOf(row)}`;
      if (stages.at(-1) !== value) stages.push(value);
    };
    capture();
    const detach = tasks.onChange(capture);
    try {
      const reply = await supervisor.starts.startQueuedNow(filing.id, {
        audience: "captain",
        from: "task-card",
        direct: true,
      });
      await tick();
      capture();
      console.log(
        JSON.stringify(
          {
            label,
            reply,
            task: filing.key,
            project: tasks.get(filing.id)?.repoId,
            findingDelivered: crew.promptCalls[0]?.includes(finding) ?? false,
            cardCopies: sourceFile.mock.calls.length,
            sourceBranchRetrievals: bringBranchHome.mock.calls.length,
            stages,
            device: tasks.get(filing.id)?.deviceId,
            promptCount: crew.promptCalls.length,
            sourceTransfers: sourceRef.mock.calls.length,
            gate: tasks.get(filing.id)?.gate,
            events: tasks
              .timeline(filing.id)
              .filter((e) => ["status", "dispatched", "briefed"].includes(e.kind))
              .map((e) => ({
                kind: e.kind,
                text: e.kind === "briefed" ? "brief delivered" : e.text,
              })),
          },
          null,
          2,
        ),
      );
      expect(tasks.get(filing.id)?.deviceId ?? null).toBe(remote ? machine : null);
      if (remote)
        expect(prepare).toHaveBeenCalledWith(
          machine,
          filing.id,
          moved ? ssh.id : inf.id,
          undefined,
        );
      expect(bringBranchHome).not.toHaveBeenCalled();
      if (recovery === "basis" && moved) {
        expect(tasks.get(filing.id)?.status).toBe("open");
        expect(couldNotStartOf(tasks.get(filing.id))).toBe(
          "The starting work belongs to a different project.",
        );
        expect(sourceRef).not.toHaveBeenCalled();
        expect(crew.promptCalls).toHaveLength(0);
        return;
      }
      // User intent: a finding in another project must not turn a valid Start into Backlog.
      expect(tasks.get(filing.id)?.status).toBe("active");
      const brief = crew.promptCalls[0] ?? "";
      expect(brief).toContain(finding);
      expect(brief).toContain(origin.key);
      expect(sourceFile).toHaveBeenCalledTimes(remote ? (recovery === "replacement" ? 2 : 1) : 0);
      for (const [, , , file] of sourceFile.mock.calls)
        expect(readFileSync(file, "utf8")).toBe(
          "<p>The probe disconnect must settle before counting.</p>",
        );
      expect(brief).toContain(`${origin.key}.html`);
      expect(
        stages
          .map((stage) => stage.split(" => ")[1])
          .filter((group, index, groups) => group !== groups[index - 1]),
      ).toEqual(["backlog", "queued", "working"]);
      expect(tasks.graph.replacedPredecessors(filing.id)).toHaveLength(
        recovery === "replacement" ? 1 : 0,
      );
      if (recovery) {
        expect(sourceRef).toHaveBeenCalledOnce();
        expect(brief).toContain("refs/infinitary/sources/filing-origin");
      } else {
        expect(brief).toContain("Recorded origin");
        expect(sourceRef).not.toHaveBeenCalled();
        expect(brief).not.toContain("refs/infinitary/");
        expect(brief).not.toContain("fm/task-source");
      }
    } finally {
      detach();
      protocol.dispose();
      await supervisor.disposeAll();
    }
  });
});
