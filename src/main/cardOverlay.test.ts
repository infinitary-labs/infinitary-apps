import { overlayAccelerator, type SavedCardOverlay } from "@shared/cardOverlay";
import type { KeyChord } from "@shared/keyboard";
import { describe, expect, it } from "vitest";
import {
  CardOverlayController,
  carriedKeys,
  LEAVE_LIMIT_MS,
  NOTHING_WAITS_MS,
  type OverlayPanel,
  WARM_LIMIT_MS,
} from "./cardOverlay";

// Intent: INF-7063's approved plan, built with the captain's choices - an
// opt-in Mac shortcut, Control+Shift+O, that shows the card stack as a
// nonactivating panel over a full-screen game: "Answer immediately; movement
// keys pause", "Back to the game; reopen for another card", and the careful
// review's "Window and keys - check that control returns to the game".

const ON: SavedCardOverlay = { on: true, key: { key: "o", ctrl: true, shift: true } };
const OTHER: KeyChord = { key: "p", alt: true, meta: true };
/** The accelerators held now, by chord. */
const held = (registered: Map<string, unknown>) => [...registered.keys()];

/** A panel that records what the controller did to it. */
function panel() {
  const did: string[] = [];
  const keys = { pressed: 0 };
  const it: OverlayPanel = {
    summoned: () => void keys.pressed++,
    showWithKeys: () => did.push("show"),
    showWithoutKeys: () => did.push("show-inactive"),
    hide: () => did.push("hide"),
    destroy: () => did.push("destroy"),
    askToLeave: () => did.push("ask-to-leave"),
  };
  return { it, did, keys };
}

/** The system's shortcut registry, a store and a clock, as the controller meets them. */
function harness(
  options: {
    saved?: SavedCardOverlay;
    held?: KeyChord[];
    system?: KeyChord[];
    supported?: boolean;
  } = {},
) {
  const held = new Set((options.held ?? []).map(overlayAccelerator));
  const system = new Set((options.system ?? []).map(overlayAccelerator));
  const registered = new Map<string, () => void>();
  const timers = new Map<number, { at: number; run: () => void }>();
  let now = 0;
  let next = 1;
  const panels: ReturnType<typeof panel>[] = [];
  let gone: (() => void) | null = null;
  let saved = options.saved ?? { on: false, key: { key: "o", ctrl: true, shift: true } };
  const writes: SavedCardOverlay[] = [];
  const controller = new CardOverlayController(
    {
      supported: options.supported ?? true,
      register: (accelerator, run) => {
        if (held.has(accelerator) || registered.has(accelerator)) return false;
        registered.set(accelerator, run);
        return true;
      },
      unregister: (accelerator) => void registered.delete(accelerator),
      systemShortcut: (chord) => system.has(overlayAccelerator(chord)),
      openPanel: (closed) => {
        const made = panel();
        panels.push(made);
        gone = closed;
        return made.it;
      },
      later: (run, ms) => {
        const id = next++;
        timers.set(id, { at: now + ms, run });
        return id;
      },
      cancel: (id) => void timers.delete(id as number),
      now: () => now,
    },
    {
      read: () => saved,
      write: (value) => {
        saved = value;
        writes.push(value);
      },
    },
  );
  return {
    controller,
    registered,
    panels,
    writes,
    /** The person presses the registered key. */
    press: () => registered.get(overlayAccelerator(ON.key))?.(),
    advance(ms: number) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at > now) continue;
        timers.delete(id);
        timer.run();
      }
    },
    closed: () => gone?.(),
    /** The panel the `index`th press opened. */
    opened(index: number) {
      const made = panels[index];
      if (!made) throw new Error(`no panel ${index} was opened`);
      return made;
    },
  };
}

