import type { PlacedSpec } from "@shared/work";
import { describe, expect, it } from "vitest";
import { scriptedClaudeWorld } from "../../../tests/helpers/scriptedClaudeContract";
import {
  api,
  model,
  placed,
  sessionHostHooks,
  TASK,
} from "../../../tests/helpers/sessionHostWorld";
import { PlacedTasks } from "./placedTasks";

/**
 * A computer that runs work saving its crew's work before its home updates
 * it (docs/helper.md, "Saving its work before an update";
 * `tests/helpers/sessionHostWorld.ts`): it decides when its work is saved,
 * holds turns meanwhile, stops a turn its crewmate carries on by itself,
 * lets the save go by itself only when its home says nothing after it, and
 * names the turns it stopped to a let-go asked after it restarted.
 */

sessionHostHooks();

describe("a computer that runs work saving its crew's work before its update", () => {
  it("answers once the running call finished and the home has the turn's end, holds a turn asked meanwhile as unstarted, and lets the save go by itself when its home says nothing", async () => {
    const at = await placed({ updateReturnMs: 100 });
    await at.open();
    const report = at.home.hold("inf:work:report");
    model([
      { tools: [{ name: "report", args: { text: "Checked the footer." } }] },
      { text: "Fixed the footer." },
    ]);
    await at.order("inf:session:prompt", [{ orderId: "rows:1", task: TASK, text: "Go." }]);
    await report.reached;

    let answered = false;
    const saving = at.order("inf:session:save-for-update", []).then((answer) => {
      answered = true;
      return answer;
    });
    // Asked again, as after the home dropped and came back: the same save.
    const again = at.order("inf:session:save-for-update", []);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(answered).toBe(false);

    report.open();
    expect(await saving).toEqual({ stopped: [TASK] });
    expect(await again).toEqual({ stopped: [TASK] });
    // The home had the call's answer and the turn's end before the save answered.
    expect(at.home.effects.map((effect) => effect.channel)).toContain("inf:work:report");
    expect(
      at.home.events.find((record) => record.event.type === "turn_ended")?.event,
    ).toMatchObject({ turn: 1 });
    const asked = api.requests.length;

    // A turn asked while the save holds never reaches its model.
    await at.order("inf:session:prompt", [{ orderId: "rows:2", task: TASK, text: "Next." }]);
    await at.ended(2);
    expect(at.home.events.at(-1)?.event).toMatchObject({
      type: "turn_ended",
      turn: 2,
      outcome: "failed",
      unstarted: true,
    });
    expect(api.requests.length).toBe(asked);

    // The home said nothing for the computer's whole wait after the save: it
    // lets the save go, and turns run again.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const { turn } = await at.order("inf:session:prompt", [
      { orderId: "rows:3", task: TASK, text: "Carry on." },
    ]);
    await at.ended(turn);
    expect(at.home.events.at(-1)?.event).toMatchObject({ type: "turn_ended", outcome: "done" });
    expect(api.requests.length).toBeGreaterThan(asked);
    // Let go already, and a turn reached its model since: the release names nothing.
    expect(await at.order("inf:session:release-update", [])).toEqual({
      stopped: [],
      withdrawn: [],
    });
  });

  // Saved the way this computer's own update saves its work: a turn begun by
  // itself during the save stops too, and the save holds while its home keeps
  // asking, as during a long download for the update.
  it("stops a turn its crewmate carries on by itself while the save holds, keeps the save while its home keeps asking, and forgets that stop once it carries on after the let-go", async () => {
    const claude = await scriptedClaudeWorld();
    const at = await placed({ claude, updateReturnMs: 1_000 });
    const spec: PlacedSpec = { ...at.spec, binding: { backend: "claude" }, model: claude.model };
    claude.answer({ text: "The background check started." });
    try {
      await at.order("inf:session:open", [{ orderId: "open:carry-on", task: TASK, spec }]);
      await at.order("inf:session:prompt", [
        { orderId: "rows:carry-on", task: TASK, text: "Start the background check." },
      ]);
      await at.ended(1);
      expect(await at.order("inf:session:save-for-update", [])).toEqual({ stopped: [] });

      claude.answer({
        tool: "note_progress",
        args: { text: "Reading the background check." },
        answer: "The background check passed.",
      });
      claude.continueTurn();
      const carriedOn = () =>
        at.home.events.filter(({ event }) => event.type === "continuation_ended").length;
      await expect.poll(carriedOn).toBe(1);
      // It carries on once more after the save stopped it: that turn stops too.
      claude.answer({
        tool: "note_progress",
        args: { text: "Reading the second check." },
        answer: "The second check passed.",
      });
      claude.continueTurn();
      await expect.poll(carriedOn).toBe(2);
      // Each call was refused before it ran: the home never heard of either.
      expect(at.home.effects.map((effect) => effect.channel)).not.toContain("inf:work:progress");

      // The home asks something more often than the computer's wait, for
      // longer than it: the save holds, and a turn asked now never starts.
      const until = Date.now() + 2_500;
      while (Date.now() < until) {
        await at.order("inf:session:roster", []);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await at.order("inf:session:prompt", [{ orderId: "rows:held", task: TASK, text: "Next." }]);
      await at.ended(2);
      expect(at.home.events.at(-1)?.event).toMatchObject({ type: "turn_ended", unstarted: true });

      // Let go, the save names the turn it stopped, which its home carries on.
      expect(await at.order("inf:session:release-update", [])).toEqual({
        stopped: [TASK],
        withdrawn: [],
      });

      // From review: once it carries on by itself with no save held, what the
      // save stopped is over, and a later update's let-go no longer names it.
      claude.answer({ text: "Picked the background check up again." });
      claude.continueTurn();
      await expect.poll(carriedOn).toBe(3);
      expect(await at.order("inf:session:release-update", [])).toEqual({
        stopped: [],
        withdrawn: [],
      });
    } finally {
      claude.endClient();
    }
  });

  // From review: a home that comes back to a save it no longer follows
  // lets it go, and must hear which turn goes on there instead of stopping.
  it("names the task whose stop it withdrew when let go while its call still runs, and that turn goes on", async () => {
    const at = await placed();
    await at.open();
    const report = at.home.hold("inf:work:report");
    model([
      { tools: [{ name: "report", args: { text: "Checked the footer." } }] },
      { text: "Fixed the footer." },
    ]);
    await at.order("inf:session:prompt", [{ orderId: "rows:1", task: TASK, text: "Go." }]);
    await report.reached;
    const saving = at.order("inf:session:save-for-update", []);

    expect(await at.order("inf:session:release-update", [])).toEqual({
      stopped: [],
      withdrawn: [TASK],
    });
    expect(await saving).toEqual({ stopped: [] });
    report.open();
    await at.ended(1);
    expect(at.home.events.at(-1)?.event).toMatchObject({
      type: "turn_ended",
      turn: 1,
      outcome: "done",
    });
  });

  // From review: a home that comes back after this computer restarted asks
  // it to let go, and must hear which turn its save stopped, so that turn's
  // end is read as the update's pause and carried on, never as its finish.
  it("still names the turn its save stopped after it restarts, until a turn reaches its model there", async () => {
    const at = await placed();
    await at.open();
    const report = at.home.hold("inf:work:report");
    model([
      { tools: [{ name: "report", args: { text: "Checked the footer." } }] },
      { text: "Fixed the footer." },
    ]);
    await at.order("inf:session:prompt", [{ orderId: "rows:1", task: TASK, text: "Go." }]);
    await report.reached;
    const saving = at.order("inf:session:save-for-update", []);
    report.open();
    expect(await saving).toEqual({ stopped: [TASK] });

    await at.restartComputer();
    expect(await at.order("inf:session:release-update", [])).toEqual({
      stopped: [TASK],
      withdrawn: [],
    });

    await at.order("inf:session:open", [{ orderId: "open:again", task: TASK, spec: at.spec }]);
    model([{ text: "Picked the footer up again." }]);
    const { turn } = await at.order("inf:session:prompt", [
      { orderId: "rows:2", task: TASK, text: "Carry on." },
    ]);
    await at.ended(turn);
    expect(at.home.events.at(-1)?.event).toMatchObject({ type: "turn_ended", outcome: "done" });
    expect(await at.order("inf:session:release-update", [])).toEqual({
      stopped: [],
      withdrawn: [],
    });
  });

  // From review: a later update's save names only its own stops, so a turn
  // that stop withdraws is never read as stopped by an earlier update.
  it("names to a later save only its own stops, once the home has the earlier stopped turn's end", async () => {
    const at = await placed();
    await at.open();
    const report = at.home.hold("inf:work:report");
    model([
      { tools: [{ name: "report", args: { text: "Checked the footer." } }] },
      { text: "Fixed the footer." },
    ]);
    await at.order("inf:session:prompt", [{ orderId: "rows:1", task: TASK, text: "Go." }]);
    await report.reached;
    const saving = at.order("inf:session:save-for-update", []);
    report.open();
    expect(await saving).toEqual({ stopped: [TASK] });
    expect(await at.order("inf:session:release-update", [])).toEqual({
      stopped: [TASK],
      withdrawn: [],
    });

    // No turn started there since, as for a turn that had already reported.
    expect(await at.order("inf:session:save-for-update", [])).toEqual({ stopped: [] });
    expect(await at.order("inf:session:release-update", [])).toEqual({
      stopped: [],
      withdrawn: [],
    });
  });

  // A quit while the save still waits on a running call cuts that turn
  // instead: it is the save's too, and its end is read as the pause.
  it("names a turn the quit cut while its save was stopping it as one the save stopped", async () => {
    const at = await placed();
    await at.open();
    const report = at.home.hold("inf:work:report");
    model([
      { tools: [{ name: "report", args: { text: "Checked the footer." } }] },
      { text: "Fixed the footer." },
    ]);
    await at.order("inf:session:prompt", [{ orderId: "rows:1", task: TASK, text: "Go." }]);
    await report.reached;
    void at.order("inf:session:save-for-update", []).catch(() => undefined);
    const state = () => new PlacedTasks(at.dataDir).state(TASK);
    await expect.poll(() => state().updateStop).toBe("stopping");

    // It quits while the call still runs: the quit cuts the turn, and the
    // call is let finish only then, so the run can let its conversation go.
    const restarting = at.restartComputer();
    await expect.poll(() => state().running).toBeUndefined();
    report.open();
    await restarting;
    await at.ended(1);
    expect(
      at.home.events.find((record) => record.event.type === "turn_ended")?.event,
    ).toMatchObject({ turn: 1, outcome: "interrupted" });
    expect(await at.order("inf:session:release-update", [])).toEqual({
      stopped: [TASK],
      withdrawn: [],
    });
  });
});
