import type { PushPayload } from "@shared/ipc";
import { DECISION_RECORD_SCHEMA, type DecisionRecord } from "@shared/provenance";
import { DATA_TERMS, DEFAULT_SHARING } from "@shared/sharing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openInMemoryDatabase } from "../storage/db";
import { SettingsStore } from "../storage/settingsStore";
import { TaskService } from "../tasks/taskService";
import type { TelemetryClient } from "../telemetry";
import { seedProject } from "../workspace/seedProject";
import {
  CONTRIBUTION_PREVIEW_LIMIT,
  crewMilestoneFor,
  DIAGNOSTICS_PENDING_CAP,
  DIAGNOSTICS_RETRY_MS,
  DIAGNOSTICS_SENT_KEEP,
  SharingService,
  type SharingServiceOptions,
} from "./sharingService";

/**
 * The two switches (roadmap 1.4, docs/sharing.md): Diagnostics is the
 * allowlisted events with the anonymous install ID, on by default, sent
 * only once the person has been shown it and never while the switch is
 * off; the ID is dropped with the switch and new when it comes back; what
 * the viewer shows is what the wire carries; the contribution switch
 * cannot be turned on while the terms are unpublished; the ask fires once
 * ever.
 */

/** The n-th install ID the service mints in a test: a well-formed random UUID shape. */
function installId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function payloadOf(body: unknown): Record<string, unknown> {
  return (body as { payload: Record<string, unknown> }).payload;
}

/** A wire that only remembers: every body it was handed, in order. */
class RecordingClient implements TelemetryClient {
  readonly sent: Record<string, unknown>[] = [];
  /** What the endpoint answers; false stands for offline or a refusal. */
  accept = true;
  closed: number | undefined;

  async send(body: Record<string, unknown>): Promise<boolean> {
    this.sent.push(body);
    return this.accept;
  }

  async close(timeoutMs?: number): Promise<void> {
    this.closed = timeoutMs;
  }
}

/** Let a run of sends (each a resolved promise, then the next) land. */
async function drain(ticks = 40): Promise<void> {
  for (let index = 0; index < ticks; index += 1) await Promise.resolve();
}

function decision(id: string, endedAt: number, taskIds: string[]): DecisionRecord {
  return {
    schema: DECISION_RECORD_SCHEMA,
    decision: id,
    startedAt: endedAt - 1,
    endedAt,
    producer: {
      actor: "firstmate",
      role: "firstmate",
      model: { provider: "openai", id: "gpt-test" },
      accountId: "account-1",
      thinkingLevel: "low",
    },
    contract: { version: "3.9", promptSha: "prompt-sha", toolsSha: "tools-sha" },
    trigger: "wake",
    served: null,
    disposition: {
      outcome: "clean",
      error: null,
      inbox: "acked",
      asks: [],
      toolCalls: [],
      cards: [],
      tasks: taskIds,
      verdict: null,
      outcomeId: null,
      handoffInboxId: null,
    },
  };
}

function setup(overrides: Partial<SharingServiceOptions> = {}) {
  const db = openInMemoryDatabase();
  seedProject(db, {
    id: "r1",
    name: "nimbus-api",
    path: "/fleet/nimbus-api",
    delivery: "direct-pr",
    addedAt: 1,
  });
  let now = 10_000;
  const tasks = new TaskService({
    db,
    repos: { get: (id) => (id === "r1" ? { delivery: "direct-pr" as const } : undefined) },
    now: () => now,
    strict: true,
  });
  const settings = new SettingsStore(db);
  const raw = new RecordingClient();
  const pushes: PushPayload<"inf:sharing">[] = [];
  let minted = 0;
  const service = new SharingService({
    settings,
    emit: (channel, payload) => {
      if (channel === "inf:sharing") pushes.push(payload as PushPayload<"inf:sharing">);
    },
    raw,
    telemetryConfig: { websiteID: "site-1", app: "firstmate-3000", version: "1.2.3" },
    destination: "a.example.com",
    decisions: {
      list: (since, limit) => tasks.decisionBacklog(since, limit),
      count: (since) => tasks.decisionBacklogCount(since),
    },
    now: () => now,
    newInstallId: () => installId(++minted),
    ...overrides,
  });
  return {
    db,
    service,
    settings,
    raw,
    pushes,
    tasks,
    tick: (ms = 1) => {
      now += ms;
    },
  };
}

