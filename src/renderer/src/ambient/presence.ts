import type { Presence } from "@shared/channels/shell";
import { create } from "zustand";

/**
 * Whether someone is at this computer, as its main process hears it
 * (src/main/presence.ts): the ambient music pauses while nobody is, and
 * Settings offers Pause when you're away only where the computer can tell.
 * Until the first reading, someone is here and nothing is watched.
 */
export const usePresence = create<Presence>(() => ({ away: false, watched: false }));

/** Reads presence once and follows each change after; call once. */
export function followPresence(): void {
  const api = window.infinitary.app;
  let pushed = false;
  api.onPresence((presence) => {
    pushed = true;
    usePresence.setState(presence);
  });
  void api.presence().then(
    (presence) => {
      // A push that arrived first is newer than this answer.
      if (!pushed) usePresence.setState(presence);
    },
    () => {},
  );
}
