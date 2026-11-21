import { PassThrough } from "node:stream";
import * as m from "@shared/i18n/messages.generated";
import { describe, expect, it } from "vitest";
import { RUN_WORDS } from "./runCommand";
import { runRefusalLines, terminalQuestion } from "./runHandOver";

/**
 * What a run says in its terminal when the one-time move cannot go on now,
 * and how it asks the person there before ending an older copy (docs/run.md,
 * "Before it starts"). The hand-over itself, with real older copies and a
 * real move, is ./runHandOver.integration.test.ts.
 */

const NAMES = { from: "Firstmate 3000", to: "Infinitary" };

function terminal() {
  const input = new PassThrough();
  const output = new PassThrough();
  let shown = "";
  output.on("data", (chunk) => {
    shown += String(chunk);
  });
  const stop = new AbortController();
  let interrupted = 0;
  const ask = terminalQuestion({
    input,
    output,
    interrupted: () => {
      interrupted += 1;
    },
    signal: stop.signal,
  });
  return { input, ask, stop, shown: () => shown, interrupted: () => interrupted };
}

describe("a run's words when the move cannot go on", () => {
  it("names the size a move needs and the free space in the person's units", () => {
    const [line] = runRefusalLines({ reason: "no-space", needed: 3e9, free: 1e9 }, NAMES);
    expect(line).toBe(m.handoverRunNoSpace({ needed: "3.0 GB", free: "1.0 GB" }));
  });

  it("says what failed without doubling the error's own full stop", () => {
    expect(
      runRefusalLines({ reason: "failed", detail: "The disk is full.", committed: false }, NAMES),
    ).toEqual([m.handoverRunFailed({ ...NAMES, detail: "The disk is full" })]);
    expect(
      runRefusalLines({ reason: "failed", detail: "The disk is full.", committed: true }, NAMES),
    ).toEqual([m.handoverRunUnfinished({ ...NAMES, detail: "The disk is full" })]);
  });

  it("says to quit an older copy that is still open or still working", () => {
    expect(runRefusalLines({ reason: "old-app-open" }, NAMES)).toEqual([
      m.handoverRunStillOpen(NAMES),
    ]);
    expect(runRefusalLines({ reason: "old-work-running" }, NAMES)).toEqual([
      m.handoverRunStillWorking(NAMES),
    ]);
  });

  it("leaves what only the window's both-folders answer meets to the window", () => {
    expect(runRefusalLines({ reason: "own-work-running" }, NAMES)).toEqual([...RUN_WORDS.handOver]);
  });
});

describe("asking the person at a terminal", () => {
  it("shows the question and its prompt, and answers the line typed", async () => {
    const at = terminal();
    const answer = at.ask(["It still holds your saved work."], "Type yes to stop it now: ");
    at.input.write("yes\n");
    expect(await answer).toBe("yes");
    expect(at.shown()).toBe("It still holds your saved work.\nType yes to stop it now: ");
  });

  it("answers nothing once the input closes", async () => {
    const at = terminal();
    const answer = at.ask(["It still holds your saved work."], "Type yes to stop it now: ");
    at.input.end();
    expect(await answer).toBe("");
  });

  it("answers nothing on a stop while it waits", async () => {
    const at = terminal();
    const answer = at.ask(["It still holds your saved work."], "Type yes to stop it now: ");
    at.stop.abort();
    expect(await answer).toBe("");
    expect(at.interrupted()).toBe(0);
  });
});