/** The next launch over the same row: a new service, the same wire. */
function relaunch(settings: SettingsStore, raw: RecordingClient): SharingService {
  return new SharingService({
    settings,
    emit: () => {},
    raw,
    telemetryConfig: { websiteID: "site-1", app: "firstmate-3000", version: "1.2.3" },
    destination: "a.example.com",
    decisions: { list: () => [], count: () => 0 },
    now: () => 10_001,
    newInstallId: () => installId(99),
  });
}

describe("SharingService - diagnostics", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is on by default: the launch mints an install ID and records, and nothing leaves until the person is told", async () => {
    const { service, raw, settings } = setup();
    expect(settings.getSharing()).toEqual(DEFAULT_SHARING);
    service.start();
    await drain();
    const view = service.get();
    expect(view.diagnostics).toMatchObject({
      enabled: true,
      viewedAt: null,
      sentAt: null,
      installId: installId(1),
      milestones: ["ftue_first_launch"],
    });
    expect(view.contribution.enabled).toBe(false);
    expect(view.termsPublished).toBe(DATA_TERMS.published);
    expect(view.diagnosticsDestination).toBe("a.example.com");
    expect(raw.sent).toEqual([]);
    // The viewer shows what waits, as the bodies the wire would carry.
    const pending = service.preview().diagnostics.pending;
    expect(pending.map((record) => record.name)).toEqual(["ftue_first_launch", "app_launch"]);
    expect(pending[1]?.body).toEqual({
      type: "event",
      payload: {
        website: "site-1",
        hostname: "app",
        title: "Firstmate 3000",
        url: "app://firstmate-3000/app_launch",
        name: "app_launch",
        data: { version: "1.2.3" },
        timestamp: 10,
        id: installId(1),
      },
    });
    expect(service.preview().diagnostics.sent).toEqual([]);
  });

  it("once told, sends what waited in order - exactly what the viewer showed - and each new event as it happens", async () => {
    const { service, raw, pushes, tick } = setup();
    service.start();
    const shown = service.preview().diagnostics.pending.map((record) => record.body);
    tick();
    service.markViewed("diagnostics");
    await drain();
    expect(raw.sent).toEqual(shown);
    expect(service.get().diagnostics).toMatchObject({ viewedAt: 10_001, sentAt: 10_000 });
    expect(service.get().diagnostics.pending).toEqual([]);
    expect(pushes.at(-1)).toEqual(service.get());
    expect(service.preview().diagnostics.pending).toEqual([]);

    tick();
    service.record({ name: "main_agent_turn_end", data: { trigger: "captain" } });
    service.record({
      name: "main_agent_turn_failed",
      data: { trigger: "operation", reason: "provider" },
    });
    await drain();
    expect(raw.sent.slice(2).map(payloadOf)).toEqual([
      expect.objectContaining({
        name: "main_agent_turn_end",
        data: { trigger: "captain", version: "1.2.3" },
        id: installId(1),
      }),
      expect.objectContaining({
        name: "main_agent_turn_failed",
        data: { trigger: "operation", reason: "provider", version: "1.2.3" },
        id: installId(1),
      }),
    ]);
    expect(service.preview().diagnostics.sent.map((record) => record.name)).toEqual([
      "ftue_first_launch",
      "app_launch",
      "main_agent_turn_end",
      "main_agent_turn_failed",
    ]);
  });

  it("keeps each first-run step once per install, even across a stretch with the switch off", async () => {
    const { service, raw, settings } = setup();
    service.start();
    service.markViewed("diagnostics");
    service.record({ name: "ftue_first_turn", data: {} });
    service.record({ name: "ftue_first_turn", data: {} });
    await drain();
    expect(raw.sent.map((body) => payloadOf(body).name)).toEqual([
      "ftue_first_launch",
      "app_launch",
      "ftue_first_turn",
    ]);
    service.setSwitch("diagnostics", false);
    service.record({ name: "ftue_first_spawn_started", data: {} });
    service.setSwitch("diagnostics", true);
    service.record({ name: "ftue_first_spawn_started", data: {} });
    await drain();
    // The first spawn happened while it was off: turning it on never reports it as new.
    expect(raw.sent).toHaveLength(3);
    expect(settings.getSharing().diagnostics.milestones).toEqual([
      "ftue_first_launch",
      "ftue_first_turn",
      "ftue_first_spawn_started",
    ]);
    // A relaunch is not a first launch.
    const again = relaunch(settings, raw);
    again.start();
    await drain();
    expect(raw.sent.slice(3).map((body) => payloadOf(body).name)).toEqual(["app_launch"]);
  });

  it("the opt-out: off drops the install ID and what waited, records nothing, and on again is a new ID", async () => {
    const { service, raw, tick } = setup();
    service.start();
    service.setSwitch("diagnostics", false);
    expect(service.get().diagnostics).toMatchObject({
      enabled: false,
      installId: null,
      pending: [],
    });
    service.markViewed("diagnostics");
    service.record({ name: "main_agent_turn_end", data: { trigger: "captain" } });
    await drain();
    expect(raw.sent).toEqual([]);
    expect(service.preview().diagnostics.pending).toEqual([]);

    tick();
    service.setSwitch("diagnostics", true);
    expect(service.get().diagnostics.installId).toBe(installId(2));
    // Shown once already: on again sends without a second showing.
    service.record({ name: "main_agent_turn_end", data: { trigger: "captain" } });
    await drain();
    expect(raw.sent.map((body) => payloadOf(body).id)).toEqual([installId(2)]);
  });

  it("a send the endpoint refused stays waiting, across a relaunch, and goes on the next try", async () => {
    const { service, raw, settings, tick } = setup();
    raw.accept = false;
    service.start();
    service.markViewed("diagnostics");
    await drain();
    // One try, refused: the run stops, and both still wait on the row.
    expect(raw.sent).toHaveLength(1);
    expect(settings.getSharing().diagnostics.pending.map((entry) => entry.name)).toEqual([
      "ftue_first_launch",
      "app_launch",
    ]);
    expect(service.get().diagnostics.sentAt).toBeNull();

    raw.accept = true;
    tick();
    const again = relaunch(settings, raw);
    again.start();
    await drain();
    expect(raw.sent.slice(1).map((body) => payloadOf(body).name)).toEqual([
      "ftue_first_launch",
      "app_launch",
      "app_launch",
    ]);
    // What was recorded keeps its own time and its own ID.
    expect(payloadOf(raw.sent[1]).timestamp).toBe(10);
    expect(new Set(raw.sent.map((body) => payloadOf(body).id))).toEqual(new Set([installId(1)]));
    expect(settings.getSharing().diagnostics.pending).toEqual([]);
  });

  it("drops, unsent, a waiting entry the policy does not allow", async () => {
    const { service, raw, settings } = setup();
    settings.setSharing({
      ...DEFAULT_SHARING,
      diagnostics: {
        ...DEFAULT_SHARING.diagnostics,
        viewedAt: 1,
        installId: installId(9),
        pending: [
          { at: 1, name: "conversation", data: { text: "hello" } },
          { at: 2, name: "main_agent_turn_end", data: { trigger: "captain", prompt: "hi" } },
          { at: 3, name: "main_agent_turn_end", data: { trigger: "captain" } },
        ],
      },
    });
    expect(service.preview().diagnostics.pending.map((record) => record.at)).toEqual([3]);
    service.start();
    await drain();
    expect(raw.sent.map((body) => payloadOf(body).name)).toEqual([
      "main_agent_turn_end",
      "ftue_first_launch",
      "app_launch",
    ]);
    expect(JSON.stringify(raw.sent)).not.toContain("hello");
    expect(JSON.stringify(raw.sent)).not.toContain("prompt");
  });

  it("an off switch survives a restart, an unreadable row reads as off, and a row from before the ID parses", () => {
    const { settings, db, raw } = setup();
    settings.setSharing({
      ...DEFAULT_SHARING,
      diagnostics: { ...DEFAULT_SHARING.diagnostics, enabled: false, viewedAt: 5 },
    });
    const off = relaunch(settings, raw);
    off.start();
    expect(settings.getSharing().diagnostics).toMatchObject({ enabled: false, installId: null });
    db.prepare("UPDATE settings SET value = ? WHERE key = 'sharing'").run('{"diagnostics":1}');
    expect(settings.getSharing().diagnostics.enabled).toBe(false);
    // The #255 row shape: no ID, no milestones, no pending - it still reads as on.
    db.prepare("UPDATE settings SET value = ? WHERE key = 'sharing'").run(
      JSON.stringify({
        diagnostics: { enabled: true, viewedAt: 7, sentAt: 8 },
        contribution: { enabled: false, viewedAt: null, sentAt: null },
        ask: { askedAt: null, answeredAt: null, answer: null },
      }),
    );
    expect(settings.getSharing().diagnostics).toEqual({
      enabled: true,
      viewedAt: 7,
      sentAt: 8,
      installId: null,
      milestones: [],
      pending: [],
      phones: {},
    });
  });

  it("a build with no destination keeps the switch as a preference, and nothing is kept or sent", async () => {
    const { service, raw } = setup({ destination: null });
    service.start();
    service.markViewed("diagnostics");
    service.record({ name: "main_agent_turn_end", data: { trigger: "captain" } });
    await drain();
    expect(raw.sent).toEqual([]);
    expect(service.get().diagnostics).toMatchObject({ enabled: true, sentAt: null, pending: [] });
    expect(service.get().diagnosticsDestination).toBeNull();
  });

  it("keeps the most recent sent events inspectable, and at most a cap of events waiting", async () => {
    const { service } = setup();
    service.start();
    for (let index = 0; index < DIAGNOSTICS_PENDING_CAP + 5; index += 1) {
      service.record({ name: "main_agent_turn_end", data: { trigger: "captain" } });
    }
    expect(service.get().diagnostics.pending).toHaveLength(DIAGNOSTICS_PENDING_CAP);
    // The first-run beginning is what stays.
    expect(service.get().diagnostics.pending[0]?.name).toBe("ftue_first_launch");
    service.markViewed("diagnostics");
    await drain(DIAGNOSTICS_PENDING_CAP * 4);
    expect(service.preview().diagnostics.sent).toHaveLength(DIAGNOSTICS_SENT_KEEP);
    expect(service.get().diagnostics.pending).toEqual([]);
  });

  it("a running app retries on a timer, and closing stops it and drains the wire", async () => {
    vi.useFakeTimers();
    const { service, raw } = setup();
    raw.accept = false;
    service.markViewed("diagnostics");
    service.start();
    await drain();
    expect(raw.sent).toHaveLength(1);
    raw.accept = true;
    await vi.advanceTimersByTimeAsync(DIAGNOSTICS_RETRY_MS);
    await drain();
    expect(raw.sent).toHaveLength(3);
    await service.close(250);
    expect(raw.closed).toBe(250);
  });
});

