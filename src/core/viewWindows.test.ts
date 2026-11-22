import { DEFAULT_APPEARANCE } from "@shared/preferences";
import { WINDOW_ANSWER_WAIT_MS, WINDOW_ASK_LIVE, WINDOW_ASK_WORDS } from "@shared/windowAsks";
import { describe, expect, it } from "vitest";
import { ViewWindows, WINDOW_ASKS } from "./viewWindows";

/**
 * The captain's pick (add-window-target): the first mate's change of a
 * window's own setting goes to the named computer's window and is answered by
 * that window alone. A window here is the frames it is sent and its answers.
 */
describe("ViewWindows", () => {
  const studio = { deviceId: "studio", name: "Studio" };
  const setup = (connected = true) => {
    const sent: { to: string; channel: string; payload: { id: string }; change: string }[] = [];
    const timers: (() => void)[] = [];
    const windows = new ViewWindows({
      liveToView: (to, channel, payload, change) => {
        sent.push({ to, channel, payload: payload as { id: string }, change });
        return connected;
      },
      wait: (ms, then) => {
        expect(ms).toBe(WINDOW_ANSWER_WAIT_MS);
        timers.push(then);
      },
    });
    return { windows, sent, timers };
  };

  it("asks only windows that know the asks, and takes the answer from the window that was asked", async () => {
    const { windows, sent } = setup();
    const result = windows.ask(studio, "inf:settings:appearance:get", []);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: "studio", channel: WINDOW_ASK_LIVE, change: WINDOW_ASKS });
    const id = sent[0]?.payload.id ?? "";
    // Another window, the home's own window, and a crewmate are not that window.
    windows.answered(id, { ok: true, result: "forged" }, { kind: "captain", view: "laptop" });
    windows.answered(id, { ok: true, result: "forged" }, { kind: "captain" });
    windows.answered(id, { ok: true, result: "forged" }, { kind: "firstmate", wake: "captain" });
    const theirs = { ...DEFAULT_APPEARANCE, usageUnit: "usd" };
    windows.answered(id, { ok: true, result: theirs }, { kind: "captain", view: "studio" });
    await expect(result).resolves.toEqual({ result: theirs });
  });

  it("sends what a change changes and from what, takes the window's value from before it, and refuses an answer the contract does not admit", async () => {
    const { windows, sent } = setup();
    const changes = [{ field: "usageUnit", was: "tokens" }];
    const next = { ...DEFAULT_APPEARANCE, usageUnit: "usd" as const };
    const changed = windows.ask(studio, "inf:settings:appearance:set", [next], changes);
    expect(sent[0]?.payload).toMatchObject({ changes });
    windows.answered(
      sent[0]?.payload.id ?? "",
      { ok: true, result: next, before: DEFAULT_APPEARANCE },
      { kind: "captain", view: "studio" },
    );
    await expect(changed).resolves.toEqual({ result: next, before: DEFAULT_APPEARANCE });
    // A whole value the contract does not admit, after or before, is refused.
    for (const said of [
      { ok: true as const, result: { usageUnit: "usd" }, before: DEFAULT_APPEARANCE },
      { ok: true as const, result: next, before: { usageUnit: "tokens" } },
    ]) {
      const asked = windows.ask(studio, "inf:settings:appearance:set", [next], changes);
      windows.answered(sent.at(-1)?.payload.id ?? "", said, { kind: "captain", view: "studio" });
      await expect(asked).rejects.toThrow(WINDOW_ASK_WORDS.badAnswer("Studio"));
    }
    // A request the contract does not admit is never sent.
    await expect(windows.ask(studio, "inf:keyboard:reminders:set", ["on"])).rejects.toThrow(
      "malformed request",
    );
    expect(sent).toHaveLength(3);
  });

  it("says plainly when no window is connected, when one does not answer, and what a refusing window said", async () => {
    await expect(setup(false).windows.ask(studio, "inf:settings:layout:get", [])).rejects.toThrow(
      WINDOW_ASK_WORDS.noWindow("Studio"),
    );
    const silent = setup();
    const unanswered = silent.windows.ask(studio, "inf:settings:layout:get", []);
    for (const then of silent.timers) then();
    await expect(unanswered).rejects.toThrow(WINDOW_ASK_WORDS.noAnswer("Studio"));
    const refusing = setup();
    const refused = refusing.windows.ask(studio, "inf:update:check", []);
    refusing.windows.answered(
      refusing.sent[0]?.payload.id ?? "",
      { ok: false, message: "Updates are off on this Mac." },
      { kind: "captain", view: "studio" },
    );
    await expect(refused).rejects.toThrow("Updates are off on this Mac.");
  });
});
