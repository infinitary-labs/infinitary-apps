import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { allowIntegrationReads } from "../../../../../tests/helpers/integrationApprovals";
import {
  NOTES_URI,
  type NotesBook,
  type NotesHttpServer,
  SAMPLE_NOTES,
  type StandInEra,
  serveNotesHttp,
} from "../../../../../tests/helpers/mcpStandIn";
import { scratchDir } from "../../../../../tests/helpers/scratchDirs";
import { hostEnv } from "../../../hostEnv";
import { Scheduler } from "../../../orchestrator/scheduler";
import { openInMemoryDatabase } from "../../../storage/db";
import { ScheduleStore } from "../../../storage/scheduleStore";
import { seedTask } from "../../../tasks/seedTask";
import { TaskService } from "../../../tasks/taskService";
import { atUtilityQos } from "../../../utilityQos";
import {
  FileIntegrationSecrets,
  githubIntegration,
  IntegrationSettingsStore,
  IntegrationsService,
} from "../../index";
import { mcpIntegration } from "./mcpIntegration";

/**
 * MCP servers as integrations (INF-781; INF-775 piece 2, whose checks name
 * "unit tests against a scripted server over stdio and HTTP for both
 * protocol eras"): a stand-in notes server is added the way Settings adds
 * one, through the integrations service, in each era over each transport.
 * The captain's q7 - trust the server's list and show it after - is the
 * row that comes back; INF-950 makes each action ask initially, with reads
 * explicitly allowed in transport tests and a reasoned change kept until its click.
 */

vi.setConfig({ testTimeout: 10_000 });

const STAND_IN = resolve(__dirname, "../../../../../tests/helpers/mcpStandIn.ts");
const task = { kind: "task", taskId: "task-1" } as const;

const opened: { service: IntegrationsService; http?: NotesHttpServer; close: () => void }[] = [];

afterEach(async () => {
  for (const { service, http, close } of opened.splice(0)) {
    await service.dispose();
    await http?.close();
    close();
  }
});

/**
 * A service over a fresh folder with the MCP binding alone, as the
 * composition root wires it, and a task whose asks it keeps.
 */
function serviceIn(root: string): {
  service: IntegrationsService;
  tasks: TaskService;
  close: () => void;
} {
  const db = openInMemoryDatabase();
  const tasks = new TaskService({ db, strict: true });
  seedTask(tasks, { id: task.taskId, title: "Keep the week's notes", status: "idle" });
  let service: IntegrationsService | undefined;
  service = new IntegrationsService({
    bindings: [
      mcpIntegration({
        root,
        env: () => hostEnv(),
        belowUi: (file, args) => atUtilityQos(file, args),
        cwd: () => root,
        version: "0.0.0-test",
        changed: () => service?.changed(),
      }),
    ],
    store: new IntegrationSettingsStore(root),
    secrets: new FileIntegrationSecrets(join(root, "secrets")),
    asks: {
      keep: (taskId, ask) => tasks.keepWriteAsk(taskId, ask),
      take: (taskId, askId) => tasks.takeWriteAsk(taskId, askId),
      record: (taskId, askId, outcome) => tasks.recordWriteAskOutcome(taskId, askId, outcome),
    },
  });
  return { service, tasks, close: () => db.close() };
}

type Served = {
  runs: string;
  /** Change the notes the way the person would elsewhere. */
  addNote: (text: string) => void;
  notes: () => string[];
  http?: NotesHttpServer;
};

async function serve(era: StandInEra, transport: "stdio" | "http", root: string): Promise<Served> {
  if (transport === "http") {
    const http = await serveNotesHttp(era);
    return {
      runs: http.url,
      addNote: (text) => http.addNote(text),
      notes: () => http.book.notes,
      http,
    };
  }
  const file = join(root, "notes.json");
  const notes = (): string[] => (JSON.parse(readFileSync(file, "utf8")) as NotesBook).notes;
  writeFileSync(file, JSON.stringify({ notes: SAMPLE_NOTES }));
  return {
    // The program and its paths as a person writes them, quoted where a folder has a space.
    runs: `'${process.execPath}' '${STAND_IN}' stdio ${era} '${file}'`,
    addNote: (text) => writeFileSync(file, JSON.stringify({ notes: [...notes(), text] })),
    notes,
  };
}

