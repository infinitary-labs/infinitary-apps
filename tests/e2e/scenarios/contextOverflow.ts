import type { Scenario } from "../mockProvider";

/** INF-447: a service refusal the client must compact or renew out of, once per stand-in. */
export const CONTEXT_OVERFLOW_PROMPT_MARKER = "recover this overlong conversation";

/**
 * The first first mate turn that carries the marker is refused as too long,
 * the way Anthropic's API refuses a conversation past its window. The
 * stand-in answers every later turn as usual.
 */
export const contextOverflow: Scenario = () => {
  let overflowed = false;
  return ({ isFirstmate, latestUserTail }) => {
    if (overflowed || !isFirstmate || !latestUserTail.includes(CONTEXT_OVERFLOW_PROMPT_MARKER))
      return undefined;
    overflowed = true;
    return {
      refusal: {
        status: 400,
        error: {
          type: "invalid_request_error",
          message: "prompt is too long: 321193 tokens > 300000 maximum",
        },
      },
    };
  };
};
