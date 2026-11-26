import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ForgeSignInState } from "@shared/forges";
import { undeclaredIntegrationMessage } from "@shared/personal/manifest";
import type { IntegrationAllowance, IntegrationAsk } from "@shared/writeAsk";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { integrationNameSchema } from "../../shared/integrations";
import { githubIntegration, IntegrationSettingsStore, IntegrationsService, PanelAsks } from ".";
import { APP_EVENTS, TASK_CLOSED_EVENT, TASK_EVENTS_ID, TASK_RELEASED_EVENT } from "./appEvents";
import type { IntegrationActionSpec, IntegrationBinding } from "./binding";
import { IntegrationOutcomeUnknown } from "./binding";
import { OLDER_BUILD_OFF_MAX } from "./store";

/**
 * INF-775 piece 1: Settings -> Integrations and the first mate's
 * `app_change` lines change one record through `IntegrationsService`, and
 * what they set holds for every caller and across a restart. GitHub's row
 * is the github.com sign-in the forge keeps; the gateway is never reached
 * here, so its calls refuse loudly.
 */

function github(signIns: Map<string, { state: ForgeSignInState; login: string | null }>) {
  const unreached = async (): Promise<string> => {
    throw new Error("the gateway is not reached in this test");
  };
  return githubIntegration({
    signIns: {
      stateOf: (host) => signIns.get(host)?.state,
      loginOf: (host) => signIns.get(host)?.login ?? null,
      checkNow: async () => {},
      signOut: (host) => {
        signIns.delete(host);
      },
    },
    gateway: { read: unreached, write: unreached, readAsSeat: unreached, writeAsSeat: unreached },
  });
}

// INF-882: these rows have the same id/name shapes as the notes server in
// the reproduced Settings clash. The transport owns actions elsewhere;
// this fixture exercises only the service's names and saved settings.
function mcpNames(names: { id: string; name: string }[]): IntegrationBinding {
  return {
    kind: "mcp",
    many: true,
    connections: () => names.map((row) => ({ ...row, account: null, health: "ok", actions: [] })),
    add: vi.fn(async () => {
      throw new Error("a reserved name must never reach the server");
    }),
    check: async () => {},
    remove: () => {},
    call: async () => {
      throw new Error("names do not call the transport");
    },
  };
}

describe("GitHub names stay with the GitHub connection (INF-882)", () => {
  function fixture(names: { id: string; name: string }[]) {
    const signIns = new Map<string, { state: ForgeSignInState; login: string | null }>();
    const dir = join(scratchDir("fm-integration-names-"), "integrations");
    const store = new IntegrationSettingsStore(dir);
    const mcp = mcpNames(names);
    const open = () =>
      new IntegrationsService({
        bindings: [github(signIns), mcp],
        store,
      });
    return { signIns, store, mcp, open };
  }

  it("reserves GitHub while signed out and checks renames and default-name resets too", async () => {
    const { open, mcp, store } = fixture([{ id: "mcp-github", name: "GitHub" }]);
    store.write({ "mcp-github": { name: "Notes" } });
    const service = open();
    await expect(service.add("mcp", { name: " gItHuB " })).rejects.toThrow(/even while signed out/);
    expect(mcp.add).not.toHaveBeenCalled();
    for (const name of [null, "GitHub", " GITHUB "])
      expect(() => service.configure("mcp-github", { name })).toThrow(/even while signed out/);
    expect(service.show("github")).toMatchObject({ refused: "invalid" });
    expect(service.show("Notes")).toMatchObject({ id: "mcp-github" });
  });

  it("repairs old clashes before discovery, preserves settings and remembers the explanation after restart", () => {
    const { open, signIns, store } = fixture([
      { id: "mcp-github", name: "GitHub" },
      { id: "mcp-notes", name: "GitHub MCP server" },
      { id: "github-mcp-server-2", name: "GitHub MCP server 2" },
    ]);
    store.write({ "mcp-github": { paused: true, off: ["add_note"] } });
    const service = open();
    expect(service.rosterLine()).toContain("GitHub MCP server 3 (paused, Renamed from “GitHub”");
    signIns.set("github.com", { state: "ok", login: "octo" });
    expect(service.changed().integrations.map((row) => row.name)).toEqual([
      "GitHub",
      "GitHub MCP server 3",
      "GitHub MCP server",
      "GitHub MCP server 2",
    ]);
    expect(service.show("GitHub")).toMatchObject({ id: "github" });
    expect(service.show("GitHub MCP server 3")).toMatchObject({ id: "mcp-github" });
    expect(store.read()["mcp-github"]).toEqual({
      name: "GitHub MCP server 3",
      paused: true,
      off: ["add_note"],
      renamed: { from: "GitHub", for: "GitHub" },
    });
    // INF-882 must not make an older app's strict settings reader drop the
    // paused state and disabled actions: the explanation has its own file.
    expect(JSON.parse(readFileSync(join(store.root, "settings.json"), "utf8"))).toEqual({
      "mcp-github": { name: "GitHub MCP server 3", paused: true, off: ["add_note"] },
    });
    const restarted = open();
    expect(restarted.view()).toEqual(service.view());
    expect(restarted.roster()).toContainEqual(
      expect.objectContaining({
        id: "mcp-github",
        name: "GitHub MCP server 3",
        renamed: { from: "GitHub", for: "GitHub" },
      }),
    );
    restarted.configure("mcp-github", { name: "Notes" });
    expect(restarted.show("Notes")).not.toHaveProperty("renamed");
    expect(store.read()["mcp-github"]).toEqual({ name: "Notes", paused: true, off: ["add_note"] });
  });

  it("ignores stale or unreadable explanations without losing any saved settings", () => {
    const { open, store } = fixture([{ id: "mcp-github", name: "GitHub" }]);
    store.write({
      "mcp-github": {
        name: "GitHub MCP server",
        paused: true,
        off: ["add_note"],
        renamed: { from: "GitHub", for: "GitHub" },
      },
    });
    // An older app changes the name in the shape it owns, leaving the new file alone.
    writeFileSync(
      join(store.root, "settings.json"),
      JSON.stringify({
        "mcp-github": {
          name: "Notes",
          paused: true,
          off: ["add_note"],
        },
      }),
    );
    expect(open().view().integrations[0]).toMatchObject({ name: "Notes", paused: true });
    expect(open().view().integrations[0]).not.toHaveProperty("renamed");
    writeFileSync(join(store.root, "name-repairs.json"), "interrupted write");
    expect(store.read()["mcp-github"]).toEqual({ name: "Notes", paused: true, off: ["add_note"] });
  });

  it("repairs a saved GitHub name's case-insensitive clash on the first signed-in read", async () => {
    const { open, signIns, store, mcp } = fixture([{ id: "mcp-work", name: "work github" }]);
    store.write({ github: { name: "Work GitHub" } });
    signIns.set("github.com", { state: "ok", login: "octo" });
    const service = open();
    expect(service.view().integrations.map((row) => row.name)).toEqual([
      "Work GitHub",
      "work github MCP server",
    ]);
    expect(service.show("WORK GITHUB")).toMatchObject({ id: "github" });
    expect(service.show("github")).toMatchObject({ id: "github" });
    signIns.clear();
    await expect(service.add("mcp", { name: "Work GitHub" })).rejects.toThrow(
      /even while signed out/,
    );
    expect(mcp.add).not.toHaveBeenCalled();
    expect(service.show("work github MCP server")).toMatchObject({ id: "mcp-work" });
  });

  it("fits repaired names within the published name size and skips occupied candidates", () => {
    const name = integrationNameSchema.parse(
      "GitHub for documentation and application development projects",
    );
    const { open, store, signIns } = fixture([{ id: "mcp-work", name }]);
    store.write({ github: { name } });
    signIns.set("github.com", { state: "ok", login: "octo" });
    const view = open().view();
    const repaired = view.integrations.find((row) => row.id === "mcp-work");
    if (!repaired) throw new Error("the existing server must remain connected");
    expect(integrationNameSchema.safeParse(repaired.name).success).toBe(true);
    expect(repaired.name).not.toBe(name);
    expect(new Set(view.integrations.map((row) => row.name.toLowerCase())).size).toBe(
      view.integrations.length,
    );
    expect(open().view()).toEqual(view);
  });
});

