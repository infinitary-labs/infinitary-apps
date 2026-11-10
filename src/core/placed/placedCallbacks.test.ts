import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION } from "@shared/ipc";
import { describe, expect, it, vi } from "vitest";
import { bundleAxiProcess } from "../../../tests/helpers/axiProcessBundle";
import { projectFontBytes } from "../../../tests/helpers/fontFixture";
import { pngImage } from "../../../tests/helpers/images";
import { piStubRuntime } from "../../../tests/helpers/piStubRuntime";
import {
  adoptHere,
  api,
  commit,
  gate,
  gitProject,
  kinds,
  MODEL,
  model,
  PROVIDER,
  placedWorldHooks,
  said,
  world,
} from "../../../tests/helpers/placedWorld";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import { attachmentPath, keepImages } from "../attachments";
import { CONTRACT_CHANGES } from "../connection/contractChanges";
import { createCrewmateTranscriptResolver } from "../observe/transcriptSource";
import { initOverflowDir, type MessageFile, withPastedFiles } from "../overflow";
import {
  crewmateCardPicturesDir,
  crewmateHandoverDir,
  crewmatePlacedDir,
  crewmateSessionsDir,
} from "../paths";
import { crewmateComputersNote } from "../pi/piResources";
import { Runbooks } from "../runbooks/runbooks";
import { forkChildProcess } from "../sql/forkChildProcess";
import { CrewTranscripts } from "../tasks/crewTranscript";
import { handoverFileName } from "../tasks/handoverFiles";
import { seedTask } from "../tasks/seedTask";
import { TaskTimeline } from "../tasks/taskTimeline";
import { NO_PLACED_TASK } from "./placedWork";

/**
 * A task that runs on a computer that runs work (`tests/helpers/placedWorld.ts`):
 * what its computer asks of this Mac: each callback done once and kept, begun marks, the files a turn sends, a live copy of its record, and closing.
 */

// Integration budget (docs/test-cohorts.md): real git on the computer and
// here, the slowest test 1.28 s at its fastest of nineteen runs on an Apple
// silicon Mac, with git unclamped as below. A poll waits for work that
// crosses the connection and runs git on both sides - a closed task's
// working copy kept, brought home and deleted took 0.46 s alone and 1.7 s
// with sixteen copies of this file running at once - so it waits for the
// rest of the test's budget, never Vitest's 1 s (tests/helpers/waitWindow.ts).
vi.setConfig({ testTimeout: 10_000 });

// On a Mac the product runs every git below the UI (`taskpolicy -c
// utility`, utilityQos.ts), where it yields to every busier process. A case
// here runs up to about a hundred gits one after another, so on a Mac
// loaded by other runs it waited on that load rather than its own work and
// ran past its budget. This file is about placed tasks, not that clamp
// (utilityQos.test.ts holds it), so its git runs as on a Mac without
// taskpolicy, at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

/** The home's one clock: the wall clock, moved on when a case waits out a backoff. */
let ahead = 0;
const now = () => Date.now() + ahead;
placedWorldHooks({
  now,
  reset: () => {
    ahead = 0;
  },
});

