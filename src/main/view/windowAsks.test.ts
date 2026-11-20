import { WINDOW_ASK_LIVE, type WindowAnswer } from "@shared/windowAsks";
import { describe, expect, it } from "vitest";
import { answerKeyReminders, answerWindowAsk } from "./windowAsks";

/**
 * The captain's pick (add-window-target): a window answers the first mate's
 * ask about its own settings as its own Settings would, and only an ask for it.
 */
describe("a window's answer to the first mate", () => {
  const ask = (deviceId: string, channel: string, args: unknown[] = []) => ({
    id: "ask-1",
    deviceId,
    channel,
    args,
  });
  const answering = async (payload: unknown, answer: () => Promise<unknown>) => {
    const sent: [string, WindowAnswer][] = [];
    await answerWindowAsk(payload, "studio", answer, async (id, said) => {
      sent.push([id, said]);
    });
    return sent;
  };

  it("answers its own ask with the result, or with why it could not, and leaves another window's alone", async () => {
    expect(WINDOW_ASK_LIVE).toBe("inf:view:ask");
    expect(
      await answering(ask("studio", "inf:settings:layout:get"), async () => ({ morePick: null })),
    ).toEqual([["ask-1", { ok: true, result: { morePick: null } }]]);
    expect(
      await answering(ask("studio", "inf:update:check"), async () => {
        throw new Error("Updates are off on this Mac.");
      }),
    ).toEqual([["ask-1", { ok: false, message: "Updates are off on this Mac." }]]);
    let ran = false;
    expect(
      await answering(ask("laptop", "inf:settings:layout:get"), async () => {
        ran = true;
      }),
    ).toEqual([]);
    expect(ran).toBe(false);
  });

  it("switches the window's own key reminder", () => {
    let on = true;
    const reminders = {
      current: () => ({ on, pressed: {} }),
      setOn: (next: boolean) => {
        on = next;
        return { on, pressed: {} };
      },
    };
    expect(answerKeyReminders(reminders, "inf:keyboard:reminders:set", [false])).toMatchObject({
      on: false,
    });
    expect(answerKeyReminders(reminders, "inf:keyboard:reminders", [])).toMatchObject({
      on: false,
    });
    expect(() => answerKeyReminders(null, "inf:keyboard:reminders", [])).toThrow("no key reminder");
  });
});
