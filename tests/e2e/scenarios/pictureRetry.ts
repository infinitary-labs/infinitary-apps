import type { Scenario } from "../mockProvider";
import { latestServedTurn } from "../providerRequest";

export const PICTURE_RETRY_WORDS = "What is in this picture?";
export const PICTURE_RETRY_ANSWER = "Your picture reached me again";
export const PICTURE_RETRY_MISSING = "The new message has no picture";

/** Read only this request's newest user input, never pictures retained in history. */
export function newestPictures(body: string): unknown[] {
  const request = JSON.parse(body) as {
    messages?: Array<{ role?: string; content?: unknown }>;
    input?: Array<{ role?: string; content?: unknown }>;
  };
  const latest = (request.messages ?? request.input ?? []).findLast((item) => item.role === "user");
  return Array.isArray(latest?.content)
    ? latest.content.filter((part) => ["image", "image_url", "input_image"].includes(part.type))
    : [];
}

/** INF-1433: an unanswered picture gets a notice; the next captain turn reports its own input. */
export const pictureRetry: Scenario = () => {
  let captainTurns = 0;
  return ({ body, isFirstmate, wantsStream, hasToolResults }) => {
    if (!isFirstmate || !wantsStream) return undefined;
    if (hasToolResults) return { text: "I have shown what arrived." };
    const turn = latestServedTurn(body);
    if (!turn?.segments.some((segment) => segment.kind === "user")) {
      return { text: "No answer shown." };
    }
    captainTurns += 1;
    // A note naming a task that does not exist is refused. The
    // shared retry's later reaction cannot cover that failed answer, so the
    // real delivery check raises the notice without changing shared scripts.
    if (captainTurns === 1) {
      return {
        calls: [
          {
            name: "emit_card",
            args: {
              title: "The picture",
              body: "<p>I tried to show the answer.</p>",
              related: ["no-such-task"],
            },
          },
        ],
      };
    }
    const arrived = newestPictures(body).length > 0;
    return {
      calls: [
        {
          name: "emit_card",
          args: {
            title: arrived ? PICTURE_RETRY_ANSWER : PICTURE_RETRY_MISSING,
            body: arrived
              ? "<p>The retried message includes the original picture.</p>"
              : "<p>The retried message includes words but no picture.</p>",
          },
        },
      ],
    };
  };
};
