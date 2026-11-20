import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { AttachmentRef } from "@shared/attachments";
import { AUTOMATIC_COMPUTER } from "@shared/placement";
import { taskHoldWords } from "@shared/taskHold";
import { describe, expect, it, vi } from "vitest";
import {
  catalogLessRouter,
  fakeCrewmate,
  fakeCrewTimersEachTest,
  intentOf,
  setup,
  tick,
} from "../../../tests/helpers/crewHarness";
import { gitRepo } from "../../../tests/helpers/crewHarnessGit";
import { jpegImage, pngImage } from "../../../tests/helpers/images";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { attachmentPath, keepImages } from "../attachments";
import { initOverflowDir, type MessageFile, withPastedFiles } from "../overflow";
import type { KindInput } from "../routing/kindClassifier";
import type { TaskEvent } from "../storage/taskEventStore";
import { seedTask } from "../tasks/seedTask";
import { TaskProtocol } from "../tasks/taskProtocol";
import type { TaskService } from "../tasks/taskService";
import type { CrewmateSpec } from "./crewSession";
import { renderRigorSection } from "./intentBrief";

// This file chains real git and is not about the utility-QoS clamp, so what
// the product spawns runs at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

fakeCrewTimersEachTest();

/** A task's record as the window reads it. */
function recordOf(tasks: TaskService): TaskProtocol {
  return new TaskProtocol({
    tasks,
    repos: { get: () => undefined },
    cards: { listOpen: () => [], snapshot: () => [] },
    broadcastEvent: () => {},
    emit: () => {},
  });
}

