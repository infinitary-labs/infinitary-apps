import {
  INSTALLED_PLUGIN_PREFIX,
  PERSONAL_PLUGIN_PREFIX,
  type PersonalExtensionView,
} from "@shared/personal/manifest";
import type { FramedPanelContent } from "./FramedPanelBody";

/**
 * A panel's pinned version, for its cards: present or not, while it is
 * compiled and served. The captain's own carries its background work and
 * whether the app stopped it; one he added has none.
 */
export function framedCodeOf(view: PersonalExtensionView): FramedPanelContent | null {
  if (!view.frame) return null;
  const installed = view.source === "installed";
  return {
    id: view.id,
    pluginId: `${installed ? INSTALLED_PLUGIN_PREFIX : PERSONAL_PLUGIN_PREFIX}${view.id}`,
    title: view.title,
    size: view.size,
    code: { source: installed ? "installed" : "personal", version: view.frame.version },
    reads: view.reads,
    sql: view.sql,
    moves: view.moves,
    decides: view.ownPresence,
    // Its `invoke` always reaches the core, which answers for a panel with
    // no background work, or one whose work the app stopped, in its words.
    ...(!installed ? { server: true } : {}),
    ...(!installed && view.stopped ? { stopped: view.stopped.reason } : {}),
    // Paused for an earlier panel API (INF-2470): not while a task builds it.
    ...(!installed && view.paused && !view.running ? { paused: { asked: view.paused.asked } } : {}),
  };
}