describe.each([
  ["legacy", "stdio"],
  ["modern", "stdio"],
  ["legacy", "http"],
  ["modern", "http"],
] as const)("an MCP server in the %s era over %s", (era, transport) => {
  it("is added with its own tool list, reads, asks before a change and tells when a resource changes", async () => {
    const root = scratchDir("mcp-integration");
    const { service, tasks, close } = serviceIn(root);
    const served = await serve(era, transport, root);
    opened.push({ service, http: served.http, close });

    const { id, view } = await service.add("mcp", { name: "Notes", runs: served.runs });
    const row = view.integrations.find((entry) => entry.id === id);
    expect(id).toBe("mcp-notes");
    expect(row).toMatchObject({ kind: "mcp", name: "Notes", runs: served.runs, health: "ok" });
    expect(row?.actions.map(({ name, effect, rule }) => ({ name, effect, rule }))).toEqual([
      { name: "list_notes", effect: "reads", rule: "ask" },
      { name: "get_note", effect: "reads", rule: "ask" },
      { name: "add_note", effect: "changes", rule: "ask" },
      { name: "read_resource", effect: "reads", rule: "ask" },
    ]);
    expect(row?.events).toEqual([
      { name: "resource_changed", label: "A resource changed", every: 1 },
    ]);
    // The first mate and the crew never read what it runs.
    expect(JSON.stringify(service.roster())).not.toContain(served.runs);
    expect(JSON.stringify(service.show("Notes"))).not.toContain(served.runs);

    allowIntegrationReads(service);
    const listed = await service.call(
      task,
      "Notes",
      "list_notes",
      {},
      "To perform the task’s requested action.",
    );
    expect(listed.refused).toBeUndefined();
    expect(listed.text).toContain(`1. ${SAMPLE_NOTES[0]}`);
    const one = await service.call(
      task,
      "notes",
      "get_note",
      { id: 2 },
      "To perform the task’s requested action.",
    );
    expect(one.text).toBe(SAMPLE_NOTES[1]);

    const start = await service.look(id, "resource_changed", null);
    expect(start.items).toEqual([]);
    served.addNote("Return the library books by Friday");
    // Polled until the server's word arrives, within the file's budget.
    await expect
      .poll(async () => (await service.look(id, "resource_changed", start.cursor)).items, {
        timeout: 9_000,
      })
      .toEqual([{ id: expect.any(String), summary: `All notes changed (${NOTES_URI})` }]);
    const read = await service.call(
      task,
      "Notes",
      "read_resource",
      { uri: NOTES_URI },
      "To perform the task’s requested action.",
    );
    expect(read.text).toContain("4. Return the library books by Friday");

    // A server started again cannot say what changed while it was down.
    await service.check(id);
    expect((await service.look(id, "resource_changed", start.cursor)).resynced).toBe(true);

    // A change is kept on the task, and runs once on the captain's click.
    const change = await service.call(
      task,
      "Notes",
      "add_note",
      { text: "Pay the electric bill" },
      "To perform the task’s requested action.",
    );
    expect(change.text).toContain("The app raised its approval card");
    expect(served.notes()).not.toContain("Pay the electric bill");
    const ask = tasks.get(task.taskId)?.delivery?.writeAsks?.[0];
    expect(ask).toMatchObject({
      kind: "integration",
      integration: "mcp-notes",
      action: "add_note",
    });
    const click = await service.sendAsk(task.taskId, ask?.id ?? "");
    expect(click.outcome).toEqual({ kind: "ran" });
    expect(click.answer).toBe("Added note 5.");
    expect(served.notes()).toContain("Pay the electric bill");
  });
});

