import type { SavedOwnStyle } from "@shared/ambientOwn";
import * as m from "@shared/i18n/messages.generated";
import type { AmbientStyle } from "@shared/preferences";
import { create } from "zustand";
import { mainMessageRefusal } from "../app/composer";
import { useShellStore } from "../app/store";

/**
 * The style list Settings → Appearance's Style picker and the sound button's
 * list both read (docs/ambient-music.md), so the two never differ.
 */

export const STYLE_WORDS: Record<AmbientStyle, { name: () => string; description: () => string }> =
  {
    "deep-drift": {
      name: m.settingsSoundStyleDeepDrift,
      description: m.settingsSoundStyleDeepDriftDescription,
    },
    "star-cruise": {
      name: m.settingsSoundStyleStarCruise,
      description: m.settingsSoundStyleStarCruiseDescription,
    },
    "cold-sleep": {
      name: m.settingsSoundStyleColdSleep,
      description: m.settingsSoundStyleColdSleepDescription,
    },
    "quiet-cove": {
      name: m.settingsSoundStyleQuietCove,
      description: m.settingsSoundStyleQuietCoveDescription,
    },
    "tavern-embers": {
      name: m.settingsSoundStyleTavernEmbers,
      description: m.settingsSoundStyleTavernEmbersDescription,
    },
    "moonlit-deck": {
      name: m.settingsSoundStyleMoonlitDeck,
      description: m.settingsSoundStyleMoonlitDeckDescription,
    },
    "harbor-dawn": {
      name: m.settingsSoundStyleHarborDawn,
      description: m.settingsSoundStyleHarborDawnDescription,
    },
    "fair-winds": {
      name: m.settingsSoundStyleFairWinds,
      description: m.settingsSoundStyleFairWindsDescription,
    },
    "wayfinder-night": {
      name: m.settingsSoundStyleWayfinderNight,
      description: m.settingsSoundStyleWayfinderNightDescription,
    },
    "island-morning": {
      name: m.settingsSoundStyleIslandMorning,
      description: m.settingsSoundStyleIslandMorningDescription,
    },
  };

export const STYLE_GROUPS: [() => string, AmbientStyle[]][] = [
  [m.settingsSoundStyleGroupSpace, ["star-cruise", "deep-drift", "cold-sleep"]],
  [m.settingsSoundStyleGroupPirate, ["quiet-cove", "tavern-embers", "moonlit-deck"]],
  [m.settingsSoundStyleGroupNautical, ["harbor-dawn", "fair-winds"]],
  [m.settingsSoundStyleGroupIsland, ["wayfinder-night", "island-morning"]],
];

/**
 * Describe your own (docs/ambient-music.md, "Your own styles"): home, with
 * the message box starting the ask to the first mate and the caret after
 * it, for the person to describe the music. Nothing is sent from here.
 * Refused, as Go to the main message is, while the box is held.
 */
export function describeOwnStyle(): void {
  const shell = useShellStore.getState();
  if (mainMessageRefusal(shell) !== null) return;
  shell.focusMainMessage();
  shell.beginDraft(m.settingsSoundOwnDraft());
}

/** A style's name and its line: a shipped style's words, or the person's own. */
export function styleWords(
  id: string,
  own: readonly Pick<SavedOwnStyle, "id" | "name" | "words">[],
): { name: string; description: string } {
  const saved = own.find((style) => style.id === id);
  if (saved) return { name: saved.name, description: saved.words || m.settingsSoundOwnNoWords() };
  const words = STYLE_WORDS[id as AmbientStyle];
  return { name: words.name(), description: words.description() };
}

/**
 * Choose ambient music (`ambient.style`) asks the sound button to open its
 * list on the chosen style; the button takes the ask once it is drawn, as it
 * is not while the music is off.
 */
export const useStyleListAsk = create<{ asked: boolean }>(() => ({ asked: false }));

/** Choose ambient music: the music on, then the sound button's list open. */
export function openStyleList(): void {
  const shell = useShellStore.getState();
  if (!shell.ambientMusic) shell.setAmbientMusic(true);
  useStyleListAsk.setState({ asked: true });
}
