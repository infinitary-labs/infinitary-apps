import { describe, expect, it } from "vitest";
import {
  emptySlots,
  expireSlot,
  retireSlot,
  revealSlot,
  type StageSlots,
  selectSlots,
  slotRoles,
} from "./stageSlots";

type View = { name: string };
const view = (name: string): View => ({ name });

/** The stage after `shown` appeared with `warm` prepared behind it. */
function settled(shown: string, warm: string | null = null): StageSlots<View> {
  return selectSlots(emptySlots<View>(), shown, warm, undefined);
}
const roles = (slots: StageSlots<View>) => slotRoles(slots).map(({ id, role }) => ({ id, role }));
const keyOf = (slots: StageSlots<View>, id: string) =>
  slotRoles(slots).find((slot) => slot.id === id)?.key ?? "";

describe("stage slots", () => {
  it("shows the first entry at once and prepares its successor behind it", () => {
    const slots = settled("a", "b");
    expect(slots.revealed).toBe(true);
    expect(roles(slots)).toEqual([
      { id: "a", role: "shown" },
      { id: "b", role: "warm" },
    ]);
    // Nothing changed: the same object, so the stage does not render again.
    expect(selectSlots(slots, "a", "b", view("a"))).toBe(slots);
  });

  it("promotes the prepared successor in place and keeps the outgoing drawing until it is ready", () => {
    const before = settled("a", "b");
    const prepared = keyOf(before, "b");
    const promoted = selectSlots(before, "b", "c", view("a"));
    expect(promoted.revealed).toBe(false);
    expect(promoted.outgoing).toMatchObject({ id: "a", view: view("a") });
    // The same mount: the prepared document is shown, never rebuilt.
    expect(promoted.shown?.key).toBe(prepared);
    // At most two documents: no new successor while the drawing is held.
    expect(promoted.warm).toBeNull();
    // Birth order never changes, so the prepared frame is never moved.
    expect(roles(promoted)).toEqual([
      { id: "a", role: "outgoing" },
      { id: "b", role: "shown" },
    ]);
    expect(promoted.order[prepared]).toBe(before.order[prepared]);

    const ready = revealSlot(promoted, prepared);
    expect(ready.revealed).toBe(true);
    expect(ready.outgoing?.id).toBe("a");
    const retired = retireSlot(ready, keyOf(ready, "a"));
    expect(retired.outgoing).toBeNull();
    // Only once the drawing is gone is the next successor prepared.
    const next = selectSlots(retired, "b", "c", view("b"));
    expect(roles(next)).toEqual([
      { id: "b", role: "shown" },
      { id: "c", role: "warm" },
    ]);
  });

  it("drops an entry that never appeared, keeping the drawing the captain still sees", () => {
    const first = settled("a");
    const paging = selectSlots(first, "b", null, view("a"));
    const again = selectSlots(paging, "c", null, view("b"));
    expect(again.outgoing?.id).toBe("a");
    expect(roles(again).map((slot) => slot.id)).toEqual(["a", "c"]);
    // Back to the drawing nothing replaced on screen: shown again as it is.
    const back = selectSlots(again, "a", null, view("c"));
    expect(back.outgoing).toBeNull();
    expect(back.revealed).toBe(true);
    expect(back.shown?.key).toBe(keyOf(first, "a"));
    expect(roles(back)).toEqual([{ id: "a", role: "shown" }]);
  });

  it("mounts an entry afresh when the selection returns to its fading drawing", () => {
    const first = settled("a");
    const paged = selectSlots(first, "b", null, view("a"));
    const away = revealSlot(paged, keyOf(paged, "b"));
    expect(away.outgoing?.id).toBe("a");
    const back = selectSlots(away, "a", null, view("b"));
    // "b" had appeared: its drawing is the one held now, and "a" is born again.
    expect(back.outgoing?.id).toBe("b");
    expect(back.shown?.id).toBe("a");
    expect(back.shown?.key).not.toBe(keyOf(first, "a"));
    expect(back.revealed).toBe(false);
    expect(roles(back)).toEqual([
      { id: "b", role: "outgoing" },
      { id: "a", role: "shown" },
    ]);
  });

  it("keeps the entry that had appeared when the selection moves during the crossfade", () => {
    const paged = selectSlots(settled("a"), "b", null, view("a"));
    const fading = revealSlot(paged, keyOf(paged, "b"));
    const moved = selectSlots(fading, "c", null, view("b"));
    expect(moved.outgoing).toMatchObject({ id: "b", view: view("b") });
    expect(roles(moved).map((slot) => slot.id)).toEqual(["b", "c"]);
    // A stale retirement of the earlier drawing changes nothing.
    expect(retireSlot(moved, keyOf(fading, "a"))).toBe(moved);
  });

  it("ends a hold that never became ready without calling it ready", () => {
    const held = selectSlots(settled("a"), "b", null, view("a"));
    expect(revealSlot(held, "not-shown")).toBe(held);
    const expired = expireSlot(held, keyOf(held, "b"));
    expect(expired.revealed).toBe(true);
    expect(expired.outgoing).toBeNull();
    expect(roles(expired)).toEqual([{ id: "b", role: "shown" }]);
  });

  it("keeps a waiting entry unseen on an empty stage until it is ready (INF-510)", () => {
    // A task record's facts and body frame arrive in turn: it must not appear
    // as an empty card that grows twice.
    const opened = selectSlots(emptySlots<View>(), "record", null, undefined, true);
    expect(opened.revealed).toBe(false);
    expect(roles(opened)).toEqual([{ id: "record", role: "shown" }]);
    expect(revealSlot(opened, keyOf(opened, "record")).revealed).toBe(true);
    expect(expireSlot(opened, keyOf(opened, "record")).revealed).toBe(true);
    // Anything else still appears at once.
    expect(selectSlots(emptySlots<View>(), "card", null, undefined, false).revealed).toBe(true);
  });

  it("retires a departed drawing without revealing an unready successor", () => {
    const departing = selectSlots(settled("a"), "b", null, view("a"));
    const waiting = retireSlot(departing, keyOf(departing, "a"));
    expect(waiting.outgoing).toBeNull();
    expect(waiting.revealed).toBe(false);
    expect(roles(waiting)).toEqual([{ id: "b", role: "shown" }]);
    // Renders while the body loads must not expose empty chrome.
    expect(selectSlots(waiting, "b", null, view("b"))).toBe(waiting);
    expect(revealSlot(waiting, keyOf(waiting, "b")).revealed).toBe(true);
  });

  it("never prepares the shown entry itself", () => {
    expect(settled("a", "a").warm).toBeNull();
  });
});