// INF-882: upgrading an existing connection must change only its name,
// not a pending request's destination, its keys, settings or event identity.
it("keeps an old MCP ask and its event on the server after the GitHub name repair", async () => {
  const root = scratchDir("mcp-github-name-");
  const legacy = serviceIn(root);
  const http = await serveNotesHttp("modern");
  const signedIn = { value: false };
  const read = vi.fn(async () => JSON.stringify({ login: "octo" }));
  const write = vi.fn(async () => {
    throw new Error("the MCP ask must not reach GitHub");
  });
  let upgraded: IntegrationsService | undefined;
  try {
    await legacy.service.add("mcp", { name: "GitHub", runs: http.url });
    await legacy.service.call(
      task,
      "GitHub",
      "add_note",
      {
        text: "Return the library books by Friday",
      },
      "To perform the task’s requested action.",
    );
    const ask = legacy.tasks.get(task.taskId)?.delivery?.writeAsks?.[0];
    if (!ask) throw new Error("the old server's change must have been kept");
    expect(ask).toMatchObject({ kind: "integration", integration: "mcp-github", place: "GitHub" });
    await legacy.service.dispose();
    upgraded = new IntegrationsService({
      bindings: [
        githubIntegration({
          signIns: {
            stateOf: () => (signedIn.value ? "ok" : undefined),
            loginOf: () => (signedIn.value ? "octo" : null),
            checkNow: async () => {},
            signOut: () => {
              signedIn.value = false;
            },
          },
          gateway: { read, readAsSeat: read, write },
        }),
        mcpIntegration({
          root,
          env: () => hostEnv(),
          belowUi: (file, args) => atUtilityQos(file, args),
          cwd: () => root,
          version: "0.0.0-test",
          changed: () => upgraded?.changed(),
        }),
      ],
      store: new IntegrationSettingsStore(root),
      secrets: new FileIntegrationSecrets(join(root, "secrets")),
      asks: {
        keep: (taskId, kept) => legacy.tasks.keepWriteAsk(taskId, kept),
        take: (taskId, askId) => legacy.tasks.takeWriteAsk(taskId, askId),
        record: (taskId, askId, outcome) =>
          legacy.tasks.recordWriteAskOutcome(taskId, askId, outcome),
      },
    });
    expect(upgraded.show("GitHub")).toMatchObject({ refused: "invalid" });
    expect(upgraded.show("GitHub MCP server")).toMatchObject({ id: "mcp-github" });
    signedIn.value = true;
    expect(upgraded.changed().integrations.map((row) => row.name)).toEqual([
      "GitHub",
      "GitHub MCP server",
    ]);
    allowIntegrationReads(upgraded);
    const crew = upgraded.forTask(task.taskId);
    expect(
      (
        await crew.call(
          "GitHub",
          "read",
          { path: "/user" },
          undefined,
          "To perform the task’s requested action.",
        )
      ).text,
    ).toContain('"login":"octo"');
    expect(read).toHaveBeenCalledOnce();
    expect(
      (
        await crew.call(
          "GitHub MCP server",
          "list_notes",
          {},
          undefined,
          "To perform the task’s requested action.",
        )
      ).text,
    ).toContain(SAMPLE_NOTES[0]);
    expect(upgraded.listenable("GitHub MCP server", "resource_changed")).toMatchObject({
      integration: "mcp-github",
    });
    expect(upgraded.rosterLine()).toContain("Renamed from “GitHub”");
    const clicked = await upgraded.sendAsk(task.taskId, ask.id);
    expect(clicked.outcome).toEqual({ kind: "ran" });
    expect(
      http.book.notes.filter((note) => note === "Return the library books by Friday"),
    ).toHaveLength(1);
    expect((await upgraded.sendAsk(task.taskId, ask.id)).ok).toBe(false);
    expect(write).not.toHaveBeenCalled();
  } finally {
    await upgraded?.dispose();
    await legacy.service.dispose();
    await http.close();
    legacy.close();
  }
});

