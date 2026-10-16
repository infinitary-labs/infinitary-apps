import type { Card } from "@shared/cards";
import { describe, expect, it, vi } from "vitest";
import { CardNotifier } from "./notifications";

function card(overrides: Partial<Card> & { id: string }): Card {
  return {
    author: "firstmate",
    priority: 15,
    title: "A note",
    meta: "firstmate",
    body: "First line.\nSecond line.",
    actions: [],
    status: "ready",
    createdAt: Date.now(),
    ...overrides,
  };
}

function notifier(overrides: { enabled?: boolean; focused?: boolean } = {}) {
  const show = vi.fn();
  const instance = new CardNotifier({
    enabled: () => overrides.enabled ?? true,
    focused: () => overrides.focused ?? false,
    show,
  });
  return { instance, show };
}

describe("CardNotifier", () => {
  it("never notifies for the boot snapshot - restored cards are old news", () => {
    const { instance, show } = notifier();
    instance.observe([card({ id: "old-decision" })]);
    expect(show).not.toHaveBeenCalled();
    // The same card broadcast again later stays quiet too.
    instance.observe([card({ id: "old-decision" })]);
    expect(show).not.toHaveBeenCalled();
  });

  it("shows a card body's visible text, never its HTML markup", () => {
    const { instance, show } = notifier();
    instance.observe([]);
    instance.observe([
      card({
        id: "h1",
        status: "ready",
        body: "<p>Keep it &amp; go; <b>now</b>.</p><p>Second</p><script>x()</script>",
      }),
    ]);
    expect(show).toHaveBeenCalledWith(
      expect.objectContaining({ body: "Keep it & go; now. Second" }),
    );
  });

  it("notifies once for a card born ready, with the title and first body line", () => {
    const { instance, show } = notifier();
    instance.observe([]);
    instance.observe([card({ id: "d1", title: "Pick a course" })]);
    expect(show).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledWith({ title: "Pick a course", body: "First line." });
    // A body update re-broadcasts the same ready card: no second ping.
    instance.observe([card({ id: "d1", title: "Pick a course" })]);
    expect(show).toHaveBeenCalledTimes(1);
  });

  it("notifies when a card reaches the stage, not while it awaits its author", () => {
    const { instance, show } = notifier();
    instance.observe([]);
    // A crewmate's new card waits for its close-out: not there yet.
    instance.observe([card({ id: "c1", title: "Pick a course", awaiting: "close-out" })]);
    expect(show).not.toHaveBeenCalled();
    instance.observe([card({ id: "c1", title: "Pick a course" })]);
    expect(show).toHaveBeenCalledTimes(1);
    // The captain replied: off the stage. Its return is an arrival.
    instance.observe([card({ id: "c1", title: "Pick a course", awaiting: "answer" })]);
    instance.observe([card({ id: "c1", title: "Pick a course, answered" })]);
    expect(show).toHaveBeenCalledTimes(2);
    expect(show).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: "Pick a course, answered" }),
    );
  });

  it("notifies when a replied-under card returns with its answer", () => {
    const { instance, show } = notifier();
    instance.observe([card({ id: "c1", title: "Pick a course" })]);
    // The captain replied: off the stage, nothing to say yet.
    instance.observe([card({ id: "c1", title: "Pick a course", awaiting: "answer" })]);
    instance.observe([card({ id: "c1", title: "Pick a course", awaiting: "close-out" })]);
    expect(show).not.toHaveBeenCalled();
    instance.observe([card({ id: "c1", title: "Pick a course, answered" })]);
    expect(show).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: "Pick a course, answered" }),
    );
    // A later push of the same answered card is not news.
    instance.observe([card({ id: "c1", title: "Pick a course, answered" })]);
    expect(show).toHaveBeenCalledTimes(1);
  });

  it("stays silent while the window is focused", () => {
    const { instance, show } = notifier({ focused: true });
    instance.observe([]);
    instance.observe([card({ id: "d1" })]);
    expect(show).not.toHaveBeenCalled();
  });

  it("stays silent when the user turned notifications off", () => {
    const { instance, show } = notifier({ enabled: false });
    instance.observe([]);
    instance.observe([card({ id: "d1" })]);
    expect(show).not.toHaveBeenCalled();
  });

  it("can notify again for a card id that left the stack and returned", () => {
    const { instance, show } = notifier();
    instance.observe([]);
    instance.observe([card({ id: "d1" })]);
    instance.observe([]);
    // A returning decision (a re-raised auth card, a parked decision coming
    // back) is a new user-facing moment.
    instance.observe([card({ id: "d1" })]);
    expect(show).toHaveBeenCalledTimes(2);
  });

  it("starts over when told to forget: what the next snapshot holds is old news", () => {
    const { instance, show } = notifier();
    instance.observe([card({ id: "d1" })]);
    instance.forget();
    // Born and finished while nobody heard: the read after a reload only seeds.
    instance.observe([card({ id: "d1" }), card({ id: "d2" })]);
    expect(show).not.toHaveBeenCalled();
    instance.observe([card({ id: "d1" }), card({ id: "d2" }), card({ id: "d3", title: "New" })]);
    expect(show).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledWith(expect.objectContaining({ title: "New" }));
  });

  it("seeds from a read snapshot only until a push has seeded", () => {
    const read = notifier();
    read.instance.seed([card({ id: "d1" })]);
    read.instance.observe([card({ id: "d1" }), card({ id: "d2", title: "After the read" })]);
    expect(read.show).toHaveBeenCalledTimes(1);
    expect(read.show).toHaveBeenCalledWith(expect.objectContaining({ title: "After the read" }));

    // A push got there first: the read is no newer, and is ignored.
    const pushed = notifier();
    pushed.instance.observe([card({ id: "d1" }), card({ id: "d2" })]);
    pushed.instance.seed([card({ id: "d1" })]);
    pushed.instance.observe([card({ id: "d1" }), card({ id: "d2" })]);
    expect(pushed.show).not.toHaveBeenCalled();
  });
});
