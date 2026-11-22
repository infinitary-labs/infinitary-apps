import { describe, expect, it } from "vitest";
import {
  CLIP_BLEND_MS,
  EMOTE_DURATION_MS,
  FIDGET_DURATION_MS,
  type FidgetVariant,
  FirstmateMachine,
} from "./machine";

// Behaviors here are the ones the captain verified live in the Lavish review
// (firstmate/data/fm3000-character-animation-prototypes-s1/report.md):
// attention always wins, busy is a parameter rather than a state, emotes are
// one-shot / guarded / directly interruptible, and fidget draws from a pool
// without repeating.

function machine(random: () => number = () => 0) {
  return new FirstmateMachine(0, random);
}

describe("FirstmateMachine base reconciliation", () => {
  it("walks the attention loop with the named clips", () => {
    const m = machine();
    m.setInputs({ listening: true, busy: false }, 100);
    expect(m.update(100)).toMatchObject({ state: "listening", clip: "attend" });
    m.setInputs({ listening: false, busy: false }, 200);
    expect(m.update(200)).toMatchObject({ state: "idle", clip: "release" });
    m.setInputs({ listening: false, busy: true }, 300);
    expect(m.update(300)).toMatchObject({ state: "working", clip: "engage" });
    m.setInputs({ listening: false, busy: false }, 400);
    expect(m.update(400)).toMatchObject({ state: "idle", clip: "settle" });
  });

  it("keeps listening while busy flips - the ember is a parameter, not a state", () => {
    const m = machine();
    m.setInputs({ listening: false, busy: true }, 0);
    m.setInputs({ listening: true, busy: true }, 100);
    expect(m.update(100)).toMatchObject({ state: "listening", busy: true });
    // The turn ends mid-listening: the state must not move, only the color.
    m.setInputs({ listening: true, busy: false }, 200);
    expect(m.update(200)).toMatchObject({ state: "listening", busy: false });
  });

  it("release resolves home through busy: working when busy, idle otherwise", () => {
    const m = machine();
    m.setInputs({ listening: false, busy: true }, 0);
    m.setInputs({ listening: true, busy: true }, 100);
    m.setInputs({ listening: false, busy: true }, 200);
    expect(m.update(200)).toMatchObject({ state: "working", clip: "release" });
  });

  it("anticipates working on submit, then reconciles when busy never rises", () => {
    const m = machine();
    m.setInputs({ listening: true, busy: false }, 0);
    m.noteSubmit(100);
    expect(m.update(100)).toMatchObject({ state: "working", clip: "intake" });
    // Within the grace window a false busy must not settle it home.
    m.setInputs({ listening: false, busy: false }, 600);
    expect(m.update(600).state).toBe("working");
    // After the grace window inputs win again.
    m.setInputs({ listening: false, busy: false }, 2000);
    expect(m.update(2000)).toMatchObject({ state: "idle", clip: "settle" });
  });
});

