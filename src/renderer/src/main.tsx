import { setCurrentLanguage } from "@shared/i18n/current";
import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { documentLanguage } from "./app/language";
import { hydratePreferences } from "./app/preferences";
import { countPresses } from "./app/presses";
import { registerDesignFixtures } from "./design/fixtures";
import { startPersonalPlugins } from "./personal/personalPlugins";
import { registerBuiltinPlugin, startGatedPanels } from "./plugins/builtin";
import { pluginHost } from "./plugins/host";
import { startPanelCommands } from "./plugins/panelCommands";
import { startPanelMounts } from "./plugins/panelMounts";
import "./design/styles.css";

const container = document.getElementById("root");
if (!container) throw new Error("Renderer root element missing");

// The captain's presses are counted before anything else listens, so a
// card pointed at knows whether a press began since (app/presses.ts).
countPresses();

// The app's own UI is the first plugin (docs/ui-plugins.md); it registers
// before the first render so every registry is populated when read.
registerBuiltinPlugin(pluginHost);
// The core's snapshot mounts the captain's own panels and the ones he
// added through the same host, each drawn in a frame of its own.
// The app's own panels that wait on a gate - Knowledge, in an alpha or
// development build with knowledge to show (docs/knowledge.md) - take a
// rail's place after the captain's own panels have theirs.
startPersonalPlugins(pluginHost, undefined, () => startGatedPanels(pluginHost));
// Every panel's commands join the window's keys and command search
// (docs/keyboard.md, "A panel's commands"), as the panels come and go.
startPanelCommands(pluginHost);
// What the window did with each panel, for the core (docs/personal-panels.md, "Placed on the rail").
startPanelMounts(pluginHost);
// Off unless this window's own localStorage asks for it (design/fixtures):
// the library gallery for the coherence check. No product path writes that key.
registerDesignFixtures(pluginHost);

// The persisted theme and layout are read before the first paint, so the
// window opens the way the captain left it rather than correcting itself a
// frame later. A failed read has already fallen back to the defaults.
// The window's language is the one its preload marked on the document,
// read before anything is worded (docs/i18n.md, "The language fact").
void Promise.all([hydratePreferences(), documentLanguage()]).then(([, language]) => {
  setCurrentLanguage(language);
  createRoot(container).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
});
