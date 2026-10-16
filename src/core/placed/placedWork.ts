import type { InvokeRequest, InvokeResponse, WorkInvokeChannel } from "@shared/ipc";

/**
 * The home's side of the work requests (src/shared/work.ts): what a
 * computer that runs work asks about a crewmate's conversation it holds for
 * this home - a tool's callback, a card picture, a job's end, the numbered
 * events. The dispatcher hands each one here with the device that asked
 * (docs/connection.md, "Requests"); `PlacedSessions` answers them
 * (src/core/placed/placedSessions.ts).
 */
export type PlacedWork = {
  answer<C extends WorkInvokeChannel>(
    deviceId: string,
    channel: C,
    request: InvokeRequest<C>[0],
  ): Promise<InvokeResponse<C>>;
};

/** What the home answers about a task its record does not place on the computer that asks. */
export const NO_PLACED_TASK = "No task of this home runs on that computer.";