describe("the reviewed tier (delivery rigor phase 2)", () => {
  it("derives the rigor at dispatch, stamps the shape, and names the tier in the brief - never in the classifier's input", async () => {
    const repo = gitRepo();
    try {
      const crewmate = fakeCrewmate();
      const asked: KindInput[] = [];
      const { supervisor, tasks, repos } = setup(crewmate, {
        routedModel: { provider: "openai-codex", id: "gpt-5.5" },
        classifier: {
          classify: async (input) => {
            asked.push(input);
            return { kind: "implement", source: "classifier:test", version: "kc1" };
          },
        },
      });
      const { repo: view } = await repos.setup({ kind: "adopt", path: repo.dir, name: repo.name });
      repos.configure(view.id, { delivery: "direct-pr" });
      // The captain's revised derivation (2026-09-19): standard by
      // default, whatever the routed bucket says - the tier moves models,
      // never ceremony.
      const { taskId } = await supervisor.intake.commission({
        title: "Fix the meter test",
        intent: intentOf("make the meter test stop flaking"),
        repoId: view.id,
      });
      await tick();
      expect(tasks.get(taskId)?.shape).toMatchObject({ kind: "implement", rigor: "standard" });
      const brief = crewmate.promptCalls[0] ?? "";
      expect(brief).toContain(renderRigorSection("standard"));
      // The rigor is appended at the mint, after the classifier ran on the
      // work's own facts: none of what it saw names a rigor, and the
      // record's stored brief is the template without the section.
      expect(asked).toHaveLength(1);
      expect(JSON.stringify(asked[0])).not.toContain("Care:");
      expect(tasks.get(taskId)?.prompt).not.toContain("Care:");
      expect(supervisor.facts.crewStatus(taskId)[0]).toMatchObject({ rigor: "standard" });
      // Reviewed is only ever asked for - the user's words or the repo's
      // configured rigor - and its brief orders review before the PR.
      const askedFor = await supervisor.intake.commission({
        title: "Careful fix",
        intent: intentOf("review this carefully before it lands"),
        repoId: view.id,
        shape: { rigor_ask: "reviewed" },
      });
      await tick();
      expect(tasks.get(askedFor.taskId)?.shape?.rigor).toBe("reviewed");
      expect(crewmate.promptCalls[1]).toContain(renderRigorSection("reviewed"));
      expect(supervisor.facts.crewStatus(askedFor.taskId)[0]).toMatchObject({ rigor: "reviewed" });
      expect(supervisor.facts.crewStatus(askedFor.taskId)[0]?.review).toBeUndefined();
    } finally {
      repo.dispose();
    }
  });

  it("reads the captain's ask, the repository's standing rigor, then standard, in the captain's order", async () => {
    const repo = gitRepo();
    try {
      const builder = fakeCrewmate();
      const noted = fakeCrewmate();
      const local = fakeCrewmate();
      const { supervisor, tasks, repos, sessionSpecs } = setup(builder, {
        routedModel: { provider: "openai-codex", id: "gpt-5.5" },
        crewmates: [noted, local],
      });
      const { repo: view } = await repos.setup({ kind: "adopt", path: repo.dir, name: repo.name });
      repos.configure(view.id, { delivery: "direct-pr" });

      // The captain's word beats the repository's default.
      const asked = await supervisor.intake.commission({
        title: "Quick fix",
        intent: intentOf("just do it quickly"),
        repoId: view.id,
        shape: { rigor_ask: "quick" },
      });
      await tick();
      expect(tasks.get(asked.taskId)?.shape).toMatchObject({ rigor_ask: "quick", rigor: "quick" });
      expect(builder.promptCalls[0]).toContain(renderRigorSection("quick"));
      expect(sessionSpecs[0]?.thinking).toMatchObject({ level: "xhigh", quick: true });

      // The repository's standing rigor - the column set by talking (phase
      // 3) - beats the default.
      repos.configure(view.id, { rigor: "reviewed" });
      const fromRepo = await supervisor.intake.commission({
        title: "Noted fix",
        intent: intentOf("fix it"),
        repoId: view.id,
      });
      await tick();
      expect(tasks.get(fromRepo.taskId)?.shape?.rigor).toBe("reviewed");
      expect(sessionSpecs[1]?.thinking).toMatchObject({ level: "xhigh" });
      expect(sessionSpecs[1]?.thinking.quick).toBeUndefined();
      expect(noted.promptCalls[0]).toContain(renderRigorSection("reviewed"));
      // A repo note is no longer a convention: nothing reads it.
      repos.configure(view.id, { rigor: null });

      // Every repository defaults to standard - the local-only default
      // workspace too (captain ruling, 2026-09-19).
      const scratch = await supervisor.intake.commission({
        title: "Scratch",
        intent: intentOf("poke"),
      });
      await tick();
      expect(tasks.get(scratch.taskId)?.shape?.rigor).toBe("standard");
      expect(local.promptCalls[0]).toContain(renderRigorSection("standard"));
    } finally {
      repo.dispose();
    }
  });

  it("starts a crewmate's follow-up at the repository's rigor, never a legacy quick", async () => {
    const repo = gitRepo();
    try {
      const builder = fakeCrewmate();
      const followupCrewmate = fakeCrewmate();
      const { supervisor, tasks, repos, specs } = setup(builder, {
        routedModel: { provider: "openai-codex", id: "gpt-5.5" },
        classifier: {
          classify: async () => ({ kind: "fix", source: "classifier:test", version: "kc1" }),
        },
        crewmates: [followupCrewmate],
      });
      const { repo: view } = await repos.setup({ kind: "adopt", path: repo.dir, name: repo.name });
      repos.configure(view.id, { delivery: "direct-pr" });
      const { taskId } = await supervisor.intake.commission({
        title: "Investigate the keychain prompt",
        intent: intentOf("find out why the keychain asks"),
        repoId: view.id,
      });
      await tick();
      // The crewmate files a follow-up; the Firstmate starts it on request
      // with no word on care (the 2026-09-24 FI3-26 path).
      (specs[0] as CrewmateSpec).onFollowup?.({
        title: "Skip keychain settings on install",
        goal: "A routine install never touches the keychain settings",
        why: "every install re-asks for the keychain",
      });
      const followup = tasks.graph.discoveredFrom(taskId)[0];
      expect(followup?.status).toBe("open");
      expect(await supervisor.starts.startQueuedNow(followup?.key ?? "")).toContain("is starting.");
      await tick();
      expect(tasks.get(followup?.id ?? "")?.status).toBe("active");
      expect(tasks.get(followup?.id ?? "")?.shape).toMatchObject({
        kind: "fix",
        rigor: "standard",
      });
      expect(followupCrewmate.promptCalls[0]).toContain(renderRigorSection("standard"));

      // The repository's standing rigor reaches a follow-up too.
      repos.configure(view.id, { rigor: "reviewed" });
      (specs[0] as CrewmateSpec).onFollowup?.({
        title: "Document the keychain",
        goal: "The docs say when the keychain is touched",
        why: "nobody knew",
      });
      const second = tasks.graph.discoveredFrom(taskId).find((row) => row.id !== followup?.id);
      await supervisor.starts.startQueuedNow(second?.key ?? "");
      await tick();
      expect(tasks.get(second?.id ?? "")?.shape?.rigor).toBe("reviewed");
    } finally {
      repo.dispose();
    }
  });

  it("reads a pre-shape row as the quick work it was, and a shapeless follow-up at the repository's rigor", async () => {
    const legacyCrewmate = fakeCrewmate();
    const followupCrewmate = fakeCrewmate();
    const { supervisor, tasks } = setup(legacyCrewmate, {
      routedModel: { provider: "openai-codex", id: "gpt-5.5" },
      crewmates: [followupCrewmate],
    });
    // A row the Firstmate commissioned before the shape existed: its intent
    // and its judged difficulty, no shape.
    seedTask(tasks, {
      id: "t-legacy",
      title: "Queued before the shape",
      prompt: "Goal: tidy the meter",
      intent: intentOf("tidy the meter"),
      difficulty: "low",
      status: "queued",
    });
    // A crewmate's follow-up as it is filed: no intent, no difficulty, no
    // shape.
    seedTask(tasks, {
      id: "t-followup",
      title: "Filed before the fix",
      prompt: "Goal: unflake the meter test",
      status: "queued",
    });
    await supervisor.starts.startQueuedNow("t-legacy");
    await tick();
    expect(tasks.get("t-legacy")?.shape).toMatchObject({
      kind_source: "legacy-judgment",
      rigor: "quick",
    });
    expect(legacyCrewmate.promptCalls[0]).toContain(renderRigorSection("quick"));
    await supervisor.starts.startQueuedNow("t-followup");
    await tick();
    expect(tasks.get("t-followup")?.shape?.rigor).toBe("standard");
    expect(followupCrewmate.promptCalls[0]).toContain(renderRigorSection("standard"));
  });
});

