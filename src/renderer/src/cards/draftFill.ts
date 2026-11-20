import type { CardAnswer } from "@shared/cards";
import { useEffect } from "react";
import type { FrameController } from "../plugins/frames/frameController";

/**
 * The bodies on screen for each card, so another window's change to a
 * card's draft reaches every body already showing it (docs/card-authoring.md,
 * "Unsent picks follow you"). A body born later takes the draft at its
 * birth, from the shell's `cardAnswers`.
 */
const shown = new Map<string, Set<React.RefObject<FrameController | null>>>();

/**
 * Another window's preview settings for a card whose body was on screen, by
 * name, with the setting this window held when they came: a preview's
 * script reads its settings only at its birth, so they wait for the body's
 * next birth, and until then the preview on screen sends what it shows.
 */
const nextBirth = new Map<string, Map<string, { answer: CardAnswer; over: string | null }>>();

const settingOf = (answers: readonly CardAnswer[] | undefined, name: string): string | null =>
  answers?.find((answer) => answer.name === name)?.values[0] ?? null;

/**
 * Applies another window's answers to every body showing the card: true when
 * a body on screen took them, whose next reading then carries the picks. Its
 * preview settings wait for the body's next birth instead, against `held`,
 * the card's answers as this window holds them.
 */
export function fillShownBodies(
  cardId: string,
  answers: CardAnswer[],
  held: readonly CardAnswer[] | undefined,
): boolean {
  const picks = answers.filter((answer) => !answer.json);
  let took = false;
  for (const controller of shown.get(cardId) ?? [])
    if (controller.current?.fill(picks)) took = true;
  if (!took) return false;
  const settings = answers.filter((answer) => answer.json);
  if (settings.length > 0) {
    const waiting = nextBirth.get(cardId) ?? new Map();
    for (const answer of settings)
      waiting.set(answer.name, { answer, over: settingOf(held, answer.name) });
    nextBirth.set(cardId, waiting);
  }
  return true;
}

/**
 * What a body born now fills from: the card's answers as this window holds
 * them, with the settings that waited for this birth, each only while this
 * window has not changed that setting since it came.
 */
export function birthFill(
  cardId: string,
  answers: CardAnswer[] | undefined,
): CardAnswer[] | undefined {
  const waiting = nextBirth.get(cardId);
  if (!waiting) return answers;
  nextBirth.delete(cardId);
  const due = [...waiting].filter(([name, kept]) => settingOf(answers, name) === kept.over);
  if (due.length === 0) return answers;
  const names = new Set(due.map(([name]) => name));
  return [
    ...(answers ?? []).filter((answer) => !names.has(answer.name)),
    ...due.map(([, kept]) => kept.answer),
  ];
}

/** The card left this window: settings that waited for its next birth go with it. */
export function forgetNextBirth(cardId: string): void {
  nextBirth.delete(cardId);
}

/** Lists this body under its card while it is mounted. */
export function useDraftFill(
  cardId: string | undefined,
  controllerRef: React.RefObject<FrameController | null>,
): void {
  useEffect(() => {
    if (!cardId) return;
    const bodies = shown.get(cardId) ?? new Set();
    bodies.add(controllerRef);
    shown.set(cardId, bodies);
    return () => {
      bodies.delete(controllerRef);
      if (bodies.size === 0 && shown.get(cardId) === bodies) shown.delete(cardId);
    };
  }, [cardId, controllerRef]);
}
