import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { integrationsViewSchema } from "@shared/integrations";
import { afterEach, describe, expect, it, vi } from "vitest";
import { allowIntegrationReads } from "../../../../../tests/helpers/integrationApprovals";
import { integrationKeys } from "../../../../../tests/helpers/integrationKeys";
import {
  NOTES_KEY_VARIABLE,
  NOTES_URI,
  type NotesBook,
  type NotesHttpServer,
  publishNotes,
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
import { githubIntegration, IntegrationSettingsStore, IntegrationsService } from "../../index";
import type { IntegrationKeys } from "../../secrets";
import { mcpIntegration } from "./mcpIntegration";
import { McpServerStore } from "./store";

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
 * composition root wires it, and a task whose asks it keeps; with `keys`,
 * the binding keeps a server's keys there.
 */
function serviceIn(
  root: string,
  keys?: IntegrationKeys,
): {
  service: IntegrationsService;
  tasks: TaskService;
  binding: ReturnType<typeof mcpIntegration>;
  close: () => void;
} {
  const db = openInMemoryDatabase();
  const tasks = new TaskService({ db, strict: true });
  seedTask(tasks, { id: task.taskId, title: "Keep the week's notes", status: "idle" });
  let service: IntegrationsService | undefined;
  const binding = mcpIntegration({
    root,
    env: () => hostEnv(),
    belowUi: (file, args) => atUtilityQos(file, args),
    cwd: () => root,
    version: "0.0.0-test",
    changed: () => service?.changed(),
    ...(keys ? { keys } : {}),
  });
  service = new IntegrationsService({
    bindings: [binding],
    store: new IntegrationSettingsStore(root),
    asks: {
      keep: (taskId, ask) => tasks.delivery.keepWriteAsk(taskId, ask),
      take: (taskId, askId) => tasks.delivery.takeWriteAsk(taskId, askId),
      record: (taskId, askId, outcome) =>
        tasks.delivery.recordWriteAskOutcome(taskId, askId, outcome),
    },
  });
  return { service, tasks, binding, close: () => db.close() };
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
    // Whole, in one rename: the child polls this file while it runs (INF-2782).
    addNote: (text) => publishNotes(file, { notes: [...notes(), text] }),
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

// INF-1573: the journey's strict JSON reader must see a complete book even
// while add_note is publishing it, not depend on winning the scheduling race.
// The preload samples real file contents at truncation and partial-write
// boundaries; the service still calls the real stand-in over stdio.
describe.each(["legacy", "modern"] as const)("atomic %s stand-in notes", (era) => {
  it("keeps the published book readable throughout add_note", async () => {
    const root = scratchDir("mcp-atomic-notes-");
    const file = join(root, "notes.json");
    const before = { notes: [...SAMPLE_NOTES] };
    writeFileSync(file, JSON.stringify(before));
    const preload = resolve(__dirname, "../../../../../tests/fixtures/mcp-notes-write.mjs");
    const { service, tasks, close } = serviceIn(root);
    opened.push({ service, close });
    await service.add("mcp", {
      name: "Notes",
      runs: `'${process.execPath}' --import '${preload}' '${STAND_IN}' stdio ${era} '${file}'`,
    });
    const reminder = "Return the library books by Friday";
    await service.call(task, "Notes", "add_note", { text: reminder }, "Keep the week's reminder.");
    const ask = tasks.get(task.taskId)?.delivery?.writeAsks?.[0];
    expect(ask).toMatchObject({ kind: "integration", action: "add_note" });
    const click = await service.sendAsk(task.taskId, ask?.id ?? "");
    expect(click.outcome).toEqual({ kind: "ran" });
    expect(click.answer).toBe(`Added note ${before.notes.length + 1}.`);
    const snapshots: string[] = JSON.parse(readFileSync(`${file}.observations.json`, "utf8"));
    const published = JSON.parse(readFileSync(file, "utf8"));
    console.info(
      `[mcp atomic ${era}]`,
      JSON.stringify({ answer: click.answer, snapshots, published }),
    );
    // A direct rewrite exposes an empty string, then half a JSON document.
    // Every in-progress read must instead see the previous complete book.
    expect(snapshots.map((snapshot) => JSON.parse(snapshot))).toEqual([before, before, before]);
    expect(published).toEqual({ notes: [...SAMPLE_NOTES, reminder] });
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
          gateway: { read, readAsSeat: read, write, writeAsSeat: write },
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
      asks: {
        keep: (taskId, kept) => legacy.tasks.delivery.keepWriteAsk(taskId, kept),
        take: (taskId, askId) => legacy.tasks.delivery.takeWriteAsk(taskId, askId),
        record: (taskId, askId, outcome) =>
          legacy.tasks.delivery.recordWriteAskOutcome(taskId, askId, outcome),
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
      asks: {
        keep: (taskId, ask) => tasks.delivery.keepWriteAsk(taskId, ask),
        take: (taskId, askId) => tasks.delivery.takeWriteAsk(taskId, askId),
        record: (taskId, askId, outcome) =>
          tasks.delivery.recordWriteAskOutcome(taskId, askId, outcome),
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
    tasks.delivery.keepWriteAsk(task.taskId, {
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
    await expect(
      service.add("mcp", { name: "Far", runs: "http://93.184.215.14/mcp" }),
    ).rejects.toThrow(/Plain http is only for a server on this computer/);
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

// INF-3307's audit, row 9: a started server whose tool listing failed was
// dropped without being closed, so each look - an Automation rule's every
// minute, or Check again - left one more program running.
describe("a connected server that fails its tool listing (INF-3367)", () => {
  const runningWith = (file: string): number[] =>
    execFileSync("ps", ["-A", "-o", "pid=,command="], { encoding: "utf8" })
      .split("\n")
      .filter((line) => line.includes(file))
      .map((line) => Number.parseInt(line.trim(), 10));

  it("is closed, leaving no program running per attempt", async () => {
    const root = scratchDir("mcp-integration");
    const { service, close } = serviceIn(root);
    opened.push({ service, close });
    const served = await serve("legacy", "stdio", root);
    const file = join(root, "notes.json");
    const { id } = await service.add("mcp", { name: "Notes", runs: served.runs });
    expect(runningWith(file)).toHaveLength(1);

    publishNotes(file, {
      notes: served.notes(),
      unavailable: "The notes service's sign-in has lapsed; sign in again.",
    });
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) await service.check(id);
      expect(service.view().integrations[0]?.health).toBe("unavailable");
      expect(runningWith(file)).toEqual([]);
    } finally {
      for (const pid of runningWith(file)) process.kill(pid);
    }
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
    // The roster's connections; the app's own events row beside them is not one.
    const rows = service.roster().filter((row) => row.kind === "mcp");
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

// INF-1408 and the captain's q7 on INF-775: trust the complete server list,
// on addition and on growth, without changing existing identities or consent.
describe.each(["legacy", "modern"] as const)("a large %s notes workspace", (era) => {
  it.each([false, true])(
    "keeps every action reachable (large at addition: %s)",
    async (largeAtAdd) => {
      const root = scratchDir("mcp-complete-list-");
      const { service, tasks, close } = serviceIn(root);
      const notebooks = Array.from({ length: 300 }, (_, index) => `notebook_${index + 1}`);
      let names = largeAtAdd ? notebooks : notebooks.slice(0, 2);
      const http = await serveNotesHttp(era, () => names);
      opened.push({ service, http, close });
      const { id } = await service.add("mcp", { name: "Notebooks", runs: http.url });
      service.configure(id, { actions: { get_note: false } });
      service.setRule(id, "list_notes", true);
      names = notebooks;
      await service.check(id);

      // Settings' published view and agent discovery must both carry the tail.
      const row = integrationsViewSchema.parse(service.view()).integrations[0];
      expect(row?.actions).toHaveLength(notebooks.length + 4);
      expect(row?.actions.find((action) => action.name === "get_note")?.rule).toBe("never");
      expect(row?.actions.find((action) => action.name === "list_notes")?.rule).toBe("allow");
      expect(row?.actions.find((action) => action.name === "notebook_300")?.rule).toBe("ask");
      expect(JSON.stringify(service.show("Notebooks"))).toContain("notebook_300");
      expect(
        JSON.parse(readFileSync(join(root, "mcp.json"), "utf8")).servers[0].tools,
      ).toHaveLength(notebooks.length + 3);

      const answer = await service.call(
        task,
        "Notebooks",
        "notebook_300",
        {},
        "Read the last notebook.",
      );
      expect(answer.text).toContain("The app raised its approval card");
      const ask = tasks.get(task.taskId)?.delivery?.writeAsks?.[0];
      expect(ask).toMatchObject({ action: "notebook_300", integration: id });
      const clicked = await service.sendAsk(task.taskId, ask?.id ?? "");
      expect(clicked.outcome).toEqual({ kind: "ran" });
      expect(clicked.answer).toContain(`notebook_300: 1. ${SAMPLE_NOTES[0]}`);
      const resource = await service.call(
        task,
        "Notebooks",
        "read_resource",
        { uri: NOTES_URI },
        "Read all notes.",
      );
      expect(resource.text).toContain("The app raised its approval card");
      const resourceAsk = tasks
        .get(task.taskId)
        ?.delivery?.writeAsks?.find(
          (kept) => kept.kind === "integration" && kept.action === "read_resource",
        );
      const read = await service.sendAsk(task.taskId, resourceAsk?.id ?? "");
      expect(read.outcome).toEqual({ kind: "ran" });
      expect(read.answer).toContain(SAMPLE_NOTES[0]);
      console.info(
        JSON.stringify({
          era,
          largeAtAdd,
          actions: row?.actions.length,
          lastAction: ask?.kind === "integration" ? ask.action : undefined,
          outcome: clicked.outcome,
          answer: clicked.answer,
          existingRules: row?.actions.filter((action) =>
            ["get_note", "list_notes"].includes(action.name),
          ),
          resourceOutcome: read.outcome,
        }),
      );
    },
  );
});

// INF-3984, from INF-785 (the captain: "secrets used to access the external
// data should be handled by the planned secret management capability"): a
// server's key moves into Secrets and its line keeps only a reference; the
// program still gets it as it starts. The captain on INF-3984's review: "when
// a user puts a value into the mcp server config, that's their consent for it
// to be used whenever the mcp server is needed", so no start asks; and PATH
// stays on the line, since it decides which program runs.
describe("an MCP server's key", () => {
  /** A key a notes service might hand out, which the stand-in server checks. */
  const KEY = "nk_live_4Fq9sT2vXw8LmC3pRb7Y";

  /** A keyed notes book, and the program that serves it as a person writes it. */
  function keyedNotes(root: string, era: StandInEra): string {
    const file = join(root, "notes.json");
    publishNotes(file, { notes: [...SAMPLE_NOTES], key: KEY });
    return `'${process.execPath}' '${STAND_IN}' stdio ${era} '${file}'`;
  }

  describe.each(["legacy", "modern"] as const)("in the %s era", (era) => {
    it("goes into Secrets as the server is added, and reaches its program at each start with no question", async () => {
      const root = scratchDir("mcp-keys-");
      const secrets = integrationKeys();
      const { service, close } = serviceIn(root, secrets.keys);
      opened.push({ service, close });
      const program = keyedNotes(root, era);

      const { id } = await service.add("mcp", {
        name: "Notes",
        runs: `${NOTES_KEY_VARIABLE}=${KEY} ${program}`,
      });
      const [entry, ...others] = await secrets.entries();
      expect(others).toEqual([]);
      expect(entry).toMatchObject({
        label: `Notes: ${NOTES_KEY_VARIABLE}`,
        discoverable: false,
        forProgram: true,
      });
      const row = () => service.view().integrations.find((one) => one.id === id);
      expect(row()).toMatchObject({
        health: "ok",
        runs: `${NOTES_KEY_VARIABLE}={secret:${entry?.ref}} ${program}`,
      });
      expect(readFileSync(join(root, "mcp.json"), "utf8")).not.toContain(KEY);

      await service.check(id);
      expect(row()?.health).toBe("ok");
      allowIntegrationReads(service);
      const listed = await service.call(task, "Notes", "list_notes", {}, "Read the notes.");
      expect(listed.text).toContain(`1. ${SAMPLE_NOTES[0]}`);
      expect(secrets.cards).toEqual([]);
      const { rules, history } = await secrets.keys.view();
      expect(rules).toEqual([]);
      // What happened marks each start as covered by the key given with it.
      expect(history.length).toBeGreaterThanOrEqual(2);
      for (const use of history)
        expect(use).toMatchObject({ state: "completed", given: true, secrets: [entry?.ref] });

      await service.remove(id);
      expect(await secrets.entries()).toEqual([]);
    });
  });

  // INF-3984's review: every value on a line moves, not only the first.
  it("moves with every other value on its line, the last word for a name written twice", async () => {
    const root = scratchDir("mcp-keys-");
    const secrets = integrationKeys();
    const { service, close } = serviceIn(root, secrets.keys);
    opened.push({ service, close });
    const program = keyedNotes(root, "modern");
    // An expired key the person wrote over later in the line, as a shell reads it.
    const expired = "nk_live_9Rt2Lp8Vx4Qm1Kc7Wb3D";

    const { id } = await service.add("mcp", {
      name: "Notes",
      runs: `${NOTES_KEY_VARIABLE}=${expired} NOTES_ACCOUNT=acct_6Rw1Hn9Tb4Kx ${NOTES_KEY_VARIABLE}=${KEY} ${program}`,
    });
    const entries = await secrets.entries();
    const refOf = (variable: string) =>
      entries.find((entry) => entry.label === `Notes: ${variable}`)?.ref;
    expect(entries.map((entry) => entry.label).sort()).toEqual([
      "Notes: NOTES_ACCOUNT",
      `Notes: ${NOTES_KEY_VARIABLE}`,
    ]);
    const line = `NOTES_ACCOUNT={secret:${refOf("NOTES_ACCOUNT")}} ${NOTES_KEY_VARIABLE}={secret:${refOf(NOTES_KEY_VARIABLE)}} ${program}`;
    // Connected only if the program got the later key: the stand-in refuses the expired one.
    expect(service.view().integrations.find((one) => one.id === id)).toMatchObject({
      health: "ok",
      runs: line,
    });
    const saved = readFileSync(join(root, "mcp.json"), "utf8");
    expect(JSON.parse(saved).servers[0].runs).toBe(line);
    for (const value of [KEY, expired, "acct_6Rw1Hn9Tb4Kx"]) expect(saved).not.toContain(value);
    expect(secrets.cards).toEqual([]);
  });

  // The captain on INF-3984's review: "Keep PATH on the line as a setting that never moves".
  it("leaves PATH on the line, where the program is found and runs with it", async () => {
    const root = scratchDir("mcp-keys-");
    const secrets = integrationKeys();
    const { service, close } = serviceIn(root, secrets.keys);
    opened.push({ service, close });
    // A server a package runner starts, found only on the PATH the line names.
    const book = join(root, "notes.json");
    publishNotes(book, { notes: [...SAMPLE_NOTES], key: KEY });
    const tools = scratchDir("mcp-path-");
    writeFileSync(
      join(tools, "npx"),
      `#!/bin/sh\n[ "$1" = -y ] && [ "$2" = notes-server ] || exit 1\nexec '${process.execPath}' '${STAND_IN}' stdio modern '${book}'\n`,
      { mode: 0o755 },
    );
    const path = `PATH=${tools}:/usr/bin:/bin`;

    const { id } = await service.add("mcp", {
      name: "Notes",
      runs: `${path} ${NOTES_KEY_VARIABLE}=${KEY} npx -y notes-server`,
    });
    const [entry, ...others] = await secrets.entries();
    expect(others).toEqual([]);
    expect(entry?.label).toBe(`Notes: ${NOTES_KEY_VARIABLE}`);
    const line = `${path} ${NOTES_KEY_VARIABLE}={secret:${entry?.ref}} npx -y notes-server`;
    expect(service.view().integrations.find((one) => one.id === id)).toMatchObject({
      health: "ok",
      runs: line,
    });
    expect(JSON.parse(readFileSync(join(root, "mcp.json"), "utf8")).servers[0].runs).toBe(line);
    await service.check(id);
    expect(service.view().integrations.find((one) => one.id === id)?.health).toBe("ok");
  });

  // A line names only keys kept for its own server, so a typed reference to
  // another server's key never reaches a program with no question.
  it("is never named by another server's line", async () => {
    const root = scratchDir("mcp-keys-");
    const secrets = integrationKeys();
    const { service, close } = serviceIn(root, secrets.keys);
    opened.push({ service, close });
    const program = keyedNotes(root, "modern");
    await service.add("mcp", { name: "Notes", runs: `${NOTES_KEY_VARIABLE}=${KEY} ${program}` });
    const [entry] = await secrets.entries();

    await expect(
      service.add("mcp", {
        name: "Copy",
        runs: `${NOTES_KEY_VARIABLE}={secret:${entry?.ref}} ${program}`,
      }),
    ).rejects.toThrow(
      "Runs names a key kept in Secrets: write the key itself, and Infinitary keeps it in Secrets for this server.",
    );
    expect(service.view().integrations.map((one) => one.name)).toEqual(["Notes"]);
    expect((await secrets.keys.view()).history.map((use) => use.secrets)).toEqual([[entry?.ref]]);
  });

  it("moves from an earlier version's line into Secrets once", async () => {
    const root = scratchDir("mcp-keys-");
    const program = keyedNotes(root, "modern");
    new McpServerStore(root).write([
      {
        id: "mcp-notes",
        name: "Notes",
        runs: `${NOTES_KEY_VARIABLE}=${KEY} ${program}`,
        health: "ok",
        tools: [],
        resources: [],
        subscribe: false,
      },
    ]);
    const secrets = integrationKeys();
    // An addition the app quit during kept its key before its line was saved.
    await secrets.keys.keepHidden({
      label: "Notes: NOTES_KEY",
      value: Buffer.from(KEY),
      forProgram: true,
    });
    const { service, binding, close } = serviceIn(root, secrets.keys);
    opened.push({ service, close });

    await binding.moveKeys();
    await binding.moveKeys();
    const [entry, ...others] = await secrets.entries();
    expect(others).toEqual([]);
    expect(entry).toMatchObject({ discoverable: false, forProgram: true });
    expect(service.view().integrations[0]?.runs).toBe(
      `${NOTES_KEY_VARIABLE}={secret:${entry?.ref}} ${program}`,
    );
    expect(readFileSync(join(root, "mcp.json"), "utf8")).not.toContain(KEY);

    await service.check("mcp-notes");
    expect(service.view().integrations[0]?.health).toBe("ok");
    expect(secrets.cards).toEqual([]);
  });

  // INF-3984's review: a list the app cannot read whole never makes a key
  // look unused, or switching back to an older build would forget them all.
  it("is kept at launch while the saved list cannot be read whole", async () => {
    const root = scratchDir("mcp-keys-");
    const program = keyedNotes(root, "modern");
    const secrets = integrationKeys();
    const ref = await secrets.keys.keepHidden({
      label: "Notes: NOTES_KEY",
      value: Buffer.from(KEY),
      forProgram: true,
    });
    const saved = {
      id: "mcp-notes",
      name: "Notes",
      runs: `${NOTES_KEY_VARIABLE}={secret:${ref}} ${program}`,
      health: "ok",
      tools: [],
      resources: [],
      subscribe: false,
    };
    const files = {
      "a newer build's file, saving a field this build does not know": JSON.stringify({
        servers: [{ ...saved, folder: root }],
      }),
      "a file cut short": JSON.stringify({ servers: [saved] }).slice(0, 80),
      "a line left with an open quote": JSON.stringify({
        servers: [{ ...saved, runs: `${saved.runs} '--notes` }],
      }),
    };
    for (const [kind, text] of Object.entries(files)) {
      writeFileSync(join(root, "mcp.json"), text);
      const { binding, close } = serviceIn(root, secrets.keys);
      // The review of INF-5409: a file that cannot be read whole may hold servers, so it counts as set up.
      expect(binding.saved?.(), kind).toBe(true);
      await binding.moveKeys();
      close();
      expect(await secrets.entries(), kind).toMatchObject([{ ref, forProgram: true }]);
    }
  });

  it("stays on the line where Secrets is not offered, and a reference cannot start there", async () => {
    const root = scratchDir("mcp-keys-");
    const program = keyedNotes(root, "modern");
    // A line saved where Secrets is offered, in a data folder brought here.
    new McpServerStore(root).write([
      {
        id: "mcp-kept-notes",
        name: "Kept notes",
        runs: `${NOTES_KEY_VARIABLE}={secret:kept-notes-key} ${program}`,
        health: "ok",
        tools: [
          { tool: "list_notes", action: "list_notes", readOnly: true, schema: { type: "object" } },
        ],
        resources: [],
        subscribe: false,
      },
    ]);
    const { service, close } = serviceIn(root);
    opened.push({ service, close });
    const runs = `${NOTES_KEY_VARIABLE}=${KEY} ${program}`;
    const { id } = await service.add("mcp", { name: "Notes", runs });
    expect(service.view().integrations.find((one) => one.id === id)).toMatchObject({
      runs,
      health: "ok",
    });
    allowIntegrationReads(service);
    const refused = await service.call(task, "Kept notes", "list_notes", {}, "Read the notes.");
    expect(refused.text).toContain(
      "Kept notes keeps its keys in Secrets, which this computer does not offer, so it cannot start here.",
    );
  });
});
