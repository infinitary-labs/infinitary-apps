import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ForgeSignInState } from "@shared/forges";
import { describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { integrationNameSchema } from "../../shared/integrations";
import {
  FileIntegrationSecrets,
  githubIntegration,
  IntegrationSettingsStore,
  IntegrationsService,
} from ".";
import type { IntegrationBinding } from "./binding";

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
              rule: "allow",
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
    expect(row?.actions.map((action) => action.rule)).toEqual(["allow", "never"]);
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
