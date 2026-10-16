import { panelCardViewModule } from "@shared/plugins/panelCards";
import { type ComponentType, useEffect, useMemo, useSyncExternalStore } from "react";
import type { PanelCardBodyProps, PanelSource } from "../plugins/contributions";
import { cardProp } from "../plugins/panelCards";
import {
  type ModuleImporter,
  type PersonalPanelContent,
  useLoadedModule,
  usePanelProps,
} from "./PersonalPanelBody";
import { PanelBoundary, PanelStoppedLine } from "./panelBoundary";

/**
 * One card of a panel of the captain's own, on the stack
 * (docs/ui-plugins.md, "A panel's cards"): its card view runs where its
 * panel runs, in the app's own window, imported from the same compiled
 * version as the panel (`cards/<view>.mjs` beside `panel.mjs`) and handed
 * the same props - its store, its reads, `invoke`, its cards - plus the
 * card it draws. A throw, or a view that will not load, is the card's quiet
 * line inside the app's own title row.
 *
 * The panel's compiled version is a source of its own, not the rail's: a
 * card stays drawable while its panel has nothing to show on the rail.
 */
export function personalCardBody(
  source: PanelSource<PersonalPanelContent>,
  importModule?: ModuleImporter,
): ComponentType<PanelCardBodyProps> {
  return function PersonalCardBody(props: PanelCardBodyProps) {
    const content = useSyncExternalStore(source.subscribe, source.get, source.get);
    if (!content) return <Unloaded onDrawn={props.onDrawn} />;
    return <LoadedCardBody content={content} importModule={importModule} {...props} />;
  };
}

/** The panel's code is not here this moment: the card says so, quietly. */
function Unloaded({ onDrawn }: { onDrawn: () => void }) {
  useEffect(() => onDrawn(), [onDrawn]);
  return <PanelStoppedLine card />;
}

/** A card view's module, beside its panel's in the same compiled version. */
export function cardViewUrl(panelUrl: string, view: string): string {
  return `${panelUrl.slice(0, panelUrl.lastIndexOf("/") + 1)}${panelCardViewModule(view)}`;
}

function LoadedCardBody({
  content,
  importModule,
  card,
  onDrawn,
}: PanelCardBodyProps & { content: PersonalPanelContent; importModule?: ModuleImporter }) {
  const props = usePanelProps(content, card.id);
  const loaded = useLoadedModule(
    cardViewUrl(content.url, card.view),
    content.version,
    importModule,
  );
  // The place it kept, as this page was born - the version that loaded is
  // the page: a keep does not move it until the card is born again.
  const version = loaded?.version ?? null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: read once per page, at its birth
  const kept = useMemo(() => card.kept, [version]);
  // A new object only when the card was put up again: the view hears it as
  // new data, and as one more revision even when the data is the same.
  const { panel, id, data, revision } = card;
  const cardData = useMemo(
    () => cardProp({ panel, id, data, revision }, kept),
    [panel, id, data, revision, kept],
  );
  const settled = loaded !== null;
  useEffect(() => {
    if (settled) onDrawn();
  }, [settled, onDrawn]);
  if (loaded === null) return null;
  if ("failed" in loaded) return <PanelStoppedLine card />;
  const { Component } = loaded;
  return (
    <PanelBoundary key={loaded.version} card>
      <Component {...props} card={cardData} />
    </PanelBoundary>
  );
}
