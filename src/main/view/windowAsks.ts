import type { KeyReminders } from "@shared/keyReminders";
import { type WindowAnswer, type WindowChannel, windowAskSchema } from "@shared/windowAsks";

/** This window's key reminder, which only its own program keeps (docs/keyboard.md, "The key reminder"). */
export type WindowKeyReminders = {
  current(): KeyReminders;
  setOn(on: boolean): KeyReminders;
};

/** A key reminder's two requests, answered from this window's own store. */
export function answerKeyReminders(
  reminders: WindowKeyReminders | null | undefined,
  channel: WindowChannel,
  args: readonly unknown[],
): KeyReminders {
  if (!reminders) throw new Error("This window keeps no key reminder yet. Ask again in a moment.");
  if (channel === "inf:keyboard:reminders:set") return reminders.setOn(args[0] === true);
  return reminders.current();
}

/**
 * One ask the first mate sent this window (`inf:view:ask`, docs/view.md,
 * "What the first mate asks of a window"): an ask for another window is not
 * this one's; this window answers its own request as its own Settings would,
 * and says what it answered, or why it could not.
 */
export async function answerWindowAsk(
  payload: unknown,
  ownId: string,
  answer: (channel: WindowChannel, args: readonly unknown[]) => Promise<unknown>,
  send: (id: string, answer: WindowAnswer) => Promise<unknown>,
): Promise<void> {
  const asked = windowAskSchema.safeParse(payload);
  if (!asked.success || asked.data.deviceId !== ownId) return;
  let said: WindowAnswer;
  try {
    said = { ok: true, result: await answer(asked.data.channel, asked.data.args) };
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 400);
    said = { ok: false, message: message || "The window could not do it." };
  }
  await send(asked.data.id, said).catch((error: unknown) =>
    console.warn(`[window] could not answer the first mate: ${String(error)}`),
  );
}
