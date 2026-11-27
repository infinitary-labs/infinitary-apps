import type { Presence } from "@shared/channels/shell";
import { create } from "zustand";

/**
 * Whether someone is at this computer, as its main process hears it
 * (src/main/presence.ts): the ambient music pauses while nobody is, Settings
 * offers Pause when you're away only where the computer can tell, and a card
 * is marked seen only while someone is there (../cards/useSeenReport.ts).
 * Until the first reading, someone is here and nothing is watched; `read`
 * says the first reading came, or could not.
 */
export const usePresence = create<Presence & { read: boolean }>(() => ({
  away: false,
  watched: false,
  read: false,
}));

/** Reads presence once and follows each change after; call once. */
export function followPresence(): void {
  const api = window.infinitary.app;
  let pushed = false;
  api.onPresence((presence) => {
    pushed = true;
    usePresence.setState({ ...presence, read: true });
  });
  void api.presence().then(
    (presence) => {
      // A push that arrived first is newer than this answer.
      if (!pushed) usePresence.setState({ ...presence, read: true });
    },
    // With no reading the computer counts as one that cannot tell, so cards are marked seen as before.
    () => usePresence.setState({ read: true }),
  );
}
