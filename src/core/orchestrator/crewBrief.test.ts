import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { AttachmentRef } from "@shared/attachments";
import { AUTOMATIC_COMPUTER } from "@shared/placement";
import { describe, expect, it, vi } from "vitest";
import {
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
import type { CrewmateSpec } from "./crewSession";
import { renderRigorSection } from "./intentBrief";

// This file chains real git and is not about the utility-QoS clamp, so what
// the product spawns runs at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

fakeCrewTimersEachTest();

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
      const { taskId } = await supervisor.commission({
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
      expect(supervisor.crewStatus(taskId)[0]).toMatchObject({ rigor: "standard" });
      // Reviewed is only ever asked for - the user's words or the repo's
      // configured rigor - and its brief orders review before the PR.
      const askedFor = await supervisor.commission({
        title: "Careful fix",
        intent: intentOf("review this carefully before it lands"),
        repoId: view.id,
        shape: { rigor_ask: "reviewed" },
      });
      await tick();
      expect(tasks.get(askedFor.taskId)?.shape?.rigor).toBe("reviewed");
      expect(crewmate.promptCalls[1]).toContain(renderRigorSection("reviewed"));
      expect(supervisor.crewStatus(askedFor.taskId)[0]).toMatchObject({ rigor: "reviewed" });
      expect(supervisor.crewStatus(askedFor.taskId)[0]?.review).toBeUndefined();
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
      const asked = await supervisor.commission({
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
      const fromRepo = await supervisor.commission({
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
      const scratch = await supervisor.commission({ title: "Scratch", intent: intentOf("poke") });
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
      const { taskId } = await supervisor.commission({
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
      expect(await supervisor.startQueuedNow(followup?.key ?? "")).toContain("Started");
      await tick();
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
      await supervisor.startQueuedNow(second?.key ?? "");
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
    await supervisor.startQueuedNow("t-legacy");
    await tick();
    expect(tasks.get("t-legacy")?.shape).toMatchObject({
      kind_source: "legacy-judgment",
      rigor: "quick",
    });
    expect(legacyCrewmate.promptCalls[0]).toContain(renderRigorSection("quick"));
    await supervisor.startQueuedNow("t-followup");
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
    const { taskId } = await supervisor.commission({
      title: "Fix the dialog",
      intent: intentOf("fix the dialog in this picture"),
      attachments,
    });
    await tick();
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

    const { taskId } = await supervisor.commission({
      title: "Identify the orphan on the ring",
      intent: intentOf("which crewmate is the orange one at the bottom of this ring?"),
      repoId: repo.id,
      attachments,
      messageFiles,
    });
    await tick();

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
    const build = supervisor.plan({ title: "Read the notes", intent: intentOf("Read the notes") });
    const messageFiles: MessageFile[] = [];
    const content = "Date,Observation\r\n2026-10-25,Dialog cannot open\r\n".repeat(100);
    const text = withPastedFiles("Read this", [{ name: "notes.csv", text: content }], messageFiles);
    tasks.capture.openAsk({ id: "text-message", text, messageFiles });
    tasks.capture.attachAsk("text-message", build.id, "tool:create_task");
    await supervisor.startQueuedNow(build.key);
    await tick();
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
    const { supervisor } = setup(crewmate);
    const messageFiles: MessageFile[] = [];
    withPastedFiles(
      "Read this",
      [{ name: "notes.txt", text: "Dialog cannot open." }],
      messageFiles,
    );
    writeFileSync(messageFiles[0]?.path ?? "", "Changed after acceptance.");
    await expect(
      supervisor.commission({
        title: "Read the notes",
        intent: intentOf("Read the notes"),
        messageFiles,
      }),
    ).rejects.toThrow("notes.txt changed");
    expect(crewmate.promptCalls).toEqual([]);
  });

  it("briefs a planned builder with the pictures of its own messages and its plan's, counting a copy that is gone", async () => {
    vi.useRealTimers();
    const crewmate = fakeCrewmate();
    const { supervisor, tasks } = setup(crewmate);
    const plan = supervisor.plan({ title: "Plan the panel", intent: intentOf("plan it") });
    const build = supervisor.plan({
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

    await supervisor.startQueuedNow(build.key);
    await tick();
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
