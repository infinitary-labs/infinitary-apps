import { type PersonalExtensionView, personalDraftPanelId } from "@shared/personal/manifest";
import { useSyncExternalStore } from "react";
import { PanelHeaderButtons } from "../plugins/PanelHeaderButtons";
import { panelRail, useRailSaid } from "../plugins/panelRail";
import { SidePanelChrome } from "../plugins/SidePanelChrome";
import { FramedPanelBody, FramedPanelStatus } from "./FramedPanelBody";
import { framedCodeOf } from "./framedCode";

/**
 * The captain's own panels as the crewmates building them have them now
 * (docs/personal-panels.md, "Built apart"). The rails keep each panel's
 * last commit until the build's report; the draft - the snapshot's
 * `drafts` - is drawn here instead, out of sight at rail width, in the same
 * chrome a rail gives it, under `personalDraftPanelId`. That copy is what
 * the crewmate's capture photographs. Its body is a frame like the panel's
 * on the rail (INF-2205 piece C), bound apart: it is inert and hidden from
 * assistive technology, so no click, key or F6 of the captain's reaches it,
 * and its page reaches its own store and background work, never his.
 */
let drafts: readonly PersonalExtensionView[] = [];
const listeners = new Set<() => void>();

export const panelDrafts = {
  set(next: readonly PersonalExtensionView[]): void {
    if (JSON.stringify(next) === JSON.stringify(drafts)) return;
    // A build that is over takes what its copy said with it.
    for (const gone of drafts.filter((view) => !next.some((draft) => draft.id === view.id))) {
      panelRail.forget(personalDraftPanelId(gone.id));
    }
    drafts = next;
    for (const listener of listeners) listener();
  },
  get(): readonly PersonalExtensionView[] {
    return drafts;
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

export function PanelDrafts() {
  const shown = useSyncExternalStore(panelDrafts.subscribe, panelDrafts.get, panelDrafts.get);
  return shown
    .filter((view) => view.source === "yours" && view.frame !== null && view.present)
    .map((view) => (
      <div key={view.id} data-panel-draft={view.id} aria-hidden="true" inert>
        <DraftPanel view={view} />
      </div>
    ));
}

function DraftPanel({ view }: { view: PersonalExtensionView }) {
  const id = personalDraftPanelId(view.id);
  const said = useRailSaid(id);
  const code = framedCodeOf(view);
  if (!code) return null;
  return (
    <SidePanelChrome
      id={id}
      title={view.title}
      attribution={null}
      status={<FramedPanelStatus content={{ ...code, draft: true }} title={view.title} />}
      size={view.size}
      placementY={view.placement.y}
      collapsed={false}
      onToggleCollapsed={() => {}}
      // Its own code decides, as on a rail: off it, there is nothing to photograph.
      hidden={view.ownPresence && said.shown !== true}
      keepBody
      headerTool={
        view.header.length > 0 ? (
          <PanelHeaderButtons
            panel={{ id, header: view.header, commands: view.commands }}
            collapsed={false}
          />
        ) : undefined
      }
    >
      <FramedPanelBody content={{ ...code, draft: true }} />
    </SidePanelChrome>
  );
}