describe("CrewSupervisor: the captain's pictures ride the crewmate's brief", () => {
  it("briefs a spawned crewmate with its message's pictures, by path, and keeps them on the brief's row", async () => {
    vi.useRealTimers();
    const crewmate = fakeCrewmate();
    const { supervisor, inbox, tasks } = setup(crewmate);
    const attachments = keepImages(randomUUID(), [{ ...pngImage, name: "dialog.png" }]);
    const { taskId } = await supervisor.intake.commission({
      title: "Fix the dialog",
      intent: intentOf("fix the dialog in this picture"),
      attachments,
    });
    await vi.waitFor(() => expect(crewmate.promptCalls.length).toBeGreaterThan(0));
    const brief = crewmate.promptCalls[0] ?? "";
    expect(brief).toContain(
      "Pictures: the captain attached 1 picture to the messages this task came from.",
    );
    // INF-1389 friction 3: the task owns a readable hand-over copy, even locally.
    const delivered = /^- dialog.png: (.+)$/m.exec(brief)?.[1] ?? "";
    expect(delivered).toContain(`/crewmates/${taskId}/temp/handover/`);
    expect(readFileSync(delivered)).toEqual(
      readFileSync(attachmentPath(attachments[0] as AttachmentRef)),
    );
    expect(statSync(delivered).mode & 0o777).toBe(0o600);
    // The section sits under the captain's words, before the host's own sections.
    expect(brief.indexOf("Pictures:")).toBeGreaterThan(
      brief.indexOf("fix the dialog in this picture"),
    );
    expect(crewmate.promptImageCalls[0]).toEqual([pngImage]);
    const [row] = inbox.inFlight(taskId);
    expect(row?.facts).toMatchObject({ kind: "attachments-kept", attachments });
    // The pinned brief the record keeps names the copy too.
    expect(
      tasks.servedBrief(tasks.timeline(taskId).filter((e) => e.kind === "briefed")[0] as TaskEvent),
    ).toContain("dialog.png");
  });

  // FI3-1728: routing never said a first turn carries the captain's
  // pictures, so a task with a screenshot could go to a model that takes
  // text only, whose first prompt refused them and closed the task failed.
  it("routes a task whose brief carries pictures past a model that takes text only, saying why", async () => {
    vi.useRealTimers();
    // Two models OpenRouter serves, each def as its catalog lists it.
    const textOnly = { provider: "openrouter", id: "deepseek/deepseek-v4-pro" };
    const readsPictures = { provider: "openrouter", id: "google/gemini-3.5-flash" };
    const defs = new Map([
      [textOnly.id, { reasoning: true, input: ["text"], contextWindow: 1_048_576 }],
      [readsPictures.id, { reasoning: true, input: ["text", "image"], contextWindow: 1_048_576 }],
    ]);
    const crewmate = fakeCrewmate();
    const { supervisor, sessionSpecs, db } = setup(crewmate, {
      realRouter: (db) =>
        catalogLessRouter(db, [textOnly, readsPictures], {
          capabilityFor: (ref) => defs.get(ref.id),
        }),
    });
    const reasons = (taskId: string) =>
      (
        db.prepare("SELECT reasons_json FROM routing_decisions WHERE task_id = ?").all(taskId) as {
          reasons_json: string;
        }[]
      ).flatMap((row) => JSON.parse(row.reasons_json) as string[]);

    const pictured = await supervisor.intake.commission({
      title: "Fix the dialog",
      intent: intentOf("fix the dialog in this picture"),
      attachments: keepImages(randomUUID(), [{ ...pngImage, name: "dialog.png" }]),
    });
    await vi.waitFor(() => expect(crewmate.promptCalls).toHaveLength(1));
    expect(sessionSpecs[0]?.model).toEqual(readsPictures);
    expect(crewmate.promptImageCalls[0]).toEqual([pngImage]);
    expect(reasons(pictured.taskId)).toContain(
      "skipped openrouter/deepseek/deepseek-v4-pro: the turn carries images and its def takes text only",
    );

    // Words alone still go to the model that takes text only.
    const words = await supervisor.intake.commission({
      title: "Fix the dialog's wording",
      intent: intentOf("fix the dialog's wording"),
    });
    await vi.waitFor(() => expect(crewmate.promptCalls).toHaveLength(2));
    expect(sessionSpecs[1]?.model).toEqual(textOnly);
    expect(reasons(words.taskId).join("\n")).not.toContain("carries images");
  });

  // A pictured task whose level holds only models that read text only
  // started a level lower, or waited, saying that level's allowance was spent.
  it("says no model at a pictured task's level reads its pictures when it starts lower or waits", async () => {
    vi.useRealTimers();
    const textOnly = { provider: "openrouter", id: "deepseek/deepseek-v4-pro" };
    const readsPictures = { provider: "openrouter", id: "google/gemini-3.5-flash" };
    const defs = new Map([
      [textOnly.id, { reasoning: true, input: ["text"], contextWindow: 1_048_576 }],
      [readsPictures.id, { reasoning: true, input: ["text", "image"], contextWindow: 1_048_576 }],
    ]);
    // The model that reads text only is the one placed for hard and premium work.
    const slots = (model: { id: string }) =>
      model.id === textOnly.id ? (["premium", "high"] as const) : (["medium"] as const);
    const crewmate = fakeCrewmate();
    const { supervisor, sessionSpecs, events, ops, tasks } = setup(crewmate, {
      realRouter: (db) =>
        catalogLessRouter(db, [textOnly, readsPictures], {
          capabilityFor: (ref) => defs.get(ref.id),
          slotsFor: slots,
        }),
    });

    await supervisor.intake.commission({
      title: "Fix the dialog",
      intent: intentOf("fix the dialog in this picture"),
      attachments: keepImages(randomUUID(), [{ ...pngImage, name: "dialog.png" }]),
      shape: { intelligence: "high" },
    });
    await vi.waitFor(() => expect(crewmate.promptCalls).toHaveLength(1));
    expect(sessionSpecs[0]?.model).toEqual(readsPictures);
    expect(events.map((event) => ("text" in event ? event.text : ""))).toContain(
      '"Fix the dialog" is a hard task on a model for normal tasks. None of your models for hard tasks can read the pictures it carries.',
    );

    // Premium is the captain's ask, so a lower level waits for the first mate.
    const premium = await supervisor.intake.commission({
      title: "Redesign the dialog",
      intent: intentOf("redesign the dialog in this picture"),
      attachments: keepImages(randomUUID(), [{ ...pngImage, name: "dialog.png" }]),
      shape: { premium_ask: true },
    });
    await premium.started;
    expect(crewmate.promptCalls).toHaveLength(1);
    expect(tasks.get(premium.taskId)).toMatchObject({
      status: "open",
      gate: { kind: "quota-reset", ref: "bucket:premium", cause: "pictures" },
    });
    expect(tasks.timeline(premium.taskId).map((event) => event.text)).toContain(
      "held: no premium model reads pictures",
    );
    await vi.waitFor(() =>
      expect(ops.find((line) => line.includes(`task ${premium.taskId}`))).toContain(
        "none there reads the pictures it carries, so no quota reset will start it",
      ),
    );
    // Its record says the same, never that premium's allowance ran out.
    const record = recordOf(tasks).detail(premium.taskId);
    expect(record.hold).toEqual(taskHoldWords({ kind: "premium", cause: "pictures" }));
    expect(record.hold?.text).toContain("none of your premium models can read the pictures");
    expect(record.queueWait?.line).toContain("Waiting for a premium model that reads pictures");
    expect(
      [record.hold?.title, record.hold?.text, record.queueWait?.line]
        .concat(record.waits?.map((wait) => wait.label))
        .join(" "),
    ).not.toContain("allowance");
  });

  // A model at the level that reads pictures but has spent its allowance
  // comes back at its reset, so the words still name the allowance.
  it("keeps the allowance words when a pictured task's level has a picture reader whose allowance is spent", async () => {
    vi.useRealTimers();
    const textOnly = { provider: "openrouter", id: "deepseek/deepseek-v4-pro" };
    const spentReader = { provider: "openai-codex", id: "gpt-6.1-sol" };
    const readsPictures = { provider: "openrouter", id: "google/gemini-3.5-flash" };
    const defs = new Map([
      [textOnly.id, { reasoning: true, input: ["text"], contextWindow: 1_048_576 }],
      [spentReader.id, { reasoning: true, input: ["text", "image"], contextWindow: 500_000 }],
      [readsPictures.id, { reasoning: true, input: ["text", "image"], contextWindow: 1_048_576 }],
    ]);
    const crewmate = fakeCrewmate();
    const { supervisor, sessionSpecs, events } = setup(crewmate, {
      realRouter: (db) =>
        catalogLessRouter(db, [textOnly, spentReader, readsPictures], {
          capabilityFor: (ref) => defs.get(ref.id),
          slotsFor: (model) => (model.id === readsPictures.id ? ["medium"] : ["high"]),
          spent: [spentReader],
        }),
    });

    await supervisor.intake.commission({
      title: "Fix the dialog",
      intent: intentOf("fix the dialog in this picture"),
      attachments: keepImages(randomUUID(), [{ ...pngImage, name: "dialog.png" }]),
      shape: { intelligence: "high" },
    });
    await vi.waitFor(() => expect(crewmate.promptCalls).toHaveLength(1));
    expect(sessionSpecs[0]?.model).toEqual(readsPictures);
    expect(events.map((event) => ("text" in event ? event.text : ""))).toContain(
      '"Fix the dialog" is a hard task on a model for normal tasks. Your models for hard tasks have used up their allowance right now.',
    );
  });

  // INF-2422: INF-2421 was spawned on a project that runs on Automatic, and
  // its crewmate's brief carried no picture, so it answered without seeing
  // the captain's screenshot. The message attaches only after the spawn
  // returns, so the start Automatic makes at once must carry it itself.
  it("briefs a crewmate that Automatic starts at once with its message's pictures and files", async () => {
    vi.useRealTimers();
    initOverflowDir(scratchDir("infinitary-automatic-text-"));
    const dir = scratchDir("infinitary-automatic-pictures-");
    execFileSync("git", ["-C", dir, "init", "--initial-branch=main"]);
    execFileSync("git", ["-C", dir, "remote", "add", "origin", "https://github.com/o/ledger.git"]);
    const crewmate = fakeCrewmate();
    const { supervisor, repos, tasks, inbox } = setup(crewmate, {
      automatic: {
        choose: async () => ({
          computerId: null,
          routed: { choice: { provider: "fm-mock", id: "mock-1" }, bucket: "high", rule: "R8" },
        }),
      },
    });
    const { repo } = await repos.setup({ kind: "adopt", path: dir, name: "ledger" });
    repos.setRunsOn(repo.id, AUTOMATIC_COMPUTER);
    const attachments = keepImages(randomUUID(), [{ ...pngImage, name: "ring.png" }]);
    const messageFiles: MessageFile[] = [];
    const content = "Crewmate,Ring\r\n3a9542a5,orphan\r\n".repeat(100);
    withPastedFiles("Read this", [{ name: "ring.csv", text: content }], messageFiles);

    const { taskId } = await supervisor.intake.commission({
      title: "Identify the orphan on the ring",
      intent: intentOf("which crewmate is the orange one at the bottom of this ring?"),
      repoId: repo.id,
      attachments,
      messageFiles,
    });
    await vi.waitFor(() => expect(crewmate.promptCalls.length).toBeGreaterThan(0));

    expect(tasks.get(taskId)?.status).toBe("active");
    const brief = crewmate.promptCalls[0] ?? "";
    expect(brief).toContain(
      "Pictures: the captain attached 1 picture to the messages this task came from.\nIt rides with this brief.",
    );
    const delivered = /^- ring\.png: (.+)$/m.exec(brief)?.[1] ?? "";
    expect(delivered).toContain(`/crewmates/${taskId}/temp/handover/`);
    expect(readFileSync(delivered)).toEqual(
      readFileSync(attachmentPath(attachments[0] as AttachmentRef)),
    );
    expect(crewmate.promptImageCalls[0]).toEqual([pngImage]);
    const file = /Attached file ring\.csv: (.+) \(the full copy/.exec(brief)?.[1] ?? "";
    expect(readFileSync(file).equals(Buffer.from(content))).toBe(true);
    // A retried first turn carries the picture again.
    expect(inbox.inFlight(taskId)[0]?.facts).toMatchObject({
      kind: "attachments-kept",
      attachments,
    });
  });

  it("hands a planned task the complete text file from its message, not just its preview", async () => {
    // INF-1389 friction 3: a complete text attachment follows the started task.
    vi.useRealTimers();
    initOverflowDir(scratchDir("infinitary-task-text-"));
    const crewmate = fakeCrewmate();
    const { supervisor, tasks } = setup(crewmate);
    const build = supervisor.intake.plan({
      title: "Read the notes",
      intent: intentOf("Read the notes"),
    });
    const messageFiles: MessageFile[] = [];
    const content = "Date,Observation\r\n2026-10-25,Dialog cannot open\r\n".repeat(100);
    const text = withPastedFiles("Read this", [{ name: "notes.csv", text: content }], messageFiles);
    tasks.capture.openAsk({ id: "text-message", text, messageFiles });
    tasks.capture.attachAsk("text-message", build.id, "tool:create_task");
    await supervisor.starts.startQueuedNow(build.key);
    await vi.waitFor(() => expect(crewmate.promptCalls.length).toBeGreaterThan(0));
    const brief = crewmate.promptCalls[0] ?? "";
    const delivered = /Attached file notes.csv: (.+) \(the full copy/.exec(brief)?.[1] ?? "";
    expect(delivered).toContain(`/crewmates/${build.id}/temp/handover/`);
    expect(readFileSync(delivered).equals(Buffer.from(content))).toBe(true);
    expect(statSync(delivered).mode & 0o777).toBe(0o600);
    expect(readFileSync(messageFiles[0]?.path ?? "", "utf8")).toBe(content);
  });

  it("refuses a changed text attachment before starting the model", async () => {
    // INF-1389 friction 3: never pass off a truncated or changed file as the attachment.
    vi.useRealTimers();
    initOverflowDir(scratchDir("infinitary-task-text-"));
    const crewmate = fakeCrewmate();
    const { supervisor, ops, tasks } = setup(crewmate);
    const messageFiles: MessageFile[] = [];
    withPastedFiles(
      "Read this",
      [{ name: "notes.txt", text: "Dialog cannot open." }],
      messageFiles,
    );
    writeFileSync(messageFiles[0]?.path ?? "", "Changed after acceptance.");
    // The answer comes before the start (INF-3060); the start refuses and
    // the first mate hears why.
    const { taskId, started } = await supervisor.intake.commission({
      title: "Read the notes",
      intent: intentOf("Read the notes"),
      messageFiles,
    });
    await started;
    expect(ops.find((line) => line.includes(`task ${taskId} "Read the notes"`))).toContain(
      "could not start",
    );
    expect(ops.find((line) => line.includes(`task ${taskId} "Read the notes"`))).toContain(
      "notes.txt changed",
    );
    expect(tasks.get(taskId)?.status).not.toBe("active");
    expect(crewmate.promptCalls).toEqual([]);
  });

  it("briefs a planned builder with the pictures of its own messages and its plan's, counting a copy that is gone", async () => {
    vi.useRealTimers();
    const crewmate = fakeCrewmate();
    const { supervisor, tasks } = setup(crewmate);
    const plan = supervisor.intake.plan({ title: "Plan the panel", intent: intentOf("plan it") });
    const build = supervisor.intake.plan({
      title: "Build the panel",
      intent: intentOf("build it"),
      shape: { basis: plan.key },
    });
    const message = (
      id: string,
      images: { mimeType: "image/png" | "image/jpeg"; data: string; name: string }[],
    ) => tasks.capture.openAsk({ id, text: id, attachments: keepImages(randomUUID(), images) });
    message("on-plan", [{ ...pngImage, name: "before.png" }]);
    message("on-build", [
      { ...jpegImage, name: "mock.jpg" },
      { ...pngImage, name: "before-again.png" },
    ]);
    message("gone", [
      {
        ...jpegImage,
        name: "lost.jpg",
        data: Buffer.from([0xff, 0xd8, 0xff, 1]).toString("base64"),
      },
    ]);
    tasks.capture.attachAsk("on-plan", plan.id, "tool:create_task");
    tasks.capture.attachAsk("on-build", build.id, "tool:update_task");
    tasks.capture.attachAsk("gone", build.id, "tool:update_task");
    rmSync(attachmentPath(tasks.capture.getAsk("gone")?.attachments[0] as AttachmentRef));

    await supervisor.starts.startQueuedNow(build.key);
    await vi.waitFor(() => expect(crewmate.promptCalls.length).toBeGreaterThan(0));
    const brief = crewmate.promptCalls[0] ?? "";
    // Its own messages first, then its plan's; the same picture sent twice rides once.
    expect(brief).toContain(
      "Pictures: the captain attached 3 pictures to the messages this task came from.\n2 pictures ride with this brief.\n1 picture could not be found among the app's copies.",
    );
    expect(brief).toMatch(/- mock\.jpg: .+\n- before-again\.png: .+$/m);
    expect(brief).not.toContain("before.png:");
    expect(crewmate.promptImageCalls[0]).toEqual([jpegImage, pngImage]);
  });
});
