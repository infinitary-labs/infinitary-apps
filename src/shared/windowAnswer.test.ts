import { WINDOW_ASK_LIVE, type WindowAnswer } from "@shared/windowAsks";
import { describe, expect, it } from "vitest";
import { answerKeyReminders, answerWindowAsk } from "./windowAnswer";

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
  const answering = async (
    payload: unknown,
    answer: (channel: string, args: readonly unknown[]) => Promise<unknown>,
  ) => {
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

  it("applies a change's named fields over its own value now, keeping its own edit since", async () => {
    // The first mate read dark; this window's own Settings chose light since.
    let own: Record<string, unknown> = { theme: "light", usageUnit: "tokens" };
    const applied: unknown[] = [];
    const sent = await answering(
      {
        ...ask("studio", "inf:settings:appearance:set", [{ theme: "dark", usageUnit: "usd" }]),
        fields: ["usageUnit"],
      },
      async (channel: string, args: readonly unknown[]) => {
        if (channel === "inf:settings:appearance:get") return own;
        applied.push(args[0]);
        own = args[0] as Record<string, unknown>;
        return own;
      },
    );
    expect(applied).toEqual([{ theme: "light", usageUnit: "usd" }]);
    expect(sent).toEqual([["ask-1", { ok: true, result: { theme: "light", usageUnit: "usd" } }]]);
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
    expect(() => answerKeyReminders(reminders, "inf:keyboard:reminders:set", ["off"])).toThrow(
      "malformed request",
    );
    expect(on).toBe(false);
  });
});
