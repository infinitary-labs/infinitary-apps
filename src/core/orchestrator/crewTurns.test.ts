/**
 * A crewmate's turn as the crew's turn owner runs it (`CrewTurns`;
 * docs/report-sort.md, docs/inbox.md, INF-992): a report that hands files on,
 * checked whole and named by kept name and size only, and the guidance a
 * backend could not take mid-turn, served as the next turn once the report's
 * turn is over, which reports nothing of its own. These cases pin the
 * behaviour no other test reaches. Each plays the crewmate's session and
 * tools and reads the receipt, the report the first mate is served and the
 * record. A turn carries the standing directions only when the conversation
 * does not already hold the current set (`crewDirections.ts`, INF-2599).
 */

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileSizeWords } from "@shared/attachments";
import { describe, expect, it } from "vitest";
import {
  fakeCrewmate,
  fakeCrewTimersEachTest,
  fakeQueuedSteerCrewmate,
  intentOf,
  reportTurn,
  setup,
  tick,
} from "../../../tests/helpers/crewHarness";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { renderDirections } from "../knowledge/directions";
import { KnowledgeService } from "../knowledge/knowledgeService";
import { crewmateHandoverDir } from "../paths";
import { keepHandoverFiles } from "../tasks/handoverFiles";

fakeCrewTimersEachTest();

describe("a crewmate's turn, as CrewTurns runs it", () => {
  it("names a report's handed files by kept name and size once they arrived whole, and refuses one that did not", async () => {
    const crewmate = fakeCrewmate();
    const h = setup(crewmate);
    const { taskId } = await h.supervisor.intake.commission({
      title: "Find the screenshot",
      intent: intentOf("find the screenshot of the clipped card"),
    });
    await tick();
    const report = h.specs.at(-1)?.onReport;
    if (!report) throw new Error("the crewmate's report tool is not bound");
    const picture = join(scratchDir("infinitary-handed-"), "clipped card.png");
    writeFileSync(picture, "a picture of the clipped card");
    const [kept] = await keepHandoverFiles([picture], crewmateHandoverDir(h.paths, taskId));
    if (!kept) throw new Error("the picture was not kept");

    // The refusal's words are owned by src/core/tasks/handoverFiles.test.ts;
    // here the report is refused, naming the file that did not arrive whole.
    await expect(
      Promise.resolve(
        report("The screenshot is ready.", undefined, {
          files: [{ ...kept, size: kept.size + 1 }],
        }),
      ),
    ).rejects.toThrow(kept.file);

    expect(await report("The screenshot is ready.", undefined, { files: [kept] })).toContain(
      "Reported.",
    );
    crewmate.emit({ type: "turn_end", taskId });
    crewmate.finishPrompt();
    await tick();
    const key = h.tasks.get(taskId)?.key;
    const handed = `Files handed on, kept for steer_crewmate files_from ${key}: ${kept.file} (${fileSizeWords(kept.size)}).`;
    expect(h.ledger.filter((wake) => wake.includes("The screenshot is ready."))).toEqual([
      expect.stringContaining(`The screenshot is ready.\n\n${handed}`),
    ]);
    expect(h.ledger.join("\n")).not.toContain("a picture of the clipped card");
  });

  it("serves guidance a backend could not take mid-turn as the next turn, which reports nothing of the last one's", async () => {
    const crewmate = fakeQueuedSteerCrewmate();
    const h = setup(crewmate);
    const { taskId } = await h.supervisor.intake.commission({
      title: "Count presses",
      intent: intentOf("make the meter count every press"),
    });
    await tick();

    expect(await h.supervisor.steer.steerCrewmate(taskId, "count the long presses too")).toBe(
      "queued-next-turn",
    );
    expect(crewmate.promptCalls).toHaveLength(1);

    await reportTurn(crewmate, taskId, "The meter counts every press.");
    expect(h.sorts.map((sort) => sort.taskId)).toEqual([taskId]);
    expect(crewmate.promptCalls).toHaveLength(2);
    expect(crewmate.promptCalls[1]).toContain("count the long presses too");
    expect(h.inbox.inFlight(taskId)).toHaveLength(1);

    // The guidance turn ends with nothing said: the first turn's report is not routed again.
    crewmate.emit({ type: "turn_end", taskId });
    crewmate.finishPrompt();
    await tick();
    expect(h.sorts.map((sort) => sort.taskId)).toEqual([taskId]);
    expect(h.ledger.filter((wake) => wake.includes("The meter counts every press."))).toHaveLength(
      1,
    );
    expect(h.inbox.inFlight(taskId)).toEqual([]);
    expect(h.inbox.pending(taskId)).toEqual([]);
    expect(crewmate.steer).not.toHaveBeenCalled();
  });
});

