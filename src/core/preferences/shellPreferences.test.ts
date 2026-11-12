import type { PushPayload } from "@shared/ipc";
import { DEFAULT_SAVED_KEYMAP, presetKeymap } from "@shared/keymap";
import { describe, expect, it } from "vitest";
import { openInMemoryDatabase } from "../storage/db";
import { keyboardPresets, MIGRATIONS } from "../storage/migrations";
import { SettingsStore } from "../storage/settingsStore";
import { ShellPreferencesService } from "./shellPreferences";

/**
 * The one writer of the captain's presentation preferences (talk-to-
 * personalize Step 1): every write lands in the settings rows and pushes
 * the whole value, and a per-panel record holds only a deviation.
 */
function setup() {
  const db = openInMemoryDatabase();
  const settings = new SettingsStore(db);
  const pushes: { channel: string; payload: unknown }[] = [];
  const service = new ShellPreferencesService(settings, (channel, payload) => {
    pushes.push({ channel, payload });
  });
  return { db, settings, pushes, service };
}

describe("ShellPreferencesService", () => {
  it("pushes the whole value after every write, equal to a fresh read", () => {
    const { service, pushes, settings } = setup();
    service.setTheme("light");
    expect(settings.getAppearance()).toEqual({
      theme: "light",
      size: 100,
      washStrength: 0,
      showCrewModelNames: true,
    });
    expect(pushes).toEqual([
      {
        channel: "inf:shell:preferences",
        payload: {
          appearance: { theme: "light", size: 100, washStrength: 0, showCrewModelNames: true },
          layout: { collapsedPanels: {}, hiddenPanels: {}, placements: {} },
          panels: { enabled: true, offReason: null },
        },
      },
    ]);
    expect(pushes[0]?.payload).toEqual(service.get());
    const pushed = pushes[0]?.payload as PushPayload<"inf:shell:preferences">;
    expect(pushed.appearance.theme).toBe("light");
  });

  it("records only deviations: hiding writes true, showing again deletes the key", () => {
    const { service, settings } = setup();
    service.setPanelHidden("now", true);
    expect(settings.getLayout().hiddenPanels).toEqual({ now: true });
    service.setPanelHidden("now", false);
    expect(settings.getLayout().hiddenPanels).toEqual({});
  });

  // INF-2344: the arrangement is written once from where the rails drew each
  // panel, so nothing moves; a panel that arrives later lands at its slot's
  // middle, and a write that changes nothing pushes nothing.
  it("writes the arrangement in once without moving a panel, then adds a new panel at its slot's middle", () => {
    const { service, settings, pushes } = setup();
    service.setLayout({
      collapsedPanels: {},
      hiddenPanels: {},
      placements: { quota: { x: "right", y: "bottom" } },
      panelOrder: ["now"],
    });
    const panels = [
      { id: "activity", preferred: { x: "left", y: "bottom" }, order: 1 },
      { id: "now", preferred: { x: "left", y: "bottom" }, order: 2 },
      { id: "quota", preferred: { x: "left", y: "top" }, order: 0 },
    ] as const;
    service.reconcile(panels);
    expect(settings.getLayout().arrangement).toEqual({
      left: { top: [], bottom: ["activity", "now"] },
      right: { top: [], bottom: ["quota"] },
    });
    expect(settings.getLayout().morePick).toBe("now");
    const written = pushes.length;
    service.reconcile(panels);
    expect(pushes.length).toBe(written);
    service.reconcile([
      ...panels,
      { id: "clock", preferred: { x: "left", y: "bottom" }, order: 3 },
    ]);
    expect(settings.getLayout().arrangement?.left.bottom).toEqual(["clock", "activity", "now"]);
  });

  it("clears every record about one panel and leaves the others", () => {
    const { service, settings } = setup();
    service.setLayout({
      collapsedPanels: { activity: false, now: true },
      hiddenPanels: { now: true },
      placements: { now: { x: "left", y: "top" }, activity: { x: "right", y: "bottom" } },
    });
    service.clearPanel("now");
    expect(settings.getLayout()).toEqual({
      collapsedPanels: { activity: false },
      hiddenPanels: {},
      placements: { activity: { x: "right", y: "bottom" } },
    });
  });

  it("reads a layout row written before the hidden and placement records", () => {
    const { service, settings } = setup();
    // What the Step 0 renderer wrote: the collapse record alone.
    settings.setLayout({ collapsedPanels: { activity: false } } as never);
    expect(service.get().layout).toEqual({
      collapsedPanels: { activity: false },
      hiddenPanels: {},
      placements: {},
    });
  });
  /**
   * The host-owned switch (Step 5). Its followers - the window through the
   * push, the personal host through `subscribe` - see the same value in
   * the same tick, which is what makes "one tick" true of the unmount.
   */
  it("writes the panels switch with its reason, pushes it, and tells its core follower", () => {
    const { service, settings, pushes } = setup();
    const followed: boolean[] = [];
    const off = service.subscribe((value) => followed.push(value.panels.enabled));

    expect(service.setPersonalPanels(false, "captain")).toEqual({
      enabled: false,
      offReason: "captain",
    });
    expect(settings.getPersonalPanels()).toEqual({ enabled: false, offReason: "captain" });
    expect(pushes.at(-1)?.payload).toEqual(service.get());
    expect(followed).toEqual([false]);

    // On clears the reason, whoever wrote it: there is nothing to explain.
    service.setPersonalPanels(false, "safe-mode");
    expect(settings.getPersonalPanels().offReason).toBe("safe-mode");
    expect(service.setPersonalPanels(true, "safe-mode")).toEqual({
      enabled: true,
      offReason: null,
    });
    expect(followed).toEqual([false, false, true]);

    off();
    service.setPersonalPanels(false, "captain");
    expect(followed).toEqual([false, false, true]);
    // A write of any preference still pushes the whole value, panels included.
    expect(pushes.at(-1)?.payload).toEqual(service.get());
  });

  it("reads an install that predates the switch as on", () => {
    const { service } = setup();
    expect(service.get().panels).toEqual({ enabled: true, offReason: null });
  });

  it("keeps the keys a person changed in their own row, outside the value it pushes", () => {
    const { service, pushes } = setup();
    // A new profile starts on Vim (INF-3547's accepted plan).
    expect(service.keymap()).toEqual({ saved: presetKeymap("vim"), unreadable: false });
    const changed = {
      ...DEFAULT_SAVED_KEYMAP,
      keys: { "commands.search": [{ key: "p", meta: true }], "settings.open": [] },
    };
    service.setKeymap(changed);
    expect(service.keymap()).toEqual({ saved: changed, unreadable: false });
    expect(pushes).toEqual([]);
    expect(Object.keys(service.get())).toEqual(["appearance", "layout", "panels"]);
  });

  it("keeps a profile updated from before presets on Legacy, with any keys it changed", () => {
    // INF-3547's accepted plan: "They stay on Legacy with every changed key intact".
    // The database as it stood just before the presets migration, wherever later migrations put it.
    const before = MIGRATIONS.indexOf(keyboardPresets);
    const upgrade = keyboardPresets;
    const untouched = openInMemoryDatabase(before);
    upgrade(untouched, false);
    expect(new ShellPreferencesService(new SettingsStore(untouched), () => {}).keymap()).toEqual({
      saved: DEFAULT_SAVED_KEYMAP,
      unreadable: false,
    });
    const changed = openInMemoryDatabase(before);
    const keys = { "commands.search": [{ key: "p", meta: true }] };
    changed
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?)")
      .run("keyboard", JSON.stringify({ version: 1, keys }));
    upgrade(changed, false);
    expect(new ShellPreferencesService(new SettingsStore(changed), () => {}).keymap()).toEqual({
      saved: { ...DEFAULT_SAVED_KEYMAP, keys },
      unreadable: false,
    });
  });

  it("reads a keys row it cannot read as the catalog's keys, said so, and leaves it there", () => {
    const { db, service } = setup();
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("keyboard", "{not json");
    expect(service.keymap()).toEqual({ saved: DEFAULT_SAVED_KEYMAP, unreadable: true });
    db.prepare("UPDATE settings SET value = ? WHERE key = ?").run(
      JSON.stringify({ version: 2, keys: {} }),
      "keyboard",
    );
    expect(service.keymap()).toEqual({ saved: DEFAULT_SAVED_KEYMAP, unreadable: true });
    expect(
      db.prepare("SELECT value FROM settings WHERE key = ?").get("keyboard") as { value: string },
    ).toEqual({ value: JSON.stringify({ version: 2, keys: {} }) });
  });
});

it("INF-609: a lasting More move survives unrelated layout writes and clearing removes only that panel", () => {
  const { service, settings } = setup();
  service.setLayout({
    collapsedPanels: {},
    hiddenPanels: {},
    placements: {},
    arrangement: { left: { top: [], bottom: ["activity", "now"] }, right: { top: [], bottom: [] } },
    morePick: "now",
  });
  service.setPanelHidden("activity", true);
  service.setTheme("light");
  expect(settings.getLayout().morePick).toBe("now");
  expect(settings.getLayout().arrangement?.left.bottom).toEqual(["activity", "now"]);
  service.clearPanel("now");
  expect(settings.getLayout().morePick).toBeUndefined();
  expect(settings.getLayout().arrangement?.left.bottom).toEqual(["activity"]);
  expect(settings.getLayout().hiddenPanels.activity).toBe(true);
});
