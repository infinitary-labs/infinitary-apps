/**
 * A crewmate's turn as the crew's turn owner runs it (`CrewTurns`;
 * docs/report-sort.md, docs/inbox.md, INF-992): a report that hands files on,
 * checked whole and named by kept name and size only, and the guidance a
 * backend could not take mid-turn, served as the next turn once the report's
 * turn is over, which reports nothing of its own. These cases pin the
 * behaviour no other test reaches. Each plays the crewmate's session and
 * tools and reads the receipt, the report the first mate is served and the
 * record.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileSizeWords } from "@shared/attachments";
import { describe, expect, it } from "vitest";
import {
  fakeCrewmate,
  fakeQueuedSteerCrewmate,
  intentOf,
  reportTurn,
  setup,
  tick,
} from "../../../tests/helpers/crewHarness";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { crewmateHandoverDir } from "../paths";
import { keepHandoverFiles } from "../tasks/handoverFiles";

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

    await expect(
      Promise.resolve(
        report("The screenshot is ready.", undefined, {
          files: [{ ...kept, size: kept.size + 1 }],
        }),
      ),
    ).rejects.toThrow(`${kept.file} did not arrive whole; report it again.`);

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
