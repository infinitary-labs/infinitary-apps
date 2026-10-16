import type { CrewWord } from "@shared/firstRun";
import { describe, expect, it } from "vitest";
import {
  CREW_STATE_WORD,
  NO_STATE_WORD,
  type StateWordCrew,
  type StateWordInput,
  type StateWordState,
  stepStateWord,
} from "./stateWords";

const mate = (id: string, status: "working" | "idle", over: Partial<StateWordCrew> = {}) => ({
  id,
  status,
  phase: "orbiting" as const,
  work: status === "working" ? 1 : 0,
  ...over,
});

const base: Omit<StateWordInput, "now"> = {
  crew: [mate("a", "working")],
  taught: { working: false, idle: false },
  visible: true,
  summaryOf: null,
  reducedMotion: false,
};

/** Reads the rule every 100 ms from `from` to `to`, collecting what it taught. */
function run(
  start: StateWordState,
  from: number,
  to: number,
  input: (now: number) => Partial<StateWordInput>,
) {
  let state = start;
  const taught: CrewWord[] = [];
  let view = null as ReturnType<typeof stepStateWord>["view"];
  for (let now = from; now <= to; now += 100) {
    const step = stepStateWord(state, { ...base, now, ...input(now) });
    state = step.state;
    view = step.view;
    if (step.taught) taught.push(step.taught);
  }
  return { state, taught, view };
}

describe("a state word", () => {
  it("does not teach an idle word from unknown last-known remote activity", () => {
    const result = run(NO_STATE_WORD, 0, 8000, () => ({
      crew: [mate("remote", "idle", { activityUnknown: true })],
    }));
    expect(result.view).toBeNull();
    expect(result.taught).toEqual([]);
  });

  it("appears after a settled crewmate has held its state for a second, and counts after a full showing", () => {
    const early = run(NO_STATE_WORD, 0, CREW_STATE_WORD.holdMs - 100, () => ({}));
    expect(early.view).toBeNull();
    const shown = run(
      early.state,
      CREW_STATE_WORD.holdMs,
      CREW_STATE_WORD.holdMs + 5900,
      () => ({}),
    );
    expect(shown.view).toEqual({ id: "a", word: "working", on: true });
    expect(shown.taught).toEqual([]);
    const done = stepStateWord(shown.state, { ...base, now: 7000 });
    expect(done.taught).toBe("working");
    // The word fades out, and the caller's record now says it was taught.
    expect(done.view).toEqual({ id: "a", word: "working", on: false });
    const after = stepStateWord(done.state, {
      ...base,
      now: 7000 + CREW_STATE_WORD.fadeOutMs,
      taught: { working: true, idle: false },
    });
    expect(after.view).toBeNull();
  });

  it("is written once: with the word taught, the same crewmate shows nothing again", () => {
    const first = run(NO_STATE_WORD, 0, 8000, () => ({}));
    expect(first.taught).toEqual(["working"]);
    const later = run(first.state, 8100, 20000, () => ({
      taught: { working: true, idle: false },
    }));
    expect(later.taught).toEqual([]);
    expect(later.view).toBeNull();
  });

  it("shows nothing for a crewmate that is idle for a few frames before leaving", () => {
    const working = run(NO_STATE_WORD, 0, 3000, () => ({}));
    const blip = run(working.state, 3100, 3300, () => ({ crew: [mate("a", "idle")] }));
    expect(blip.view?.word).not.toBe("idle");
    const gone = run(blip.state, 3400, 9000, () => ({
      crew: [mate("a", "idle", { phase: "leaving" })],
    }));
    expect(gone.taught).toEqual([]);
  });

  it("waits for the blend to settle and never shows on a spawning crewmate", () => {
    const warming = run(NO_STATE_WORD, 0, 3000, () => ({
      crew: [mate("a", "working", { work: 0.5 })],
    }));
    expect(warming.view).toBeNull();
    const spawning = run(NO_STATE_WORD, 0, 3000, () => ({
      crew: [mate("a", "working", { phase: "spawning" })],
    }));
    expect(spawning.view).toBeNull();
  });

  it("waits for the summary of its own crewmate", () => {
    expect(run(NO_STATE_WORD, 0, 3000, () => ({ summaryOf: "a" })).view).toBeNull();
  });

  it.each([
    ["a card covers the stage", { visible: false }],
    ["its color changes", { crew: [mate("a", "idle")] }],
    ["the crewmate leaves", { crew: [mate("a", "working", { phase: "leaving" })] }],
    ["the crewmate is gone", { crew: [] }],
    ["its summary opens", { summaryOf: "a" }],
  ] as const)("is cancelled and counts for nothing when %s", (_name, cut) => {
    const showing = run(NO_STATE_WORD, 0, 4000, () => ({}));
    expect(showing.view?.on).toBe(true);
    const cancelled = run(showing.state, 4100, 4200, () => cut);
    expect(cancelled.taught).toEqual([]);
    expect(cancelled.view?.on ?? false).toBe(false);
    // Offered again afterwards: a full uninterrupted showing is taught.
    const again = run(cancelled.state, 4300, 14000, () => ({}));
    expect(again.taught).toEqual(["working"]);
  });

  it("does not count time a hidden window stalled the clock", () => {
    const showing = run(NO_STATE_WORD, 0, 4000, () => ({}));
    const back = stepStateWord(showing.state, { ...base, now: 60000 });
    expect(back.taught).toBeNull();
    expect(back.state.showing).toBeNull();
  });

  it("teaches the two words independently, the earliest crewmate in a state carrying it", () => {
    const crew = [mate("a", "working"), mate("b", "idle"), mate("c", "working")];
    const first = run(NO_STATE_WORD, 0, 8000, () => ({ crew }));
    expect(first.taught).toEqual(["working"]);
    const second = run(first.state, 8100, 16000, () => ({
      crew,
      taught: { working: true, idle: false },
    }));
    expect(second.taught).toEqual(["idle"]);
  });

  it("settles by state alone under reduced motion", () => {
    const still = run(NO_STATE_WORD, 0, 8000, () => ({
      crew: [mate("a", "working", { work: 0.2 })],
      reducedMotion: true,
    }));
    expect(still.taught).toEqual(["working"]);
  });
});