/**
 * INF-2631, the captain's "Approve and build" on a phone's usage events
 * going through its computer, gated on the computer's own switch: hostname
 * ios, title Infinitary, the phone's own install ID, kept on the computer.
 */
describe("SharingService - a phone's events", () => {
  const PHONE = "device-iphone";
  const IPAD = "device-ipad";
  const launch = { name: "ios_launch", data: { device: "iphone" } } as const;

  it("on and told, a phone's event goes under the phone's own ID, names and version", async () => {
    const { service, raw, tick } = setup();
    service.start();
    service.markViewed("diagnostics");
    await drain();
    const computerSent = raw.sent.length;
    tick(1000);
    service.recordPhone(PHONE, launch, "0.1.0", 10_500);
    service.recordPhone(IPAD, { name: "ios_opened", data: { device: "ipad" } }, "0.2.0", 10_900);
    await drain();
    const phoneBodies = raw.sent.slice(computerSent);
    expect(phoneBodies).toEqual([
      {
        type: "event",
        payload: {
          website: "site-1",
          hostname: "ios",
          title: "Infinitary",
          url: "app://infinitary-ios/ios_launch",
          name: "ios_launch",
          data: { device: "iphone", version: "0.1.0" },
          timestamp: 10,
          id: installId(2),
        },
      },
      expect.objectContaining({
        payload: expect.objectContaining({
          name: "ios_opened",
          data: { device: "ipad", version: "0.2.0" },
          id: installId(3),
        }),
      }),
    ]);
    // The computer's own ID and names stay its own.
    expect(service.get().diagnostics.installId).toBe(installId(1));
    expect(service.get().diagnostics.phones).toEqual({
      [PHONE]: { installId: installId(2), milestones: [] },
      [IPAD]: { installId: installId(3), milestones: [] },
    });
  });

  it("off, untold or with nowhere to send, a phone's event is not built or kept, nor its ID", async () => {
    const untold = setup();
    untold.service.start();
    untold.service.recordPhone(PHONE, launch, "0.1.0", 10_000);
    expect(untold.service.get().diagnostics.phones).toEqual({});
    expect(untold.service.get().diagnostics.pending.map((entry) => entry.name)).toEqual([
      "ftue_first_launch",
      "app_launch",
    ]);

    const off = setup();
    off.service.start();
    off.service.markViewed("diagnostics");
    off.service.setSwitch("diagnostics", false);
    off.service.recordPhone(PHONE, launch, "0.1.0", 10_000);
    await drain();
    expect(off.raw.sent.map((body) => payloadOf(body).hostname)).not.toContain("ios");
    expect(off.service.get().diagnostics).toMatchObject({ pending: [], phones: {} });

    const nowhere = setup({ destination: null });
    nowhere.service.start();
    nowhere.service.markViewed("diagnostics");
    nowhere.service.recordPhone(PHONE, launch, "0.1.0", 10_000);
    expect(nowhere.service.get().diagnostics).toMatchObject({ pending: [], phones: {} });
  });

  it("turning Diagnostics off drops every phone's ID, and on again gives the phone a new one", async () => {
    const { service, raw } = setup();
    service.start();
    service.markViewed("diagnostics");
    service.recordPhone(PHONE, launch, "0.1.0", 10_000);
    await drain();
    service.setSwitch("diagnostics", false);
    expect(service.get().diagnostics.phones).toEqual({});
    service.setSwitch("diagnostics", true);
    service.recordPhone(PHONE, launch, "0.1.0", 10_000);
    await drain();
    const ids = raw.sent
      .map(payloadOf)
      .filter((payload) => payload.hostname === "ios")
      .map((payload) => payload.id);
    expect(ids).toEqual([installId(2), installId(4)]);
  });

  it("a phone that left the list drops its ID and what of it still waits; joining again is a new install", async () => {
    const { service, raw } = setup();
    raw.accept = false;
    service.start();
    service.markViewed("diagnostics");
    service.recordPhone(PHONE, launch, "0.1.0", 10_000);
    service.recordPhone(IPAD, { name: "ios_launch", data: { device: "ipad" } }, "0.1.0", 10_000);
    service.keepPhones((deviceId) => deviceId === IPAD);
    const diagnostics = service.get().diagnostics;
    expect(Object.keys(diagnostics.phones)).toEqual([IPAD]);
    expect(diagnostics.pending.filter((entry) => entry.phone === PHONE)).toEqual([]);
    expect(diagnostics.pending.filter((entry) => entry.phone === IPAD)).toHaveLength(1);
    raw.accept = true;
    service.recordPhone(PHONE, launch, "0.1.0", 10_000);
    expect(service.get().diagnostics.phones[PHONE]?.installId).toBe(installId(4));
  });

  it("each phone's first-run steps go once per its ID, and its first message comes with the first message sent", async () => {
    const { service, raw } = setup();
    service.start();
    service.markViewed("diagnostics");
    await drain();
    const from = raw.sent.length;
    const sent = { name: "ios_message_sent", data: { device: "iphone" } } as const;
    const joined = { name: "ios_ftue_joined", data: { device: "iphone" } } as const;
    service.recordPhone(PHONE, joined, "0.1.0", 10_000);
    service.recordPhone(PHONE, joined, "0.1.0", 10_000);
    service.recordPhone(PHONE, sent, "0.1.0", 10_000);
    service.recordPhone(PHONE, sent, "0.1.0", 10_000);
    service.recordPhone(
      PHONE,
      { name: "ios_card_answered", data: { device: "iphone" } },
      "0.1.0",
      10_000,
    );
    await drain();
    expect(raw.sent.slice(from).map((body) => payloadOf(body).name)).toEqual([
      "ios_ftue_joined",
      "ios_ftue_first_message",
      "ios_message_sent",
      "ios_message_sent",
      "ios_card_answered",
    ]);
    expect(service.get().diagnostics.phones[PHONE]?.milestones).toEqual([
      "ios_ftue_joined",
      "ios_ftue_first_message",
    ]);
  });

  it("the computer's own way in never sends a phone's event under the computer's ID", async () => {
    const { service, raw } = setup();
    service.start();
    service.markViewed("diagnostics");
    service.record(launch);
    await drain();
    expect(raw.sent.map((body) => payloadOf(body).name)).not.toContain("ios_launch");
  });
});