describe("IntegrationsService", () => {
  // The app's own events every view carries (`APP_EVENTS`), as Settings reads them.
  const APP_EVENTS_VIEW = APP_EVENTS.map((source) => ({
    id: source.id,
    name: source.name,
    events: source.events.map((spec) => ({
      name: spec.name,
      label: spec.label,
      every: spec.every,
      ...(spec.filters
        ? { filters: spec.filters.map((field) => ({ name: field.name, label: field.label })) }
        : {}),
    })),
  }));

  it("draws GitHub from the github.com sign-in, and keeps its settings across a restart until it is removed", async () => {
    const signIns = new Map([["github.com", { state: "ok" as const, login: "octo" }]]);
    const dir = join(scratchDir("fm-integrations-"), "integrations");
    const open = () =>
      new IntegrationsService({
        bindings: [github(signIns)],
        store: new IntegrationSettingsStore(dir),
      });

    const first = open();
    expect(first.view()).toEqual({
      integrations: [
        {
          id: "github",
          kind: "github",
          name: "GitHub",
          account: "octo",
          health: "ok",
          paused: false,
          actions: [
            {
              name: "read",
              label: "Read from GitHub",
              effect: "reads",
              enabled: true,
              rule: "ask",
            },
            {
              name: "write",
              label: "Change something on GitHub",
              effect: "changes",
              enabled: true,
              rule: "ask",
            },
          ],
        },
      ],
      addable: [],
      appEvents: APP_EVENTS_VIEW,
    });
    expect(first.rosterLine()).toBe("GitHub (signed in as octo)");

    first.configure("github", { name: "Work GitHub", paused: true, actions: { write: false } });
    expect(() => first.configure("github", { actions: { merge: false } })).toThrow(
      /no action merge/,
    );

    const restarted = open();
    const [row] = restarted.view().integrations;
    expect(row).toMatchObject({ name: "Work GitHub", paused: true });
    expect(row?.actions.map((action) => action.rule)).toEqual(["ask", "never"]);
    expect(
      await restarted.forTask("task-1").call("Work GitHub", "read", { path: "/user" }),
    ).toEqual({
      text: "Work GitHub is paused. The captain resumes it in Settings → Integrations.",
      refused: "refused",
    });

    await restarted.remove("github");
    expect(signIns.has("github.com")).toBe(false);
    expect(restarted.view()).toEqual({
      integrations: [],
      addable: [{ kind: "github", name: "GitHub" }],
      appEvents: APP_EVENTS_VIEW,
    });
    expect(restarted.rosterLine()).toBeUndefined();
    // Signing in again starts from the kind's defaults, not the removed row's.
    signIns.set("github.com", { state: "ok", login: "octo" });
    expect(open().view().integrations[0]).toMatchObject({ name: "GitHub", paused: false });
  });
  it("lists the app's own task events beside the integrations, and keeps their name", () => {
    // The captain's answer on the put-off review: declare "A task closes" in
    // the integrations listing, so Settings → Automation and the agents'
    // integrations tool read and name it, its Task field with it. The approved
    // side-effect-task plan adds "Work ships in a release" beside it.
    const dir = join(scratchDir("fm-integrations-"), "integrations");
    const service = new IntegrationsService({
      bindings: [mcpNames([{ id: "mcp-notes", name: "Notes" }])],
      store: new IntegrationSettingsStore(dir),
    });
    expect(service.view().appEvents).toEqual([
      {
        id: TASK_EVENTS_ID,
        name: "Tasks",
        events: [
          {
            name: TASK_CLOSED_EVENT.name,
            label: "A task closes",
            every: 1,
            filters: [{ name: "task", label: "Task" }],
          },
          {
            name: TASK_RELEASED_EVENT.name,
            label: "Work ships in a release",
            every: 1,
            filters: [{ name: "task", label: "Task" }],
          },
        ],
      },
    ]);
    expect(service.roster()).toContainEqual({
      name: "Tasks",
      id: TASK_EVENTS_ID,
      kind: "app",
      events: [TASK_CLOSED_EVENT.name, TASK_RELEASED_EVENT.name],
    });
    expect(service.show("tasks")).toMatchObject({
      integration: "Tasks",
      actions: [],
      events: [
        expect.objectContaining({
          label: "A task closes",
          listen: expect.stringContaining(`"${TASK_EVENTS_ID}/${TASK_CLOSED_EVENT.name}"`),
        }),
        expect.objectContaining({
          label: "Work ships in a release",
          listen: expect.stringContaining(`"${TASK_EVENTS_ID}/${TASK_RELEASED_EVENT.name}"`),
        }),
      ],
    });
    expect(() => service.configure("mcp-notes", { name: "Tasks" })).toThrow(
      "Tasks names the app's own Tasks events. Choose another name.",
    );
  });
});

