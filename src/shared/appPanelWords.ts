import * as m from "./i18n/messages.generated.ts";
import type { PanelCommandId } from "./keyboard.ts";

/**
 * The app's own panels' commands in the app's words (docs/i18n.md, "The
 * app's own panels"). A panel's `manifest.json` is its author's format, so
 * an app panel's keeps its English there, as any panel's does, and a copy of
 * the folder added from elsewhere reads it. The app words its own panels'
 * commands from the catalog instead, by the command's id, which no panel
 * added from elsewhere may take: its label, and the other words command
 * search finds it by, one string separated by commas as a catalog command's
 * (`searchWords` in ./keyboard.ts). `appPanelWords.test.ts` holds every
 * app panel folder's commands to this table, their English included.
 */
export type AppPanelCommandWords = { label: () => string; words?: () => string };

export const APP_PANEL_COMMAND_WORDS: Readonly<
  Partial<Record<PanelCommandId, AppPanelCommandWords>>
> = {
  "panel:now/find": { label: m.commandPanelNowFind },
  "panel:now/board": { label: m.commandPanelNowBoard, words: m.commandPanelNowBoardWords },
  "panel:now/board-find": {
    label: m.commandPanelNowBoardFind,
    words: m.commandPanelNowBoardFindWords,
  },
  "panel:now/board-backlog": {
    label: m.commandPanelNowBoardBacklog,
    words: m.commandPanelNowBoardBacklogWords,
  },
  "panel:now/board-done": {
    label: m.commandPanelNowBoardDone,
    words: m.commandPanelNowBoardDoneWords,
  },
  "panel:now/board-dropped": {
    label: m.commandPanelNowBoardDropped,
    words: m.commandPanelNowBoardDroppedWords,
  },
  "panel:now/collapse-parts": {
    label: m.commandPanelNowCollapseParts,
    words: m.commandPanelNowCollapsePartsWords,
  },
  "panel:now/expand-parts": {
    label: m.commandPanelNowExpandParts,
    words: m.commandPanelNowExpandPartsWords,
  },
  "panel:now/tag-filter": {
    label: m.commandPanelNowTagFilter,
    words: m.commandPanelNowTagFilterWords,
  },
  "panel:now/group": { label: m.commandPanelNowGroup, words: m.commandPanelNowGroupWords },
  "panel:now/board-tags": {
    label: m.commandPanelNowBoardTags,
    words: m.commandPanelNowBoardTagsWords,
  },
  "panel:now/board-move": {
    label: m.commandPanelNowBoardMove,
    words: m.commandPanelNowBoardMoveWords,
  },
  "panel:knowledge/open": {
    label: m.commandPanelKnowledgeOpen,
    words: m.commandPanelKnowledgeOpenWords,
  },
  "panel:batches-panel/open": {
    label: m.commandPanelBatchesPanelOpen,
    words: m.commandPanelBatchesPanelOpenWords,
  },
};
