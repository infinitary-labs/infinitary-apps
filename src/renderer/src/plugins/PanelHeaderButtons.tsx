import { type CommandId, panelCommandId } from "@shared/keyboard";
import type { PanelAskVia, PanelHeaderButton, PanelHeaderIcon } from "@shared/personal/contracts";
import type { ReactNode } from "react";
import { useCommandKeys } from "../app/keyHints";
import { useShellStore } from "../app/store";
import { IconButton } from "../design";
import type { SidePanelContribution } from "./contributions";
import { emitNamedCard, pushPanelAsk } from "./panelCards";
import { railStore } from "./railStore";

/** What the buttons are drawn from: the panel's id and its manifest's header and commands. */
type HeaderButtonsPanel = Pick<SidePanelContribution, "id" | "header" | "commands">;

/**
 * A panel's header buttons (docs/ui-plugins.md, "A panel's cards"; the
 * design skill's `components/panel/Panel.prompt.md`): drawn by the app
 * from the panel's manifest beside the chevron, each from the app's own
 * icons and with the key of the command that does the same. A button that
 * names a card puts it up itself, at the front of the stack, and is drawn
 * while the panel is expanded and while it is collapsed; one that names
 * none presses itself into the panel as an ask, so it is drawn while the
 * panel shows its body - collapsed, the header keeps its room for what the
 * panel says it holds, and the command that presses it brings the panel
 * out first. Focus stays where it was, as on any header control.
 */
export function PanelHeaderButtons({
  panel,
  collapsed,
}: {
  panel: HeaderButtonsPanel;
  collapsed: boolean;
}) {
  const buttons = (panel.header ?? []).filter((button) => !collapsed || button.emits !== undefined);
  if (buttons.length === 0) return null;
  return (
    <span data-panel-header-buttons="" style={{ display: "inline-flex", flexShrink: 0 }}>
      {buttons.map((button) => (
        <HeaderButton key={button.id} panel={panel} button={button} />
      ))}
    </span>
  );
}

/**
 * A built-in panel's header button that does what a window command does,
 * keyed `<panel>/<button>`: it names that command's key, since the panel
 * declares no command of its own for it (Automation's Open Automation opens
 * Settings → Automation, as Open Automation does).
 */
const WINDOW_COMMAND_OF: Readonly<Record<string, CommandId>> = {
  "automation/open": "settings.automation",
};

function HeaderButton({ panel, button }: { panel: HeaderButtonsPanel; button: PanelHeaderButton }) {
  // The key of the command that does the same: the one that presses it,
  // else one that puts up the same card - with the same data first, then
  // with any (Open task board's key also puts focus in the board).
  const commands = panel.commands ?? [];
  const command =
    commands.find(
      (candidate) =>
        candidate.presses === button.id ||
        (button.emits !== undefined &&
          candidate.emits === button.emits &&
          JSON.stringify(candidate.data ?? null) === JSON.stringify(button.data ?? null)),
    ) ??
    (button.emits === undefined
      ? undefined
      : commands.find((candidate) => candidate.emits === button.emits));
  const keys = useCommandKeys(
    command
      ? panelCommandId(panel.id, command.id)
      : (WINDOW_COMMAND_OF[`${panel.id}/${button.id}`] ?? null),
  );
  return (
    <span data-panel-header-button={button.id} style={{ display: "inline-flex", flexShrink: 0 }}>
      <IconButton
        label={button.label}
        size={24}
        {...keys}
        onClick={() => pressHeaderButton(panel.id, button, "click")}
        style={{ color: "var(--fg-3)" }}
      >
        {PANEL_ICONS[button.icon]}
      </IconButton>
    </span>
  );
}

/**
 * What a header button does, the same from its click and from the command
 * that presses it: its card at the front, or an ask into the panel, which
 * comes out of its collapse first so its body is there to hear it, and
 * hears how the press came (`via`).
 */
export function pressHeaderButton(
  panelId: string,
  button: PanelHeaderButton,
  via: PanelAskVia,
): void {
  const s = useShellStore.getState();
  if (s.view !== "home") s.setView("home");
  if (button.emits !== undefined) {
    emitNamedCard(panelId, button.emits, button.data);
    return;
  }
  if (railStore.isCollapsed(panelId)) railStore.toggleCollapsed(panelId);
  pushPanelAsk(panelId, button.id, via);
}

/** Lucide's, 14 px, the stroke of the header's own chevron and search. */
function icon(children: ReactNode) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/** The icons a header button may wear: the app's own, never the panel's. */
export const PANEL_ICONS: Readonly<Record<PanelHeaderIcon, ReactNode>> = {
  // maximize-2: a card opened large, as Open task board wears.
  open: icon(
    <>
      <path d="M15 3h6v6" />
      <path d="M9 21H3v-6" />
      <path d="m21 3-7 7" />
      <path d="m3 21 7-7" />
    </>,
  ),
  search: icon(
    <>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </>,
  ),
  add: icon(
    <>
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </>,
  ),
  list: icon(
    <>
      <path d="M8 6h13" />
      <path d="M8 12h13" />
      <path d="M8 18h13" />
      <path d="M3 6h.01" />
      <path d="M3 12h.01" />
      <path d="M3 18h.01" />
    </>,
  ),
  note: icon(
    <>
      <path d="M15.5 3H5a2 2 0 0 0-2 2v14c0 1.1.9 2 2 2h14a2 2 0 0 0 2-2V8.5L15.5 3Z" />
      <path d="M15 3v6h6" />
    </>,
  ),
  filter: icon(<path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z" />),
  clock: icon(
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </>,
  ),
  chart: icon(
    <>
      <path d="M3 3v18h18" />
      <path d="M18 17V9" />
      <path d="M13 17V5" />
      <path d="M8 17v-3" />
    </>,
  ),
};