/**
 * INF-946 piece 2, approved: one owner for integration names. Every way a
 * name arrives - an addition, a sign-in, a rename, a reset to the default
 * name, an older version's saved rows - runs the same check, and a name an
 * overlapping addition or sign-in waits on is held until it ends (INF-948).
 */
describe("One owner for integration names (INF-946)", () => {
  /** MCP servers whose additions wait until the test lets each one finish. */
  function servers(saved: { id: string; name: string }[]) {
    const rows = [...saved];
    const waiting: (() => void)[] = [];
    const binding: IntegrationBinding = {
      kind: "mcp",
      many: true,
      connections: () => rows.map((row) => ({ ...row, account: null, health: "ok", actions: [] })),
      add: async (input, claim) => {
        const { name } = input as { name: string };
        const base = `mcp-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
        let id = base;
        for (let count = 2; rows.some((row) => row.id === id) || !claim?.(id); count++)
          id = `${base}-${count}`;
        await new Promise<void>((resolve) => waiting.push(resolve));
        rows.push({ id, name });
        return id;
      },
      check: async () => {},
      remove: (id) => {
        rows.splice(
          rows.findIndex((row) => row.id === id),
          1,
        );
      },
      call: async (id) => ({ text: `answered by ${id}` }),
    };
    const finish = () => waiting.shift()?.();
    return { binding, finish };
  }

  /** A kind signed in to in the browser that declares no identity, waiting until the test answers. */
  function browserKind() {
    let signedIn = false;
    let answer: (() => void) | undefined;
    const binding: IntegrationBinding = {
      kind: "stand-in",
      connections: () =>
        signedIn ? [{ id: "stand-in", account: "ada", health: "ok", actions: [] }] : [],
      signIn: (signal) =>
        new Promise<string>((resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("ended")));
          answer = () => {
            signedIn = true;
            resolve("stand-in");
          };
        }),
      check: async () => {},
      remove: () => {
        signedIn = false;
      },
      call: async () => ({ text: "stand-in answered" }),
    };
    return { binding, answer: () => answer?.() };
  }

  function open(bindings: IntegrationBinding[]) {
    const dir = join(scratchDir("fm-integration-owner-"), "integrations");
    const store = new IntegrationSettingsStore(dir);
    const service = () =>
      new IntegrationsService({
        bindings,
        store,
      });
    return { store, service };
  }

  it("holds a name and its id while an addition waits, and lets them go when it ends", async () => {
    const mcp = servers([]);
    const { service } = open([mcp.binding]);
    const integrations = service();
    const first = integrations.add("mcp", { name: "Studio notes" });
    await expect(integrations.add("mcp", { name: " studio NOTES " })).rejects.toThrow(
      "An integration named studio NOTES is being added. Choose another name.",
    );
    const second = integrations.add("mcp", { name: "Studio-notes" });
    mcp.finish();
    mcp.finish();
    expect((await first).id).toBe("mcp-studio-notes");
    expect((await second).id).toBe("mcp-studio-notes-2");
    expect(integrations.view().integrations.map((row) => [row.id, row.name])).toEqual([
      ["mcp-studio-notes", "Studio notes"],
      ["mcp-studio-notes-2", "Studio-notes"],
    ]);
    // No name can take another row's id either.
    expect(() =>
      integrations.configure("mcp-studio-notes", { name: "MCP-studio-notes-2" }),
    ).toThrow("An integration is already named Studio-notes. Choose another name.");
  });

  it("holds the name a sign-in will take until it comes back or is cancelled", async () => {
    const mcp = servers([]);
    const browser = browserKind();
    const { service } = open([browser.binding, mcp.binding]);
    const integrations = service();
    const signingIn = integrations.signIn("stand-in");
    await expect(integrations.add("mcp", { name: "Stand-in" })).rejects.toThrow(
      "An integration named Stand-in is being added. Choose another name.",
    );
    integrations.cancelSignIn();
    await expect(signingIn).rejects.toThrow("The sign-in was cancelled.");
    const added = integrations.add("mcp", { name: "Stand-in" });
    await expect(integrations.signIn("stand-in")).rejects.toThrow(
      "An integration named Stand-in is being added, so Stand-in cannot be added beside it until that ends. Then sign in to Stand-in again.",
    );
    mcp.finish();
    await added;
    const again = integrations.signIn("stand-in");
    browser.answer();
    await expect(again).rejects.toThrow(
      "The MCP server named Stand-in already uses that name, so Stand-in cannot be added beside it.",
    );
  });

  it("checks a reset to a server's own default name like any rename (INF-938)", () => {
    const mcp = servers([
      { id: "mcp-notes", name: "Notes" },
      { id: "mcp-drafts", name: "Drafts" },
    ]);
    const { service } = open([mcp.binding]);
    const integrations = service();
    integrations.configure("mcp-notes", { name: "Work" });
    integrations.configure("mcp-drafts", { name: "Notes" });
    expect(() => integrations.configure("mcp-notes", { name: null })).toThrow(
      "An integration is already named Notes. Choose another name.",
    );
    expect(integrations.show("Notes")).toMatchObject({ id: "mcp-drafts" });
    expect(integrations.show("Work")).toMatchObject({ id: "mcp-notes" });
  });

  it("gives every existing row of a shared name or another's id a distinct name, whatever order the place lists them in", () => {
    const saved = [
      { id: "mcp-notes-2", name: "Notes" },
      { id: "mcp-tasks", name: "mcp-notes" },
      { id: "mcp-notes", name: "notes" },
      { id: "mcp-drafts", name: "Drafts" },
    ];
    const { service, store } = open([servers(saved).binding]);
    store.write({ "mcp-notes-2": { paused: true, off: ["add_note"] } });
    const names = (bindings: IntegrationBinding[]) =>
      new IntegrationsService({
        bindings,
        store: new IntegrationSettingsStore(join(scratchDir("fm-integration-order-"), "i")),
      })
        .view()
        .integrations.map((row) => [row.id, row.name])
        .sort();
    const view = service().view();
    expect(view.integrations.map((row) => [row.id, row.name, row.renamed])).toEqual([
      ["mcp-notes-2", "Notes (mcp-notes-2)", { from: "Notes", for: "notes" }],
      ["mcp-tasks", "mcp-notes (mcp-tasks)", { from: "mcp-notes", for: "notes" }],
      ["mcp-notes", "notes", undefined],
      ["mcp-drafts", "Drafts", undefined],
    ]);
    expect(store.read()["mcp-notes-2"]).toMatchObject({ paused: true, off: ["add_note"] });
    expect(names([servers([...saved].reverse()).binding])).toEqual(
      view.integrations.map((row) => [row.id, row.name]).sort(),
    );
    expect(service().view()).toEqual(view);
  });

  it("gives discovery each connection's reference, which reaches only that connection", async () => {
    const mcp = servers([{ id: "mcp-notes", name: "Notes" }]);
    const { service } = open([mcp.binding]);
    const integrations = service();
    const [listed] = integrations.roster();
    const connection = String(listed?.connection);
    expect(connection).toMatch(/^c-/);
    expect(integrations.show(connection)).toMatchObject({ id: "mcp-notes", connection });
    expect(await integrations.call({ kind: "firstmate" }, connection, "missing", {})).toMatchObject(
      { refused: "invalid", text: expect.stringContaining("Notes has no action") },
    );
    expect(() => integrations.configure("mcp-notes", { name: connection })).toThrow(
      "reads as a connection's reference",
    );
    // Removed and added again under the same name and id, it is another connection.
    await integrations.remove("mcp-notes");
    const added = integrations.add("mcp", { name: "Notes" });
    mcp.finish();
    expect((await added).id).toBe("mcp-notes");
    expect(integrations.show(connection)).toEqual({
      text: `No integration is connection ${connection} now: it was removed or replaced. List the integrations again and use one's connection or name.`,
      refused: "invalid",
    });
    expect(integrations.show("Notes")).toMatchObject({ id: "mcp-notes" });
    expect(integrations.show("Notes")).not.toMatchObject({ connection });
  });
});