describe("the card overlay's key", () => {
  it("is held with the system only while the switch is on", () => {
    const h = harness();
    expect(held(h.registered)).toEqual([]);
    expect(h.controller.set(ON).refused).toBeNull();
    expect(held(h.registered)).toEqual([overlayAccelerator(ON.key)]);
    h.controller.set({ ...ON, on: false });
    expect(held(h.registered)).toEqual([]);
    expect(h.writes.map((w) => w.on)).toEqual([true, false]);
  });

  it("refuses a key the system will not register and keeps the one that works", () => {
    const h = harness({ saved: ON, held: [OTHER] });
    const answer = h.controller.set({ on: true, key: OTHER });
    expect(answer.refused).toBe("taken");
    expect(answer.overlay.key).toEqual(ON.key);
    expect(held(h.registered)).toEqual([overlayAccelerator(ON.key)]);
    expect(h.writes).toEqual([]);
  });

  // Intent: the captain's answer to the review - "Also refuse the Mac's own shortcuts, like the
  // screenshot key", since a Mac registers a key another program holds without complaint.
  it("refuses one of macOS's own shortcuts and keeps the one that works", () => {
    const screenshot: KeyChord = { key: "4", meta: true, shift: true };
    const h = harness({ saved: ON, system: [screenshot] });
    const answer = h.controller.set({ on: true, key: screenshot });
    expect(answer.refused).toBe("system");
    expect(answer.overlay.key).toEqual(ON.key);
    expect(held(h.registered)).toEqual([overlayAccelerator(ON.key)]);
    expect(h.writes).toEqual([]);
  });

  it("moves to a new key, letting the old one go", () => {
    const h = harness({ saved: ON });
    expect(h.controller.set({ on: true, key: OTHER }).refused).toBeNull();
    expect(held(h.registered)).toEqual([overlayAccelerator(OTHER)]);
  });

  it("refuses a key with no Control, Option or Command, or one a game always uses", () => {
    const h = harness({ saved: ON });
    expect(h.controller.set({ on: true, key: { key: "o", shift: true } }).refused).toBe(
      "not-allowed",
    );
    expect(h.controller.set({ on: true, key: { key: "Escape", ctrl: true } }).refused).toBe(
      "not-allowed",
    );
    expect(held(h.registered)).toEqual([overlayAccelerator(ON.key)]);
  });

  it("says a saved key the system will not register does not work", () => {
    const h = harness({ saved: ON, held: [ON.key] });
    expect(h.controller.current().problem).toBe("taken");
    expect(h.registered.size).toBe(0);
  });

  it("holds nothing on a desktop without the overlay", () => {
    const h = harness({ saved: ON, supported: false });
    expect(h.controller.current().problem).toBe("unsupported");
    expect(h.registered.size).toBe(0);
  });

  it("gives the key back to the system when the app quits", () => {
    const h = harness({ saved: ON });
    h.press();
    h.controller.dispose();
    expect(h.registered.size).toBe(0);
    expect(h.panels[0]?.did).toEqual(["destroy"]);
  });
});

describe("the card overlay's panel", () => {
  it("takes the keys once its card is ready, and the key again sends it away", () => {
    const h = harness({ saved: ON });
    h.press();
    const first = h.opened(0);
    expect(first.did).toEqual([]);
    h.controller.ready(first.it, true);
    expect(first.did).toEqual(["show"]);
    h.press();
    expect(first.did).toEqual(["show", "hide", "ask-to-leave"]);
    // The page settled its words and let go: the panel is destroyed and the next press opens a new one.
    h.controller.hideAsked(first.it);
    expect(first.did.at(-1)).toBe("destroy");
    h.press();
    expect(h.panels).toHaveLength(2);
  });

  it("goes after the leave limit when its page never lets go", () => {
    const h = harness({ saved: ON });
    h.press();
    const first = h.opened(0);
    h.controller.ready(first.it, true);
    h.controller.leave();
    h.advance(LEAVE_LIMIT_MS - 1);
    expect(first.did).not.toContain("destroy");
    h.advance(1);
    expect(first.did.at(-1)).toBe("destroy");
  });

  it("gives the keys back when it loses them to a click on the game", () => {
    const h = harness({ saved: ON });
    h.press();
    const first = h.opened(0);
    h.controller.ready(first.it, true);
    h.controller.blurred(first.it);
    expect(first.did).toEqual(["show", "hide", "ask-to-leave"]);
    // Its own hide's blur, heard while it leaves, changes nothing.
    h.controller.blurred(first.it);
    expect(first.did).toEqual(["show", "hide", "ask-to-leave"]);
  });

  it("with no card says so without the keys, then goes on its own", () => {
    const h = harness({ saved: ON });
    h.press();
    const first = h.opened(0);
    h.controller.ready(first.it, false);
    expect(first.did).toEqual(["show-inactive"]);
    h.advance(NOTHING_WAITS_MS);
    expect(first.did).toEqual(["show-inactive", "hide", "ask-to-leave"]);
  });

  it("spends a press made while its page starts on nothing", () => {
    const h = harness({ saved: ON });
    h.press();
    h.press();
    expect(h.panels).toHaveLength(1);
    expect(h.panels[0]?.did).toEqual([]);
  });

  it("forgets a panel that closed on its own, so the next press opens one", () => {
    const h = harness({ saved: ON });
    h.press();
    h.controller.ready(h.opened(0).it, true);
    h.closed();
    expect(h.controller.owns(h.opened(0).it)).toBe(false);
    h.press();
    expect(h.panels).toHaveLength(2);
  });

  it("goes when the switch goes off while it shows", () => {
    const h = harness({ saved: ON });
    h.press();
    h.controller.ready(h.opened(0).it, true);
    h.controller.set({ ...ON, on: false });
    expect(h.panels[0]?.did).toEqual(["show", "hide", "ask-to-leave"]);
  });

  it("hears a ready or a let-go only from the panel it has now", () => {
    const h = harness({ saved: ON });
    h.press();
    const stranger = panel();
    h.controller.ready(stranger.it, true);
    h.controller.hideAsked(stranger.it);
    expect(stranger.did).toEqual([]);
    expect(h.panels[0]?.did).toEqual([]);
  });
});