describe("FirstmateMachine emotes", () => {
  it("fires from idle or working, never from listening or another emote", () => {
    const m = machine();
    expect(m.requestEmote("greet", 100)).toBe(true);
    expect(m.requestEmote("ponder", 200)).toBe(false); // one-shot, no queueing
    const busyMachine = machine();
    busyMachine.setInputs({ listening: false, busy: true }, 0);
    expect(busyMachine.requestEmote("celebrate", 100)).toBe(true);
    const listeningMachine = machine();
    listeningMachine.setInputs({ listening: true, busy: false }, 0);
    expect(listeningMachine.requestEmote("greet", 100)).toBe(false);
  });

  it("returns home through busy when the clip ends", () => {
    const m = machine();
    m.setInputs({ listening: false, busy: true }, 0);
    m.requestEmote("celebrate", 100);
    const t = 100 + EMOTE_DURATION_MS.celebrate + 1;
    expect(m.update(t)).toMatchObject({ state: "working", clip: "return" });
    const idleMachine = machine();
    idleMachine.requestEmote("greet", 100);
    const t2 = 100 + EMOTE_DURATION_MS.greet + 1;
    expect(idleMachine.update(t2)).toMatchObject({ state: "idle", clip: "return" });
  });

  it("is cut short directly by attention to listening", () => {
    const m = machine();
    m.requestEmote("ponder", 100);
    m.setInputs({ listening: true, busy: false }, 200);
    expect(m.update(200)).toMatchObject({ state: "listening", clip: "attend" });
  });

  // INF-790, the captain's ask: "keep the emote animation but change the
  // color to indicate the working status, similar to how we handle the
  // 'listening' state".
  it("plays on in ember when a turn starts, then returns to working", () => {
    const m = machine();
    m.requestEmote("ponder", 100);
    m.setInputs({ listening: false, busy: true }, 200);
    expect(m.update(200)).toMatchObject({ state: "ponder", busy: true, clip: "drift" });
    const t = 100 + EMOTE_DURATION_MS.ponder + 1;
    m.setInputs({ listening: false, busy: true }, t);
    expect(m.update(t)).toMatchObject({ state: "working", clip: "return" });
  });

  // INF-790 answer "send": a message the captain sends leaves a playing emote
  // alone, and the emote ending inside the submit grace goes to working.
  it("plays on through a send, then anticipates working for the grace", () => {
    const m = machine();
    m.requestEmote("greet", 100);
    const sent = 100 + EMOTE_DURATION_MS.greet - 500;
    m.noteSubmit(sent);
    m.setInputs({ listening: false, busy: false }, sent);
    expect(m.update(sent)).toMatchObject({ state: "greet" });
    const ended = 100 + EMOTE_DURATION_MS.greet + 1;
    m.setInputs({ listening: false, busy: false }, ended);
    expect(m.update(ended)).toMatchObject({ state: "working", clip: "return" });
    // Busy never rose: the grace runs out and the character rests.
    m.setInputs({ listening: false, busy: false }, sent + 1600);
    expect(m.update(sent + 1600)).toMatchObject({ state: "idle", clip: "settle" });
  });

  it("only cools when busy falls mid-emote - no state change", () => {
    const m = machine();
    m.setInputs({ listening: false, busy: true }, 0);
    m.requestEmote("celebrate", 100);
    m.setInputs({ listening: false, busy: false }, 200);
    expect(m.update(200)).toMatchObject({ state: "celebrate", busy: false });
  });
});

describe("FirstmateMachine crystalActive parameter", () => {
  it("never changes the state: crystal rising and falling only rides the snapshot", () => {
    const m = machine();
    m.setInputs({ listening: false, busy: true }, 0);
    expect(m.update(0)).toMatchObject({ state: "working", clip: "engage", crystalActive: false });
    m.setInputs({ listening: false, busy: true, crystalActive: true }, 100);
    expect(m.update(100)).toMatchObject({ state: "working", clip: "engage", crystalActive: true });
    m.setInputs({ listening: false, busy: true, crystalActive: false }, 5000);
    expect(m.update(5000)).toMatchObject({
      state: "working",
      clip: "engage",
      crystalActive: false,
    });
    const idle = machine();
    idle.setInputs({ listening: false, busy: false, crystalActive: true }, 0);
    expect(idle.update(0)).toMatchObject({ state: "idle", crystalActive: true });
  });

  it("lets attention win mid-crystal and returns to working with the crystal intact", () => {
    const m = machine();
    m.setInputs({ listening: false, busy: true, crystalActive: true }, 0);
    m.setInputs({ listening: true, busy: true, crystalActive: true }, 100);
    expect(m.update(100)).toMatchObject({ state: "listening", crystalActive: true });
    m.setInputs({ listening: false, busy: true, crystalActive: true }, 200);
    expect(m.update(200)).toMatchObject({ state: "working", clip: "release", crystalActive: true });
  });

  it("plays an emote mid-crystal and returns to working with the crystal intact", () => {
    const m = machine();
    m.setInputs({ listening: false, busy: true, crystalActive: true }, 0);
    expect(m.requestEmote("celebrate", 100)).toBe(true);
    m.setInputs({ listening: false, busy: true, crystalActive: true }, 200);
    expect(m.update(200)).toMatchObject({ state: "celebrate", crystalActive: true });
    const t = 100 + EMOTE_DURATION_MS.celebrate + 1;
    m.setInputs({ listening: false, busy: true, crystalActive: true }, t);
    expect(m.update(t)).toMatchObject({ state: "working", clip: "return", crystalActive: true });
  });
});

