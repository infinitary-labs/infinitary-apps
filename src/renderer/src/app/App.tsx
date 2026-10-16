import { useEffect, useRef } from "react";
import { guardStrayFileDrops } from "../attachments/strayDrops";
import { markShellPainted } from "../design/reveals";
import { ViewPill } from "../devices/RemoteControl";
import { PanelDrafts } from "../personal/PanelDrafts";
import { guardFrameActivation } from "../plugins/frames/frameActivation";
import { giveHandedFocusBack, guardFrameFocus } from "../plugins/frames/frameFocus";
import { placeSidePanels, pluginHost, useContributions } from "../plugins/host";
import { PeekSummary } from "../plugins/point/PeekSummary";
import { Rail } from "../plugins/Rail";
import { useRailLayout } from "../plugins/railStore";
import { SettingsScreen } from "../settings/SettingsScreen";
import { CommandSearch } from "./CommandSearch";
import { cardStage } from "./cardStage";
import { followDictationKey } from "./dictationKey";
import { guardLostFocus } from "./focusRecovery";
import { HomeMate, HomePrompt, HomeScreen } from "./HomeScreen";
import { guardHeldPresses } from "./heldKeys";
import { applyTheme } from "./preferences";
import { followShellCommands } from "./shellCommands";
import { isHeldEntry, shownCard, useShellStore } from "./store";
import { TopBar } from "./TopBar";

export function App() {
  useEffect(() => guardStrayFileDrops(), []);
  useEffect(() => guardLostFocus(giveHandedFocusBack), []);
  useEffect(() => guardFrameFocus(), []);
  useEffect(() => guardFrameActivation(), []);
  useEffect(() => guardHeldPresses(), []);
  useEffect(() => followShellCommands(), []);
  const theme = useShellStore((s) => s.theme);
  const view = useShellStore((s) => s.view);
  const setView = useShellStore((s) => s.setView);
  const init = useShellStore((s) => s.init);
  const backButtonRef = useRef<HTMLButtonElement>(null);
  // The captain's layout (hidden panels, moved panels) is applied here,
  // over every registered panel, so a change the Firstmate writes lands on
  // the rails the moment the core pushes it (talk-to-personalize Step 1).
  const rails = placeSidePanels(useContributions(pluginHost.sidePanels), useRailLayout());

  useEffect(() => {
    markShellPainted();
    init();
  }, [init]);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => followDictationKey(), []);

  // Escape closes the one topmost thing that is open (docs/keyboard.md).
  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      const store = useShellStore.getState();
      if (store.pickingDictationKey) return;
      if (event.key === "Escape") {
        // An Escape nothing in the card used restores a maximized card
        // before anything else it would do (design skill ResponseCard,
        // "Maximize"); its own controls, the close question, the picture
        // viewer and command search use theirs first.
        const stage = cardStage();
        if (
          store.view === "home" &&
          stage?.maximized &&
          !event.defaultPrevented &&
          store.phase !== "recording"
        ) {
          stage.toggleSize();
          return;
        }
        const shown = shownCard(
          store.cards,
          store.cardIndex,
          store.collapsedCardIds,
          store.records,
        );
        if (store.view === "home" && isHeldEntry(shown)) {
          // A panel's card hides on an Escape nothing in it used
          // (docs/ui-plugins.md, "A panel's cards"); one its own field took stays.
          if (shown?.panelCard && event.defaultPrevented) return;
          store.closeRecord();
        } else if (store.phase === "recording") {
          store.abandonRecording();
        } else if (store.view === "settings") {
          store.setView("home");
        }
      }
    };
    window.addEventListener("keydown", down);
    return () => window.removeEventListener("keydown", down);
  }, []);

  // Landing in settings moves focus to the back control so keyboard users
  // are not stranded in the previous screen's tree.
  useEffect(() => {
    if (view === "settings") {
      backButtonRef.current?.focus();
    }
  }, [view]);

  const home = view === "home";

  // The home shell (D5): two dock rails frame a STAGE that holds the fixed
  // geometry. An empty rail is zero-width (design/styles.css), so with both
  // empty the stage is the whole window and nothing below moves. The rails
  // are home-only in v1; Settings keeps its own centred composition. The
  // activity feed is a panel on the left rail (phase 2, the built-in
  // plugin) - FYI lives in the feed (captain refinement 4a),
  // and the feed shows whenever it has lines, so an answered turn with zero
  // cards still leaves its trace there.
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        // The body paints the material tint or the void (design/styles.css); the
        // root stays clear so the window shows through it exactly once.
        background: "transparent",
        overflow: "hidden",
        fontFamily: "var(--font-ui)",
      }}
    >
      {home && <HomeMate />}
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          alignItems: "stretch",
          pointerEvents: "none",
        }}
      >
        {home && <Rail side="left" panels={rails.left} theme={theme} />}
        <div
          data-stage=""
          style={{
            position: "relative",
            flex: 1,
            minWidth: 0,
            // Stage-relative sizes (cqw) for anything that must not assume
            // the stage is the window. Clicks pass through to the mate
            // behind; cards and Settings opt back in.
            containerType: "inline-size",
            pointerEvents: home ? "none" : "auto",
          }}
        >
          {home && <HomeScreen />}
          {view === "settings" && <SettingsScreen />}
        </div>
        {home && <Rail side="right" panels={rails.right} theme={theme} />}
      </div>
      {/* The panels crewmates are building, out of sight (docs/personal-panels.md, "Built apart"). */}
      {home && <PanelDrafts />}
      {home && <HomePrompt />}
      {/* Above the rails, the cards and the input: a Tasks row's summary, or a
          task key's - in Settings too, where its keys rest the same way. */}
      <PeekSummary />
      {/* Why changes are off on the Mac this one controls (docs/view.md). */}
      {home && <ViewPill />}
      <TopBar
        view={view}
        onSettings={() => setView("settings")}
        onBack={() => setView("home")}
        backButtonRef={backButtonRef}
      />
      {/* Over everything, home or Settings: the window's commands by name. */}
      <CommandSearch />
    </div>
  );
}