// INF-947 (the captain's approval of INF-946's piece 1): removing a
// connection and adding another under the same name gives the new one the
// same id, so a kept request or an Automation rule must not follow the id
// to the replacement. A rename keeps both on the connection they were for.
describe("a server removed and replaced under the same name (INF-947)", () => {
  it("never runs a request kept for the removed server on its replacement, and keeps one across a rename and a restart", async () => {
    const root = scratchDir("mcp-replaced-");
    const { service, tasks, close } = serviceIn(root);
    const first = await serveNotesHttp("modern");
    const second = await serveNotesHttp("modern");
    opened.push({ service, http: first, close }, { service, http: second, close: () => {} });

    const { id } = await service.add("mcp", { name: "Studio notes", runs: first.url });
    await service.call(
      task,
      "Studio notes",
      "add_note",
      { text: "Book the October shoot" },
      "To perform the task’s requested action.",
    );
    const kept = tasks.get(task.taskId)?.delivery?.writeAsks?.[0];
    if (!kept) throw new Error("the change must have been kept as an ask");
    await service.remove(id);
    const replaced = await service.add("mcp", { name: "Studio notes", runs: second.url });
    // The same name makes the same id: only the kept connection tells them apart.
    expect(replaced.id).toBe(id);

    const click = await service.sendAsk(task.taskId, kept.id);
    expect(click.outcome).toEqual({
      kind: "refused",
      why: "Studio notes was removed or replaced since it was asked; ask again",
    });
    expect(second.book.notes).toEqual(SAMPLE_NOTES);
    expect(first.book.notes).toEqual(SAMPLE_NOTES);

    // A request kept for the replacement survives its rename and a restart.
    await service.call(
      task,
      "Studio notes",
      "add_note",
      { text: "Pay the electric bill" },
      "To perform the task’s requested action.",
    );
    const again = tasks.get(task.taskId)?.delivery?.writeAsks?.[0];
    service.configure(id, { name: "Home notes" });
    await service.dispose();
    const restarted = new IntegrationsService({
      bindings: [
        mcpIntegration({
          root,
          env: () => hostEnv(),
          belowUi: (file, args) => atUtilityQos(file, args),
          cwd: () => root,
          version: "0.0.0-test",
          changed: () => restarted.changed(),
        }),
      ],
      store: new IntegrationSettingsStore(root),
      secrets: new FileIntegrationSecrets(join(root, "secrets")),
      asks: {
        keep: (taskId, ask) => tasks.keepWriteAsk(taskId, ask),
        take: (taskId, askId) => tasks.takeWriteAsk(taskId, askId),
        record: (taskId, askId, outcome) => tasks.recordWriteAskOutcome(taskId, askId, outcome),
      },
    });
    opened.push({ service: restarted, close: () => {} });
    expect((await restarted.sendAsk(task.taskId, again?.id ?? "")).outcome).toEqual({
      kind: "ran",
    });
    expect(second.book.notes).toEqual([...SAMPLE_NOTES, "Pay the electric bill"]);
    expect(first.book.notes).toEqual(SAMPLE_NOTES);
  });

  it("refuses a request kept before the app could tell connections apart", async () => {
    const root = scratchDir("mcp-replaced-");
    const { service, tasks, close } = serviceIn(root);
    const http = await serveNotesHttp("modern");
    opened.push({ service, http, close });
    await service.add("mcp", { name: "Studio notes", runs: http.url });
    // An older build kept the destination by its id alone.
    tasks.keepWriteAsk(task.taskId, {
      id: "ia0123456789ab",
      kind: "integration",
      integration: "mcp-studio-notes",
      place: "Studio notes",
      action: "add_note",
      input: JSON.stringify({ text: "Book the October shoot" }),
      at: Date.UTC(2026, 9, 21),
    });
    const click = await service.sendAsk(task.taskId, "ia0123456789ab");
    expect(click.outcome).toEqual({
      kind: "refused",
      why: "it was kept before the app could tell one Studio notes connection from another; ask again",
    });
    expect(http.book.notes).toEqual(SAMPLE_NOTES);
  });

  it("stops an Automation rule on the removed server until its integration is picked again", async () => {
    const root = scratchDir("mcp-replaced-");
    const { service, close } = serviceIn(root);
    const first = await serveNotesHttp("modern");
    const second = await serveNotesHttp("modern");
    opened.push({ service, http: first, close }, { service, http: second, close: () => {} });
    const looked: string[] = [];
    const scheduler = new Scheduler({
      store: new ScheduleStore(openInMemoryDatabase()),
      notify: () => null,
      broadcastEvent: () => {},
      events: {
        find: (integration, event) => service.listenable(integration, event),
        look: (integration, event, cursor, filter, connection) => {
          looked.push(integration);
          return service.look(integration, event, cursor, filter, connection);
        },
      },
    });
    const tick = async () => {
      scheduler.tick(Date.now());
      await scheduler.settled();
    };

    const { id } = await service.add("mcp", { name: "Studio notes", runs: first.url });
    const rule = scheduler.create(
      { kind: "event", integration: "Studio notes", event: "resource_changed" },
      "Tidy the notes: {{events}}",
      true,
    );
    await tick();
    expect(looked).toEqual([id]);
    expect(scheduler.stopped(rule)).toBeUndefined();

    await service.remove(id);
    await service.add("mcp", { name: "Studio notes", runs: second.url });
    const waiting = scheduler.rules()[0];
    if (!waiting) throw new Error("the rule must still be saved");
    // The replacement has the same id and event, and the rule never looks at it.
    expect(service.listenable(id, "resource_changed")).toBeDefined();
    await tick();
    expect(looked).toEqual([id]);
    expect(scheduler.stopped(waiting)).toBe(
      "Its integration was removed or replaced, so it waits until its integration is picked again.",
    );
    expect(scheduler.listening(waiting)).toBeUndefined();
    // An edit that keeps the same integration does not pick the replacement for the person.
    const edited = scheduler.update(rule.id, { prompt: "Sort the notes: {{events}}" });
    expect(scheduler.stopped(edited)).toBeDefined();

    // Picking it again is the person's explicit choice: the rule listens to the replacement.
    const picked = scheduler.update(rule.id, { spec: edited.spec, reconnect: true });
    expect(scheduler.stopped(picked)).toBeUndefined();
    await tick();
    expect(looked).toEqual([id, id]);
  });

  it("stops a rule saved before the app could tell connections apart", async () => {
    const root = scratchDir("mcp-replaced-");
    const { service, close } = serviceIn(root);
    const http = await serveNotesHttp("modern");
    opened.push({ service, http, close });
    const store = new ScheduleStore(openInMemoryDatabase());
    const looked: string[] = [];
    const scheduler = new Scheduler({
      store,
      notify: () => null,
      broadcastEvent: () => {},
      events: {
        find: (integration, event) => service.listenable(integration, event),
        look: (integration, event, cursor, filter, connection) => {
          looked.push(integration);
          return service.look(integration, event, cursor, filter, connection);
        },
      },
    });
    const { id } = await service.add("mcp", { name: "Studio notes", runs: http.url });
    // An older build kept the rule's destination by its id alone.
    store.insert({
      id: "r0legacy",
      spec: { kind: "event", integration: id, event: "resource_changed" },
      prompt: "Tidy the notes: {{events}}",
      nextFire: Date.now(),
      createdAt: Date.now(),
      captainRequested: true,
      state: "enabled",
      revision: 1,
    });
    scheduler.tick(Date.now());
    await scheduler.settled();
    expect(looked).toEqual([]);
    const legacy = scheduler.rules()[0];
    if (!legacy) throw new Error("the rule must be saved");
    expect(scheduler.stopped(legacy)).toBe(
      "It was saved before the app could tell one connection from another, so it waits until its integration is picked again.",
    );
  });
});