// Captain's slow Info tab (INF-916): returning to a populated record must not
// rebuild its sandboxed document, but unrelated cards keep their old lifetime.
it("keeps the same populated mount only within its owner's tab visit", () => {
  const first = selectSlots(emptySlots<View>(), "info", null, undefined, false, "info");
  const key = keyOf(first, "info");
  const away = selectSlots(first, "crew", null, view("info"), false, "info");
  const settledAway = retireSlot(revealSlot(away, keyOf(away, "crew")), key);
  expect(slotRoles(settledAway)).toContainEqual({ id: "info", key, role: "parked" });
  const browser = selectSlots(settledAway, "browser", null, view("crew"), false, "info");
  const back = selectSlots(browser, "info", null, view("browser"), true, "info");
  expect(back.shown?.key).toBe(key);
  expect(back.parked).toBeNull();
  const again = selectSlots(back, "crew", null, view("info"), false, "info");
  const parked = retireSlot(revealSlot(again, keyOf(again, "crew")), key);
  const closed = selectSlots(parked, null, null, view("crew"));
  expect(slotRoles(closed).some((slot) => slot.id === "info")).toBe(false);
});

it("parks the owner's document when another tab replaces its outgoing drawing before retirement", () => {
  // INF-916: tab navigation need not wait for the previous crossfade.
  const first = selectSlots(emptySlots<View>(), "info", null, undefined, false, "info");
  const key = keyOf(first, "info");
  const crew = selectSlots(first, "crew", null, view("info"), false, "info");
  const ready = revealSlot(crew, keyOf(crew, "crew"));
  const browser = selectSlots(ready, "browser", null, view("crew"), false, "info");
  expect(browser.parked?.key).toBe(key);
  expect(slotRoles(browser).map((slot) => slot.key)).toEqual([
    ...new Set(slotRoles(browser).map((slot) => slot.key)),
  ]);
  const back = selectSlots(browser, "info", null, view("browser"), true, "info");
  expect(back.shown?.key).toBe(key);
  expect(back.parked).toBeNull();
});