// INF-950's approved model: the service owns the rule, not the action's effect.
describe("per-action approval (INF-950)", () => {
  function fixture() {
    const dir = scratchDir("infinitary-action-approvals-");
    const store = new IntegrationSettingsStore(dir);
    const notes = ["Call the dentist to move Thursday's cleaning"];
    const actions = [
      {
        name: "list_notes",
        label: "List notes",
        effect: "reads" as const,
        description: "Lists every note with its number.",
        input: z.strictObject({}),
      },
      {
        name: "add_note",
        label: "Add a note",
        effect: "changes" as const,
        description: "Adds a note to the end of the list.",
        input: z.strictObject({ text: z.string() }),
      },
    ];
    let account = "sam";
    const binding: IntegrationBinding = {
      kind: "mcp",
      connections: () => [{ id: "mcp-notes", name: "Notes", account, health: "ok", actions }],
      check: async () => {},
      remove: () => {},
      call: vi.fn(async (_id, action, input) => {
        if (action === "add_note") notes.push((input as { text: string }).text);
        return { text: notes.join("\n") };
      }),
    };
    const kept = new Map<string, IntegrationAsk>();
    const present = vi.fn();
    const open = () =>
      new IntegrationsService({
        bindings: [binding],
        store,
        asks: {
          keep: (_taskId, ask) => {
            kept.set(ask.id, ask);
          },
          present,
          take: (_taskId, id) => {
            const ask = kept.get(id);
            if (!ask || ask.sentAt !== undefined) return { refused: "already taken or absent" };
            ask.sentAt = Date.now();
            return { ask };
          },
          record: (_taskId, id, outcome) => {
            const ask = kept.get(id);
            if (ask) ask.outcome = outcome;
          },
        },
      });
    const latest = () => [...kept.values()].at(-1)!;
    return {
      open,
      options: {
        bindings: [binding],
        store,
      },
      asks: {
        keep: (_taskId: string, ask: IntegrationAsk) => {
          kept.set(ask.id, ask);
        },
        present,
        take: () => ({ refused: "not taken here" }),
        record: () => {},
      },
      store,
      binding,
      actions,
      notes,
      latest,
      present,
      account: (value: string) => {
        account = value;
      },
    };
  }

  it("asks for reads and outward calls, requires a reason, and only the exact once or always choice runs it", async () => {
    const f = fixture();
    const service = f.open();
    const crew = service.forTask("task-1");
    expect(service.view().integrations[0]?.actions.map((a) => a.rule)).toEqual(["ask", "ask"]);
    expect((await crew.call("Notes", "list_notes", {})).refused).toBe("invalid");
    expect(f.present).not.toHaveBeenCalled();
    expect(f.binding.call).not.toHaveBeenCalled();
    const reason = "Find the dentist reminder for the week.";
    await crew.call("Notes", "list_notes", {}, undefined, reason);
    expect(f.present).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({ reason, input: "{}", effect: "reads" }),
      [],
    );
    expect((await service.sendAsk("task-1", f.latest().id, "once")).answer).toContain("dentist");
    expect(service.view().integrations[0]?.actions[0]?.rule).toBe("ask");
    expect((await service.sendAsk("task-1", f.latest().id)).ok).toBe(false);
    expect(f.binding.call).toHaveBeenCalledTimes(1);
    await crew.call("Notes", "list_notes", {}, undefined, reason);
    await service.sendAsk("task-1", f.latest().id, "always");
    expect((await f.open().forTask("another-task").call("Notes", "list_notes", {})).text).toContain(
      "dentist",
    );
    expect(f.binding.call).toHaveBeenCalledTimes(3);
    await crew.call(
      "Notes",
      "add_note",
      { text: "Return the library books by Friday" },
      undefined,
      "Keep the reminder I requested.",
    );
    await service.sendAsk("task-1", f.latest().id, "deny");
    expect(f.notes).toHaveLength(1);
    await crew.call(
      "Notes",
      "add_note",
      { text: "Return the library books by Friday" },
      undefined,
      "Keep the reminder I requested.",
    );
    await service.sendAsk("task-1", f.latest().id, "always");
    await crew.call("Notes", "add_note", { text: "Pay the electric bill" });
    expect(f.notes).toEqual([
      "Call the dentist to move Thursday's cleaning",
      "Return the library books by Friday",
      "Pay the electric bill",
    ]);
    service.setRule("mcp-notes", "add_note", false);
    expect(service.view().integrations[0]?.actions[1]?.rule).toBe("ask");
    service.configure("mcp-notes", { actions: { add_note: false } });
    expect(service.roster()[0]).toMatchObject({
      actions: [
        { name: "list_notes", rule: "allow" },
        { name: "add_note", rule: "never" },
      ],
    });
    expect((await crew.call("Notes", "add_note", { text: "Not allowed" })).refused).toBe("refused");
  });

  it("reports an unknown outward outcome honestly even when Always allow skips the card", async () => {
    const f = fixture();
    const service = f.open();
    service.setRule("mcp-notes", "add_note", true);
    vi.mocked(f.binding.call).mockRejectedValueOnce(
      new IntegrationOutcomeUnknown("The server dropped the connection after taking the note"),
    );
    const answer = await service
      .forTask("task-1")
      .call("Notes", "add_note", { text: "Return the library books by Friday" });
    expect(answer.text).toContain("unknown outcome");
    expect(answer.text).toContain("Do not repeat this call");
    expect(f.binding.call).toHaveBeenCalledTimes(1);
    expect(f.present).not.toHaveBeenCalled();
  });

  // INF-1108: the first mate's calls follow the same per-action rule as a
  // crewmate's. The captain's q2: "Like a new connection: every action asks
  // until you choose Always allow"; an always allowed change runs from its seat.
  it("holds the first mate's call for the host's own row and card, and runs it as the first mate once taken", async () => {
    const f = fixture();
    const kept: IntegrationAsk[] = [];
    const service = new IntegrationsService({
      ...f.options,
      asks: {
        ...f.asks,
        keepForFirstmate: (ask) => {
          kept.push(ask);
          return `integration-ask-${ask.id}`;
        },
      },
    });
    const firstmate = { kind: "firstmate" } as const;
    const call = { text: "Return the library books by Friday" };
    expect((await service.call(firstmate, "Notes", "add_note", call)).text).toContain(
      "Call again with reason explaining why this action is needed.",
    );
    expect(kept).toEqual([]);
    const reason = "The captain asked me to remember the library books.";
    const held = await service.call(firstmate, "Notes", "add_note", call, reason);
    expect(held.refused).toBe("refused");
    expect(held.text).toContain("You will hear the outcome once through write-answered.");
    expect(f.binding.call).not.toHaveBeenCalled();
    expect(f.present).not.toHaveBeenCalled();
    expect(kept).toEqual([
      expect.objectContaining({
        by: "firstmate",
        reason,
        input: JSON.stringify(call),
        effect: "changes",
      }),
    ]);
    // The turn counts the host's card as what it did (docs/task-capture.md).
    expect(held.card).toBe(`integration-ask-${kept[0]?.id}`);
    const sent = await service.sendTaken("host-row", { ask: kept[0]! }, "once");
    expect(sent).toMatchObject({ ok: true, place: "Notes" });
    expect(f.binding.call).toHaveBeenCalledWith("mcp-notes", "add_note", call, firstmate);
    expect(service.view().integrations[0]?.actions[1]?.rule).toBe("ask");
    service.setRule("mcp-notes", "add_note", true);
    expect(
      await service.call(firstmate, "Notes", "add_note", { text: "Pay the electric bill" }),
    ).toMatchObject({ ran: "changes" });
    service.setRule("mcp-notes", "list_notes", true);
    expect(await service.call(firstmate, "Notes", "list_notes", {})).not.toHaveProperty("ran");
    expect(f.notes.slice(1)).toEqual([call.text, "Pay the electric bill"]);
    expect(kept).toHaveLength(1);
  });

  it("refuses the first mate's held call when the app could not keep it, and runs nothing", async () => {
    const f = fixture();
    const service = new IntegrationsService({
      ...f.options,
      asks: {
        ...f.asks,
        keepForFirstmate: () => {
          throw new Error("the approval card has no row to wait on");
        },
      },
    });
    const answer = await service.call(
      { kind: "firstmate" },
      "Notes",
      "list_notes",
      {},
      "Find the dentist reminder.",
    );
    expect(answer).toMatchObject({ refused: "refused" });
    expect(answer.text).toContain(
      "the app could not keep the call: the approval card has no row to wait on",
    );
    expect(f.binding.call).not.toHaveBeenCalled();
  });

  it("starts existing connections over, keeps old settings readable, and irrevocably invalidates grants on tool or account changes", async () => {
    const f = fixture();
    f.store.write({ "mcp-notes": { name: "Notes", paused: false } });
    const service = f.open();
    expect(service.view().integrations[0]?.actions[0]?.rule).toBe("ask");
    service.setRule("mcp-notes", "list_notes", true);
    expect(JSON.parse(readFileSync(join(f.store.root, "settings.json"), "utf8"))).toEqual({
      "mcp-notes": { name: "Notes", paused: false },
    });
    const read = f.actions[0]!;
    const description = read.description;
    read.description = "Lists notes including archived notes.";
    expect(service.view().integrations[0]?.actions[0]?.rule).toBe("ask");
    read.description = description;
    expect(service.view().integrations[0]?.actions[0]?.rule).toBe("ask");
    service.setRule("mcp-notes", "list_notes", true);
    // Changing the MCP read-only mark changes its declared effect.
    (read as IntegrationActionSpec).effect = "changes";
    expect(service.view().integrations[0]?.actions[0]?.rule).toBe("ask");
    (read as IntegrationActionSpec).effect = "reads";
    service.setRule("mcp-notes", "list_notes", true);
    f.account("another-account");
    expect(service.view().integrations[0]?.actions[0]?.rule).toBe("ask");
    service.setRule("mcp-notes", "list_notes", true);
    await service.remove("mcp-notes");
    expect(service.view().integrations[0]?.actions[0]?.rule).toBe("ask");
  });
});