describe("FirstmateMachine folding parameter", () => {
  // INF-3011: the cinch is a look over working, so the canvas's name stays the state.
  it("never changes the state: folding only rides the snapshot", () => {
    const m = machine();
    m.setInputs({ listening: false, busy: true }, 0);
    expect(m.update(0)).toMatchObject({ state: "working", folding: false });
    m.setInputs({ listening: false, busy: true, folding: true }, 100);
    expect(m.update(100)).toMatchObject({ state: "working", clip: "engage", folding: true });
    m.setInputs({ listening: false, busy: true, folding: false }, 4000);
    expect(m.update(4000)).toMatchObject({ state: "working", folding: false });
    const idle = machine();
    idle.setInputs({ listening: false, busy: false, folding: true }, 0);
    expect(idle.update(0)).toMatchObject({ state: "idle", folding: true });
  });
});

describe("FirstmateMachine fidget pool", () => {
  it("draws the variant, honors its duration, and never repeats", () => {
    // random() = 0 always picks the first eligible variant, so consecutive
    // draws must alternate between the first two pool entries.
    const m = machine(() => 0);
    const pool = Object.keys(FIDGET_DURATION_MS) as FidgetVariant[];
    expect(m.requestEmote("fidget", 100)).toBe(true);
    const first = m.update(100).variant;
    expect(first).toBe(pool[0]);
    const firstDur = FIDGET_DURATION_MS[first as FidgetVariant];
    expect(m.update(100 + firstDur - 1).state).toBe("fidget");
    expect(m.update(100 + firstDur + 1).state).toBe("idle");
    const t = 100 + firstDur + 10;
    expect(m.requestEmote("fidget", t)).toBe(true);
    expect(m.update(t).variant).toBe(pool[1]); // the previous pick is excluded
  });

  it("keeps the black hole last in the pool: the black hole e2e's deterministic draw picks it", () => {
    const pool = Object.keys(FIDGET_DURATION_MS) as FidgetVariant[];
    expect(pool[pool.length - 1]).toBe("blackhole");
    // The sky fidgets (the captain's picks, 2026-09-29) sit between the
    // short fidgets and the black hole, each long enough to read.
    expect(pool).toEqual([
      "roll",
      "yawn",
      "orbit",
      "orion",
      "dipper",
      "saturn",
      "galaxy",
      "algol",
      // The warps (captain, INF-1750: "add all 3 actually"), before the black hole.
      "tunnel",
      "sphere",
      "corkscrew",
      "blackhole",
    ]);
    for (const sky of ["orion", "dipper", "saturn", "galaxy", "algol"] as const) {
      expect(FIDGET_DURATION_MS[sky]).toBeGreaterThanOrEqual(5_000);
      expect(FIDGET_DURATION_MS[sky]).toBeLessThan(6_000);
    }
  });

  it("auto-fidgets after idling and fidgets on tap", () => {
    const m = machine(() => 0.5);
    // The idle fidget timer is 9-16s; well past it, update self-fires.
    expect(m.update(20_000).state).toBe("fidget");
    const m2 = machine(() => 0.5);
    expect(m2.tap(100)).toBe("fidget");
    expect(m2.update(100).state).toBe("fidget");
    const busyMachine = machine();
    busyMachine.setInputs({ listening: false, busy: true }, 0);
    expect(busyMachine.tap(100)).toBe("kick");
  });
});

describe("FirstmateMachine clip table", () => {
  it("declares a blend duration for every clip it can play", () => {
    for (const clip of [
      "attend",
      "release",
      "intake",
      "engage",
      "settle",
      "hail",
      "burst",
      "drift",
      "tangle",
      "dip",
      "snap",
      "mark",
      "stow",
      "blush",
      "return",
      ...Object.keys(FIDGET_DURATION_MS),
    ]) {
      expect(CLIP_BLEND_MS[clip], clip).toBeGreaterThan(0);
    }
  });
});

