/**
 * A program as the crew supervisor runs it (docs/programs.md): its ask()
 * answered through the one-question session, a part the host refuses to
 * file, and a drop while a part is underway. INF-2625's plan, the crew
 * supervisor's seventh step, moves the program code out of the supervisor
 * into the program runner; these cases pin, before it moves, the behaviour
 * no other test reaches. Each runs the script in the real program process
 * and reads the record, the first mate's wake and the answer.
 */

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  type FakeCrewmate,
  fakeCrewmate,
  intentOf,
  type SetupExtras,
  setup,
} from "../../../tests/helpers/crewHarness";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { forkChildProcess } from "../sql/forkChildProcess";

const PROGRAM_WAIT = { timeout: 20_000, interval: 25 };
const programProcess = forkChildProcess(
  fileURLToPath(new URL("../program/programProcess.ts", import.meta.url)),
);

/** A when-ready program in "meterlab", a git project, running `script`. */
async function running(script: string, extras: SetupExtras = {}) {
  const crewmate: FakeCrewmate = fakeCrewmate();
  const h = setup(crewmate, { ...extras, programProcess });
  const dir = scratchDir("infinitary-program-");
  execFileSync("git", ["-C", dir, "init", "--initial-branch=main"]);
  const { repo } = await h.repos.setup({ kind: "adopt", path: dir, name: "meterlab" });
  const program = h.supervisor.plan({
    title: "Cap the meter's rendered results",
    intent: intentOf("Cap what the meter renders."),
    repoId: repo.id,
    startPolicy: "when-ready",
    shape: { program: { script, bound: 2 } },
  });
  h.supervisor.graphChanged();
  return { ...h, crewmate, program };
}

describe("a program, before its code moves out of the crew supervisor", () => {
  it("answers ask() through the one-question session, checked against its schema, and with null when the app has none", async () => {
    const FILE = {
      type: "object",
      required: ["file"],
      properties: { file: { type: "string" } },
    };
    const script = `return await ask("Which file renders the meter?", ${JSON.stringify(FILE)});`;
    const asked: { caller: { purpose: string; taskId?: string }; text: string }[] = [];
    const h = await running(script, {
      answerJson: async (caller, _instruction, text) => {
        asked.push({ caller, text });
        return { text: '{"file":"src/meter.ts"}' };
      },
    });
    await vi.waitFor(() => expect(h.tasks.get(h.program.id)?.status).toBe("done"), PROGRAM_WAIT);
    expect(h.tasks.latestResult(h.program.id)?.value).toEqual({ file: "src/meter.ts" });
    expect(asked).toHaveLength(1);
    expect(asked[0]?.caller).toEqual({ purpose: "program-ask", taskId: h.program.id });
    expect(asked[0]?.text).toContain("Which file renders the meter?");
    expect(h.tasks.graph.children(h.program.id)).toEqual([]);

    const none = await running(`const answer = await ask("Which file?", null); return { answer };`);
    await vi.waitFor(
      () => expect(none.tasks.get(none.program.id)?.status).toBe("done"),
      PROGRAM_WAIT,
    );
    expect(none.tasks.latestResult(none.program.id)?.value).toEqual({ answer: null });
  });

  it("throws a part the host will not file into the script's await, filing nothing", async () => {
    const h = await running(`
      try {
        await task("Find where the meter renders.", { schema: { type: "array" } });
        return { filed: true };
      } catch (caught) {
        return { refused: caught.message };
      }
    `);
    await vi.waitFor(() => expect(h.tasks.get(h.program.id)?.status).toBe("done"), PROGRAM_WAIT);
    expect(h.tasks.latestResult(h.program.id)?.value).toEqual({
      refused: 'result_schema must have an object at its root: give it "type": "object".',
    });
    expect(h.tasks.graph.children(h.program.id)).toEqual([]);
  });

  it("stops at once on a drop while a part is underway, closing the part first and then the program", async () => {
    const h = await running(`return await task("Cap the meter.");`);
    const part = await vi.waitFor(() => {
      const found = h.tasks.graph.children(h.program.id)[0];
      if (found?.status !== "active" || !h.crewmate.promptCalls.length)
        throw new Error("the part has not started");
      return found;
    }, PROGRAM_WAIT);

    expect(h.supervisor.dropTask(h.program.key, { reason: "changed course" })).toBe(
      `Dropping ${h.program.key} "Cap the meter's rendered results": its program stopped, and its started part ${part.key} close first, their work saved.`,
    );
    await vi.waitFor(() => expect(h.tasks.get(h.program.id)?.status).toBe("dropped"), PROGRAM_WAIT);
    expect(h.tasks.get(part.id)).toMatchObject({ status: "dropped", closedReason: "superseded" });
    expect(h.tasks.get(h.program.id)?.closedReason).toBe("cancelled");
    // The script never finished: the first mate hears no program end.
    expect(h.ops.join("\n")).not.toContain(`the program on task ${h.program.key}`);
  });
});
