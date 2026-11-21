import type { CardNote } from "@shared/cardNotes";
import { noteTarget, pickedNote, sameNoteTarget } from "@shared/cardNoteTargets";
import { cardNavigationParts } from "@shared/cardParts";
import { CARD_REPLY_MAX_CHARS } from "@shared/cards";
import type { FrameAnnotationTarget } from "@shared/plugins/bridge";
import { useLayoutEffect, useMemo, useRef } from "react";
import { useShellStore } from "../app/store";
import type { FrameController } from "../plugins/frames/frameController";
import { whenFrameHoldsFocus } from "../plugins/frames/frameFocus";
import { cardBodyHtml } from "./prototypeSrcdoc";
import { revealInCard } from "./RevisionNavigation";
import { useAnnotationHome } from "./useAnnotationHome";

export type NoteReveal = "revealed" | "missing" | "unavailable";

const bridges = new Map<
  string,
  {
    sync: (clear?: boolean) => void;
    reveal: (note: CardNote, edit: boolean) => Promise<NoteReveal>;
  }
>();
export function syncAnnotation(cardId?: string): void {
  if (cardId) bridges.get(cardId)?.sync();
}

export function sameNote(a: CardNote, b: CardNote): boolean {
  return (
    a.key === b.key && a.start === b.start && JSON.stringify(a.span) === JSON.stringify(b.span)
  );
}

/** Keyboard focus goes back to the card's Point at once its row is drawn again. */
export function focusPointAt(cardId: string): void {
  requestAnimationFrame(() =>
    document
      .querySelector<HTMLButtonElement>(`[data-card-point-at="${CSS.escape(cardId)}"]`)
      ?.focus(),
  );
}

/** Queue (or replace) a note and close its editor; the frame's selection clears with it. */
export function queueNote(cardId: string, note: CardNote): void {
  useShellStore.setState((s) => ({
    replyNotes: {
      ...s.replyNotes,
      [cardId]: [...(s.replyNotes[cardId] ?? []).filter((n) => !sameNote(n, note)), note],
    },
    annotationPick: null,
  }));
  bridges.get(cardId)?.sync(true);
}

export function removeNote(cardId: string, note: CardNote): void {
  useShellStore.setState((s) => ({
    replyNotes: {
      ...s.replyNotes,
      [cardId]: (s.replyNotes[cardId] ?? []).filter((n) => !sameNote(n, note)),
    },
    ...(s.annotationPick?.cardId === cardId && sameNote(s.annotationPick.note, note)
      ? { annotationPick: null }
      : {}),
  }));
}

/**
 * A press outside the open note editor closes it and keeps its words (INF-3786):
 * a note with words, or one already queued, is queued; an empty new note is dropped.
 * A comment past its limit, which only dictation writes, stays open to trim
 * and answers false.
 */
export function settleAnnotation(): boolean {
  const s = useShellStore.getState();
  const pick = s.annotationPick;
  if (!pick || s.sendingReplies[pick.cardId]) return true;
  if (pick.note.comment.length > CARD_REPLY_MAX_CHARS) return false;
  const queued = (s.replyNotes[pick.cardId] ?? []).some((n) => sameNote(n, pick.note));
  if (pick.note.comment || queued) queueNote(pick.cardId, pick.note);
  else useShellStore.setState({ annotationPick: null });
  return true;
}

/** Escape consumes only this card's Annotate offer or empty pick, without discarding a comment. */
export function dismissEmptyAnnotation(cardId: string | undefined): boolean {
  const { annotationPick: pick, annotationOffer: offer, pointAtCard } = useShellStore.getState();
  if (cardId && offer?.cardId === cardId) {
    useShellStore.setState({ annotationOffer: null });
    return true;
  }
  if (!cardId || pick?.cardId !== cardId || pick.note.comment) return false;
  useShellStore.setState({
    annotationPick: null,
    ...(pointAtCard === cardId ? { pointAtCard: null } : {}),
  });
  return true;
}

export function revealNote(cardId: string, note: CardNote, edit = false): Promise<NoteReveal> {
  return bridges.get(cardId)?.reveal(note, edit) ?? Promise.resolve("unavailable");
}