describe("crewMilestoneFor", () => {
  it("reads the crew's first-run steps off the events a task change already broadcasts", () => {
    expect(
      crewMilestoneFor({
        type: "task_started",
        taskId: "t1",
        title: "Fix the login bug",
        machineId: "local",
        crewmate: "crewmate 1",
      }),
    ).toEqual({ name: "ftue_first_spawn_started", data: {} });
    expect(
      crewMilestoneFor({ type: "task_report", taskId: "t1", title: "x", crewmate: "c" }),
    ).toEqual({ name: "ftue_first_spawn_succeeded", data: {} });
    const closed = {
      type: "task_changed" as const,
      taskId: "t1",
      key: "SCR-1",
      kind: "work" as const,
      status: "dropped" as const,
      from: "active" as const,
      activity: null,
      closedReason: "discarded" as const,
      seq: 4,
    };
    expect(crewMilestoneFor(closed)).toEqual({
      name: "ftue_first_disposal",
      data: { outcome: "discarded" },
    });
    // Not a crewmate's task, not a transition, not a close: no step.
    expect(crewMilestoneFor({ ...closed, kind: "question" })).toBeNull();
    expect(crewMilestoneFor({ ...closed, from: "dropped" })).toBeNull();
    expect(
      crewMilestoneFor({ ...closed, status: "active", closedReason: null, from: "open" }),
    ).toBeNull();
    expect(crewMilestoneFor({ type: "user_turn", text: "hello" })).toBeNull();
  });
});