describe("a task that runs on a computer that runs work", () => {
  // Intent: the captain's accepted INF-311 plan, window 1: the effect survives but its answer does not.
  it("does not repeat a begun change after a home restart without its answer (INF-312)", async () => {
    const at = await world();
    const slow = gate();
    model([{ held: slow.held, text: "Finished after recovery." }]);
    await at.start("t-begun");
    // The restart cuts a real held turn, not dispatch's initial idle state.
    await expect.poll(() => api.openRequests()).toBe(1);
    const request = { task: "t-begun", callId: "progress-cut", text: "Progress before the cut." };
    const dir = crewmatePlacedDir(at.home().paths, request.task);
    const progress = at.home().tasks.noteProgress.bind(at.home().tasks);
    const effect = vi.spyOn(at.home().tasks, "noteProgress").mockImplementation((...args) => {
      // The persisted mark is already readable at the effect's owner.
      expect(readFileSync(join(dir, "begun.jsonl"), "utf8")).toContain(
        JSON.stringify(request.callId),
      );
      return progress(...args);
    });
    await at.home().placed.answer(at.deviceId, "inf:work:progress", request);
    expect(effect).toHaveBeenCalledTimes(1);
    effect.mockRestore();
    expect(readFileSync(join(dir, "begun.jsonl"), "utf8")).toContain(
      JSON.stringify(request.callId),
    );
    expect(
      at
        .home()
        .tasks.timeline(request.task)
        .filter((event) => event.kind === "progress"),
    ).toHaveLength(1);
    // Model the exact cut: the change happened, but calls.jsonl never kept its answer.
    await at.restartHome(() => {
      writeFileSync(join(dir, "calls.jsonl"), "");
      // A report that began, but never answered, must not enter adoption's replay list.
      writeFileSync(
        join(dir, "begun.jsonl"),
        `${readFileSync(join(dir, "begun.jsonl"), "utf8")}\n${JSON.stringify("report-cut")}\n${JSON.stringify("card-cut")}\n${JSON.stringify("reply-cut")}\n`,
      );
    });
    await at.inReach(request.task);
    const home = at.home();
    const before = home.tasks
      .timeline(request.task)
      .filter((event) => event.kind === "progress").length;
    for (let repeat = 0; repeat < 2; repeat++)
      await expect(home.placed.answer(at.deviceId, "inf:work:progress", request)).rejects.toThrow(
        "stopped while recording your progress",
      );
    expect(
      home.tasks.timeline(request.task).filter((event) => event.kind === "progress"),
    ).toHaveLength(before);
    const kept = readFileSync(join(dir, "calls.jsonl"), "utf8");
    expect(kept.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(kept)).toMatchObject({
      callId: request.callId,
      error: expect.stringContaining("Read your task with tasks"),
    });
    expect(JSON.parse(kept).report).toBeUndefined();
    expect(JSON.parse(kept).error).toContain("Read your task with tasks before continuing");
    expect(JSON.parse(kept).error).not.toContain("timeline with tasks");
    expect(JSON.parse(kept).error).not.toMatch(/inf:work:|the destination/);
    await expect(
      home.placed.answer(at.deviceId, "inf:work:report", {
        task: request.task,
        callId: "report-cut",
        text: "Must not replay this report.",
      }),
    ).rejects.toThrow("the report may already be recorded");
    await expect(
      home.placed.answer(at.deviceId, "inf:work:card", {
        task: request.task,
        callId: "card-cut",
        card: {
          title: "Recovery check",
          body: "<p>Check before showing it again.</p>",
          actions: [],
        },
      }),
    ).rejects.toThrow("stopped while showing this card, so it may already be up");
    await expect(
      home.placed.answer(at.deviceId, "inf:work:reply", {
        task: request.task,
        callId: "reply-cut",
        cardId: "card-t-begun",
        text: "Already posted?",
      }),
    ).rejects.toThrow("cannot confirm whether the reply was posted");
    // Reads still run on another ask, rather than acquiring a begun mark.
    const read = { task: request.task, callId: "read-cut", input: {} };
    await home.placed.answer(at.deviceId, "inf:work:tasks", read);
    expect(readFileSync(join(dir, "begun.jsonl"), "utf8")).not.toContain("read-cut");
    expect(home.tasks.get(request.task)?.outcome).toBeNull();
    slow.open();
    // Idle can also describe adoption; the saved outcome witnesses this turn's completion.
    await expect.poll(() => home.tasks.get(request.task)?.outcome).toBe("Finished after recovery.");
    expect(home.tasks.get(request.task)?.activity).toBe("idle");
    console.info("Window 1 recovery:", kept.trim(), "progress count unchanged:", before);
  });

  it("leaves no begun mark when the task conversation is not ready (INF-312)", async () => {
    const at = await world();
    const home = at.home();
    seedTask(home.tasks, {
      id: "t-not-ready",
      title: "Not open",
      status: "running",
      deviceId: at.deviceId,
    });
    await expect(
      home.placed.answer(at.deviceId, "inf:work:progress", {
        task: "t-not-ready",
        callId: "not-ready",
        text: "Not yet.",
      }),
    ).rejects.toThrow("not open");
    expect(existsSync(join(crewmatePlacedDir(home.paths, "t-not-ready"), "begun.jsonl"))).toBe(
      false,
    );
  });

  // INF-40: the captain saw Working beside an empty Crewmate tab on a placed task.
  it("copies completed steps into the Crewmate tab before the placed turn ends", async () => {
    const at = await world();
    const held = gate();
    const next = gate();
    const copying = gate();
    const firstCopy = gate();
    const trailingCopy = gate();
    const home = at.home();
    const ask = home.devices.ask.bind(home.devices);
    let copies = 0;
    const sent = vi.spyOn(home.devices, "ask").mockImplementation(async (device, channel, args) => {
      const answer = await ask(device, channel, args);
      if (channel === "inf:session:copy") {
        copies += 1;
        if (copies === 1) {
          firstCopy.open();
          await copying.held;
        } else if (copies === 2) trailingCopy.open();
      }
      return answer;
    });
    const progress = (text: string) => ({ tools: [{ name: "note_progress", args: { text } }] });
    model([
      progress("Reading the footer on Mac mini."),
      { ...progress("Checking the footer."), held: next.held },
      progress("The footer checks passed."),
      { held: held.held, text: "The footer is fixed." },
    ]);
    try {
      await at.start("t-live");
      await firstCopy.held;
      next.open();
      // The live transfer must not hold up event delivery or pile up one transfer per step.
      await expect
        .poll(() => kinds(home, "t-live").filter((kind) => kind === "progress").length)
        .toBe(3);
      expect(copies).toBe(1);
      // Review F3: a backwards clock adjustment cannot postpone the trailing transfer by a minute.
      ahead -= 60_000;
      copying.open();
      await expect.poll(() => api.openRequests()).toBe(1);
      const recordDirOf = (id: string) => crewmateSessionsDir(home.paths, id);
      const resolve = createCrewmateTranscriptResolver({
        recordDirOf,
        backendOf: () => undefined,
        configDirOf: () => undefined,
      });
      const reader = new CrewTranscripts({
        recordDirOf,
        currentSession: (task) => resolve(task).path,
      });
      const read = () => {
        const task = home.tasks.get("t-live");
        if (!task) throw new Error("The placed task is missing.");
        return reader.of(task, home.tasks.timeline(task.id), false);
      };
      await trailingCopy.held;
      await expect.poll(() => read().lines.filter((line) => line.kind === "plan").length).toBe(3);
      expect(copies).toBe(2);
      expect(home.tasks.get("t-live")?.activity).toBe("running");
      expect(api.openRequests()).toBe(1);
      held.open();
      await expect.poll(() => home.tasks.get("t-live")?.activity).toBe("idle");
      expect(read().lines).toContainEqual(
        expect.objectContaining({ kind: "said", text: "The footer is fixed." }),
      );
      const [file] = readdirSync(at.folders("t-live").sessions);
      expect(file).toBeDefined();
      expect(readFileSync(join(recordDirOf("t-live"), file ?? ""), "utf8")).toBe(
        readFileSync(join(at.folders("t-live").sessions, file ?? ""), "utf8"),
      );
    } finally {
      next.open();
      copying.open();
      held.open();
      sent.mockRestore();
    }
  });
  it("carries captain-message pictures and text into the started task's hand-over folder without a helper task", async () => {
    // INF-1389 friction 3: an attached screenshot must follow its task, not need a helper task.
    const vision = await piStubRuntime(api.url, {
      provider: PROVIDER,
      id: MODEL,
      input: ["text", "image"],
    });
    const at = await world(undefined, { runtime: vision });
    const home = at.home();
    const task = "t-message-files";
    const attachments = keepImages("captain-message-files", [{ ...pngImage, name: "dialog.png" }]);
    initOverflowDir(scratchDir("infinitary-message-files-"));
    const messageFiles: MessageFile[] = [];
    const content =
      "Date,Observation\r\n2026-10-25,Dialog cannot open\r\n".repeat(100) +
      "End of complete attachment.\r\n";
    const text = withPastedFiles(
      "Fix this dialog",
      [
        { name: "notes.csv", text: content },
        { name: "empty.txt", text: "" },
      ],
      messageFiles,
    );
    seedTask(home.tasks, {
      id: task,
      title: "Fix the dialog",
      prompt: text,
      status: "queued",
      deviceId: at.deviceId,
    });
    home.tasks.capture.openAsk({ id: "message-files", text, attachments, messageFiles });
    home.tasks.capture.attachAsk("message-files", task, "tool:create_task");
    // Read the durable references again at dispatch, not the initial input objects.
    expect(home.tasks.capture.getAsk("message-files")?.messageFiles).toEqual(messageFiles);
    const dir = join(at.folders(task).temp, "handover");
    const picture = attachments[0];
    const file = messageFiles[0];
    const empty = messageFiles[1];
    if (!picture || !file || !empty) throw new Error("No attachment references");
    const imagePath = join(dir, handoverFileName(picture.name, picture.sha256));
    const textPath = join(dir, handoverFileName(file.name, file.sha256));
    const emptyPath = join(dir, handoverFileName(empty.name, empty.sha256));
    model([
      {
        tools: [
          { name: "read", args: { path: imagePath } },
          { name: "read", args: { path: textPath } },
        ],
      },
      { text: "Opened the picture and the complete text file from my hand-over folder." },
    ]);
    const requests = api.requests.length;
    await home.supervisor.starts.dispatchQueuedTask(task);
    expect(home.tasks.get(task)?.gate, JSON.stringify(home.tasks.timeline(task))).toBeNull();
    expect(home.tasks.get(task)?.status).toBe("active");
    await expect.poll(() => home.tasks.get(task)?.activity).toBe("idle");
    expect(JSON.stringify(api.requests.at(-1))).toContain("End of complete attachment.");
    expect(readFileSync(emptyPath).length).toBe(0);
    expect(readFileSync(imagePath)).toEqual(readFileSync(attachmentPath(picture)));
    expect(readFileSync(textPath).equals(Buffer.from(content))).toBe(true);
    for (const path of [imagePath, textPath, emptyPath])
      expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const request = JSON.stringify(api.requests.slice(requests));
    expect(request).toContain(imagePath);
    expect(request).toContain(textPath);
    expect(
      home.tasks
        .list()
        .filter((entry) => entry.kind === "work")
        .map((entry) => entry.id),
    ).toEqual([task]);
    console.log(
      "INF-1389 attachment delivery proof",
      JSON.stringify({
        files: [imagePath, textPath, emptyPath].map((path) => ({
          path,
          bytes: statSync(path).size,
          mode: statSync(path).mode & 0o777,
        })),
        directoryMode: statSync(dir).mode & 0o777,
        completeBytesMatch: true,
        destinationPathsInBrief: true,
        workTasks: [task],
      }),
    );
  });

  // INF-2225, INF-2214's approved shared cards: a computer from before shared
  // cards would read a write on someone else's card as its own card shown,
  // so the home refuses it before anything is saved.
  it("refuses a write on someone else's card from a computer before shared cards, saving nothing", async () => {
    const at = await world(undefined, { changes: [] });
    const home = at.home();
    // Its hello has arrived; a list with no names is sent as none at all.
    await expect.poll(() => home.devices.version(at.deviceId)?.contract).toBe(PROTOCOL_VERSION);
    expect(home.devices.version(at.deviceId)?.changes ?? []).not.toContain("shared-cards");
    expect(home.placed.takesSharedCards(at.deviceId)).toBe(true);
    model([{ text: "Looking for the remover." }]);
    await at.start("t-old-cards", "Find the job host remover's path.");
    await expect.poll(() => home.tasks.get("t-old-cards")?.activity).toBe("idle");
    // The task already exists when the computer reconnects with an older contract.
    await at.restartComputer({ protocolVersion: `${CONTRACT_CHANGES.major - 1}.0.0`, changes: [] });
    await expect
      .poll(() => home.devices.version(at.deviceId)?.contract)
      .toBe(`${CONTRACT_CHANGES.major - 1}.0.0`);
    expect(home.placed.takesSharedCards(at.deviceId)).toBe(false);
    const id = home.supervisor.addFirstmateCard({
      title: "Remove the job host",
      body: "<p>Run the remover on the shell PC.</p>",
      actions: [],
    });
    const answer = await home.placed.answer(at.deviceId, "inf:work:card", {
      task: "t-old-cards",
      callId: "old-shared-write",
      card: {
        id,
        title: "Remove the job host",
        body: "<p>Run C:\\FleetCheckSetup\\shell-pc-job-host-remove.cmd on the shell PC.</p>",
        actions: [],
        reply: "It is at C:\\FleetCheckSetup\\shell-pc-job-host-remove.cmd.",
      },
    });
    expect(answer).toMatchObject({
      refused: { reason: "other", why: expect.stringContaining("runs an older Infinitary") },
    });
    expect(home.supervisor.cards.thread(id).messages).toEqual([]);
    const cards = home.supervisor.cards.snapshot();
    expect(cards.find((card) => card.id === id)?.body).toBe(
      "<p>Run the remover on the shell PC.</p>",
    );
    expect(cards.filter((card) => card.taskId === "t-old-cards")).toEqual([]);
  });

  // INF-2599 (the captain: "Send a crewmate its directions once, and again
  // only when they change"): the home holds a crewmate's directions as read
  // only where its computer tells it of each fold, and serves them on every
  // turn to one that does not.
  it.each([true, false])(
    "reads whether a computer tells it of its conversations' folds (current work major: %s)",
    async (lists) => {
      const at = await world(undefined, {
        protocolVersion: lists ? PROTOCOL_VERSION : `${CONTRACT_CHANGES.major - 1}.0.0`,
        changes: [],
        // Protected Secrets discovery also needs the real task channel, not
        // merely a compatible version (the metadata-only remote catalog intent).
        taskChannel: await bundleAxiProcess(),
      });
      const home = at.home();
      await expect
        .poll(() => home.devices.version(at.deviceId)?.contract)
        .toBe(lists ? PROTOCOL_VERSION : `${CONTRACT_CHANGES.major - 1}.0.0`);
      expect(home.placed.reportsFolds(at.deviceId)).toBe(lists);
      // Secrets discovery is metadata only and still needs this work major.
      expect(home.placed.takesSecrets(at.deviceId)).toBe(lists);
      expect(home.placed.answersFiles(at.deviceId)).toBe(lists);
    },
  );

  it("delivers bundled runbook skills on the current major without the retired name", async () => {
    // INF-1109 required conflict integration: preserve main's runbook transport
    // without treating a retired minor name as permission or a missing capability.
    const runbooks = new Runbooks(join(__dirname, "../../../resources/runbooks"), {
      getRunbookStates: () => ({}),
      setRunbookStates: () => {},
    });
    const at = await world(undefined, { changes: [], runbooks });
    model([{ text: "The bundled guidance reached this computer." }]);
    await at.start("t-runbooks-major");
    await expect
      .poll(() => at.home().tasks.get("t-runbooks-major")?.outcome)
      .toBe("The bundled guidance reached this computer.");
    expect(at.home().devices.version(at.deviceId)?.changes ?? []).toEqual([]);
    const request = JSON.stringify(api.requests);
    expect(request).toContain("Runbook resources:");
    expect(request).toContain("lessons");
    expect(at.bound).toHaveLength(1);
  });

  // INF-1109's required main integration keeps INF-1555 F12's refusal at the
  // work-major boundary; historical names cannot grant an older peer work.
  it("keeps a direct-pr change queued until its computer takes the current work major", async () => {
    const protocolVersion = `${CONTRACT_CHANGES.major - 1}.0.0`;
    const at = await world(undefined, { protocolVersion, changes: ["check-declarations"] });
    const home = at.home();
    await expect
      .poll(() => home.devices.version(at.deviceId)?.changes)
      .toEqual(["check-declarations"]);
    expect(home.placed.takesCheckDeclarations(at.deviceId)).toBe(false);
    expect(home.placed.takesMoves(at.deviceId)).toBe(false);
    // Even advertising the retired check, runbook and task-move names cannot grant work.
    await at.restartComputer({
      protocolVersion,
      changes: ["check-declarations", "merge-offer-readiness", "runbooks", "task-move"],
    });
    await expect
      .poll(() => home.devices.version(at.deviceId)?.changes)
      .toEqual(["check-declarations", "merge-offer-readiness", "runbooks", "task-move"]);
    expect(home.placed.takesCheckDeclarations(at.deviceId)).toBe(false);
    expect(home.placed.takesMoves(at.deviceId)).toBe(false);

    const { repo } = await home.repos.setup({ kind: "init", name: "check-declarations" });
    home.repos.configure(repo.id, { delivery: "direct-pr" });
    seedTask(home.tasks, {
      id: "t-old-check-tool",
      title: "Fix the project checks",
      status: "queued",
      repoId: repo.id,
      deviceId: at.deviceId,
      shape: { kind: "fix", kind_source: "host:test", deliverable: "change", rigor_ask: "quick" },
    });
    const requests = api.requests.length;
    await home.supervisor.starts.dispatchQueuedTask("t-old-check-tool");
    // Another major is already out of reach for work: dispatch never reaches
    // the old within-major feature refusal or starts a model conversation.
    expect(home.devices.version(at.deviceId)?.contract).toBe(protocolVersion);
    expect(home.placed.ready(at.deviceId, "t-old-check-tool")).toBe(false);
    expect(home.tasks.get("t-old-check-tool")).toMatchObject({
      status: "open",
      activity: null,
      gate: null,
    });
    expect(api.requests).toHaveLength(requests);
    await at.restartComputer({ protocolVersion: PROTOCOL_VERSION, changes: [] });
    await expect.poll(() => home.placed.takesCheckDeclarations(at.deviceId)).toBe(true);
    expect(home.placed.takesMoves(at.deviceId)).toBe(true);
  });

  it.each(["10.1.0", "11.0.0"])(
    "keeps an attachment task queued on an older contract %s",
    async (protocolVersion) => {
      // INF-1389 friction 3: no silent path-only fallback on an older computer.
      const at = await world(undefined, {
        protocolVersion,
      });
      const home = at.home();
      initOverflowDir(scratchDir("infinitary-attachment-update-"));
      const messageFiles: MessageFile[] = [];
      const text = withPastedFiles("Read this", [{ name: "empty.txt", text: "" }], messageFiles);
      seedTask(home.tasks, {
        id: "t-old-attachments",
        title: "Read attached file",
        prompt: text,
        status: "queued",
        deviceId: at.deviceId,
      });
      home.tasks.capture.openAsk({ id: "old-attachments", text, messageFiles });
      home.tasks.capture.attachAsk("old-attachments", "t-old-attachments", "tool:create_task");
      const requests = api.requests.length;
      await home.supervisor.starts.dispatchQueuedTask("t-old-attachments");
      expect(home.tasks.get("t-old-attachments")).toMatchObject({ status: "open", activity: null });
      expect(home.devices.version(at.deviceId)?.contract).toBe(protocolVersion);
      expect(home.placed.ready(at.deviceId, "t-old-attachments")).toBe(false);
      expect(home.placed.takesHandover(at.deviceId)).toBe(false);
      expect(api.requests.length).toBe(requests);
      await at.restartComputer({ protocolVersion: PROTOCOL_VERSION });
      await expect.poll(() => home.devices.version(at.deviceId)?.contract).toBe(PROTOCOL_VERSION);
      await at.inReach("t-old-attachments");
      model([{ text: "Read the attached file." }]);
      await home.supervisor.starts.dispatchQueuedTask("t-old-attachments");
      await expect
        .poll(() => home.tasks.get("t-old-attachments")?.outcome)
        .toBe("Read the attached file.");
      const files = readdirSync(join(at.folders("t-old-attachments").temp, "handover"));
      expect(files).toHaveLength(1);
      expect(
        statSync(join(at.folders("t-old-attachments").temp, "handover", files[0] ?? "missing"))
          .size,
      ).toBe(0);
    },
  );

  it("hands a file one task there reports to another task there, and never puts its content anywhere else", async () => {
    // INF-992, direction B: "a second task can hand files to the waiting
    // task"; the captain's words on it: "make sure file content never gets
    // printed or leaked because it's possible the file can contain secrets".
    const at = await world();
    const secret = `client_secret=${createHash("sha256").update("INF-992").digest("hex")}`;
    const found = join(scratchDir("infinitary-placed-found-"), "client secret.json");
    writeFileSync(found, `{"installed":{"${secret}"}}\n`);
    model([{ text: "Waiting for the client file." }]);
    await at.start("t-wait", "Build with the Google client file.");
    const home = at.home();
    await expect.poll(() => home.tasks.get("t-wait")?.activity).toBe("idle");
    model([
      { tools: [{ name: "report", args: { text: "Found the client file.", files: [found] } }] },
      { text: "Reported." },
    ]);
    const requests = api.requests.length;
    await at.start("t-find", "Find the Google client file.");
    await expect.poll(() => home.tasks.get("t-find")?.activity).toBe("idle");
    // The home holds it whole, and its report names it by kept name and size alone.
    const sha256 = createHash("sha256").update(readFileSync(found)).digest("hex");
    const kept = `${sha256.slice(0, 16)}-client_secret.json`;
    const atHome = join(home.paths.crewmatesDir, "t-find", "handover-out", kept);
    expect(readFileSync(atHome)).toEqual(readFileSync(found));
    expect(statSync(atHome).mode & 0o777).toBe(0o600);
    expect(home.tasks.get("t-find")?.outcome).toContain(
      `Files handed on, kept for steer_crewmate files_from ${home.tasks.get("t-find")?.key}: ${kept}`,
    );
    // The first mate's steer hands it to the waiting task, in its hand-over folder there.
    model([{ text: "Using it." }]);
    const words = await home.supervisor.sessions.handFiles("t-find", "t-wait");
    const delivered = join(at.folders("t-wait").temp, "handover", kept);
    expect(words).toContain(delivered);
    expect(readFileSync(delivered)).toEqual(readFileSync(found));
    expect(statSync(delivered).mode & 0o777).toBe(0o600);
    // Nothing but the handed copies holds its content: no record, transcript,
    // feed line, journal or model request on either computer.
    const holders = (dir: string): string[] =>
      readdirSync(dir, { recursive: true, encoding: "utf8" }).flatMap((name) => {
        const path = join(dir, name);
        return lstatSync(path).isFile() && readFileSync(path).includes(secret) ? [path] : [];
      });
    expect(holders(home.paths.crewmatesDir)).toEqual([atHome]);
    expect(holders(dirname(home.paths.crewmatesDir)).filter((path) => path !== atHome)).toEqual([]);
    expect(holders(at.dataDir).sort()).toEqual(
      [join(at.folders("t-find").temp, "handover-out", kept), delivered].sort(),
    );
    expect(JSON.stringify(api.requests.slice(requests))).not.toContain(secret);
    expect(words).not.toContain(secret);
  });

  // INF-1484 E1: on-ask history must survive the real placed session's work-request parser.
  // Real paired connection, SessionHost, home dispatcher and SQLite; only model words are scripted.
  it("carries an explicit timeline field through a placed session without expanding ordinary reads", async () => {
    const at = await world();
    const home = at.home();
    const target = seedTask(home.tasks, {
      id: "timeline-target",
      title: "Read the saved practice release checks",
      status: "queued",
      startPolicy: "on-request",
      intent: {
        goal: "The earlier check remains readable.",
        userWords: "read the saved practice release checks",
      },
    });
    home.tasks.turns.recordReport(target.id, {
      text: "The Mac check stopped the practice release. The saved work is unchanged.",
    });
    const expected = new TaskTimeline({ tasks: home.tasks }).sources(target.id);
    expect(expected.length).toBeGreaterThan(0);
    const outcome = "The placed history read is complete.";
    model([
      { tools: [{ name: "tasks", args: { key: target.key } }] },
      { tools: [{ name: "tasks", args: { key: target.key, field: "timeline" } }] },
      { tools: [{ name: "report", args: { text: outcome } }] },
      { text: "Reported." },
    ]);
    await at.start("t-first");
    await expect.poll(() => home.tasks.get("t-first")?.outcome).toBe(outcome);
    const calls = readFileSync(
      join(crewmatePlacedDir(home.paths, "t-first"), "calls.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as { channel: string; answer?: { rows: Record<string, unknown>[] } },
      );
    const replies = calls
      .filter((call) => call.channel === "inf:work:tasks")
      .map((call) => call.answer);
    expect(replies).toHaveLength(2);
    expect(replies[0]?.rows[0]).toMatchObject({ task_id: target.id, key: target.key });
    expect(replies[0]?.rows[0]).not.toHaveProperty("timeline");
    expect(replies[1]?.rows[0]?.timeline).toEqual(expected);
    console.info("Placed on-ask history replies", JSON.stringify({ task: target.key, replies }));
  });

  it("starts there, does each callback once here, and keeps its report and a copy of its record", async () => {
    const at = await world();
    model([
      { tools: [{ name: "note_progress", args: { text: "Started on the footer." } }] },
      { tools: [{ name: "report", args: { text: "The footer is fixed.", summary: "Fixed." } }] },
      { text: "Reported." },
    ]);
    const requests = api.requests.length;
    await at.start("t-first");
    const home = at.home();
    await expect.poll(() => home.tasks.get("t-first")?.outcome).toBe("The footer is fixed.");
    expect(home.tasks.get("t-first")).toMatchObject({
      deviceId: at.deviceId,
      activity: "idle",
      worktreeDir: "",
      sessionFile: expect.stringContaining(at.folders("t-first").sessions),
    });
    // Its brief reached the model there, as a crewmate told that computer's folders.
    const brief = api.requests[requests];
    expect(said(brief)).toContain("Fix the footer.");
    expect(JSON.stringify(brief?.body.system)).toContain(at.folders("t-first").evidence);
    // It is told which computer it is on (INF-567: "hmm this is because we
    // set this up on my macbook?"), so a folder path from the home reads as
    // naming nothing there.
    expect(JSON.stringify(brief?.body.system)).toContain(
      JSON.stringify(
        crewmateComputersNote({
          here: "Builder",
          workers: [{ name: "Builder", sameComputer: true }],
        }),
      ).slice(1, -1),
    );
    // Each callback had its effect here once, and the brief left the lane.
    expect(kinds(home, "t-first").filter((kind) => kind === "progress")).toHaveLength(1);
    expect(home.inbox.allFor("t-first")).toEqual([]);
    expect(home.inbox.inFlight("t-first")).toEqual([]);
    expect(api.requests.length - requests).toBe(3);
    // The crew's events reached the feed as any crewmate's do, named by where it runs.
    expect(home.events).toContainEqual(
      expect.objectContaining({ type: "task_started", taskId: "t-first", machineId: at.deviceId }),
    );
    expect(home.events).toContainEqual(
      expect.objectContaining({ type: "tool_start", taskId: "t-first", toolName: "report" }),
    );
    // A copy of its record is here, the same bytes as there.
    const there = at.folders("t-first").sessions;
    const [file] = readdirSync(there);
    expect(file).toBeDefined();
    const copy = join(crewmateSessionsDir(home.paths, "t-first"), file ?? "");
    expect(readFileSync(copy, "utf8")).toBe(readFileSync(join(there, file ?? ""), "utf8"));
    // Every callback's answer is kept here, by its id.
    const calls = readFileSync(
      join(crewmatePlacedDir(home.paths, "t-first"), "calls.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { channel: string });
    expect(calls.map((call) => call.channel)).toEqual(["inf:work:progress", "inf:work:report"]);
  });

  // INF-3022's plan, "a crewmate on a work computer reaches the same tool":
  // its start_program call travels to the home, which files the program on
  // its record, found on the task there and waited on.
  it("starts a program at the home from a crewmate there (INF-3022)", async () => {
    const project = await gitProject();
    const at = await world(undefined, {
      programProcess: forkChildProcess(
        fileURLToPath(new URL("../program/programProcess.ts", import.meta.url)),
      ),
    });
    const home = at.home();
    const { repo } = await adoptHere(home.repos, project.home);
    model([
      {
        tools: [
          {
            name: "start_program",
            args: {
              title: "Read the website",
              goal: "Say what the website's README holds.",
              script: 'return { read: "README.md" };',
              bound: 1,
            },
          },
        ],
      },
      { text: "Started it." },
    ]);
    await at.start("t-program", "Read the website; use start_program to do this.", repo.id);
    await expect
      .poll(() => home.tasks.list().find((row) => row.shape?.program)?.title)
      .toBe("Read the website");
    const program = home.tasks.list().find((row) => row.shape?.program);
    if (!program) throw new Error("no program was filed");
    expect(home.tasks.crewFilingOrigin(program.id)?.id).toBe("t-program");
    expect(home.tasks.graph.blockers("t-program").map((row) => row.id)).toContain(program.id);
    await expect.poll(() => home.tasks.get(program.id)?.status).toBe("done");
    expect(home.tasks.latestResult(program.id)?.value).toEqual({ read: "README.md" });
    // The call was answered here once, kept by its id.
    await expect
      .poll(() =>
        readFileSync(join(crewmatePlacedDir(home.paths, "t-program"), "calls.jsonl"), "utf8")
          .trim()
          .split("\n")
          .map((line) => (JSON.parse(line) as { channel: string }).channel)
          .filter((channel) => channel === "inf:work:start-program"),
      )
      .toHaveLength(1);
  });

  // INF-378's two divergent-record cases now belong to pi/placedMigration.test.ts.

  it("closes the conversation there when its record closes, now or once the computer is back", async () => {
    const at = await world();
    model([{ text: "Done here." }, { text: "Done there." }]);
    await at.start("t-close-now");
    await at.start("t-close-later");
    const home = at.home();
    await expect.poll(() => home.tasks.get("t-close-later")?.activity).toBe("idle");
    const roster = async () =>
      (await home.devices.ask(at.deviceId, "inf:session:roster", [])) as {
        tasks: { task: string; closed: boolean }[];
      };

    await home.supervisor.sessions.interruptCrewmate("t-close-now", "cancel");
    await expect
      .poll(async () => (await roster()).tasks.find((task) => task.task === "t-close-now")?.closed)
      .toBe(true);

    await home.drop();
    await home.supervisor.sessions.interruptCrewmate("t-close-later", "cancel");
    await home.listen();
    await expect
      .poll(
        async () => (await roster()).tasks.find((task) => task.task === "t-close-later")?.closed,
      )
      .toBe(true);
  });

  it("keeps a card's demo recording once its last piece arrives, and never a piece past its end", async () => {
    const at = await world();
    const home = at.home();
    seedTask(home.tasks, {
      id: "t-demo",
      title: "Shows a demo",
      status: "running",
      deviceId: at.deviceId,
    });
    const id = `t-demo-${"e".repeat(32)}`;
    const recording = Buffer.from(Array.from({ length: 10 }, (_, at) => at));
    const kept = join(crewmateCardPicturesDir(home.paths, "t-demo"), `${id}.mp4`);
    const piece = (callId: string, offset: number, bytes: Buffer, size = recording.length) =>
      home.placed.answer(at.deviceId, "inf:work:media", {
        task: "t-demo",
        callId,
        id,
        extension: "mp4",
        offset,
        size,
        data: bytes.toString("base64"),
      });
    await piece("call-1", 0, recording.subarray(0, 6));
    // Part of it is no recording a card may name yet.
    expect(existsSync(kept)).toBe(false);
    await piece("call-2", 6, recording.subarray(6));
    expect(readFileSync(kept)).toEqual(recording);
    await expect(piece("call-3", 8, recording.subarray(0, 4))).rejects.toThrow(
      /past the recording's end/,
    );
    // Another task's recording is not this task's to keep.
    await expect(
      home.placed.answer(at.deviceId, "inf:work:media", {
        task: "t-demo",
        callId: "call-4",
        id: `t-other-${"e".repeat(32)}`,
        extension: "mp4",
        offset: 0,
        size: 1,
        data: "AA==",
      }),
    ).rejects.toThrow(/not this task's/);
  });

  it("keeps a project font a card's preview names where this Mac's frames load it, and only this task's", async () => {
    const at = await world();
    const home = at.home();
    seedTask(home.tasks, {
      id: "t-font",
      title: "Shows a preview",
      status: "running",
      deviceId: at.deviceId,
    });
    const id = `t-font-${"a".repeat(32)}`;
    const font = projectFontBytes();
    await home.placed.answer(at.deviceId, "inf:work:typeface", {
      task: "t-font",
      callId: "call-1",
      id,
      extension: "woff2",
      data: font.toString("base64"),
    });
    const kept = join(crewmateCardPicturesDir(home.paths, "t-font"), `${id}.woff2`);
    expect(readFileSync(kept)).toEqual(font);
    // A copy damaged in place is replaced whole when the same font arrives again.
    writeFileSync(kept, Buffer.alloc(font.length));
    await home.placed.answer(at.deviceId, "inf:work:typeface", {
      task: "t-font",
      callId: "call-1b",
      id,
      extension: "woff2",
      data: font.toString("base64"),
    });
    expect(readFileSync(kept)).toEqual(font);
    await expect(
      home.placed.answer(at.deviceId, "inf:work:typeface", {
        task: "t-font",
        callId: "call-2",
        id: `t-other-${"a".repeat(32)}`,
        extension: "woff2",
        data: font.toString("base64"),
      }),
    ).rejects.toThrow(/not this task's/);
  });

  it("carries measured remote lines into the offered completion card (INF-1235)", async () => {
    // Captain chose “Fix remote-task line counts”: real git and the paired connection,
    // ending at the host-authored completion strip, with no provider sign-in or network git.
    const project = await gitProject();
    const at = await world();
    const home = at.home();
    const { repo } = await adoptHere(home.repos, project.home);
    home.repos.configure(repo.id, { rigor: "quick", delivery: "direct-pr" });
    model([{ text: "Ready for the footer." }]);
    await at.start("t-lines", "Describe the website footer.", repo.id);
    await expect.poll(() => home.tasks.get("t-lines")?.activity).toBe("idle");
    const dir = at.folders("t-lines").work;
    writeFileSync(join(dir, "README.md"), "# website\nA footer for the website.\n");
    const first = await commit(dir, "fix: describe the footer");
    const reading = await home.placed.revision(at.deviceId, "t-lines", first);
    expect(reading).toMatchObject({
      headSha: first,
      changeLines: { base: project.main, added: 1, deleted: 0 },
    });
    seedDelivery(home.tasks, "t-lines", { headSha: first, ci: "green", ciAt: Date.now() });
    await home.placed.answer(at.deviceId, "inf:work:card", {
      task: "t-lines",
      callId: "line-card",
      card: {
        id: "done",
        title: "The website footer is ready",
        body: "<h2>Why</h2><p>Describe the website footer.</p><h2>What changed</h2><p>I described the footer.</p><h2>Before</h2><p>The description named only the website.</p><h2>After</h2><p>The description includes the footer.</p>",
        requiredActions: [],
        actions: [{ id: "merge", default: true, effect: { kind: "merge", after: "close" } }],
      },
    });
    await expect
      .poll(() => home.cards().find((card) => card.taskId === "t-lines")?.body)
      .toContain("+1 added · −0 deleted");
    expect(home.tasks.get("t-lines")?.delivery?.changeLines).toMatchObject({
      head: first,
      base: project.main,
      added: 1,
      deleted: 0,
    });
    console.info("Remote revision response:", JSON.stringify(reading));
    console.info(
      "Persisted completion measurement:",
      JSON.stringify(home.tasks.get("t-lines")?.delivery?.changeLines),
    );
    console.info("Completion strip:", home.cards().find((card) => card.taskId === "t-lines")?.body);
  });

  // Intent: guardrail before the placedSessions.ts split (INF-2625's plan): a
  // file a computer hands this Mac comes in pieces and is kept only when it
  // arrives whole and unchanged; otherwise nothing of it is left here.
  it("keeps a handed file only when its pieces arrive whole and unchanged", async () => {
    const at = await world();
    model([{ text: "Handing it over." }]);
    await at.start("t-hand");
    const home = at.home();
    const bytes = Buffer.from("Invoice 2214: three hours of footer work.\n");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const file = handoverFileName("invoice.txt", sha256);
    const dir = crewmateHandoverDir(home.paths, "t-hand");
    const hand = (callId: string, offset: number, piece: Buffer, sha = sha256) =>
      home.placed.answer(at.deviceId, "inf:work:handover-file", {
        task: "t-hand",
        callId,
        file,
        size: bytes.length,
        sha256: sha,
        offset,
        data: piece.toString("base64"),
      });
    const half = 20;

    // A piece past the file's end is refused.
    await expect(hand("past-end", half, bytes)).rejects.toThrow(
      "That piece runs past the handed file's end.",
    );
    // Changed on the way: refused, and neither the file nor its partial copy stays.
    const changed = Buffer.from(bytes);
    changed[0] = "i".charCodeAt(0);
    await expect(hand("changed-1", 0, changed.subarray(0, half))).resolves.toEqual({ ok: true });
    await expect(hand("changed-2", half, changed.subarray(half))).rejects.toThrow(
      "The handed file did not arrive unchanged.",
    );
    expect(readdirSync(dir)).toEqual([]);

    // Whole and unchanged: kept under its name, with nothing partial beside it.
    await expect(hand("whole-1", 0, bytes.subarray(0, half))).resolves.toEqual({ ok: true });
    expect(readdirSync(dir)).toEqual([`${file}.partial`]);
    await expect(hand("whole-2", half, bytes.subarray(half))).resolves.toEqual({ ok: true });
    expect(readdirSync(dir)).toEqual([file]);
    expect(readFileSync(join(dir, file))).toEqual(bytes);
  });

  // Intent: guardrail before the placedSessions.ts split (INF-2625's plan): a
  // quit can cut the last line of the kept answers and of the begun marks;
  // after the restart every whole line still holds, and the cut call, never
  // begun, is done once when asked again.
  it("reads past a last line a quit cut short in the kept answers and the begun marks", async () => {
    const at = await world();
    const slow = gate();
    model([{ held: slow.held, text: "Finished after the cut." }]);
    await at.start("t-torn");
    await expect.poll(() => api.openRequests()).toBe(1);
    const dir = crewmatePlacedDir(at.home().paths, "t-torn");
    const kept = { task: "t-torn", callId: "progress-kept", text: "Kept before the quit." };
    const cut = { task: "t-torn", callId: "progress-cut", text: "Cut by the quit." };
    const answered = await at.home().placed.answer(at.deviceId, "inf:work:progress", kept);
    const progress = () =>
      at
        .home()
        .tasks.timeline("t-torn")
        .filter((event) => event.kind === "progress");
    expect(progress()).toHaveLength(1);
    await at.restartHome(() => {
      writeFileSync(
        join(dir, "calls.jsonl"),
        `${readFileSync(join(dir, "calls.jsonl"), "utf8")}{"callId":"progress-cut","chann`,
      );
      writeFileSync(
        join(dir, "begun.jsonl"),
        `${readFileSync(join(dir, "begun.jsonl"), "utf8")}"progress-c`,
      );
    });
    await at.inReach("t-torn");
    const home = at.home();
    // The whole line holds: its answer again, its effect once.
    await expect(home.placed.answer(at.deviceId, "inf:work:progress", kept)).resolves.toEqual(
      answered,
    );
    expect(progress()).toHaveLength(1);
    // The cut one was never begun: done now, once, however often it is asked.
    for (let repeat = 0; repeat < 2; repeat++)
      await expect(home.placed.answer(at.deviceId, "inf:work:progress", cut)).resolves.toEqual(
        answered,
      );
    expect(progress()).toHaveLength(2);
    slow.open();
  });

  it("refuses what a computer asks about a task this Mac does not run there", async () => {
    const at = await world();
    const home = at.home();
    seedTask(home.tasks, { id: "t-here", title: "Runs here", status: "running" });
    seedTask(home.tasks, {
      id: "t-elsewhere",
      title: "Runs on another computer",
      status: "running",
      deviceId: "another-mac",
    });
    for (const task of ["t-here", "t-elsewhere", "t-missing"])
      await expect(
        home.placed.answer(at.deviceId, "inf:work:report", {
          task,
          callId: "call-1",
          text: "Not yours.",
        }),
      ).rejects.toThrow(NO_PLACED_TASK);
  });

  // Intent: guardrail before the placedSessions.ts split (INF-2625's plan): a
  // computer's task browser reaches this Mac's browser owner through
  // `answer`, said once and never kept, while its events are kept as calls,
  // and a closed task takes only a saved sign-in copied back as its browser
  // stops (docs/task-browser.md, "On another computer").
  it("hands a computer's task browser to this Mac's browser owner, and a closed task only its sign-in", async () => {
    const heard: unknown[][] = [];
    const held = { cookies: [], storage: [] };
    const saved = {
      ...held,
      site: "club.example",
      id: "club",
      savedAt: 1,
      automatic: true as const,
    };
    const at = await world(undefined, {
      browsers: () => ({
        automaticSignIn: (task, site) => {
          heard.push(["sign-in", task, site]);
          return site === "club.example" ? saved : undefined;
        },
        heardFact: (deviceId, task, fact) => heard.push(["fact", deviceId, task, fact]),
        heardFrame: (task, frame) => heard.push(["frame", task, frame]),
        heardEvent: (deviceId, task, event) => heard.push(["event", deviceId, task, event]),
        privateSiteList: () => ["wiki.corp.example"],
      }),
    });
    model([{ text: "Looking." }]);
    await at.start("t-browse");
    const home = at.home();
    const fact = {
      state: "open" as const,
      site: "club.example",
      url: "https://club.example/",
      title: "Club",
      control: "captain" as const,
      session: "work-browser",
      generation: 1,
    };
    const frame = { data: "aGVsbG8=", width: 2, height: 1 };
    await expect(
      home.placed.answer(at.deviceId, "inf:work:browser", { task: "t-browse", fact }),
    ).resolves.toEqual({ ok: true });
    await expect(
      home.placed.answer(at.deviceId, "inf:work:browser-frame", { task: "t-browse", frame }),
    ).resolves.toEqual({ ok: true });
    await expect(
      home.placed.answer(at.deviceId, "inf:work:browser-sign-in", {
        task: "t-browse",
        site: "club.example",
      }),
    ).resolves.toEqual({ signIn: saved });
    // The captain's private sites list is lent whole, read live (INF-3116, answer A).
    await expect(
      home.placed.answer(at.deviceId, "inf:work:private-sites", { task: "t-browse" }),
    ).resolves.toEqual({ sites: ["wiki.corp.example"] });
    const note = { kind: "note" as const, text: "Signed in to the club." };
    for (let repeat = 0; repeat < 2; repeat++)
      await expect(
        home.placed.answer(at.deviceId, "inf:work:browser-event", {
          task: "t-browse",
          callId: "note-1",
          event: note,
        }),
      ).resolves.toEqual({ ok: true });
    expect(heard).toEqual([
      ["fact", at.deviceId, "t-browse", fact],
      ["frame", "t-browse", frame],
      ["sign-in", "t-browse", "club.example"],
      // Asked twice, heard once: the second is the kept answer.
      ["event", at.deviceId, "t-browse", note],
    ]);
    const dir = crewmatePlacedDir(home.paths, "t-browse");
    const kept = readFileSync(join(dir, "calls.jsonl"), "utf8").trim().split("\n");
    expect(kept.map((line) => JSON.parse(line).channel)).toEqual(["inf:work:browser-event"]);

    seedTask(home.tasks, {
      id: "t-closed",
      title: "Closed",
      status: "cancelled",
      deviceId: at.deviceId,
    });
    heard.length = 0;
    await expect(
      home.placed.answer(at.deviceId, "inf:work:browser", { task: "t-closed", fact }),
    ).rejects.toThrow("That task is closed on");
    await expect(
      home.placed.answer(at.deviceId, "inf:work:browser-event", {
        task: "t-closed",
        callId: "note-2",
        event: note,
      }),
    ).rejects.toThrow("That task is closed on");
    const signIn = { kind: "sign-in" as const, site: "club.example", id: "club", held };
    await expect(
      home.placed.answer(at.deviceId, "inf:work:browser-event", {
        task: "t-closed",
        callId: "sign-in-1",
        event: signIn,
      }),
    ).resolves.toEqual({ ok: true });
    expect(heard).toEqual([["event", at.deviceId, "t-closed", signIn]]);
  });
});
