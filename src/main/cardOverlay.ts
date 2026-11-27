import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { writePrivate } from "@core/devices/identity";
import {
  type CardOverlay,
  type CardOverlayProblem,
  type CardOverlayRefusal,
  DEFAULT_CARD_OVERLAY,
  overlayAccelerator,
  overlayKeyAllowed,
  type SavedCardOverlay,
  savedCardOverlaySchema,
} from "@shared/cardOverlay";
import type { KeyChord } from "@shared/keyboardCommands";

/**
 * The card overlay's main-process side (docs/card-overlay.md): the system
 * shortcut, held only while the switch is on, and the one panel window it
 * opens and closes. Electron stays behind `CardOverlayDeps`, so the rules
 * here run without a window (./cardOverlay.test.ts).
 */

/** The overlay's one panel window, as the controller drives it. */
export type OverlayPanel = {
  /** Shown and given the keys, while the front app stays the front app (a nonactivating panel). */
  showWithKeys(): void;
  /** Shown without the keys: the brief word that no card waits. */
  showWithoutKeys(): void;
  /** Out of sight at once, before its page has let go. */
  hide(): void;
  destroy(): void;
  /** Asks its page to let go: settle its unsent words, then ask `hideAsked`. */
  askToLeave(): void;
};

export type CardOverlayDeps = {
  /** Whether this desktop has the overlay: a Mac's alone. */
  supported: boolean;
  /** Registers a system-wide shortcut; false when the system will not take it (a key another program holds is not refused on a Mac). */
  register(accelerator: string, run: () => void): boolean;
  /** Whether the chord is one of macOS's own shortcuts, which would take the key first. */
  systemShortcut(chord: KeyChord): boolean;
  unregister(accelerator: string): void;
  /** Makes the panel, hidden, and starts its page; `gone` hears it close, however it closes. */
  openPanel(gone: () => void): OverlayPanel;
  later(run: () => void, ms: number): unknown;
  cancel(handle: unknown): void;
  /** Milliseconds, for the open timing marks. */
  now(): number;
  /** One line about an open, for the timing marks a check reads. */
  mark?(line: string): void;
};

/** How long the page has to settle its words before the panel goes anyway. */
export const LEAVE_LIMIT_MS = 1_000;
/** How long the word that no card waits stays up. */
export const NOTHING_WAITS_MS = 1_600;

type Phase =
  | { kind: "closed" }
  | { kind: "opening"; panel: OverlayPanel; since: number }
  | { kind: "answering"; panel: OverlayPanel }
  | { kind: "nothing"; panel: OverlayPanel; timer: unknown }
  | { kind: "leaving"; panel: OverlayPanel; timer: unknown };

/**
 * The keys a person was already holding when the panel took the keys - the
 * overlay's own chord, a game's movement key - repeat into the panel but were
 * never pressed there. `carried` is true for each of those presses and their
 * let-go, which the panel drops, so a held key never answers or moves on a
 * card; a key pressed fresh in the panel works, held or not.
 */
export function carriedKeys(): {
  carried(input: { type: string; code: string; isAutoRepeat: boolean }): boolean;
} {
  const fresh = new Set<string>();
  return {
    carried: ({ type, code, isAutoRepeat }) => {
      if (type === "keyDown") {
        if (!isAutoRepeat) {
          fresh.add(code);
          return false;
        }
        return !fresh.has(code);
      }
      if (type === "keyUp") return !fresh.delete(code);
      return false;
    },
  };
}

export class CardOverlayController {
  private saved: SavedCardOverlay;
  private registered: string | null = null;
  private problem: CardOverlayProblem | null = null;
  private phase: Phase = { kind: "closed" };
  private readonly listeners = new Set<(value: CardOverlay) => void>();

  constructor(
    private readonly deps: CardOverlayDeps,
    private readonly store: { read(): SavedCardOverlay; write(next: SavedCardOverlay): void },
  ) {
    this.saved = store.read();
    this.install(this.saved);
  }

  current(): CardOverlay {
    return { ...this.saved, problem: this.problem };
  }

