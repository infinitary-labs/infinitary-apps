import type { FirstmateApi } from "@shared/ipc";

declare global {
  interface Window {
    infinitary: FirstmateApi;
    /** The same API under its name before the Infinitary rename. */
    firstmate: FirstmateApi;
  }
}
