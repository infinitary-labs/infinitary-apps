// The Firstmate character's animation state machine - the captain-approved
// design from firstmate/data/fm3000-character-animation-prototypes-s1
// (report.md, iterated live with the captain): named states, an explicit
// clip for every transition, one-shot emotes with a randomized fidget pool,
// and ONE blend parameter - busy - that drives the ember independently of
// state, so listening - or an emote a turn starts under - runs hot while the
// agent's own turn continues and cools in place the moment it ends.
//
// The reviewed prototype was event-sourced (voiceStart/typeStart/...). The
// app version reconciles against the shell's derived inputs instead -
// listening from voice/typing (HomeMate), busy from the firstmate_state
// event - so the machine can never wedge out of sync with the store: inputs
// are authoritative, and the one anticipation (submit plays intake into
// working before busy confirms) expires on a bounded grace window.
//
// This module is DOM-free and time-injected so it unit-tests in node.

import type { FidgetVariant } from "@shared/emotes";
import { isReplyEmote, REPLY_DURATION_MS, type ReplyEmote } from "./replies";
import { SUPERNOVA } from "./supernova";
import { WARP } from "./warp";

export type { FidgetVariant };

export type FirstmateBaseState = "idle" | "listening" | "working";
export type FirstmateEmote =
  | "greet"
  | "celebrate"
  | "ponder"
  | "confused"
  | "fidget"
  // Reply emotes (./replies): the trivial no-card replies.
  | ReplyEmote;
export type FirstmateState = FirstmateBaseState | FirstmateEmote;

export type TransitionClip =
  | "none"
  | "attend" // -> listening: attention (voice or typing) arrives
  | "release" // listening -> home (working when busy, idle otherwise)
  | "intake" // listening -> working: the turn was submitted
  | "engage" // -> working: the agent's own turn begins
  | "settle" // working -> idle: the turn ended
  | "hail" // -> greet
  | "burst" // -> celebrate
  | "drift" // -> ponder
  | "tangle" // -> confused
  | "dip" // -> nod ("got it")
  | "snap" // -> salute ("on it")
  | "mark" // -> tick ("all set")
  | "stow" // -> tuck ("noted")
  | "blush" // -> aww ("any time")
  | "return" // emote -> home
  | FidgetVariant; // -> fidget, named by the drawn pool variant

export const EMOTE_DURATION_MS: Record<FirstmateEmote, number> = {
  greet: 2100,
  celebrate: 2300,
  ponder: 2800,
  confused: 2300,
  fidget: 1900, // placeholder - the drawn variant's duration governs
  ...REPLY_DURATION_MS,
};

export const FIDGET_DURATION_MS: Record<FidgetVariant, number> = {
  roll: 2300,
  yawn: 2500,
  orbit: 2200,
  orion: 5400,
  dipper: 5000,
  saturn: 5200,
  galaxy: 5800,
  algol: 5000,
  // The warps' length is the captain's setting on the prototype card.
  tunnel: WARP.durationMs,
  sphere: WARP.durationMs,
  corkscrew: WARP.durationMs,
  // The supernova's length is the captain's setting on its preview card.
  supernova: SUPERNOVA.durationMs,
  // Last on purpose: the pool draws by key order, and the black hole's e2e
  // picks "the last variant" with a deterministic draw.
  blackhole: 5600,
};

const EMOTE_ENTRY_CLIP: Record<Exclude<FirstmateEmote, "fidget">, TransitionClip> = {
  greet: "hail",
  celebrate: "burst",
  ponder: "drift",
  confused: "tangle",
  nod: "dip",
  salute: "snap",
  tick: "mark",
  tuck: "stow",
  aww: "blush",
};

export const CLIP_BLEND_MS: Record<string, number> = {
  none: 1,
  attend: 350,
  release: 450,
  intake: 400,
  engage: 400,
  settle: 500,
  hail: 250,
  burst: 250,
  drift: 300,
  tangle: 250,
  dip: 200,
  snap: 200,
  mark: 250,
  stow: 250,
  blush: 300,
  return: 350,
  roll: 250,
  yawn: 250,
  orbit: 250,
  orion: 250,
  dipper: 250,
  saturn: 250,
  galaxy: 250,
  algol: 250,
  tunnel: 250,
  sphere: 250,
  corkscrew: 250,
  supernova: 250,
  blackhole: 250,
};

/** After a submit, how long the anticipated working state may run ahead of
 * the busy signal before inputs reconcile it back. */
const SUBMIT_GRACE_MS = 1500;

const isEmote = (s: FirstmateState): s is FirstmateEmote => Object.hasOwn(EMOTE_DURATION_MS, s);

