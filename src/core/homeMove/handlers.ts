import type { CoreInvokeChannel, InvokeRequest, InvokeResponse } from "@shared/ipc";
import type { OutgoingHomeMove } from "./outgoing";

type HomeMoveHandlers = {
  [C in Extract<CoreInvokeChannel, `inf:home-move:${string}`>]: (
    ...args: InvokeRequest<C>
  ) => Promise<InvokeResponse<C>> | InvokeResponse<C>;
};

/** A core started without a move of its own (a test's) refuses one in plain words. */
const NO_MOVE = "This first mate cannot move to another computer.";

/** Settings -> Devices' requests about moving the first mate (docs/devices.md, "Moving the first mate"). */
export function homeMoveHandlers(move: OutgoingHomeMove | undefined): HomeMoveHandlers {
  return {
    "inf:home-move:ready": (deviceId) => {
      if (!move) throw new Error(NO_MOVE);
      return move.ready(deviceId);
    },
    "inf:home-move:start": (deviceId) =>
      move ? move.start(deviceId) : { ok: false, text: NO_MOVE },
    "inf:home-move:cancel": () => (move ? move.cancel() : { ok: false, text: NO_MOVE }),
    "inf:home-move:start-here": () => (move ? move.startHere() : { ok: false, text: NO_MOVE }),
  };
}
