import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type PlacedSpec,
  placedTaskFolders,
  type WorkOrderChannel,
  workRequests,
} from "@shared/work";
import { describe, expect, it, vi } from "vitest";
import { expectBytesEqual } from "../../../tests/helpers/expectBytes";
import { scriptedClaudeWorld } from "../../../tests/helpers/scriptedClaudeContract";
import {
  api,
  MODEL,
  model,
  PROVIDER,
  placed,
  sessionHostHooks,
  TASK,
} from "../../../tests/helpers/sessionHostWorld";
import { answersDir, savedAnswerText } from "../session/answerFiles";
import { PlacedTasks } from "./placedTasks";
import { PLACED_REQUEST_WAIT_MS } from "./toolWait";

/**
 * A crewmate's conversation held on a computer that runs work
 * (`tests/helpers/sessionHostWorld.ts`): forwarding to the home, prompt runs, drops and callbacks, check and story declarations, and the orders it refuses.
 */

sessionHostHooks();

describe("a conversation held on a computer that runs work", () => {
  it("INF-2214 preserves response correlation through the home", async () => {
    const at = await placed();
    await at.open();
    model([
      {
        tools: [
          {
            name: "report",
            args: {
              text: "The remover is at the verified target path.",
              responses: [
                { request_id: "path-request", response_id: "path-answer", status: "answered" },
              ],
            },
          },
        ],
      },
      { text: "Response submitted." },
    ]);
    await at.order("inf:session:prompt", [
      { orderId: "path:1", task: TASK, text: "Answer path-request." },
    ]);
    await at.ended(1);
    const reports = at.home.effects.filter((effect) => effect.channel === "inf:work:report");
    expect(reports[0]?.request).toMatchObject({
      declared: {
        responses: [{ requestId: "path-request", responseId: "path-answer", status: "answered" }],
      },
    });
  });
  // INF-2225, INF-2214's approved shared cards: the home on this major keeps
  // the revision read, so the correction goes to it whole.
  it("sends a shared-card correction to its home (INF-2225)", async () => {
    const at = await placed();
    at.spec.tools.push("revise_required_action");
    await at.open();
    model([
      {
        tools: [
          {
            name: "revise_required_action",
            args: {
              action: "card-fm-required-action-op1",
              source: "DOP-208",
              action_id: "remove-job-host",
              expected_generation: 1,
              patch: { instructions: ["Run C:\\FleetCheckSetup\\shell-pc-job-host-remove.cmd"] },
              reason: "The remover path was wrong",
              operation_id: "op-remover-path",
              same_action: true,
            },
          },
        ],
      },
      { text: "Corrected." },
    ]);
    await at.order("inf:session:prompt", [
      { orderId: "fix:1", task: TASK, text: "Correct the remover path." },
    ]);
    await at.ended(1);
    const sent = at.home.effects.filter(
      (effect) => effect.channel === "inf:work:revise-required-action",
    );
    expect(sent[0]?.request).toMatchObject({
      input: {
        action: "card-fm-required-action-op1",
        expectedGeneration: 1,
        operationId: "op-remover-path",
        sameAction: true,
      },
    });
  });
  // INF-2589, the captain: "any too big answer gets stored in a file and we
  // return the path to the file instead of the full answer". The file is
  // saved where the crewmate's shell runs, so it can open it.
  it("saves an answer too long to read whole in the task's temporary folder there, and the model reads its path", async () => {
    // A real answer past the band: the captured INF-91 record as one read serves it whole.
    const answer = JSON.stringify(
      JSON.parse(readFileSync("tests/fixtures/accepted-plan/inf91.json", "utf8")),
      null,
      2,
    );
    const at = await placed();
    at.spec.tools.push("github_read");
    at.home.answer("inf:work:github-read", { text: answer });
    await at.open();
    model([
      {
        tools: [
          { name: "github_read", args: { path: "/repos/acme/shop/actions/runs?per_page=100" } },
        ],
      },
      { text: "Read the runs." },
    ]);
    await at.order("inf:session:prompt", [
      { orderId: "runs:1", task: TASK, text: "List the latest runs." },
    ]);
    await at.ended(1);
    const answers = answersDir(placedTaskFolders(join(at.dataDir, "tasks"), TASK).temp);
    const [saved] = readdirSync(answers);
    const path = join(answers, saved ?? "");
    expect(readFileSync(path, "utf8")).toBe(answer);
    const result = api.requests
      .at(-1)
      ?.body.messages?.flatMap((message) => (Array.isArray(message.content) ? message.content : []))
      .findLast((block: { type?: string }) => block.type === "tool_result") as
      | { content?: string | { text?: string }[] }
      | undefined;
    const served =
      typeof result?.content === "string"
        ? result.content
        : result?.content?.map((block) => block.text ?? "").join("\n");
    expect(served).toBe(savedAnswerText(path, answer));
    expect(
      at.home.events.find(
        (record) => record.event.type === "tool_end" && record.event.toolName === "github_read",
      )?.event,
    ).toMatchObject({ isError: false });
  });

  // INF-2599 (the captain: "Send a crewmate its directions once, and again
  // only when they change"): the home sends directions again after a fold,
  // so it must hear one.
  it("tells its home when its Claude conversation folds (INF-2599)", async () => {
    const claude = await scriptedClaudeWorld();
    const at = await placed({ claude });
    const spec: PlacedSpec = { ...at.spec, binding: { backend: "claude" }, model: claude.model };
    claude.answer({ text: "Counted every press." });
    await at.order("inf:session:open", [{ orderId: "open:fold", task: TASK, spec }]);
    await at.order("inf:session:prompt", [
      { orderId: "rows:fold", task: TASK, text: "Count every press." },
    ]);
    await at.ended(1);
    claude.fold();
    // The home hears what the conversation did in order: a model it named
    // after the fold is heard after the fold too, with or without it.
    claude.answer({ text: "Counted the long presses." });
    await at.order("inf:session:prompt", [
      { orderId: "rows:after-fold", task: TASK, text: "Count the long presses." },
    ]);
    await at.ended(2);
    const folds = at.home.events.filter(({ event }) => event.type === "context_compacted");
    expect(folds.map(({ event }) => event)).toEqual([{ type: "context_compacted" }]);
  });
  it("forwards first-release facts and a task list page to the home that records them (INF-1607)", async () => {
    const at = await placed();
    await at.open();
    const release = {
      version: "0.6.0",
      url: "https://github.com/infinitary-labs/infinitary/releases/tag/v0.6.0",
      evidence: "Published source contains the task's merge; earlier published sources do not.",
      tasks: ["INF-1607"],
    };
    model([
      { tools: [{ name: "tasks", args: { status: "done", skip: 100 } }] },
      {
        tools: [
          {
            name: "report",
            args: {
              text: "Verified the first published release of the merged fix.",
              first_release: release,
            },
          },
        ],
      },
      { text: "Reported the release verification." },
    ]);
    await at.order("inf:session:prompt", [
      { orderId: "release:1", task: TASK, text: "Record the verified release." },
    ]);
    await at.ended(1);
    const queries = at.home.effects.filter((effect) => effect.channel === "inf:work:tasks");
    expect(queries[0]?.request).toMatchObject({ input: { status: "done", skip: 100 } });
    const reports = at.home.effects.filter((effect) => effect.channel === "inf:work:report");
    expect(reports[0]?.request).toMatchObject({ declared: { firstRelease: release } });
    expect(
      at.home.events.find(
        (record) => record.event.type === "tool_end" && record.event.toolName === "report",
      )?.event,
    ).toMatchObject({ isError: false });
  });

  it("asks the home for a task list's cut (INF-1746 R9)", async () => {
    const at = await placed();
    await at.open();
    model([
      { tools: [{ name: "tasks", args: { status: "open", limit: 1 } }] },
      { text: "Listed." },
    ]);
    await at.order("inf:session:prompt", [
      { orderId: "list:1", task: TASK, text: "List the open work." },
    ]);
    await at.ended(1);
    const [query] = at.home.effects.filter((effect) => effect.channel === "inf:work:tasks");
    const input = (query?.request as { input?: Record<string, unknown> } | undefined)?.input;
    expect(input).toMatchObject({ status: "open", limit: 1 });
    expect(input?.snapshot).toBe(true);
    expect(
      at.home.events.find(
        (record) => record.event.type === "tool_end" && record.event.toolName === "tasks",
      )?.event,
    ).toMatchObject({ isError: false });
  });

  it("runs the home's prompt there, does each callback once at the home, and tells the home every event once, in order", async () => {
    const at = await placed();
    const opened = await at.open();
    expect(opened.state).toMatchObject({
      backend: "pi",
      streaming: false,
      model: { provider: PROVIDER, id: MODEL },
      controlProfile: { backgroundWork: "host" },
    });
    model([
      { tools: [{ name: "note_progress", args: { text: "Started." } }] },
      { tools: [{ name: "report", args: { text: "All done.", summary: "It is done." } }] },
      { text: "Reported." },
    ]);
    expect(
      await at.order("inf:session:prompt", [{ orderId: "rows:1", task: TASK, text: "Do it." }]),
    ).toEqual({ turn: 1 });
    await at.ended(1);

    // The model's request carried the home's instructions and the forwarded tools.
    const served = api.requests.at(-1)?.body;
    expect(JSON.stringify(served?.system)).toContain("You are a crewmate on another Mac.");
    expect(served?.tools?.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["emit_card", "report", "note_progress", "file_followup", "tasks"]),
    );

    // Each callback once, as the computer itself, after every event before it.
    expect(at.home.effects.map((effect) => effect.channel)).toEqual([
      "inf:work:progress",
      "inf:work:report",
    ]);
    expect(at.home.effects[1]?.request).toMatchObject({
      task: TASK,
      text: "All done.",
      summary: "It is done.",
    });
    expect(at.home.actors.length).toBeGreaterThan(0);
    for (const actor of at.home.actors)
      expect(actor).toEqual({ kind: "device", deviceId: at.deviceId });
    const reportStart = at.home.events.find(
      (record) => record.event.type === "tool_start" && record.event.toolName === "report",
    );
    expect(at.home.effects[1]?.after).toBeGreaterThanOrEqual(reportStart?.seq ?? Number.NaN);

    // Every event once, numbered from 1 with no gap, the turn's start first and its end last.
    expect(at.home.events.map((record) => record.seq)).toEqual(
      at.home.events.map((_, index) => index + 1),
    );
    const types = at.home.types();
    expect(types[0]).toBe("turn_started");
    expect(types.at(-1)).toBe("turn_ended");
    expect(types).toEqual(expect.arrayContaining(["tool_start", "tool_end", "turn_end"]));
    expect(at.home.events.at(-1)?.event).toMatchObject({
      type: "turn_ended",
      turn: 1,
      outcome: "done",
      undelivered: [],
      state: { streaming: false, resume: expect.stringMatching(/\.jsonl$/) },
    });
    // What the home keeps, the computer forgets: its outbox holds nothing kept.
    const outbox = join(placedTaskFolders(join(at.dataDir, "tasks"), TASK).root, "outbox.jsonl");
    await expect.poll(() => readFileSync(outbox, "utf8")).toBe("");
  });

  it("answers an order it already applied as it did, without doing it again", async () => {
    const at = await placed();
    const opened = await at.open();
    model([{ text: "Once." }]);
    const prompt = [{ orderId: "rows:7", task: TASK, text: "Say it once." }];
    expect(await at.order("inf:session:prompt", prompt)).toEqual({ turn: 1 });
    await at.ended(1);
    const requests = api.requests.length;

    expect(await at.order("inf:session:prompt", prompt)).toEqual({ turn: 1 });
    expect((await at.open()).state.sessionId).toBe(opened.state.sessionId);
    expect(api.requests.length).toBe(requests);
    expect(at.home.types().filter((type) => type === "turn_started")).toHaveLength(1);

    // A steer after the turn ended reached nothing, so the home puts its words back.
    expect(
      await at.order("inf:session:steer", [{ orderId: "rows:8", task: TASK, text: "Late." }]),
    ).toEqual({ delivered: false });
  });

  it("rebinds an idle conversation when a later open names a tool it lacked (INF-398)", async () => {
    const at = await placed();
    const opened = await at.open();
    model([{ text: "Started." }, { text: "Has the tool." }]);
    await at.order("inf:session:prompt", [{ orderId: "rows:1", task: TASK, text: "Start." }]);
    await at.ended(1);
    expect(api.requests.at(-1)?.body.tools?.map((tool) => tool.name)).not.toContain(
      "prepare_change",
    );
    const held = await at.open();
    expect(held.state.sessionId).toBe(opened.state.sessionId);
    expect(held.state.resume).toBeTruthy();

    const again = await at.order("inf:session:open", [
      {
        orderId: `open:${TASK}:2`,
        task: TASK,
        spec: {
          ...at.spec,
          tools: [...at.spec.tools, "prepare_change"],
          resume: held.state.resume,
        },
      },
    ]);
    expect(again.state.resume).toBe(held.state.resume);
    await at.order("inf:session:prompt", [{ orderId: "rows:2", task: TASK, text: "Continue." }]);
    await at.ended(2);
    expect(api.requests.at(-1)?.body.tools?.map((tool) => tool.name)).toContain("prepare_change");
  });

  // Intent: INF-311's accepted whole-call deadline includes waiting for prior events.
  it.each(["inf:work:report", "inf:work:events"])(
    "ends the whole tool call after 24 days while waiting on %s (INF-312)",
    async (channel) => {
      const at = await placed();
      await at.open();
      const held = at.home.hold(channel);
      model([
        { tools: [{ name: "report", args: { text: "Across the deadline." } }] },
        { text: "Checked the timeout." },
      ]);
      const first = api.requests.length;
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
      await at.order("inf:session:prompt", [{ orderId: "deadline", task: TASK, text: "Report." }]);
      await held.reached;
      // Wait for the model's tool-start event before moving only the deadline clock.
      await expect
        .poll(() => {
          const outbox = new PlacedTasks(at.dataDir).outbox(TASK, 0);
          return outbox.some((record) => record.event.type === "tool_start");
        })
        .toBe(true);
      try {
        await vi.advanceTimersByTimeAsync(PLACED_REQUEST_WAIT_MS);
      } finally {
        vi.useRealTimers();
      }
      held.open();
      await at.ended(1);
      const transcript = JSON.stringify(
        api.requests.slice(first).map((request) => request.body.messages),
      );
      expect(transcript).toContain(
        channel === "inf:work:report" ? "may already be done" : "was not sent",
      );
      if (channel === "inf:work:events")
        expect(
          at.home.effects.filter((effect) => effect.channel === "inf:work:report"),
        ).toHaveLength(0);
      console.info("Whole-call deadline:", channel, transcript.slice(-1200));
    },
  );

  it("keeps the turn running through a drop: a waiting callback is asked again under its id, done once, and the home catches up exactly", async () => {
    const at = await placed();
    await at.open();
    const report = at.home.hold("inf:work:report");
    model([
      { tools: [{ name: "report", args: { text: "Across the drop." } }] },
      { text: "Carried on." },
    ]);
    await at.order("inf:session:prompt", [{ orderId: "rows:2", task: TASK, text: "Report." }]);
    await report.reached;

    await at.dropAndReturn();
    // The same call, asked again on the new connection, while the first still waits.
    await expect
      .poll(() => at.home.asked.filter((ask) => ask.channel === "inf:work:report").length)
      .toBe(2);
    const [first, second] = at.home.asked.filter((ask) => ask.channel === "inf:work:report");
    expect(second?.callId).toBe(first?.callId);
    report.open();
    await at.ended(1);

    expect(at.home.effects.filter((effect) => effect.channel === "inf:work:report")).toHaveLength(
      1,
    );
    expect(at.home.events.map((record) => record.seq)).toEqual(
      at.home.events.map((_, index) => index + 1),
    );
    expect(at.home.types().filter((type) => type === "turn_ended")).toHaveLength(1);
    expect(at.home.events.at(-1)?.event).toMatchObject({ type: "turn_ended", outcome: "done" });
  });

  it("holds several callbacks waiting at once, and answers each once after a drop", async () => {
    const at = await placed();
    await at.open();
    const progress = at.home.hold("inf:work:progress");
    const followup = at.home.hold("inf:work:followup");
    model([
      {
        tools: [
          { name: "note_progress", args: { text: "Two at once." } },
          {
            name: "file_followup",
            args: { title: "A gap", goal: "Close it.", why: "Found it." },
          },
        ],
      },
      { text: "Both answered." },
    ]);
    await at.order("inf:session:prompt", [{ orderId: "rows:3", task: TASK, text: "Both." }]);
    await Promise.all([progress.reached, followup.reached]);

    await at.dropAndReturn();
    await expect.poll(() => at.home.asked.length).toBe(4);
    progress.open();
    followup.open();
    await at.ended(1);
    expect(at.home.effects.map((effect) => effect.channel).sort()).toEqual([
      "inf:work:followup",
      "inf:work:progress",
    ]);
  });

  // INF-125 proof custody also keeps INF-312's cancellation rule: a stopped
  // proof transfer must not go on to send its report.
  it.each([false, true])(
    "INF-125: transfers kept validation bytes before the report (cancelled: %s)",
    async (cancelled) => {
      const controller = new AbortController();
      const at = await placed(cancelled ? { toolSignal: controller.signal } : {});
      await at.open();
      model([
        {
          tools: [
            {
              name: "note_progress",
              args: { text: "The paired work connection delivered this observation." },
            },
          ],
        },
        { text: "Recorded." },
      ]);
      await at.order("inf:session:prompt", [
        { orderId: "proof:observe", task: TASK, text: "Record one observation." },
      ]);
      await at.ended(1);
      const transcript = JSON.stringify(
        at.home.effects.filter((item) => item.channel === "inf:work:progress"),
      );
      expect(JSON.parse(transcript)).toHaveLength(1);
      const folders = placedTaskFolders(join(at.dataDir, "tasks"), TASK);
      const path = join(folders.evidence, "paired-observation.json");
      writeFileSync(path, transcript);
      const start = at.home.effects.length;
      const head = "a".repeat(40);
      model([
        {
          tools: [
            {
              name: "report",
              args: {
                text: "The actual paired work connection delivered the observation.",
                validation: {
                  kind: "run",
                  id: "paired-run",
                  head,
                  scenarioRevision: 1,
                  completion: "complete",
                  verdict: "go",
                  reason: "The local paired helper and home exchanged the actual report call.",
                  observations: [
                    {
                      scenario: "paired-report",
                      result: "pass",
                      live: true,
                      actual: "The home recorded the helper's progress call.",
                      evidence: ["received"],
                      standIns: ["Two local processes, not two physical computers; scripted model"],
                      unproven: [],
                      attempted: [],
                    },
                  ],
                  evidence: [
                    {
                      id: "received",
                      path,
                      description: "The actual progress call received by the home.",
                    },
                  ],
                },
              },
            },
          ],
        },
        { text: "Reported." },
      ]);
      const media = cancelled ? at.home.hold("inf:work:media") : undefined;
      try {
        await at.order("inf:session:prompt", [
          { orderId: "proof:report", task: TASK, text: "Keep that observed call with its report." },
        ]);
        if (media) {
          await media.reached;
          controller.abort(new Error("The provider stopped waiting for the proof transfer"));
          await at.ended(2);
          expect(at.home.asked.filter((request) => request.channel === "inf:work:report")).toEqual(
            [],
          );
          expect(
            at.home.effects.slice(start).filter((effect) => effect.channel === "inf:work:report"),
          ).toEqual([]);
          console.info(
            "INF-125 cancelled proof: the held transfer ended without sending a report.",
          );
          return;
        }
        await at.ended(2);
      } finally {
        media?.open();
      }
      const effects = at.home.effects.slice(start);
      expect(effects.map((item) => item.channel)).toEqual(["inf:work:media", "inf:work:report"]);
      const proof = workRequests["inf:work:report"].request.parse([effects[1]?.request])[0].declared
        ?.validation;
      if (!proof || proof.kind !== "run")
        throw new Error("The paired report lost its validation run.");
      expect(proof).toMatchObject({
        head,
        scenarioRevision: 1,
        completion: "complete",
        observations: [{ scenario: "paired-report", evidence: ["received"] }],
      });
      const received = proof.evidence[0]!;
      expect(received.text).toBe(transcript);
      expectBytesEqual(
        at.home.recordings.get(String(effects[0]?.request.id)) as Buffer,
        Buffer.from(transcript),
      );
      expect(effects[0]?.request).toMatchObject({
        extension: "json",
        size: Buffer.byteLength(transcript),
        offset: 0,
      });
    },
  );

  // INF-1555 F12: the home on this major records the crew's check judgments.
  it("forwards current check declarations to the home", async () => {
    const at = await placed();
    await at.order("inf:session:open", [
      {
        orderId: `open:${TASK}:1`,
        task: TASK,
        spec: { ...at.spec, tools: [...at.spec.tools, "check_change"] },
      },
    ]);
    const input = {
      declaration: {
        headSha: "93355db9d04e964513879db74d068a7789cb4c16",
        verdict: "flake",
        check: "linux-checks",
        evidence: "The failed log differs from the successful same-version rerun.",
      },
    };
    model([{ tools: [{ name: "check_change", args: input }] }, { text: "Recorded the result." }]);
    await at.order("inf:session:prompt", [
      { orderId: "check-judgment", task: TASK, text: "Record the check judgment." },
    ]);
    await at.ended(1);
    const effects = at.home.effects.filter((effect) => effect.channel === "inf:work:check-change");
    expect(effects.map((effect) => effect.request.input)).toEqual([input]);
  });

  // INF-1932: the home lists an artifact's files and saves selected ones.
  it("asks the home to list or select an artifact's files", async () => {
    const at = await placed();
    await at.order("inf:session:open", [
      {
        orderId: `open:${TASK}:1`,
        task: TASK,
        spec: { ...at.spec, tools: [...at.spec.tools, "download_artifact"] },
      },
    ]);
    const whole = { runId: 41007625484, artifactId: 12960596943 };
    const selected = { ...whole, files: ["ipad/join/48-xcodebuild.log"] };
    model([
      {
        tools: [
          { name: "download_artifact", args: whole },
          { name: "download_artifact", args: selected },
        ],
      },
      { text: "Read the log." },
    ]);
    await at.order("inf:session:prompt", [
      { orderId: "artifact-parts", task: TASK, text: "Read the iPad join log." },
    ]);
    await at.ended(1);
    const asked = at.home.effects
      .filter((effect) => effect.channel === "inf:work:download-artifact")
      .map((effect) => effect.request.input);
    expect(asked).toEqual([whole, selected]);
  });

  // INF-2330: the home saves one exact workflow file into task evidence.
  it("sends an exact workflow file to the home", async () => {
    const at = await placed();
    await at.order("inf:session:open", [
      {
        orderId: `open:${TASK}:1`,
        task: TASK,
        spec: { ...at.spec, tools: [...at.spec.tools, "download_artifact"] },
      },
    ]);
    const input = {
      runId: 41464279524,
      artifactId: 13168688886,
      file: "ipad/rest/77D9D1B4-0109-473B-849C-B88EBF3250C7.mp4",
    };
    model([
      { tools: [{ name: "download_artifact", args: input }] },
      { text: "Read the recording." },
    ]);
    await at.order("inf:session:prompt", [
      { orderId: "evidence-file", task: TASK, text: "Read the recording." },
    ]);
    await at.ended(1);
    const asked = at.home.effects
      .filter((effect) => effect.channel === "inf:work:download-artifact")
      .map((effect) => effect.request.input);
    expect(asked).toEqual([input]);
  });

  // INF-497: a home before `STORY_AROUND_SINCE` strips around from open_change and
  // would answer as if the words had been changed; the computer refuses first.
  it("refuses to change the words around a story through a home too old to keep the story, sending nothing", async () => {
    const at = await placed({ homeVersion: "10.0.0" });
    await at.order("inf:session:open", [
      {
        orderId: `open:${TASK}:1`,
        task: TASK,
        spec: { ...at.spec, tools: [...at.spec.tools, "open_change"] },
      },
    ]);
    const title = "feat(validation): require reviewed live proof for careful changes";
    model([
      {
        tools: [
          {
            name: "open_change",
            args: {
              title,
              presentation: 2,
              around: {
                from: "This first publication advances the published protocol to 9.0.0.",
                to: "The published protocol advances to 10.0.0.",
              },
            },
          },
        ],
      },
      { tools: [{ name: "open_change", args: { title, presentation: 2 } }] },
      { text: "Reported." },
    ]);
    await at.order("inf:session:prompt", [
      { orderId: "rows:around", task: TASK, text: "Correct the summary above the story." },
    ]);
    await at.ended(1);

    // Only the call without around reached the home.
    expect(at.home.effects.map((effect) => effect.channel)).toEqual(["inf:work:open-change"]);
    expect(at.home.effects[0]?.request).toMatchObject({ input: { title, presentation: 2 } });
    expect(at.home.effects[0]?.request).not.toHaveProperty("input.around");
    const ends = at.home.events.filter(
      (record) => record.event.type === "tool_end" && record.event.toolName === "open_change",
    );
    expect(ends.map((record) => record.event)).toMatchObject([{ isError: true }, {}]);
    expect(JSON.stringify(api.requests.at(-1)?.body?.messages)).toContain(
      "runs an older Infinitary that cannot change the words around a story; nothing was sent",
    );
  });

  // INF-2184 (INF-2490): the home opens the branch the captain asked for,
  // never the task's own.
  it("opens a change from a named branch through its home (INF-2184)", async () => {
    const at = await placed();
    await at.order("inf:session:open", [
      {
        orderId: `open:${TASK}:1`,
        task: TASK,
        spec: { ...at.spec, tools: [...at.spec.tools, "open_change"] },
      },
    ]);
    const input = {
      title: "chore(main): release 0.1.8",
      body: "The release the captain asked to open.",
      branch: "release-please--branches--main",
    };
    model([{ tools: [{ name: "open_change", args: input }] }, { text: "Reported." }]);
    await at.order("inf:session:prompt", [
      { orderId: "open-branch", task: TASK, text: "Open the release pull request." },
    ]);
    await at.ended(1);
    const asked = at.home.effects
      .filter((effect) => effect.channel === "inf:work:open-change")
      .map((effect) => effect.request.input);
    expect(asked).toEqual([input]);
  });

  it("keeps a crewmate's builds and tests below the UI as another user on the home's own Mac", async () => {
    // Captain on INF-255. This world joins by a link for another user here (`work`).
    const at = await placed();
    await at.open();
    expect(at.belowUi()).toBe(true);
  });

  it("refuses an order it does not know, a malformed one, and one for a task it never opened", async () => {
    const at = await placed();
    await expect(at.order("inf:session:launch" as WorkOrderChannel, [])).rejects.toThrow(
      "not a request this computer answers",
    );
    await expect(at.order("inf:session:prompt", [{ task: TASK }])).rejects.toThrow("malformed");
    await expect(
      at.order("inf:session:prompt", [{ orderId: "rows:9", task: TASK, text: "Hi." }]),
    ).rejects.toThrow("No conversation is open");
    // Nothing open to stop: nothing done, and nothing kept for a task it never held.
    expect(await at.order("inf:session:abort", [{ orderId: "stop:1", task: TASK }])).toEqual({
      ok: true,
    });
    expect((await at.order("inf:session:roster", [])).tasks).toEqual([]);
    // A computer that keeps no working copies holds a task's work in its
    // folder, so it never removes one.
    await expect(
      at.order("inf:session:remove", [{ orderId: "remove:1", task: TASK }]),
    ).rejects.toThrow("keeps a task's work in its folder");
    await expect(
      at.order("inf:session:open", [{ orderId: "open:x", task: "../escape", spec: at.spec }]),
    ).rejects.toThrow("malformed");
    expect(existsSync(join(at.dataDir, "escape"))).toBe(false);
  });
});