export type MachineSnapshot = {
  state: FirstmateState;
  busy: boolean;
  /** ms since entering the current state */
  phase: number;
  /** normalized 0..1 progress of the active emote, else 0 */
  emoteT: number;
  variant: FidgetVariant | null;
  clip: TransitionClip;
  /** 0..1 progress of the active transition blend */
  blendT: number;
  /** Preserved crystal-animation parameter, carried for the renderer only. */
  crystalActive: boolean;
  /** The first mate is shortening its conversation (./cinch), carried for the renderer only. */
  folding: boolean;
};

export type MachineInputs = {
  listening: boolean;
  busy: boolean;
  crystalActive?: boolean;
  folding?: boolean;
  /** Cards cover the first mate: idle fidgets wait, and a card coming up drops a held stage-cleared fidget. */
  hidden?: boolean;
};

export class FirstmateMachine {
  private state: FirstmateState = "idle";
  private listening = false;
  private busy = false;
  private crystalActive = false;
  private folding = false;
  private enteredAt: number;
  private clip: TransitionClip = "none";
  private clipStart: number;
  private variant: FidgetVariant | null = null;
  private lastFidget: FidgetVariant | null = null;
  private fidgetAt: number;
  /** When the idle fidget delay counts from: entering idle, or the cards leaving. */
  private fidgetFrom: number;
  private hidden = false;
  /** The captain's press cleared the stage while another emote played: the fidget it plays next. */
  private pendingClearFidget = false;
  private submitGraceUntil = 0;
  /** Normalized emote progress the clock is pinned at, else null (review/test aid). */
  private pinnedT: number | null = null;
  /** A reply emote asked for during the Firstmate's own turn, held for its end. */
  private pendingReply: ReplyEmote | null = null;

  constructor(
    now: number,
    private random: () => number = Math.random,
  ) {
    this.enteredAt = now;
    this.clipStart = now;
    this.fidgetFrom = now;
    this.fidgetAt = this.nextFidgetDelay();
  }

  private nextFidgetDelay(): number {
    return 9000 + this.random() * 7000;
  }

  private go(to: FirstmateState, clip: TransitionClip, now: number): void {
    this.state = to;
    this.enteredAt = now;
    this.clip = clip;
    this.clipStart = now;
    if (to === "idle") {
      this.fidgetFrom = now;
      this.fidgetAt = this.nextFidgetDelay();
    }
    if (to !== "fidget") this.variant = null;
    if (!isEmote(to)) this.pinnedT = null;
  }

  stateNow(): FirstmateState {
    return this.state;
  }

  /**
   * Reconcile against the shell's derived inputs. Attention always wins -
   * listening interrupts any state, emotes included. Busy is the parameter:
   * flipping it during listening or an emote changes only the color - a
   * turn starting while an emote plays lets it finish in ember, then home is
   * working - and a turn ending while working settles home, or into the
   * reply held back during the turn, which plays as the ember cools.
   */
  setInputs(inputs: MachineInputs, now: number): void {
    const busyFell = !inputs.busy && this.busy;
    this.busy = inputs.busy;
    // The turn ended: a held reply plays now or not at all. Attention on the
    // character, or another emote still playing, drops it - the captain has
    // moved on, and an emote never interrupts another.
    const reply = busyFell ? this.pendingReply : null;
    if (busyFell) this.pendingReply = null;
    // Crystal activation is a parameter like busy, and unlike busy it never moves
    // the state: nothing below reads it.
    this.crystalActive = inputs.crystalActive ?? false;
    // So is folding: the cinch is a look over working, never a state.
    this.folding = inputs.folding ?? false;
    this.listening = inputs.listening;
    // Cards covering the first mate pause its idle fidgets; the next one
    // counts from when they leave. A card coming up, or attention, drops a
    // held stage-cleared fidget.
    const hidden = inputs.hidden ?? false;
    if (hidden && !this.hidden) this.pendingClearFidget = false;
    if (!hidden && this.hidden) this.fidgetFrom = now;
    this.hidden = hidden;
    if (inputs.listening) this.pendingClearFidget = false;

    if (inputs.listening) {
      if (this.state !== "listening") this.go("listening", "attend", now);
      return;
    }
    if (this.state === "listening") {
      // Attention left. During the submit grace the intake already ran; an
      // abandon releases home - to working when busy, idle otherwise.
      this.go(inputs.busy ? "working" : "idle", "release", now);
      return;
    }
    if (isEmote(this.state)) {
      // Busy only colors an emote: a starting turn heats it and it plays on
      // to its end (update), a turn ending cools it in place.
      return;
    }
    if (reply) {
      this.go(reply, EMOTE_ENTRY_CLIP[reply], now);
      return;
    }
    if (this.state === "idle" && inputs.busy) {
      this.go("working", "engage", now);
      return;
    }
    if (this.state === "working" && !inputs.busy && now >= this.submitGraceUntil) {
      this.go("idle", "settle", now);
    }
  }