// INF-2993, the captain's picks: Allow for the rest of this task covers "The
// same action, kind of request and place", for that task's crewmate only, and
// ends with the task or with anything that ends Always allow. The calls are
// finding 3's run, which wrote into one throwaway repository.
describe("Allow for the rest of this task (INF-2993)", () => {
  function fixture() {
    const dir = scratchDir("infinitary-task-allow-");
    const store = new IntegrationSettingsStore(dir);
    const signIns = new Map([["github.com", { state: "ok" as const, login: "octo" }]]);
    const writes: { by: string; method: string; path: string }[] = [];
    const binding = githubIntegration({
      signIns: {
        stateOf: (host) => signIns.get(host)?.state,
        loginOf: (host) => signIns.get(host)?.login ?? null,
        checkNow: async () => {},
        signOut: (host) => {
          signIns.delete(host);
        },
      },
      gateway: {
        read: async () => "[]",
        readAsSeat: async () => "[]",
        write: async (taskId, input) => {
          writes.push({ by: taskId, method: input.method, path: input.path });
          return '{"number":7}';
        },
        writeAsSeat: async (input) => {
          writes.push({ by: "firstmate", method: input.method, path: input.path });
          return '{"number":8}';
        },
      },
    });
    const kept = new Map<string, IntegrationAsk>();
    const allowances = new Map<string, IntegrationAllowance[]>();
    const service = new IntegrationsService({
      bindings: [binding],
      store,
      asks: {
        keep: (_taskId, ask) => {
          kept.set(ask.id, ask);
        },
        keepForFirstmate: (ask) => {
          kept.set(ask.id, ask);
          return `integration-ask-${ask.id}`;
        },
        present: () => {},
        take: (_taskId, id) => {
          const ask = kept.get(id);
          if (!ask || ask.sentAt !== undefined) return { refused: "already taken or absent" };
          ask.sentAt = Date.now();
          return { ask };
        },
        record: () => {},
        allow: (taskId, allowance) => {
          allowances.set(taskId, [...(allowances.get(taskId) ?? []), allowance]);
        },
        allowances: (taskId) => allowances.get(taskId) ?? [],
      },
    });
    const reason = "Open the proof pull request the task asks for.";
    const write = (taskId: string, method: string, path: string) =>
      service
        .forTask(taskId)
        .call("GitHub", "write", { method, path, body: "{}" }, undefined, reason);
    /** Ask once, and answer that ask with Allow for the rest of this task. */
    const allow = async (taskId: string, method: string, path: string) => {
      const asked = await write(taskId, method, path);
      expect(asked.refused).toBe("refused");
      const ask = [...kept.values()].at(-1)!;
      return service.sendAsk(taskId, ask.id, "task");
    };
    return { service, signIns, writes, kept, allowances, write, allow, reason };
  }

  it("runs the task's later calls of the same kind to the same repository without a card, and asks for any other", async () => {
    const f = fixture();
    const sent = await f.allow("task-1", "POST", "/repos/Octo/Queue-Proof-4ca5/pulls");
    expect(sent).toMatchObject({ ok: true, outcome: { kind: "ran" } });
    expect(sent.allowance).toMatchObject({
      action: "write",
      scope: "POST /repos/octo/queue-proof-4ca5",
      words: "POST requests to octo/queue-proof-4ca5",
    });
    const asksBefore = f.kept.size;
    expect(
      await f.write("task-1", "POST", "/repos/octo/queue-proof-4ca5/statuses/0be4f05"),
    ).not.toHaveProperty("refused");
    expect(f.kept.size).toBe(asksBefore);
    for (const [taskId, method, path] of [
      ["task-1", "DELETE", "/repos/octo/queue-proof-4ca5"],
      ["task-1", "POST", "/repos/octo/meter/pulls"],
      ["task-1", "POST", "/repos/octo/queue-proof-4ca5/../../meter/pulls"],
      ["task-2", "POST", "/repos/octo/queue-proof-4ca5/pulls"],
    ] as const)
      expect((await f.write(taskId, method, path)).refused).toBe("refused");
    const firstmate = await f.service.call(
      { kind: "firstmate" },
      "GitHub",
      "write",
      { method: "POST", path: "/repos/octo/queue-proof-4ca5/pulls", body: "{}" },
      f.reason,
    );
    expect(firstmate.refused).toBe("refused");
    expect(f.kept.size).toBe(asksBefore + 5);
    expect(f.writes.map((w) => `${w.by} ${w.method} ${w.path}`)).toEqual([
      "task-1 POST /repos/Octo/Queue-Proof-4ca5/pulls",
      "task-1 POST /repos/octo/queue-proof-4ca5/statuses/0be4f05",
    ]);
    // The rule in Settings stays Ask: the choice kept nothing there.
    expect(f.service.view().integrations[0]?.actions.map((a) => a.rule)).toEqual(["ask", "ask"]);
  });

  it("ends when the action is turned off and on, its rule changes, or the account changes", async () => {
    const f = fixture();
    const later = () => f.write("task-1", "POST", "/repos/octo/queue-proof-4ca5/issues");
    const ends = async (change: () => void) => {
      await f.allow("task-1", "POST", "/repos/octo/queue-proof-4ca5/pulls");
      expect((await later()).refused).toBeUndefined();
      change();
      expect((await later()).refused).toBe("refused");
    };
    await ends(() => {
      f.service.configure("github", { actions: { write: false } });
      f.service.configure("github", { actions: { write: true } });
    });
    await ends(() => {
      f.service.setRule("github", "write", true);
      f.service.setRule("github", "write", false);
    });
    await ends(() => {
      f.signIns.set("github.com", { state: "ok", login: "another-login" });
    });
  });

  it("ends when the action's own description changes", async () => {
    const f = fixture();
    await f.allow("task-1", "POST", "/repos/octo/queue-proof-4ca5/pulls");
    const [allowance] = f.allowances.get("task-1")!;
    // An allowance chosen for another description of the action.
    f.allowances.set("task-1", [
      { ...allowance!, signature: '["an older description","changes"]' },
    ]);
    expect(
      (await f.write("task-1", "POST", "/repos/octo/queue-proof-4ca5/issues")).ran,
    ).toBeUndefined();
  });
});