// Intent: the captain's open-speed choice, "Load the page when a card notice
// arrives, drop it later", so the key after a notification opens the card
// without loading the page.
describe("a panel loaded on a card's notification", () => {
  it("loads hidden and holds its page until the key, which opens that panel", async () => {
    const h = harness({ saved: ON });
    h.controller.noticed();
    const first = h.opened(0);
    expect(first.did).toEqual([]);
    let started = false;
    void h.controller.pressed(first.it).then(() => {
      started = true;
    });
    await Promise.resolve();
    expect(started).toBe(false);
    h.press();
    await Promise.resolve();
    expect(started).toBe(true);
    expect(h.panels).toHaveLength(1);
    expect(first.keys.pressed).toBe(1);
    h.controller.ready(first.it, true);
    expect(first.did).toEqual(["show"]);
  });

  it("goes unpressed after the wait, counted from the newest notification", () => {
    const h = harness({ saved: ON });
    h.controller.noticed();
    h.advance(WARM_LIMIT_MS - 1);
    h.controller.noticed();
    expect(h.panels).toHaveLength(1);
    h.advance(WARM_LIMIT_MS - 1);
    expect(h.opened(0).did).toEqual([]);
    h.advance(1);
    expect(h.opened(0).did).toEqual(["destroy"]);
    h.press();
    expect(h.panels).toHaveLength(2);
  });

  it("loads nothing while the switch is off or a panel is already open", () => {
    const off = harness();
    off.controller.noticed();
    expect(off.panels).toHaveLength(0);
    const h = harness({ saved: ON });
    h.press();
    h.controller.noticed();
    expect(h.panels).toHaveLength(1);
  });

  it("goes on a lock while it waits, so the key after opens a new one", () => {
    const h = harness({ saved: ON });
    h.controller.noticed();
    h.controller.leave();
    expect(h.opened(0).did).toEqual(["destroy"]);
    h.press();
    expect(h.panels).toHaveLength(2);
  });
});

describe("carriedKeys", () => {
  const down = (code: string, isAutoRepeat = false) => ({ type: "keyDown", code, isAutoRepeat });
  const up = (code: string) => ({ type: "keyUp", code, isAutoRepeat: false });

  it("drops the repeats and the let-go of a key held from the game", () => {
    const keys = carriedKeys();
    expect(keys.carried(down("KeyW", true))).toBe(true);
    expect(keys.carried(down("KeyW", true))).toBe(true);
    expect(keys.carried(up("KeyW"))).toBe(true);
  });

  it("keeps a key pressed in the panel, held or not", () => {
    const keys = carriedKeys();
    expect(keys.carried(down("ArrowDown"))).toBe(false);
    expect(keys.carried(down("ArrowDown", true))).toBe(false);
    expect(keys.carried(up("ArrowDown"))).toBe(false);
  });

  it("keeps a held key once it is let go and pressed again", () => {
    const keys = carriedKeys();
    keys.carried(down("Enter", true));
    keys.carried(up("Enter"));
    expect(keys.carried(down("Enter"))).toBe(false);
  });
});
