import { type ShellState, useShellStore } from "./store";

/**
 * Whether this window holds words not yet sent: the message box's words,
 * pictures or pastes, or a reply under a card with its words, notes,
 * pastes or pictures. An app following its home's version waits to start
 * again while any of its windows holds some (docs/view.md, "Following the
 * home's version"), so a restart never takes what someone is writing.
 */
export function holdsUnsentWords(state: ShellState): boolean {
  return (
    state.inputText.trim() !== "" ||
    state.attachments.length > 0 ||
    state.pastes.length > 0 ||
    Object.values(state.replyDrafts).some((draft) => draft.trim() !== "") ||
    Object.values(state.replyNotes).some((notes) => notes.length > 0) ||
    Object.values(state.replyPastes).some((pastes) => pastes.length > 0) ||
    Object.values(state.replyImages).some((images) => images.length > 0)
  );
}

/** Tells the main process each time this window starts or stops holding unsent words. */
export function followUnsentWords(): () => void {
  let told: boolean | null = null;
  const tell = (state: ShellState) => {
    const holds = holdsUnsentWords(state);
    if (holds === told) return;
    told = holds;
    // A refused tell misses nothing: the app goes on as nobody wrote anything.
    void window.infinitary.update.unsent(holds).catch(() => undefined);
  };
  tell(useShellStore.getState());
  return useShellStore.subscribe((state) => tell(state));
}