  /**
   * A turn was submitted: play intake into working immediately instead of
   * waiting for the busy signal, holding for a bounded grace window. A
   * playing emote is left alone - the ember shows the message was taken -
   * and returns to working when it ends inside that window.
   */
  noteSubmit(now: number): void {
    this.submitGraceUntil = now + SUBMIT_GRACE_MS;
    if (isEmote(this.state)) return;
    if (this.state !== "working") {
      this.go("working", this.state === "listening" ? "intake" : "engage", now);
    }
  }

  /**
   * One-shot emotes fire from idle or working only; listening holds them off
   * (voice keeps the conn) and an emote never interrupts another. Fidget
   * draws its variant from the pool, never repeating the previous pick -
   * unless a caller names one (review pages and tests want a specific
   * fidget on demand; the product never forces the pick).
   *
   * A reply emote answers the captain, so it lands with the answer: asked
   * for while the Firstmate's own turn runs, it is held and plays as that
   * turn ends (setInputs), whatever state the character is in meanwhile.
   * One per turn - the first asked for; another is refused.
   */
  requestEmote(name: FirstmateEmote, now: number, variant?: FidgetVariant): boolean {
    if (this.busy && isReplyEmote(name)) {
      if (this.pendingReply !== null) return this.pendingReply === name;
      this.pendingReply = name;
      return true;
    }
    if (this.state !== "idle" && this.state !== "working") return false;
    if (name === "fidget") {
      if (variant) {
        this.variant = variant;
      } else {
        const pool = (Object.keys(FIDGET_DURATION_MS) as FidgetVariant[]).filter(
          (v) => v !== this.lastFidget,
        );
        this.variant = pool[Math.floor(this.random() * pool.length)] ?? "roll";
      }
      this.lastFidget = this.variant;
      this.go("fidget", this.variant, now);
      return true;
    }
    this.go(name, EMOTE_ENTRY_CLIP[name], now);
    return true;
  }

  /**
   * Pin the active emote's clock at a normalized progress (0..1) so a frame
   * can be held for review or a screenshot; null lets it run on from there.
   * Inputs still win: attention leaves the emote and drops the pin. Pinning outside an emote is a no-op.
   */
  pinEmote(fraction: number | null, now: number): void {
    if (fraction === null) {
      this.pinnedT = null;
      return;
    }
    if (!isEmote(this.state)) return;
    this.pinnedT = Math.max(0, Math.min(0.999, fraction));
    this.enteredAt = now - this.pinnedT * this.emoteDurationMs();
  }

  /**
   * The captain's own press took the last card off the stage: one fidget
   * from the pool. Attention wins, so nothing plays while listening; another
   * emote playing finishes first and the fidget follows it, unless attention
   * or a card coming up drops it meanwhile.
   */
  stageCleared(now: number): boolean {
    if (this.listening) return false;
    if (this.requestEmote("fidget", now)) return true;
    this.pendingClearFidget = true;
    return true;
  }

  /** A tap on the character: fidget when idle, a spin kick otherwise. */
  tap(now: number): "fidget" | "kick" {
    if (this.state === "idle" && this.requestEmote("fidget", now)) return "fidget";
    return "kick";
  }

  private emoteDurationMs(): number {
    if (this.state === "fidget") return FIDGET_DURATION_MS[this.variant ?? "roll"];
    return EMOTE_DURATION_MS[this.state as FirstmateEmote];
  }

  /** Advance timers and return the frame snapshot the renderer consumes. */
  update(now: number): MachineSnapshot {
    if (this.pinnedT !== null && isEmote(this.state)) {
      // A pinned emote's clock stands still at the pinned progress.
      this.enteredAt = now - this.pinnedT * this.emoteDurationMs();
    }
    if (isEmote(this.state) && now - this.enteredAt >= this.emoteDurationMs()) {
      const home = this.busy || now < this.submitGraceUntil ? "working" : "idle";
      this.go(home, "return", now);
      if (this.pendingClearFidget) {
        this.pendingClearFidget = false;
        this.requestEmote("fidget", now);
      }
    }
    if (this.state === "idle" && !this.hidden && now - this.fidgetFrom >= this.fidgetAt) {
      this.requestEmote("fidget", now);
    }
    const emoteT = isEmote(this.state)
      ? Math.min(1, (now - this.enteredAt) / this.emoteDurationMs())
      : 0;
    return {
      state: this.state,
      busy: this.busy,
      phase: now - this.enteredAt,
      emoteT,
      variant: this.variant,
      clip: this.clip,
      blendT: Math.min(1, (now - this.clipStart) / (CLIP_BLEND_MS[this.clip] ?? 1)),
      crystalActive: this.crystalActive,
      folding: this.folding,
    };
  }
}
