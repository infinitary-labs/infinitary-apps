import type { Scenario } from "../mockProvider";

export const FAILED_ACTION_OUTPUT = "error: Cannot build fm-placer-0.1.0.drv";
export const ACTION_REPAIR_REPLY =
  "The rebuild is still unconfirmed. I will arrange repair and keep the update here.";

/**
 * INF-1137 friction 2: the first mate answers on the app-owned card, not in
 * main chat. Its line says it will arrange repair, a handoff, so it names no
 * message and the captain's report stays open (the captain's "a handoff
 * stays open").
 */
export const requiredActionFailure: Scenario =
  () =>
  ({ isFirstmate, wantsStream, hasToolResults, body }) => {
    if (!isFirstmate || !wantsStream || !body.includes(FAILED_ACTION_OUTPUT)) return undefined;
    if (hasToolResults) return { text: "I answered on the rebuild card." };
    const id = body.match(/about: card (card-[\w-]+)/)?.[1];
    if (!id) return undefined;
    return {
      calls: [
        {
          name: "emit_card",
          args: {
            id,
            task_id: id.replace("card-fm-required-action-", ""),
            title: "Rebuild help",
            body: "<p>The original instructions stay unchanged.</p>",
            actions: [],
            reply: ACTION_REPAIR_REPLY,
          },
        },
      ],
    };
  };
