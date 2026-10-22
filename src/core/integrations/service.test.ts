import { join } from "node:path";
import type { ForgeSignInState } from "@shared/forges";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import {
  FileIntegrationSecrets,
  githubIntegration,
  IntegrationSettingsStore,
  IntegrationsService,
} from ".";

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