describe("an MCP server that drops a change it took", () => {
  it("leaves the change unknown and never runs it again", async () => {
    // Review finding F2 on INF-784: told "sent nothing" after the server took the call, a crewmate would make the change twice.
    const root = scratchDir("mcp-integration");
    const { service, tasks, close } = serviceIn(root);
    const http = await serveNotesHttp("modern");
    opened.push({ service, http, close });
    await service.add("mcp", { name: "Notes", runs: http.url });
    await service.call(
      task,
      "Notes",
      "add_note",
      { text: "Pay the electric bill" },
      "To perform the task’s requested action.",
    );
    const ask = tasks.get(task.taskId)?.delivery?.writeAsks?.[0];
    http.dropNextAdd();

    const click = await service.sendAsk(task.taskId, ask?.id ?? "");
    expect(click.outcome).toMatchObject({ kind: "unknown" });
    expect(http.book.notes.filter((note) => note === "Pay the electric bill")).toHaveLength(1);
    expect((await service.sendAsk(task.taskId, ask?.id ?? "")).ok).toBe(false);
    expect(http.book.notes.filter((note) => note === "Pay the electric bill")).toHaveLength(1);
  });
});

describe("an MCP server that cannot connect", () => {
  it("is refused in words and leaves no row", async () => {
    const root = scratchDir("mcp-integration");
    const { service, close } = serviceIn(root);
    opened.push({ service, close });
    // Named by itself, never by the wrapper that starts it below the window on a Mac.
    await expect(
      service.add("mcp", { name: "Broken", runs: "mcp-server-that-is-not-installed --stdio" }),
    ).rejects.toThrow(/^mcp-server-that-is-not-installed could not be found on this computer\.$/);
    await expect(
      service.add("mcp", { name: "Piped", runs: "npx some-server | tee log" }),
    ).rejects.toThrow(/read by no shell/);
    expect(service.view().integrations).toEqual([]);
  });

  it("reaches an address only through the guarded transport's network classes", async () => {
    const root = scratchDir("mcp-integration");
    const { service, close } = serviceIn(root);
    opened.push({ service, close });
    // Plain http leaves this computer for no server.
    await expect(
      service.add("mcp", { name: "Far", runs: "http://93.184.215.14/mcp" }),
    ).rejects.toThrow(/Plain http is only for a server on this computer/);
    // A redirect is never followed to wherever it points.
    const redirecting = createServer((_request, reply) => {
      reply.writeHead(307, { location: "http://169.254.169.254/latest" });
      reply.end();
    });
    await new Promise<void>((done) => redirecting.listen(0, "127.0.0.1", done));
    const { port } = redirecting.address() as AddressInfo;
    try {
      await expect(
        service.add("mcp", { name: "Moved", runs: `http://127.0.0.1:${port}/mcp` }),
      ).rejects.toThrow(/redirected/);
    } finally {
      await new Promise<void>((done) => redirecting.close(() => done()));
    }
    expect(service.view().integrations).toEqual([]);
  });
});