/**
 * INF-2599, the captain: "Send a crewmate its directions once, and again only
 * when they change". The audit behind it found the whole block on every
 * notice a crewmate was served. A project crewmate with two of the captain's
 * directions, on a stand-in model that reads each input the way a backend
 * says it did.
 */
describe("a crewmate's standing directions, as its turns carry them", () => {
  async function directedTask() {
    const crewmate = fakeCrewmate();
    let held: KnowledgeService | undefined;
    const h = setup(crewmate, {
      knowledge: (registry) => {
        held = new KnowledgeService({
          projects: { get: (id) => registry.get(id), list: () => registry.list() },
        });
        return held;
      },
    });
    const knowledge = held;
    if (!knowledge) throw new Error("the crew has no knowledge");
    const { repo } = await h.repos.setup({ kind: "init", name: "meter" });
    knowledge.directions.change({
      op: "add",
      id: "review-once",
      scope: repo.id,
      text: "Do not re-review a task only because main moved.",
      reason: "captain said so",
    });
    knowledge.directions.change({
      op: "add",
      id: "root-cause",
      scope: repo.id,
      text: "When a flaky test remains, fix its root cause instead of relying on re-runs.",
      reason: "captain said so",
    });
    const { taskId } = await h.supervisor.intake.commission({
      title: "Fix the meter",
      intent: intentOf("Make the press meter count every press."),
      repoId: repo.id,
    });
    await tick();
    return {
      crewmate,
      knowledge,
      /** The set a turn carries now, from its owner. */
      current: () =>
        renderDirections(
          knowledge.directions.standing({ kind: "crewmate", taskId, repoId: repo.id }),
        ) ?? "",
      /** The model makes its first request on the input, and the turn ends. */
      read: async () => {
        crewmate.emit({ type: "request_started" });
        crewmate.finishPrompt();
        await tick();
      },
      /** The first mate steers it once its turn is over: the turn served for it. */
      steer: async (text: string) => {
        const before = crewmate.promptCalls.length;
        await h.supervisor.steer.steerCrewmate(taskId, text);
        await tick();
        expect(crewmate.promptCalls).toHaveLength(before + 1);
        return crewmate.promptCalls.at(-1) ?? "";
      },
    };
  }

  it("serves them once, again when they change and after a fold, and not on an unchanged turn", async () => {
    const { crewmate, knowledge, current, read, steer } = await directedTask();
    const opening = current();
    expect(crewmate.promptCalls).toHaveLength(1);
    expect(crewmate.promptCalls[0]).toContain(opening);
    await read();

    const unchanged = await steer("Count the long presses too.");
    expect(unchanged).toContain("Count the long presses too.");
    expect(unchanged).not.toContain(opening);
    await read();

    knowledge.directions.change({ op: "retire", id: "review-once", reason: "captain retired it" });
    const changed = await steer("Carry on with the meter.");
    expect(current()).not.toBe(opening);
    expect(changed).toContain(current());
    expect(changed).not.toContain("Do not re-review a task only because main moved.");
    await read();
    expect(await steer("Say what blocks you, or finish.")).not.toContain(current());
    await read();

    // A fold replaces the conversation's older context, the set with it.
    crewmate.emit({ type: "context_compacted", turn: "unknown" });
    expect(await steer("Report when the meter passes.")).toContain(current());
    await read();
    expect(await steer("Open the pull request.")).not.toContain(current());
  });

  it("serves them again when the conversation never read the turn that carried them, or is a new one", async () => {
    const { crewmate, current, read, steer } = await directedTask();
    // The turn ended before the model read its input.
    crewmate.finishPrompt();
    await tick();
    const again = await steer("Count the long presses too.");
    expect(again).toContain(current());

    // A backend that confirms the exact input it read holds them too; a
    // confirmation of other words does not.
    crewmate.emit({ type: "input_read", textSha256: sha256("Count the long presses too.") });
    crewmate.finishPrompt();
    await tick();
    const unread = await steer("Carry on with the meter.");
    expect(unread).toContain(current());
    crewmate.emit({ type: "input_read", textSha256: sha256(unread) });
    crewmate.finishPrompt();
    await tick();
    expect(await steer("Say what blocks you, or finish.")).not.toContain(current());
    await read();

    // A renewal can mint a new conversation, which holds nothing yet.
    Object.assign(crewmate, { sessionId: "s2" });
    expect(await steer("Report when the meter passes.")).toContain(current());
  });
});

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