/** Bind only card bodies, never panels; no captain words are sent down to the frame. */
export function useAnnotationBridge(
  cardId: string | undefined,
  body: string,
  controller: React.RefObject<FrameController | null>,
  frame: React.RefObject<HTMLIFrameElement | null>,
  admit?: () => boolean,
  originalToRendered?: (start: number) => number,
): void {
  const supported = useAnnotationHome();
  const parts = useMemo(() => (supported ? cardNavigationParts(body) : []), [body, supported]);
  const latest = useRef({ body, parts, admit, originalToRendered });
  latest.current = { body, parts, admit, originalToRendered };
  useLayoutEffect(() => {
    if (!cardId || !supported) return;
    let previousMode = false;
    const target = (note: CardNote): FrameAnnotationTarget | undefined =>
      noteTarget(latest.current.parts, note, latest.current.originalToRendered);
    const sync = (clear = false) => {
      const s = useShellStore.getState();
      const mode = s.pointAtCard === cardId;
      const current =
        s.annotationPick?.cardId === cardId ? target(s.annotationPick.note) : undefined;
      const queued = (s.replyNotes[cardId] ?? []).flatMap((note) => {
        const t = target(note);
        return t ? [t] : [];
      });
      controller.current?.annotate(mode, queued, current, mode && !previousMode, clear);
      if (mode && !previousMode) frame.current?.focus();
      previousMode = mode;
    };
    const bridge = {
      sync,
      reveal: async (note: CardNote, edit: boolean): Promise<NoteReveal> => {
        if (!frame.current || !controller.current || latest.current.admit?.() === false)
          return "unavailable";
        const t = target(note);
        if (!t) return "missing";
        const shown = frame.current;
        const revealed = await controller.current.revealAnnotation(t);
        if (!revealed || shown !== frame.current || latest.current.admit?.() === false)
          return "unavailable";
        void revealInCard(shown, revealed.top, false, () => latest.current.admit?.() !== false);
        if (edit) {
          const box = frame.current.getBoundingClientRect();
          useShellStore.setState({
            annotationPick: {
              cardId,
              note,
              box: { top: box.top, bottom: box.top, left: box.left, right: box.right },
            },
          });
        }
        return "revealed";
      },
    };
    bridges.set(cardId, bridge);
    controller.current?.update({
      onAnnotation: (picked, box, focusComment) => {
        if (latest.current.admit?.() === false || useShellStore.getState().sendingReplies[cardId])
          return;
        whenFrameHoldsFocus(
          () => frame.current,
          () => {
            const rect = frame.current?.getBoundingClientRect();
            const source = cardBodyHtml(
              useShellStore.getState().cards.find((card) => card.id === cardId)?.body ??
                latest.current.body,
            );
            const note = pickedNote({
              picked,
              parts: latest.current.parts,
              source,
              queued: useShellStore.getState().replyNotes[cardId] ?? [],
              ...(latest.current.originalToRendered
                ? { originalToRendered: latest.current.originalToRendered }
                : {}),
            });
            if (!note || !rect) return;
            const at = {
              top: rect.top + box.top,
              bottom: rect.top + box.bottom,
              left: rect.left + box.left,
              right: rect.left + box.right,
            };
            const s = useShellStore.getState();
            if (s.annotationPick?.cardId === cardId && sameNote(s.annotationPick.note, note)) {
              document
                .querySelector<HTMLTextAreaElement>(".inf-annotation-popover textarea")
                ?.focus();
              return;
            }
            // Selected words with Point at off only offer Annotate; Copy keeps the selection.
            if (!focusComment && s.pointAtCard !== cardId) {
              useShellStore.setState({ annotationOffer: { cardId, note, box: at } });
              return;
            }
            if (!settleAnnotation()) return;
            // Point at turns off once it has picked; pointing at another part takes it again.
            useShellStore.setState((state) => ({
              annotationPick: { cardId, note, box: at },
              annotationOffer: null,
              ...(state.pointAtCard === cardId ? { pointAtCard: null } : {}),
            }));
          },
        );
      },
      onPointerDown: () => {
        settleAnnotation();
        if (useShellStore.getState().annotationOffer?.cardId === cardId)
          useShellStore.setState({ annotationOffer: null });
      },
      onSelectionCleared: () => {
        if (useShellStore.getState().annotationOffer?.cardId === cardId)
          useShellStore.setState({ annotationOffer: null });
      },
      onPointExit: () => {
        dismissEmptyAnnotation(cardId);
        useShellStore.setState({ pointAtCard: null });
      },
    });
    sync();
    const unsubscribe = useShellStore.subscribe((state, previous) => {
      const pick = state.annotationPick?.cardId === cardId ? state.annotationPick.note : undefined;
      const before =
        previous.annotationPick?.cardId === cardId ? previous.annotationPick.note : undefined;
      if (
        (state.pointAtCard === cardId) === (previous.pointAtCard === cardId) &&
        state.replyNotes[cardId] === previous.replyNotes[cardId] &&
        sameNoteTarget(pick, before)
      )
        return;
      sync();
    });
    return () => {
      unsubscribe();
      if (bridges.get(cardId) === bridge) bridges.delete(cardId);
      if (useShellStore.getState().annotationPick?.cardId === cardId)
        useShellStore.setState({ annotationPick: null });
      if (useShellStore.getState().annotationOffer?.cardId === cardId)
        useShellStore.setState({ annotationOffer: null });
    };
  }, [cardId, controller, frame, supported]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a revised body remaps every kept target
  useLayoutEffect(() => {
    syncAnnotation(cardId);
  }, [body, cardId]);
}
