import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { registerBuiltinPlugin } from "../plugins/builtin";
import { orderSettingsSections, pluginHost } from "../plugins/host";
import {
  SETTINGS_COLUMN_PX,
  SettingsScreen,
  sectionsFor,
  settingsColumnStyle,
  tabStep,
} from "./SettingsScreen";

describe("Settings column", () => {
  it("uses the Intelligence wide width and shrinks with the window", () => {
    const style = settingsColumnStyle("wide");
    expect(style.width).toBe(SETTINGS_COLUMN_PX);
    expect(style.maxWidth).toBe("100%");
    expect(style.boxSizing).toBe("border-box");
  });

  it("offers a Mac that controls another only its own keys, its own look, the automations that run there and Leave", () => {
    const remove = registerBuiltinPlugin(pluginHost);
    try {
      const sections = orderSettingsSections(pluginHost.settingsSections.list());
      const view = {
        role: "view",
        name: "MacBook Pro",
        address: "192.168.1.20",
        joinedAt: 0,
        contact: "in-reach",
        readOnly: null,
        heardAt: null,
        caughtUp: 1,
      } as const;
      expect(sectionsFor(sections, view).map((section) => section.id)).toEqual([
        "appearance",
        "keyboard",
        "automation",
        "devices",
      ]);
      expect(sectionsFor(sections, { role: "home", left: null })).toEqual(sections);
      expect(sectionsFor(sections, null)).toEqual(sections);
    } finally {
      remove();
    }
  });
});

describe("Settings tabs from the keyboard", () => {
  it("move to the next and previous tab with the arrows, wrapping around, and to the ends with Home and End", () => {
    expect(tabStep("ArrowRight", 0, 7)).toBe(1);
    expect(tabStep("ArrowRight", 6, 7)).toBe(0);
    expect(tabStep("ArrowLeft", 0, 7)).toBe(6);
    expect(tabStep("ArrowLeft", 3, 7)).toBe(2);
    expect(tabStep("Home", 4, 7)).toBe(0);
    expect(tabStep("End", 1, 7)).toBe(6);
  });

  it("leave every other key to the browser, and move nothing without tabs", () => {
    expect(tabStep("ArrowDown", 0, 7)).toBeNull();
    expect(tabStep("Enter", 0, 7)).toBeNull();
    expect(tabStep("ArrowRight", 0, 0)).toBeNull();
  });

  it("are one Tab stop, the chosen tab, each naming the section it opens", () => {
    const remove = registerBuiltinPlugin(pluginHost);
    try {
      const html = renderToStaticMarkup(<SettingsScreen />);
      const tabs = html.match(/<button[^>]*role="tab"[^>]*>/g) ?? [];
      expect(tabs.length).toBeGreaterThan(1);
      expect(tabs.filter((tab) => tab.includes('tabindex="0"'))).toHaveLength(1);
      expect(tabs.filter((tab) => tab.includes('tabindex="-1"'))).toHaveLength(tabs.length - 1);
      const panel = html.match(/<div[^>]*role="tabpanel"[^>]*>/)?.[0] ?? "";
      const panelId = /id="([^"]+)"/.exec(panel)?.[1];
      expect(panelId).toBeDefined();
      for (const tab of tabs) expect(tab).toContain(`aria-controls="${panelId}"`);
    } finally {
      remove();
    }
  });
});