// INF-948 (INF-946 piece 2): two additions started together against the
// real server each waited on discovery before either was saved, so both
// rows came back named the same with the same id.
describe("two additions that overlap (INF-948)", () => {
  it("gives each its own id, refuses a second of the same name, and reaches each by its own name", async () => {
    const root = scratchDir("mcp-overlap-");
    const { service, close } = serviceIn(root);
    const first = await serveNotesHttp("modern");
    const second = await serveNotesHttp("modern");
    opened.push({ service, http: first, close }, { service, http: second, close: () => {} });

    const adding = [
      service.add("mcp", { name: "Studio notes", runs: first.url }),
      service.add("mcp", { name: "Studio notes", runs: second.url }),
      service.add("mcp", { name: "Studio-notes", runs: second.url }),
    ];
    const [one, same, other] = await Promise.allSettled(adding);
    expect(same).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({
        message: "An integration named Studio notes is being added. Choose another name.",
      }),
    });
    expect(one).toMatchObject({ status: "fulfilled", value: { id: "mcp-studio-notes" } });
    expect(other).toMatchObject({ status: "fulfilled", value: { id: "mcp-studio-notes-2" } });
    const rows = service.roster();
    expect(rows.map((row) => [row.id, row.name])).toEqual([
      ["mcp-studio-notes", "Studio notes"],
      ["mcp-studio-notes-2", "Studio-notes"],
    ]);
    expect(new Set(rows.map((row) => row.connection)).size).toBe(2);

    allowIntegrationReads(service);
    const read = await service.call(
      task,
      "Studio-notes",
      "list_notes",
      {},
      "To perform the task’s requested action.",
    );
    expect(read.text).toContain(SAMPLE_NOTES[0]);
    const answer = await service.call(
      task,
      String(rows[1]?.connection),
      "add_note",
      {
        text: "Book the October shoot",
      },
      "To perform the task’s requested action.",
    );
    expect(answer.text).toContain("Not run: Studio-notes's add_note");
  });
});
