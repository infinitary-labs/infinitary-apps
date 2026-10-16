import { KNOWLEDGE_ID_EXACT } from "@shared/knowledge";
import { z } from "zod";
import { panelCardEntryId, useShellStore } from "../../app/store";
import type { SidePanelContribution } from "../contributions";
import { pluginHost, useContributions } from "../host";
import { emitNamedCard } from "../panelCards";
import type { ContributionRegistry } from "../registry";

/**
 * Pointing at knowledge from the app's own surfaces (docs/knowledge.md,
 * "References in an answer" and "Knowledge used on a task"): a card body's
 * reference and a task record's Knowledge used row open the Knowledge
 * browser's one inspector on an entry - at an earlier revision too - the
 * way the panel's own rows open the browser, by putting its card up with
 * the place in its data. Opening reads; it records no use, checks nothing
 * and changes no task.
 *
 * These surfaces live only while the Knowledge panel does: it is registered
 * only in a build that keeps knowledge and has some to show (its gate,
 * `startGatedPanels`), so a stable build, a view of another Mac and an
 * alpha with nothing recorded link nothing and list nothing.
 */

/** The Knowledge panel's id and its browser card's name (src/panels/knowledge/manifest.json). */
export const KNOWLEDGE_PANEL = "knowledge";
const BROWSER_CARD = "browser";

/** Whether the window has the Knowledge browser to open now. */
export function knowledgeHere(
  panels: Pick<ContributionRegistry<SidePanelContribution>, "get"> = pluginHost.sidePanels,
): boolean {
  return panels.get(KNOWLEDGE_PANEL)?.cards?.[BROWSER_CARD] !== undefined;
}

/** Whether the window has the Knowledge browser, following the panel as it comes and goes. */
export function useKnowledgeHere(): boolean {
  const panels = useContributions(pluginHost.sidePanels);
  return panels.some(
    (panel) => panel.id === KNOWLEDGE_PANEL && panel.cards?.[BROWSER_CARD] !== undefined,
  );
}

/** An entry to open: its id, its collection, and an earlier revision to read instead of the current one. */
export const knowledgeOpenSchema = z.strictObject({
  id: z.string().regex(KNOWLEDGE_ID_EXACT),
  scope: z.string().min(1).max(64),
  revision: z.number().int().positive().optional(),
});
export type KnowledgeOpen = z.infer<typeof knowledgeOpenSchema>;

/**
 * Puts the Knowledge browser up at the front of the stack with its inspector
 * on `entry` and the keyboard on it, from the home screen; `focus` gives the
 * card focus once the stage shows it drawn. Answers whether the browser was
 * there to put up.
 */
export function openKnowledgeEntry(
  entry: KnowledgeOpen,
  focus: (entryId: string) => void,
): boolean {
  const parsed = knowledgeOpenSchema.safeParse(entry);
  if (!parsed.success || !knowledgeHere()) return false;
  const shell = useShellStore.getState();
  if (shell.view !== "home") shell.setView("home");
  const { id, scope, revision } = parsed.data;
  const cardId = emitNamedCard(KNOWLEDGE_PANEL, BROWSER_CARD, {
    focus: "inspector",
    scope,
    entry: id,
    ...(revision !== undefined ? { revision } : {}),
  });
  if (cardId === null) return false;
  focus(panelCardEntryId(KNOWLEDGE_PANEL, cardId));
  return true;
}
