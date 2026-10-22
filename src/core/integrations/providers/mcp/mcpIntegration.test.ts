import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
import { openInMemoryDatabase } from "../../../storage/db";
import { seedTask } from "../../../tasks/seedTask";
import { TaskService } from "../../../tasks/taskService";
import { atUtilityQos } from "../../../utilityQos";
import { FileIntegrationSecrets, IntegrationSettingsStore, IntegrationsService } from "../../index";
import { mcpIntegration } from "./mcpIntegration";

/**
 * MCP servers as integrations (INF-781; INF-775 piece 2, whose checks name
 * "unit tests against a scripted server over stdio and HTTP for both
 * protocol eras"): a stand-in notes server is added the way Settings adds
 * one, through the integrations service, in each era over each transport.
 * The captain's q7 - trust the server's list and show it after - is the
 * row that comes back; his q5 - a read runs, a change asks - is the calls,
 * a change kept on the task as an ask that his click runs once.
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
      { name: "list_notes", effect: "reads", rule: "allow" },
      { name: "get_note", effect: "reads", rule: "allow" },
      { name: "add_note", effect: "changes", rule: "ask" },
      { name: "read_resource", effect: "reads", rule: "allow" },
    ]);
    expect(row?.events).toEqual([
      { name: "resource_changed", label: "A resource changed", every: 1 },
    ]);
    // The first mate and the crew never read what it runs.
    expect(JSON.stringify(service.roster())).not.toContain(served.runs);
    expect(JSON.stringify(service.show("Notes"))).not.toContain(served.runs);

    const listed = await service.call(task, "Notes", "list_notes", {});
    expect(listed.refused).toBeUndefined();
    expect(listed.text).toContain(`1. ${SAMPLE_NOTES[0]}`);
    const one = await service.call(task, "notes", "get_note", { id: 2 });
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
    const read = await service.call(task, "Notes", "read_resource", { uri: NOTES_URI });
    expect(read.text).toContain("4. Return the library books by Friday");

    // A server started again cannot say what changed while it was down.
    await service.check(id);
    expect((await service.look(id, "resource_changed", start.cursor)).resynced).toBe(true);

    // A change is kept on the task, and runs once on the captain's click.
    const change = await service.call(task, "Notes", "add_note", { text: "Pay the electric bill" });
    expect(change.text).toContain("Kept as ask");
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
