import type { z } from "zod";
import { signInWorkRequests } from "../signIns";
import { workRequests } from "../work";

type WorkRequest = {
  effect: "read" | "change";
  repeats?: "safe";
  request: z.ZodType;
  response: z.ZodType;
};

type WorkChannels<R extends Record<string, WorkRequest>> = {
  [C in keyof R]: Omit<R[C], "repeats"> & { surface: "core"; reach: "work" };
};

/**
 * Each request as the contract publishes it: the repeat rule stays off the
 * wire, and only a computer that runs work may ask it.
 */
function channelsOf<R extends Record<string, WorkRequest>>(requests: R): WorkChannels<R> {
  return Object.fromEntries(
    Object.entries(requests).map(([channel, { repeats: _repeats, ...wire }]) => [
      channel,
      { ...wire, surface: "core", reach: "work" },
    ]),
  ) as WorkChannels<R>;
}

/**
 * What a computer that runs work asks its home: about a crewmate's
 * conversation it holds, with the shapes in src/shared/work.ts (docs/helper.md,
 * "Holding a conversation"), and about its own sign-ins, with the shapes in
 * src/shared/signIns.ts (docs/helper.md, "Its own sign-ins").
 */
export const workChannels = { ...channelsOf(workRequests), ...channelsOf(signInWorkRequests) };
