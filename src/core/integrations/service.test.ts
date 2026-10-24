import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ForgeSignInState } from "@shared/forges";
import type { IntegrationAsk } from "@shared/writeAsk";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { integrationNameSchema } from "../../shared/integrations";
import {
  FileIntegrationSecrets,
  githubIntegration,
  IntegrationSettingsStore,
  IntegrationsService,
} from ".";
import type { IntegrationActionSpec, IntegrationBinding } from "./binding";
import { IntegrationOutcomeUnknown } from "./binding";

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
    gateway: { read: unreached, write: unreached, readAsSeat: unreached },
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
        secrets: new FileIntegrationSecrets(join(dir, "secrets")),
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
  it("draws GitHub from the github.com sign-in, and keeps its settings across a restart until it is removed", async () => {
    const signIns = new Map([["github.com", { state: "ok" as const, login: "octo" }]]);
    const dir = join(scratchDir("fm-integrations-"), "integrations");
    const open = () =>
      new IntegrationsService({
        bindings: [github(signIns)],
        store: new IntegrationSettingsStore(dir),
        secrets: new FileIntegrationSecrets(join(dir, "secrets")),
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
    });
    expect(restarted.rosterLine()).toBeUndefined();
    // Signing in again starts from the kind's defaults, not the removed row's.
    signIns.set("github.com", { state: "ok", login: "octo" });
    expect(open().view().integrations[0]).toMatchObject({ name: "GitHub", paused: false });
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
        secrets: new FileIntegrationSecrets(join(dir, "secrets")),
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
    // Another name whose words make the same id gets the next id, never the same one.
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
        secrets: new FileIntegrationSecrets(join(scratchDir("fm-integration-order-"), "s")),
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
    // The same rows listed in another order keep the same names.
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
        secrets: new FileIntegrationSecrets(join(dir, "secrets")),
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
    expect(
      (
        await service.call({ kind: "firstmate" }, "Notes", "add_note", {
          text: "Do not run without a task",
        })
      ).refused,
    ).toBe("refused");
    expect(f.binding.call).not.toHaveBeenCalled();
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