describe("FirstmateMachine reply emotes (captain's board verdict, 2026-09-22)", () => {
  const off = { listening: false, busy: false };
  const turn = { listening: false, busy: true };

  it("holds a reply asked for during the Firstmate's turn and plays it as the turn ends", () => {
    const m = machine();
    m.setInputs(turn, 0);
    expect(m.requestEmote("nod", 100)).toBe(true);
    // Still working: the reply lands with the answer, not in the work.
    expect(m.update(500).state).toBe("working");
    m.setInputs(off, 1000);
    expect(m.update(1000)).toMatchObject({ state: "nod", clip: "dip", busy: false });
    expect(m.update(1000 + EMOTE_DURATION_MS.nod).state).toBe("idle");
  });

  it("keeps the reply through typing mid-turn, and plays it once the turn ends", () => {
    const m = machine();
    m.setInputs({ listening: true, busy: true }, 0);
    expect(m.requestEmote("tuck", 100)).toBe(true);
    m.setInputs(turn, 200);
    expect(m.update(200).state).toBe("working");
    m.setInputs(off, 900);
    expect(m.update(900).state).toBe("tuck");
  });

  it("drops the reply when the captain's attention is on the character as the turn ends", () => {
    const m = machine();
    m.setInputs(turn, 0);
    m.requestEmote("tick", 100);
    m.setInputs({ listening: true, busy: true }, 200);
    m.setInputs({ listening: true, busy: false }, 300);
    expect(m.update(300).state).toBe("listening");
    m.setInputs(off, 400);
    expect(m.update(400).state).toBe("idle");
    // Nothing is left over for a later turn.
    m.setInputs(turn, 500);
    m.setInputs(off, 800);
    expect(m.update(800).state).toBe("idle");
  });

  it("plays one reply per turn - the first asked for", () => {
    const m = machine();
    m.setInputs(turn, 0);
    expect(m.requestEmote("nod", 100)).toBe(true);
    expect(m.requestEmote("nod", 110)).toBe(true);
    expect(m.requestEmote("aww", 120)).toBe(false);
    m.setInputs(off, 600);
    expect(m.update(600).state).toBe("nod");
    // The next turn starts with an empty slot.
    m.update(600 + EMOTE_DURATION_MS.nod);
    m.setInputs(turn, 5000);
    expect(m.requestEmote("aww", 5100)).toBe(true);
    m.setInputs(off, 5600);
    expect(m.update(5600).state).toBe("aww");
  });

  it("leaves the shipped emotes as they were: a celebrate mid-turn plays at once", () => {
    const m = machine();
    m.setInputs(turn, 0);
    expect(m.requestEmote("celebrate", 100)).toBe(true);
    expect(m.update(100).state).toBe("celebrate");
  });

  it("never interrupts another emote: one still playing as the turn ends drops the reply", () => {
    const m = machine();
    m.setInputs(turn, 0);
    m.requestEmote("nod", 100);
    m.requestEmote("celebrate", 200);
    m.setInputs(off, 400);
    expect(m.update(400).state).toBe("celebrate");
    expect(m.update(200 + EMOTE_DURATION_MS.celebrate).state).toBe("idle");
  });

  it("plays a reply at once when no turn is running", () => {
    const m = machine();
    expect(m.requestEmote("salute", 100)).toBe(true);
    expect(m.update(100)).toMatchObject({ state: "salute", clip: "snap" });
  });
});

describe("FirstmateMachine review aids", () => {
  it("fires a named fidget variant on request and remembers it as the last pick", () => {
    const m = machine(() => 0);
    expect(m.requestEmote("fidget", 100, "blackhole")).toBe(true);
    expect(m.update(100)).toMatchObject({ state: "fidget", variant: "blackhole" });
    m.update(100 + FIDGET_DURATION_MS.blackhole);
    // The forced pick counts as the previous one: the next random draw skips it.
    m.requestEmote("fidget", 10_000);
    expect(m.update(10_000).variant).not.toBe("blackhole");
  });

  it("pins an emote's progress until released, then runs on from there", () => {
    const m = machine();
    m.requestEmote("fidget", 0, "blackhole");
    m.pinEmote(0.5, 1000);
    expect(m.update(1000).emoteT).toBeCloseTo(0.5, 3);
    expect(m.update(9000).emoteT).toBeCloseTo(0.5, 3);
    expect(m.update(9000).state).toBe("fidget");
    m.pinEmote(null, 9000);
    const dur = FIDGET_DURATION_MS.blackhole;
    expect(m.update(9000 + dur * 0.25).emoteT).toBeCloseTo(0.75, 3);
    expect(m.update(9000 + dur).state).toBe("idle");
  });

  it("drops the pin when attention or a turn interrupts the emote", () => {
    const m = machine();
    m.requestEmote("fidget", 0, "blackhole");
    m.pinEmote(0.5, 0);
    m.setInputs({ listening: true, busy: false }, 100);
    expect(m.update(100).state).toBe("listening");
    m.setInputs({ listening: false, busy: false }, 200);
    // Back home the pin is gone: a fresh emote runs on its own clock.
    m.requestEmote("fidget", 300, "roll");
    expect(m.update(300 + FIDGET_DURATION_MS.roll).state).toBe("idle");
  });
});