// INF-1407: a connection may list any number of actions, but an
// older build's strict settings reader took at most 64 off ones, and so
// did this one, reading every saved name, pause and off action as the
// defaults once a 65th was off. These are the GitHub MCP server's own tools.
describe("off actions past an older build's count (INF-1407)", () => {
  const tools = [
    "add_issue_comment",
    "add_sub_issue",
    "assign_copilot_to_issue",
    "cancel_workflow_run",
    "create_and_submit_pull_request_review",
    "create_branch",
    "create_gist",
    "create_issue",
    "create_or_update_file",
    "create_pending_pull_request_review",
    "create_pull_request",
    "create_repository",
    "delete_file",
    "delete_pending_pull_request_review",
    "delete_workflow_run_logs",
    "dismiss_notification",
    "download_workflow_run_artifact",
    "fork_repository",
    "get_code_scanning_alert",
    "get_commit",
    "get_dependabot_alert",
    "get_discussion",
    "get_discussion_comments",
    "get_file_contents",
    "get_issue",
    "get_issue_comments",
    "get_job_logs",
    "get_latest_release",
    "get_me",
    "get_notification_details",
    "get_pull_request",
    "get_pull_request_comments",
    "get_pull_request_diff",
    "get_pull_request_files",
    "get_pull_request_reviews",
    "get_pull_request_status",
    "get_release_by_tag",
    "get_secret_scanning_alert",
    "get_tag",
    "get_team_members",
    "get_teams",
    "get_workflow_run",
    "get_workflow_run_logs",
    "get_workflow_run_usage",
    "list_branches",
    "list_code_scanning_alerts",
    "list_commits",
    "list_dependabot_alerts",
    "list_discussion_categories",
    "list_discussions",
    "list_gists",
    "list_issue_types",
    "list_issues",
    "list_notifications",
    "list_pull_requests",
    "list_releases",
    "list_secret_scanning_alerts",
    "list_starred_repositories",
    "list_sub_issues",
    "list_tags",
    "list_workflow_jobs",
    "list_workflow_run_artifacts",
    "list_workflow_runs",
    "list_workflows",
    "manage_notification_subscription",
    "manage_repository_notification_subscription",
    "mark_all_notifications_read",
    "merge_pull_request",
    "push_files",
    "remove_sub_issue",
    "reprioritize_sub_issue",
    "request_copilot_review",
    "rerun_failed_jobs",
    "rerun_workflow_run",
    "run_workflow",
    "search_code",
    "search_issues",
    "search_orgs",
    "search_pull_requests",
    "search_repositories",
    "search_users",
    "star_repository",
    "submit_pending_pull_request_review",
    "unstar_repository",
    "update_gist",
    "update_issue",
    "update_pull_request",
    "update_pull_request_branch",
  ];
  // The strict reader builds before INF-1407 parsed settings.json with.
  const olderBuild = z.record(
    z.string().min(1).max(48),
    z.strictObject({
      name: integrationNameSchema.optional(),
      paused: z.boolean().optional(),
      off: z.array(z.string().min(1).max(48)).max(OLDER_BUILD_OFF_MAX).optional(),
    }),
  );

  function fixture() {
    const dir = join(scratchDir("fm-integration-off-"), "integrations");
    const store = new IntegrationSettingsStore(dir);
    const actions = tools.map((name) => ({
      name,
      label: name.replaceAll("_", " "),
      effect:
        name.startsWith("get_") || name.startsWith("list_")
          ? ("reads" as const)
          : ("changes" as const),
      description: `The GitHub MCP server's ${name} tool.`,
      input: z.strictObject({}),
    }));
    const binding: IntegrationBinding = {
      kind: "mcp",
      many: true,
      connections: () => [
        { id: "mcp-github", name: "GitHub MCP server", account: "octo", health: "ok", actions },
        { id: "mcp-notes", name: "Notes", account: null, health: "ok", actions: [] },
      ],
      check: async () => {},
      remove: () => {},
      call: async () => {
        throw new Error("turning actions off calls no tool");
      },
    };
    const open = () =>
      new IntegrationsService({
        bindings: [binding],
        store,
      });
    const offIn = (service: IntegrationsService) => {
      const row = service.roster().find((entry) => entry.id === "mcp-github");
      if (!row) throw new Error("the GitHub MCP server must stay connected");
      return (row.actions as { name: string; rule: string }[])
        .filter((action) => action.rule === "never")
        .map((action) => action.name);
    };
    return { store, open, offIn };
  }

  it("keeps every off action, name and pause past 64, and an older build still reads them", () => {
    expect(tools.length).toBeGreaterThan(OLDER_BUILD_OFF_MAX);
    const { store, open, offIn } = fixture();
    const service = open();
    service.configure("mcp-github", { name: "Work GitHub", paused: true });
    service.configure("mcp-notes", { paused: true, actions: {} });
    // Settings turns them off one at a time; the 65th is where it broke.
    for (const name of tools) service.configure("mcp-github", { actions: { [name]: false } });
    const restarted = open();
    expect(offIn(restarted)).toEqual(tools);
    expect(restarted.show("Work GitHub")).toMatchObject({ id: "mcp-github", paused: true });
    expect(restarted.show("Notes")).toMatchObject({ id: "mcp-notes", paused: true });
    const older = olderBuild.parse(
      JSON.parse(readFileSync(join(store.root, "settings.json"), "utf8")),
    );
    expect(older["mcp-github"]).toEqual({
      name: "Work GitHub",
      paused: true,
      off: tools.slice(0, OLDER_BUILD_OFF_MAX),
    });
    expect(older["mcp-notes"]).toEqual({ paused: true });

    // Turned back on below the count, each stays on and the rest stay off.
    const on = tools.slice(0, tools.length - OLDER_BUILD_OFF_MAX + 2);
    for (const name of on) restarted.configure("mcp-github", { actions: { [name]: true } });
    expect(offIn(open())).toEqual(tools.slice(on.length));
    expect(
      olderBuild.safeParse(JSON.parse(readFileSync(join(store.root, "settings.json"), "utf8")))
        .success,
    ).toBe(true);
    for (const name of tools) restarted.configure("mcp-github", { actions: { [name]: true } });
    expect(offIn(open())).toEqual([]);
    expect(open().show("Work GitHub")).toMatchObject({ paused: true });
  });

  it("reads the settings a build before INF-1407 wrote with more than 64 off actions", () => {
    const { store, open, offIn } = fixture();
    const off = tools.slice(0, OLDER_BUILD_OFF_MAX + 1);
    mkdirSync(store.root, { recursive: true });
    writeFileSync(
      join(store.root, "settings.json"),
      JSON.stringify({ "mcp-github": { name: "Work GitHub", paused: true, off } }),
    );
    const service = open();
    expect(offIn(service)).toEqual(off);
    expect(service.show("Work GitHub")).toMatchObject({ id: "mcp-github", paused: true });
    // Its next change writes the shape an older build reads again.
    service.configure("mcp-github", { actions: { [tools.at(-1)!]: false } });
    expect(
      olderBuild.safeParse(JSON.parse(readFileSync(join(store.root, "settings.json"), "utf8")))
        .success,
    ).toBe(true);
    expect(offIn(open())).toEqual([...off, tools.at(-1)]);
  });

  it("keeps an action off when an older build turned on another, and forgets the list with the connection", () => {
    const { store, open, offIn } = fixture();
    const service = open();
    for (const name of tools) service.configure("mcp-github", { actions: { [name]: false } });
    const file = join(store.root, "settings.json");
    // An older build turns the first action on in the only file it reads.
    const settings = olderBuild.parse(JSON.parse(readFileSync(file, "utf8")));
    settings["mcp-github"]!.off = settings["mcp-github"]!.off!.slice(1);
    writeFileSync(file, JSON.stringify(settings));
    expect(offIn(open())).toEqual(tools);
    // An older build forgets the connection: nothing it left behind applies.
    writeFileSync(file, JSON.stringify({}));
    expect(offIn(open())).toEqual([]);
  });
});

