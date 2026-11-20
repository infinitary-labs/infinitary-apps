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
    await expect(result).resolves.toEqual(theirs);
  });

  it("sends a change's named fields, and refuses an answer the contract does not admit", async () => {
    const { windows, sent } = setup();
    const changed = windows.ask(
      studio,
      "inf:settings:appearance:set",
      [{ ...DEFAULT_APPEARANCE, usageUnit: "usd" }],
      ["usageUnit"],
    );
    expect(sent[0]?.payload).toMatchObject({ fields: ["usageUnit"] });
    windows.answered(
      sent[0]?.payload.id ?? "",
      { ok: true, result: { usageUnit: "usd" } },
      { kind: "captain", view: "studio" },
    );
    await expect(changed).rejects.toThrow(WINDOW_ASK_WORDS.badAnswer("Studio"));
    // A request the contract does not admit is never sent.
    await expect(windows.ask(studio, "inf:keyboard:reminders:set", ["on"])).rejects.toThrow(
      "malformed request",
    );
    expect(sent).toHaveLength(1);
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
