import { parseInvokeRequest } from "./ipc";
import type { KeyReminders } from "./keyReminders";
import {
  WINDOW_ASK_WORDS,
  WINDOW_VALUE_OF,
  type WindowAnswer,
  type WindowChannel,
  windowAskSchema,
} from "./windowAsks";

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
  if (channel === "inf:keyboard:reminders:set")
    return reminders.setOn(parseInvokeRequest(channel, args)[0]);
  return reminders.current();
}

/** Whether two values a window keeps read the same, as JSON reads them: in any key order, absent and undefined alike. */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = (value: object) =>
    Object.keys(value).filter((key) => (value as Record<string, unknown>)[key] !== undefined);
  const [left, right] = [keys(a), keys(b)];
  return (
    left.length === right.length &&
    left.every((key) =>
      sameJson((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
    )
  );
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
    const { channel, args, changes } = asked.data;
    const wholeRead = WINDOW_VALUE_OF[channel];
    if (changes && wholeRead) {
      // A change to a shared value sets only the fields it names. Each
      // must still read as the first mate read it, or already as it asks;
      // one this window's own Settings moved elsewhere since refuses it, so
      // an edit made here is never undone. It answers its own value from
      // just before, for the line that says what changed.
      const own = (await answer(wholeRead, [])) as Record<string, unknown>;
      const asks = args[0] as Record<string, unknown>;
      const moved = changes.filter(
        ({ field, was }) => !sameJson(own[field], was) && !sameJson(own[field], asks[field]),
      );
      if (moved.length) throw new Error(WINDOW_ASK_WORDS.changedThere(moved.map((c) => c.field)));
      const next = { ...own };
      for (const { field } of changes) {
        if (Object.hasOwn(asks, field)) next[field] = asks[field];
        else delete next[field];
      }
      said = { ok: true, result: await answer(channel, [next]), before: own };
    } else said = { ok: true, result: await answer(channel, args) };
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 400);
    said = { ok: false, message: message || "The window could not do it." };
  }
  await send(asked.data.id, said).catch((error: unknown) =>
    console.warn(`[window] could not answer the first mate: ${String(error)}`),
  );
}