describe("a panel is one more caller (INF-2334 piece 1)", () => {
  // The captain's consent A: one rule for every caller. A panel reaches only
  // what its manifest names, its asks raise the same approval card, one per
  // action at a time, and Always allow lets its later calls run.
  function fixture() {
    const dir = scratchDir("infinitary-panel-caller-");
    const store = new IntegrationSettingsStore(dir);
    const notes = ["Call the dentist to move Thursday's cleaning"];
    const actions: IntegrationActionSpec[] = [
      {
        name: "list_notes",
        label: "List notes",
        effect: "reads",
        description: "Lists every note with its number.",
        input: z.strictObject({}),
      },
      {
        name: "add_note",
        label: "Add a note",
        effect: "changes",
        description: "Adds a note to the end of the list.",
        input: z.strictObject({ text: z.string() }),
      },
    ];
    const binding: IntegrationBinding = {
      kind: "mcp",
      connections: () => [
        { id: "mcp-notes", name: "Notes", account: "sam", health: "ok", actions },
      ],
      check: async () => {},
      remove: () => {},
      call: vi.fn(async (_id, action, input) => {
        if (action === "add_note") notes.push((input as { text: string }).text);
        return { text: notes.join("\n") };
      }),
    };
    const panelAsks = new PanelAsks(join(dir, "asks"));
    const kept = new Map<string, IntegrationAsk>();
    const cards: string[] = [];
    const service = new IntegrationsService({
      bindings: [binding],
      store,
      asks: {
        keep: () => {
          throw new Error("a panel's ask is never a task's");
        },
        keepForPanel: (ask) => {
          const held = ask.panel
            ? panelAsks.held(ask.panel.key, ask.integration, ask.action)
            : undefined;
          if (held) return { held: held.state };
          kept.set(ask.id, ask);
          const card = `card-${cards.length + 1}`;
          cards.push(card);
          panelAsks.asking(ask, card);
          return { card };
        },
        take: (_row, id) => {
          const ask = kept.get(id);
          if (!ask || ask.sentAt !== undefined) return { refused: "already taken or absent" };
          ask.sentAt = Date.now();
          return { ask };
        },
        record: () => {},
      },
    });
    const panel = service.forPanel({
      key: "workspace:notes-board",
      title: "Notes board",
      uses: [{ integration: "Notes", actions: ["list_notes"], why: "Shows your notes." }],
    });
    return { service, panel, panelAsks, kept, cards, binding, notes };
  }

  it("lists and shows only what the manifest names, and refuses the rest in one wording", async () => {
    const f = fixture();
    const listed = f.panel.list();
    expect(listed.map((entry) => entry.id)).toEqual(["mcp-notes"]);
    expect(listed[0]?.actions).toEqual([expect.objectContaining({ name: "list_notes" })]);
    const shown = f.panel.show("Notes") as { actions: { name: string }[] };
    expect(shown.actions.map((action) => action.name)).toEqual(["list_notes"]);
    const refused = await f.panel.call("Notes", "add_note", { text: "Pay the electric bill" });
    expect(refused).toEqual({
      text: undeclaredIntegrationMessage("Notes", { action: "add_note" }),
      refused: "refused",
    });
    expect(f.notes).toHaveLength(1);
    expect(f.cards).toEqual([]);
  });

  it("raises one card per action at a time, keeps Not now, and runs once allowed always", async () => {
    const f = fixture();
    const first = await f.panel.call("Notes", "list_notes", {});
    expect(first.refused).toBe("refused");
    expect(f.cards).toEqual(["card-1"]);
    const [ask] = [...f.kept.values()];
    if (!ask) throw new Error("the panel's call kept no ask");
    expect(ask).toMatchObject({
      by: "panel",
      panel: { key: "workspace:notes-board", title: "Notes board" },
      reason: "Shows your notes.",
    });
    expect(f.panelAsks.of("workspace:notes-board")).toEqual([
      expect.objectContaining({ action: "list_notes", label: "List notes", state: "asking" }),
    ]);
    // A timer's next call waits on the same card.
    expect((await f.panel.call("Notes", "list_notes", {})).text).toContain(
      "waits for the captain's answer",
    );
    expect(f.cards).toHaveLength(1);
    expect(f.binding.call).not.toHaveBeenCalled();

    // Not now: refused without a card until the panel's line asks again.
    expect((await f.service.sendAsk("host-row", ask.id, "deny")).ok).toBe(false);
    f.panelAsks.answered(ask.id, true);
    expect((await f.panel.call("Notes", "list_notes", {})).text).toContain("chose Not now");
    expect(f.cards).toHaveLength(1);

    // Ask again raises a new card; Always allow runs the kept call as the panel's.
    f.panelAsks.forget("workspace:notes-board", "mcp-notes", "list_notes");
    await f.panel.call("Notes", "list_notes", {});
    expect(f.cards).toHaveLength(2);
    const again = [...f.kept.values()].at(-1);
    if (!again) throw new Error("Ask again kept no ask");
    const sent = await f.service.sendAsk("host-row", again.id, "always");
    expect(sent.answer).toContain("dentist");
    expect(f.binding.call).toHaveBeenLastCalledWith(
      "mcp-notes",
      "list_notes",
      {},
      expect.objectContaining({ kind: "panel" }),
    );
    f.panelAsks.answered(again.id, false);
    expect(f.panelAsks.of("workspace:notes-board")).toEqual([]);
    expect((await f.panel.call("Notes", "list_notes", {})).text).toContain("dentist");
    expect(f.cards).toHaveLength(2);
  });
});
