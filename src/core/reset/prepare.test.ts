import { CORE_INVOKE_CHANNELS, PROGRAM_ONLY_CHANNELS } from "@shared/ipc";
import { describe, expect, it } from "vitest";
import { prepareReset, type ResetPrepareDeps, resetScope } from "./prepare";

/**
 * The first mate's side of a reset (docs/reset.md, "Before it quits"): it
 * undoes what the folder's deletion alone would leave elsewhere, and a step
 * that fails or times out is counted, never stops the next.
 */

function deps(overrides: Partial<ResetPrepareDeps> = {}) {
  const steps: string[] = [];
  const step =
    (name: string) =>
    async (id: string): Promise<unknown> => {
      steps.push(`${name} ${id}`);
      return undefined;
    };
  const base: ResetPrepareDeps = {
    devices: () => [{ id: "phone" }],
    removeDevice: step("remove device"),
    accounts: () => [{ id: "claude" }],
    signOut: step("sign out"),
    integrations: () => [{ id: "github" }],
    removeIntegration: step("remove integration"),
    openTasks: () => [{ id: "t1" }, { id: "t2" }],
    discardTask: step("discard"),
    leftoversSettled: step("settled"),
    keptJobs: () => [{ id: "k1" }],
    removeKeptJob: async (id) => {
      steps.push(`remove kept ${id}`);
      return { removed: true };
    },
    projects: () => ["/projects/app"],
    undoProject: step("undo project"),
  };
  return { steps, deps: { ...base, ...overrides } };
}

describe("the first mate's side of a reset", () => {
  it("is asked only by the window's own program, so no agent can start a reset", () => {
    // Program-only channels are refused to the command and never forwarded
    // to the page (captainCommands.test.ts owns that refusal).
    expect(PROGRAM_ONLY_CHANNELS.has("inf:app:reset-prepare")).toBe(true);
    // The reset itself is a host channel, which the first mate never serves.
    expect(CORE_INVOKE_CHANNELS).not.toContain("inf:app:reset");
  });

  it("counts the open tasks the reset stops", () => {
    expect(resetScope(deps().deps)).toEqual({ tasks: 2 });
  });

  it("removes devices while connected, closes tasks before their records go, then the rest", async () => {
    const { steps, deps: d } = deps();
    expect(await prepareReset(d)).toEqual({ ok: true });
    expect(steps).toEqual([
      "remove device phone",
      "discard t1",
      "discard t2",
      "settled t1",
      "settled t2",
      "remove kept k1",
      "undo project /projects/app",
      "sign out claude",
      "remove integration github",
    ]);
  });

  it("leaves the computer that asked for this reset on the list, since it resets itself next", async () => {
    const { steps, deps: d } = deps({ devices: () => [{ id: "phone" }, { id: "laptop" }] });
    await prepareReset(d, { keep: "laptop" });
    expect(steps).toContain("remove device phone");
    expect(steps).not.toContain("remove device laptop");
  });

  it("still tries every later step after one failed, timed out or stayed", async () => {
    const { steps, deps: d } = deps({
      removeDevice: () => {
        throw new Error("offline");
      },
      removeKeptJob: async () => ({ removed: false }),
      signOut: () => new Promise(() => {}),
      // A short cap stands in for the real one, so the sign-out that never answers times out.
      within: (work) =>
        Promise.race([work, new Promise<"timed-out">((done) => setTimeout(done, 20, "timed-out"))]),
    });
    expect(await prepareReset(d)).toEqual({ ok: true });
    expect(steps).toContain("remove integration github");
  });
});
