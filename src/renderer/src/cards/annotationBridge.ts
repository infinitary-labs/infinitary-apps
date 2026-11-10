import type { CardNote } from "@shared/cardNotes";
import { notePartIn, sameNoteTarget } from "@shared/cardNoteTargets";
import { cardNavigationParts } from "@shared/cardParts";
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
  { sync: () => void; reveal: (note: CardNote, edit: boolean) => Promise<NoteReveal> }
>();
export function syncAnnotation(cardId?: string): void {
  if (cardId) bridges.get(cardId)?.sync();
}
/** Escape consumes only this card's empty pick, without discarding a comment. */
export function dismissEmptyAnnotation(cardId: string | undefined): boolean {
  const { annotationPick: pick, pointAtCard } = useShellStore.getState();
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
    const target = (note: CardNote): FrameAnnotationTarget | undefined => {
      const start = notePartIn(latest.current.parts, note, latest.current.originalToRendered);
      const endPart = note.endKey
        ? notePartIn(
            latest.current.parts,
            {
              ...note,
              key: note.endKey,
              start: note.span?.endPart ?? 0,
              endKey: undefined,
              span: undefined,
            },
            latest.current.originalToRendered,
          )
        : undefined;
      if (start === undefined || (note.endKey && endPart === undefined)) return undefined;
      return {
        start,
        kind: note.kind,
        excerpt: note.excerpt,
        ...(note.span
          ? { span: { ...note.span, ...(endPart !== undefined ? { endPart } : {}) } }
          : {}),
      };
    };
    const sync = () => {
      const s = useShellStore.getState();
      const mode = s.pointAtCard === cardId;
      const current =
        s.annotationPick?.cardId === cardId ? target(s.annotationPick.note) : undefined;
      const queued = (s.replyNotes[cardId] ?? []).flatMap((note) => {
        const t = target(note);
        return t ? [t] : [];
      });
      controller.current?.annotate(
        mode && s.annotationPick?.cardId !== cardId,
        queued,
        current,
        mode && !previousMode,
      );
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
            const open = useShellStore.getState().annotationPick;
            if (open?.cardId === cardId && open.note.comment) {
              sync();
              if (focusComment !== false)
                document
                  .querySelector<HTMLTextAreaElement>(".inf-annotation-popover textarea")
                  ?.focus();
              return;
            }
            const part = latest.current.parts.find((part) => part.start === picked.start);
            const rect = frame.current?.getBoundingClientRect();
            if (!part || !rect) return;
            const source = cardBodyHtml(
              useShellStore.getState().cards.find((card) => card.id === cardId)?.body ??
                latest.current.body,
            );
            const sourceParts = cardNavigationParts(source);
            const original =
              sourceParts.find(
                (candidate) =>
                  candidate.key === part.key &&
                  (latest.current.originalToRendered?.(candidate.start) ?? candidate.start) ===
                    part.start,
              ) ?? sourceParts.find((candidate) => candidate.key === part.key);
            const end =
              picked.span?.endPart === undefined
                ? undefined
                : latest.current.parts.find(
                    (candidate) => candidate.start === picked.span?.endPart,
                  );
            const originalEnd = end
              ? sourceParts.find(
                  (candidate) =>
                    candidate.key === end.key &&
                    (latest.current.originalToRendered?.(candidate.start) ?? candidate.start) ===
                      end.start,
                )
              : undefined;
            const note: CardNote = {
              ...picked,
              start: original?.start ?? part.start,
              key: part.key,
              ...(end && picked.span
                ? {
                    endKey: end.key,
                    span: { ...picked.span, endPart: originalEnd?.start ?? end.start },
                  }
                : {}),
              comment: "",
              line: source.slice(0, original?.start ?? part.start).split("\n").length,
            };
            const existing = useShellStore
              .getState()
              .replyNotes[cardId]?.find(
                (n) =>
                  n.key === note.key &&
                  notePartIn(latest.current.parts, n, latest.current.originalToRendered) ===
                    picked.start &&
                  JSON.stringify(target(n)?.span) === JSON.stringify(picked.span),
              );
            useShellStore.setState({
              annotationPick: {
                cardId,
                note: existing ?? note,
                focusComment,
                box: {
                  top: rect.top + box.top,
                  bottom: rect.top + box.bottom,
                  left: rect.left + box.left,
                  right: rect.left + box.right,
                },
              },
            });
          },
        );
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
    };
  }, [cardId, controller, frame, supported]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a revised body remaps every kept target
  useLayoutEffect(() => {
    syncAnnotation(cardId);
  }, [body, cardId]);
}
