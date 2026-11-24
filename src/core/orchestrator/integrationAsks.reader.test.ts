/**
 * The unsafe data reader's one approval card (docs/forge.md, "A reader's
 * writes"; docs/integrations.md, "A reader's integrations"): its kept write
 * where its project lives and its kept integration call share one card with
 * only Not now and Only this time, and one click runs the ticked rows once;
 * and only a reader's session gets the typed integration tools, which reach
 * its reader rules. Each case drives a real CrewSupervisor through the crew harness.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { allowFieldOf, INTEGRATION_APPROVAL_WORDS, NOT_ALLOWED_WHY } from "@shared/integrations";
import type { ForgeWriteAsk, IntegrationAsk, WriteAskSent } from "@shared/writeAsk";
import { describe, expect, it, vi } from "vitest";
import {
  fakeCrewmate,
  fakeCrewTimersEachTest,
  intentOf,
  setup,
  tick,
} from "../../../tests/helpers/crewHarness";
import type { IntegrationAskTaken, TaskIntegrations } from "../integrations";
import type { CrewmateSpec } from "./crewSession";
import { seedProject } from "../workspace/seedProject";

fakeCrewTimersEachTest();

const comment: ForgeWriteAsk = {
  id: "comment",
  kind: "github",
  host: "github.com",
  place: "GitHub",
  via: "project",
  method: "POST",
  path: "/repos/octo/meter/issues/12/comments",
  body: JSON.stringify({ body: "Thanks, this reproduces." }),
  at: 1,
};
const note: IntegrationAsk = {
  id: "note",
  kind: "integration",
  integration: "mcp-notes",
  connection: "mcp-notes#1",
  place: "Notes",
  action: "add_note",
  label: "Add a note",
  description: "Adds a note to the end of the list.",
  effect: "changes",
  reason: "Remember issue 12 for the captain.",
  signature: "add_note:changes",
  input: JSON.stringify({ text: "Issue 12 reproduces" }),
  at: 2,
};
const read: IntegrationAsk = {
  ...note,
  id: "read",
  action: "list_notes",
  label: "List notes",
  effect: "reads",
  reason: "Check what the captain already noted.",
  input: "{}",
  at: 3,
};

describe("an unsafe data reader's one approval card", () => {
  it("lists its write and its integration calls as ticked rows, and runs the ticked ones once", async () => {
    const sent = vi.fn(
      async (_taskId: string, taken: IntegrationAskTaken, _choice: string): Promise<WriteAskSent> =>
        "ask" in taken
          ? { ok: true, ask: taken.ask, call: "", place: "", outcome: { kind: "ran" }, answer: "ok" }
          : { ok: false, call: "", place: "", outcome: { kind: "refused", why: taken.refused } },
    );
    const crewmate = fakeCrewmate();
    const h = setup(crewmate, { sendTakenIntegrationAsk: sent });
    const folder = join(h.paths.fleetDir, "meter");
    mkdirSync(join(folder, ".git"), { recursive: true });
    const repo = seedProject(h.db, { id: "meter", name: "meter", path: folder, setupKind: "init" });
    h.repos.configure(repo.id, { origin: "https://github.com/octo/meter.git" });
    const { taskId } = await h.supervisor.intake.commission({
      title: "Read the waiting issues",
      intent: {
        ...intentOf("read the waiting issues and note the real ones"),
        constraints: [{ kind: "read-only" as const }],
      },
      repoId: repo.id,
      shape: { unsafe_data_reader: true },
    });
    await tick();

    h.tasks.delivery.keepWriteAsk(taskId, comment);
    expect(h.supervisor.integrationAsks.askForge(taskId, comment)).toBe(false);
    for (const ask of [note, read]) {
      h.tasks.delivery.keepWriteAsk(taskId, ask);
      expect(h.supervisor.integrationAsks.askIntegration(taskId, ask)).toBe(true);
    }
    await tick();

    const cards = h.supervisor.cards.snapshot().filter((card) => card.taskId === taskId);
    expect(cards.map((card) => card.id)).toEqual(["write-ask-comment"]);
    const card = cards[0];
    expect(card?.title).toBe("Allow these calls?");
    expect(card?.actions.map((action) => action.label)).toEqual([
      INTEGRATION_APPROVAL_WORDS.deny,
      INTEGRATION_APPROVAL_WORDS.once,
    ]);
    expect(card?.body).toContain("POST /repos/octo/meter/issues/12/comments");
    expect(card?.body).toContain("Notes: Add a note");
    expect(card?.body).toContain("Issue 12 reproduces");
    expect(card?.body).toContain("Remember issue 12 for the captain.");
    expect(card?.body).toContain("Notes: List notes");

    expect(
      h.supervisor.cardActions.act(
        "write-ask-comment",
        "once",
        "chrome",
        {
          answers: [
            { name: allowFieldOf("comment"), values: ["allow"], changed: false },
            { name: allowFieldOf("note"), values: [], changed: true },
            { name: allowFieldOf("read"), values: ["allow"], changed: false },
          ],
        },
        { id: "gesture-0001", lifecycleId: card?.lifecycleId, offerId: card?.offerId },
      ),
    ).toEqual({});
    await tick();
    await tick();

    expect(
      sent.mock.calls.map(([, taken, choice]) => `${"ask" in taken ? taken.ask.id : "-"} ${choice}`),
    ).toEqual(["comment once", "read once"]);
    const left = h.tasks.get(taskId)?.delivery?.writeAsks?.find((ask) => ask.id === "note");
    expect(left?.outcome).toEqual({ kind: "refused", why: NOT_ALLOWED_WHY });
    expect(h.supervisor.cards.get("write-ask-comment")).toBeUndefined();
  });
});

describe("an unsafe data reader's integration tools", () => {
  it("reach the reader's rules for a reader, and are absent for any other crewmate", async () => {
    const reached: string[] = [];
    const reach = (who: string): TaskIntegrations => ({
      list: async () => [{ name: "Notes", by: who }],
      show: async (name) => ({ name, by: who }),
      call: async (name, action, _input, _signal, reason) => {
        reached.push(`${who} ${name} ${action} ${reason}`);
        return { text: `${who} answered` };
      },
    });
    const crewmate = fakeCrewmate();
    const h = setup(crewmate, {
      integrations: { forTask: () => reach("task"), forReader: () => reach("reader") },
    });
    const folder = join(h.paths.fleetDir, "meter");
    mkdirSync(join(folder, ".git"), { recursive: true });
    const repo = seedProject(h.db, { id: "meter", name: "meter", path: folder, setupKind: "init" });
    h.repos.configure(repo.id, { origin: "https://github.com/octo/meter.git" });
    await h.supervisor.intake.commission({
      title: "Read the waiting issues",
      intent: {
        ...intentOf("read the waiting issues and note the real ones"),
        constraints: [{ kind: "read-only" as const }],
      },
      repoId: repo.id,
      shape: { unsafe_data_reader: true },
    });
    await tick();
    const reader = h.specs.at(-1) as CrewmateSpec;
    expect(await reader.onIntegrations?.({})).toBe(
      JSON.stringify({ integrations: [{ name: "Notes", by: "reader" }] }),
    );
    expect(
      await reader.onUseIntegration?.({ name: "Notes", action: "list_notes", reason: "Check notes." }),
    ).toBe("reader answered");
    expect(reached).toEqual(["reader Notes list_notes Check notes."]);

    await h.supervisor.intake.commission({
      title: "Fix the meter",
      intent: intentOf("fix the meter"),
      repoId: repo.id,
    });
    await tick();
    const ordinary = h.specs.at(-1) as CrewmateSpec;
    expect(ordinary).not.toBe(reader);
    expect(ordinary.onIntegrations).toBeUndefined();
    expect(ordinary.onUseIntegration).toBeUndefined();
  });
});