describe("SharingService - contribution", () => {
  it("cannot be turned on while the terms are unpublished, and a stale on row is coerced off", () => {
    const { service, settings } = setup({ terms: { published: false, version: "draft-1" } });
    expect(service.setSwitch("contribution", true).contribution.enabled).toBe(false);
    expect(service.answerAsk("contribute").contribution.enabled).toBe(false);
    expect(service.noteLocalModelEnabled().askPending).toBe(false);

    settings.setSharing({
      ...DEFAULT_SHARING,
      contribution: { enabled: true, viewedAt: 5, sentAt: null },
    });
    const again = new SharingService({
      settings,
      emit: () => {},
      raw: new RecordingClient(),
      telemetryConfig: { websiteID: "", version: "1.2.3" },
      destination: null,
      decisions: { list: () => [], count: () => 0 },
      terms: { published: false, version: "draft-1" },
    });
    expect(again.get().contribution).toEqual({ enabled: false, viewedAt: 5, sentAt: null });
    expect(settings.getSharing().contribution.enabled).toBe(false);
  });

  it("previews the redacted decision backlog newer than the last send, capped, with the whole count", () => {
    const published = { published: true, version: "1" };
    const { service, tasks, tick } = setup({ terms: published });
    tasks.create({ id: "t1", title: "one", prompt: "p", repoId: "r1", status: "active" });
    tasks.create({ id: "t2", title: "two", prompt: "p", repoId: "r1", status: "active" });
    for (let index = 0; index < CONTRIBUTION_PREVIEW_LIMIT + 3; index += 1) {
      tick();
      const record = decision(`d${index}`, 10_000 + index + 1, ["t1"]);
      // A field the corpus export blanks must never survive into a record.
      record.producer.accountId = "sk-ant-api03-VERYSECRET";
      tasks.turns.recordDecision(record);
    }
    tick();
    tasks.turns.recordDecision(decision("last", 20_000, ["t1", "t2"]));

    const preview = service.preview();
    expect(preview.contribution.pendingCount).toBe(CONTRIBUTION_PREVIEW_LIMIT + 3 + 2);
    expect(preview.contribution.pending).toHaveLength(CONTRIBUTION_PREVIEW_LIMIT);
    // Newest first: the last decision's two rows, one per task it touched.
    const newest = preview.contribution.pending.slice(0, 2) as { taskId: string; ref: string }[];
    expect(newest.map((record) => record.taskId).sort()).toEqual(["t1", "t2"]);
    expect(preview.contribution.pending[0]).toMatchObject({
      kind: "decided",
      ref: "last",
      data: { decision: "last" },
    });
    expect(JSON.stringify(preview)).not.toContain("VERYSECRET");
  });

  it("sends the backlog through the sender once on, viewed and published, then stamps the send", async () => {
    const batches: Record<string, unknown>[][] = [];
    const { service, tasks, tick } = setup({
      terms: { published: true, version: "1" },
      contributionSender: async (records) => {
        batches.push(records);
      },
    });
    tasks.create({ id: "t1", title: "one", prompt: "p", repoId: "r1", status: "active" });
    tick();
    tasks.turns.recordDecision(decision("d1", 10_001, ["t1"]));
    service.setSwitch("contribution", true);
    expect(batches).toEqual([]);
    tick();
    service.markViewed("contribution");
    await Promise.resolve();
    expect(batches).toHaveLength(1);
    expect(batches[0]?.[0]).toMatchObject({ ref: "d1" });
    expect(service.get().contribution.sentAt).toBe(10_002);
    expect(service.preview().contribution).toEqual({ pending: [], pendingCount: 0 });
  });

  it("with no sender the backlog is a preview only, and nothing stamps a send", () => {
    const { service, tasks, tick } = setup({ terms: { published: true, version: "1" } });
    tasks.create({ id: "t1", title: "one", prompt: "p", repoId: "r1", status: "active" });
    tick();
    tasks.turns.recordDecision(decision("d1", 10_001, ["t1"]));
    service.setSwitch("contribution", true);
    service.markViewed("contribution");
    expect(service.get().contribution.sentAt).toBeNull();
    expect(service.preview().contribution.pendingCount).toBe(1);
  });

  it("asks once at local-model enablement, and either answer is final", () => {
    const { service, tick } = setup({ terms: { published: true, version: "1" } });
    expect(service.noteLocalModelEnabled().askPending).toBe(true);
    expect(service.get().ask).toEqual({ askedAt: 10_000, answeredAt: null, answer: null });
    tick();
    // Enabling again while pending does not restart the ask.
    expect(service.noteLocalModelEnabled().ask.askedAt).toBe(10_000);
    const answered = service.answerAsk("not-now");
    expect(answered.askPending).toBe(false);
    expect(answered.ask).toEqual({ askedAt: 10_000, answeredAt: 10_001, answer: "not-now" });
    expect(answered.contribution.enabled).toBe(false);
    tick();
    // Never again on the app's own initiative.
    expect(service.noteLocalModelEnabled().askPending).toBe(false);
    expect(service.answerAsk("contribute").ask.answer).toBe("not-now");
  });

  it("'contribute' turns the switch on, still pending its first view", () => {
    const { service, pushes } = setup({ terms: { published: true, version: "1" } });
    service.noteLocalModelEnabled();
    const view = service.answerAsk("contribute");
    expect(view.ask.answer).toBe("contribute");
    expect(view.contribution).toEqual({ enabled: true, viewedAt: null, sentAt: null });
    expect(pushes.at(-1)).toEqual(view);
  });
});
