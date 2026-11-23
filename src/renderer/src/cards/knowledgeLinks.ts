import * as m from "@shared/i18n/messages.generated";
import {
  KNOWLEDGE_STANDING_WORDS,
  type KnowledgeRef,
  type KnowledgeRefs,
  knowledgeIdsIn,
} from "@shared/knowledge";
import type { FrameEntryRef } from "@shared/plugins/bridge";
import { useEffect, useMemo, useState } from "react";
import { focusPanelCard } from "../app/shellCommands";
import { openKnowledgeEntry, useKnowledgeHere } from "../plugins/point/openKnowledge";
import { appReadExecutor } from "../plugins/reads/appExecutor";

/**
 * The knowledge a card body cites (docs/knowledge.md, "References in an
 * answer"; the design skill's ResponseCard, "Knowledge references in a
 * body"): `refs` are the entry ids the body writes that name an entry the
 * window reads, as the bridge links them - each with the words its reference
 * is read by and the mark its standing takes. Which findings an answer
 * relies on is its author's call: the app links what the body writes and
 * guesses nothing.
 */
export type KnowledgeLinks = {
  refs: readonly FrameEntryRef[];
  /** The entry an id names, as the window read it. */
  entry: (id: string) => KnowledgeRef | undefined;
};

const NONE: readonly KnowledgeRef[] = [];

export function referenceLabel(ref: KnowledgeRef): string {
  const named = { id: ref.id, title: ref.title.replace(/[.\s]+$/, "") };
  const kind =
    ref.kind === "finding" ? m.cardKnowledgeFindingRef(named) : m.cardKnowledgeConceptRef(named);
  const standing = ref.standing
    ? ` · ${KNOWLEDGE_STANDING_WORDS[ref.standing]}`
    : ref.retired
      ? ` · ${m.cardKnowledgeRetired()}`
      : "";
  return `${kind}${standing}`;
}

/** The mark a reference's standing takes: checked with evidence, worth another look, or neither. */
export function referenceTone(ref: KnowledgeRef): FrameEntryRef["tone"] {
  if (ref.standing === "checked") return "ok";
  if (ref.standing === "recheck" || ref.standing === "differing") return "warn";
  return "none";
}

/**
 * Finds which of the entry ids a body writes name an entry the window
 * reads, and keeps each one current (`knowledge.refs` re-reads after every
 * write). Only while the window has the Knowledge browser to open them in:
 * a stable build, a view of another Mac and an alpha with nothing recorded
 * ask nothing and link nothing.
 */
export function useKnowledgeLinks(body: string): KnowledgeLinks {
  const here = useKnowledgeHere();
  const wanted = useMemo(() => knowledgeIdsIn(body).join(" "), [body]);
  const [read, setRead] = useState<readonly KnowledgeRef[]>(NONE);
  useEffect(() => {
    setRead(NONE);
    if (!here || !wanted) return;
    return appReadExecutor().subscribe(
      "knowledge.refs",
      { ids: wanted.split(" ") },
      {
        onValue: (value) => {
          const answer = value as KnowledgeRefs;
          setRead(answer.state === "ready" ? answer.refs : NONE);
        },
        onError: () => setRead(NONE),
      },
    );
  }, [here, wanted]);
  return useMemo(
    () => ({
      refs: read.map((ref) => ({
        id: ref.id,
        label: referenceLabel(ref),
        tone: referenceTone(ref),
      })),
      entry: (id: string) => read.find((ref) => ref.id === id),
    }),
    [read],
  );
}

/**
 * A click or Enter on a linked reference: the Knowledge browser comes to
 * the front with its inspector on that entry, at its current revision. A
 * body the captain cannot act on now (`admitted` false) opens nothing.
 * Opening reads: it records no use and checks nothing.
 */
export function knowledgeReferenceGesture(
  id: string,
  context: { links: KnowledgeLinks; admitted: boolean },
): void {
  const entry = context.links.entry(id);
  if (!entry || !context.admitted) return;
  openKnowledgeEntry({ id: entry.id, scope: entry.scope }, focusPanelCard);
}
