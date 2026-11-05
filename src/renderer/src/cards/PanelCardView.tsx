import type { FrameTheme } from "@shared/plugins/frameDocument";
import { useContext, useEffect, useSyncExternalStore } from "react";
import type { PanelCardEntry } from "../app/store";
import { CardCorner, CardSizeContext } from "../design/cards/CardSize";
import { CARD_MAX_HEIGHT, ResponseCard } from "../design/cards/ResponseCard";
import { pluginHost } from "../plugins/host";

/**
 * One of a panel's cards on the stage (docs/ui-plugins.md, "A panel's
 * cards"; the design skill's `components/cards/PanelCard.prompt.md`): a
 * shell-held stack entry like a task's record, put up by its panel's
 * `cards.emit`, a header button or a command. The app draws its one row of
 * chrome - the card's title, then "yours" or its maker's name (nothing for
 * the app's own), and Hide - and the panel's card view draws the rest,
 * where its panel runs (the binding's `CardBody`).
 *
 * Only the shown card draws a body: the stage prepares no held entry, so a
 * card waiting its turn runs no page at all.
 *
 * A card of `fill` height takes the stage's height, and its view fills the
 * body edge to edge and scrolls itself, so it can keep a row of its own in
 * place (the task board's own row and foot); any other card grows with its
 * view and scrolls it.
 */
export function PanelCardView({
  card,
  theme,
  onClose,
  onDrawn,
}: {
  card: PanelCardEntry;
  theme: FrameTheme;
  onClose: () => void;
  onDrawn: () => void;
}) {
  const panels = useSyncExternalStore(
    pluginHost.sidePanels.subscribe,
    pluginHost.sidePanels.list,
    pluginHost.sidePanels.list,
  );
  const panel = panels.find((candidate) => candidate.id === card.panel);
  // An Escape the card's view did not use restores a maximized card before it hides one.
  const size = useContext(CardSizeContext);
  const Body = panel?.CardBody;
  // A card whose panel is gone this moment (a reload of its files) draws
  // nothing to wait for: the stage reveals it at once.
  useEffect(() => {
    if (!Body) onDrawn();
  }, [Body, onDrawn]);
  const fill = card.height === "fill";
  return (
    <ResponseCard
      width="100%"
      minHeight={0}
      title={card.title}
      {...(fill
        ? {
            style: { height: CARD_MAX_HEIGHT },
            bodyStyle: { padding: 0, overflow: "hidden", scrollbarGutter: "auto" },
          }
        : {})}
      chrome={<PanelCardChrome title={card.title} attribution={panel?.attribution ?? null} />}
    >
      <div
        data-panel-card={`${card.panel}/${card.id}`}
        data-panel-card-view={card.view}
        data-panel-card-height={card.height}
        style={{
          fontSize: "var(--text-sm)",
          lineHeight: "var(--leading-body)",
          color: "var(--fg-2)",
          ...(fill ? { height: "100%" } : {}),
        }}
      >
        {Body ? (
          <Body
            card={card}
            theme={theme}
            onDrawn={onDrawn}
            onEscape={size?.maximized ? () => size.toggle(true) : onClose}
          />
        ) : null}
      </div>
    </ResponseCard>
  );
}

/** The card's one row of chrome: its title, who made its panel, and Hide. */
function PanelCardChrome({ title, attribution }: { title: string; attribution: string | null }) {
  return (
    <div
      data-panel-card-chrome=""
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-2)",
        padding: "var(--space-2) var(--space-2) var(--space-2) var(--space-4)",
        borderBottom: "1px solid var(--line-1)",
        flexShrink: 0,
        minWidth: 0,
      }}
    >
      <span
        data-panel-card-title=""
        style={{
          fontSize: "var(--text-md)",
          fontWeight: "var(--weight-medium)",
          color: "var(--fg-1)",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          minWidth: 0,
        }}
      >
        {title}
      </span>
      {attribution !== null && (
        <span
          data-panel-card-attribution=""
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-xs)",
            color: "var(--fg-3)",
            whiteSpace: "nowrap",
            flexShrink: 0,
          }}
        >
          {attribution}
        </span>
      )}
      <CardCorner style={{ marginLeft: "auto" }} />
    </div>
  );
}
