import type { FirstmateApi } from "@shared/windowApi";

declare global {
  interface Window {
    infinitary: FirstmateApi;
    /** The same API under its name before the Infinitary rename. */
    firstmate: FirstmateApi;
  }
}