  subscribe(listener: (value: CardOverlay) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * A person's change. A key that cannot be held is refused whole: the
   * switch and the key stay as they were and keep working.
   */
  set(next: SavedCardOverlay): { overlay: CardOverlay; refused: CardOverlayRefusal | null } {
    if (!overlayKeyAllowed(next.key)) return { overlay: this.current(), refused: "not-allowed" };
    if (next.on && this.deps.supported) {
      const accelerator = overlayAccelerator(next.key);
      if (accelerator !== this.registered) {
        if (this.deps.systemShortcut(next.key))
          return { overlay: this.current(), refused: "system" };
        if (!this.deps.register(accelerator, () => this.summon())) {
          return { overlay: this.current(), refused: "taken" };
        }
        if (this.registered) this.deps.unregister(this.registered);
        this.registered = accelerator;
      }
      this.problem = null;
    } else {
      this.release();
      this.problem = this.deps.supported ? null : "unsupported";
    }
    this.saved = next;
    this.store.write(next);
    this.tell();
    return { overlay: this.current(), refused: null };
  }

  /** The system shortcut was pressed. */
  summon(): void {
    const phase = this.phase;
    if (phase.kind === "closed") {
      const since = this.deps.now();
      this.deps.mark?.("pressed");
      const panel = this.deps.openPanel(() => this.gone(panel));
      this.phase = { kind: "opening", panel, since };
      return;
    }
    // A press while the page starts, or while it lets go, is spent on nothing.
    if (phase.kind === "answering" || phase.kind === "nothing") this.leave();
  }

  /**
   * The panel's page has its cards: with one to answer the panel takes the
   * keys, and with none it only says so and goes, the keys staying where
   * they were.
   */
  ready(panelAsking: OverlayPanel, cards: boolean): void {
    const phase = this.phase;
    if (phase.kind !== "opening" || phase.panel !== panelAsking) return;
    // i18n-exempt: a timing line for a check, read by no person in the app
    this.deps.mark?.(`ready ${this.deps.now() - phase.since}ms cards=${cards}`);
    if (cards) {
      phase.panel.showWithKeys();
      this.phase = { kind: "answering", panel: phase.panel };
      return;
    }
    phase.panel.showWithoutKeys();
    const timer = this.deps.later(() => this.leave(), NOTHING_WAITS_MS);
    this.phase = { kind: "nothing", panel: phase.panel, timer };
  }

  /** The panel's page let go, or asked to go (Escape, an answer, an empty stack). */
  hideAsked(panelAsking: OverlayPanel): void {
    const phase = this.phase;
    if (phase.kind === "closed" || phase.panel !== panelAsking) return;
    this.finish();
  }

  /**
   * Sends the panel away: out of sight at once, then gone once its page has
   * settled its words, or after `LEAVE_LIMIT_MS`. Every way out comes here
   * - the key, a click or app elsewhere, a lock, a display gone.
   */
  leave(): void {
    const phase = this.phase;
    if (phase.kind === "closed" || phase.kind === "leaving") return;
    if (phase.kind === "nothing") this.deps.cancel(phase.timer);
    if (phase.kind === "opening") {
      // Nothing was shown and nothing typed: there is nothing to settle.
      this.finish();
      return;
    }
    // Leaving before the panel hides: hiding takes its keys, and the blur that
    // follows must find it already on its way out.
    const timer = this.deps.later(() => this.finish(), LEAVE_LIMIT_MS);
    this.phase = { kind: "leaving", panel: phase.panel, timer };
    phase.panel.hide();
    phase.panel.askToLeave();
  }

  /** The panel lost the keys: a click on the game, another app, another Space. */
  blurred(panelLosing: OverlayPanel): void {
    const phase = this.phase;
    if (phase.kind === "answering" && phase.panel === panelLosing) this.leave();
  }

  /** Whether `panel` is the overlay's now, for the channels only it may ask. */
  owns(panel: OverlayPanel): boolean {
    return this.phase.kind !== "closed" && this.phase.panel === panel;
  }

  /** The app is quitting: the key goes back to the system. */
  dispose(): void {
    this.finish();
    this.release();
  }

  private install(saved: SavedCardOverlay): void {
    if (!this.deps.supported) {
      this.problem = "unsupported";
      return;
    }
    if (!saved.on || !overlayKeyAllowed(saved.key)) return;
    const accelerator = overlayAccelerator(saved.key);
    if (this.deps.register(accelerator, () => this.summon())) this.registered = accelerator;
    else this.problem = "taken";
  }

  private release(): void {
    if (this.registered) this.deps.unregister(this.registered);
    this.registered = null;
    this.leave();
  }

  private finish(): void {
    const phase = this.phase;
    if (phase.kind === "closed") return;
    if (phase.kind === "leaving" || phase.kind === "nothing") this.deps.cancel(phase.timer);
    this.phase = { kind: "closed" };
    phase.panel.destroy();
  }

  /** The panel closed on its own, such as its page ending. */
  private gone(panel: OverlayPanel): void {
    const phase = this.phase;
    if (phase.kind === "closed" || phase.panel !== panel) return;
    if (phase.kind === "leaving" || phase.kind === "nothing") this.deps.cancel(phase.timer);
    this.phase = { kind: "closed" };
  }

  private tell(): void {
    const value = this.current();
    for (const listener of this.listeners) listener(value);
  }
}

/**
 * The switch and key in one file of this computer's own, whichever first
 * mate its window follows: the key is pressed on this keyboard. The one
 * writer of that file. A file that cannot be read is a new profile's: off.
 */
export function cardOverlayFile(path: string): {
  read(): SavedCardOverlay;
  write(next: SavedCardOverlay): void;
} {
  return {
    read: () => {
      try {
        return savedCardOverlaySchema.parse(JSON.parse(readFileSync(path, "utf8")));
      } catch {
        return DEFAULT_CARD_OVERLAY;
      }
    },
    write: (next) => {
      try {
        mkdirSync(dirname(path), { recursive: true });
        writePrivate(path, JSON.stringify(next));
      } catch (error) {
        // The key still works for this run.
        console.warn(`[card overlay] could not save: ${(error as Error).message}`);
      }
    },
  };
}
