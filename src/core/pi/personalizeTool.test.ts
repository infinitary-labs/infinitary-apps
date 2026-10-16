import { rmSync } from "node:fs";
import type { FmEvent } from "@shared/events";
import type { PersonalExtensionView, PersonalSnapshot } from "@shared/personal/manifest";
import { DEFAULT_LAYOUT } from "@shared/preferences";
import { afterEach, describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { ShellPreferencesService } from "../preferences/shellPreferences";
import { openInMemoryDatabase } from "../storage/db";
import { SettingsStore } from "../storage/settingsStore";
import {
  createPersonalizeTool,
  listSurfaces,
  renderSurfacesSection,
  SURFACES_CONTEXT_LIMIT,
} from "./personalizeTool";
import { piToolOf } from "./toolSpec";

/**
 * The `personalize` tool (talk-to-personalize Step 1, Tier A): one call
 * per preference, applied through the core's one preferences writer, one
 * feed line, never a card; refusals as text.
 */
type ToolHandle = {
  name: string;
  description: string;
  execute: (
    id: string,
    params: Record<string, unknown>,
  ) => Promise<{ content: { type: string; text?: string }[] }>;
};

function extension(
  id: string,
  title: string,
  x: "left" | "right" = "right",
): PersonalExtensionView {
  return {
    id,
    source: "yours",
    by: null,
    frame: null,
    title,
    placement: { x, y: "top" },
    order: 100,
    size: "content",
    present: true,
    ownPresence: false,
    moves: false,
    running: false,
    reads: [],
    sql: [],
    panel: null,
    server: null,
    cardViews: [],
    cards: {},
    header: [],
    commands: [],
    error: null,
  };
}

/** A build whose gates are all shut, as a stable one's are. */
const STABLE = { knowledge: false } as const;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(options: { personal?: PersonalSnapshot; captainTurn?: boolean } = {}) {
  const settings = new SettingsStore(openInMemoryDatabase());
  const pushes: unknown[] = [];
  const preferences = new ShellPreferencesService(settings, (channel, payload) => {
    pushes.push({ channel, payload });
  });
  const events: FmEvent[] = [];
  const removed: string[] = [];
  const workspace = scratchDir("infinitary-personalize-");
  dirs.push(workspace);
  let personal = options.personal ?? { extensions: [] };
  const tool = piToolOf(
    createPersonalizeTool({
      preferences,
      personal: () => personal,
      removePersonal: async (id) => {
        removed.push(id);
        personal = { extensions: personal.extensions.filter((entry) => entry.id !== id) };
        return { removed: true, committed: true };
      },
      uninstallPlugin: async (id) => {
        removed.push(id);
        const found = personal.extensions.some(
          (entry) => entry.id === id && entry.source === "installed",
        );
        personal = { extensions: personal.extensions.filter((entry) => entry.id !== id) };
        return { removed: found };
      },
      personalWorkspaceDir: workspace,
      gates: () => STABLE,
      isCaptainTurn: () => options.captainTurn ?? true,
      broadcastEvent: (event) => events.push(event),
    }),
  ) as unknown as ToolHandle;
  const run = async (params: Record<string, unknown>) =>
    (await tool.execute("c1", { evidence: "the captain said so", ...params })).content[0]?.text;
  return { tool, run, settings, preferences, events, pushes, removed, workspace };
}

const feed = (events: FmEvent[]) =>
  events.filter((event) => event.type === "personalized").map((event) => event.text);

describe("retired personalization actions", () => {
  it("refuses old theme and panel calls rather than retaining a second write path", async () => {
    const { run, preferences, events } = setup();
    const before = preferences.get();
    for (const action of ["theme", "panel"])
      expect(await run({ action, theme: "light", surface: "now", visible: false })).toContain(
        "Use app_change",
      );
    expect(preferences.get()).toEqual(before);
    expect(events).toEqual([]);
  });
});

describe("personalize", () => {
  it("names its two actions and the surface ids in its description, and never the machinery", () => {
    const { tool } = setup();
    expect(tool.name).toBe("personalize");
    // Theme and panel placement are app_change's (contract 4.54); the persona's
    // operate move says so once, and a call that asks for them here is refused.
    for (const word of ["remove", "instruction", "your-surfaces"]) {
      expect(tool.description).toContain(word);
    }
    expect(tool.description).not.toMatch(/\bplugin\b/i);
    expect(tool.description).not.toMatch(/\bextension\b/i);
  });

  /**
   * With the host-owned switch off (Step 5) the core serves no personal
   * surface, so an id that names one is not a typo - and a refusal that
   * called it one would send the Firstmate looking for a different name.
   */
  it("refuses a surface id while the captain's panels are off, naming the switch", async () => {
    const { run, preferences } = setup();
    preferences.setPersonalPanels(false, "safe-mode");
    const refusal = await run({ action: "remove", surface: "tokyo-clock" });
    expect(refusal).toContain('No surface "tokyo-clock"');
    expect(refusal).toContain(
      "The captain's panels - his own and the ones he added - are off right now",
    );
    expect(refusal).toContain("the switch is in Settings");
    // An app panel is still nameable: the switch is about the captain's own.
    expect(await run({ action: "remove", surface: "now" })).toContain("hidden rather than removed");
  });

  it("removes an app panel by hiding it and a personal panel through the workspace", async () => {
    const { run, settings, events, removed } = setup({
      personal: { extensions: [extension("open-prs", "Open PRs")] },
    });
    settings.setLayout({
      collapsedPanels: { now: false },
      hiddenPanels: {},
      placements: { now: { x: "left", y: "top" }, "open-prs": { x: "left", y: "bottom" } },
    });
    expect(await run({ action: "remove", surface: "now" })).toContain(
      "Tasks is an app panel, so it is hidden rather than removed",
    );
    expect(settings.getLayout()).toEqual({
      collapsedPanels: {},
      hiddenPanels: { now: true },
      placements: { "open-prs": { x: "left", y: "bottom" } },
    });
    expect(await run({ action: "remove", surface: "open-prs" })).toBe(
      "Open PRs removed from your workspace in one commit; git keeps its history.",
    );
    expect(removed).toEqual(["open-prs"]);
    expect(settings.getLayout().placements).toEqual({});
    expect(feed(events)).toEqual(["Tasks hidden", "Open PRs removed"]);
    // Gone from the surfaces, so a second remove is a refusal by list.
    expect(await run({ action: "remove", surface: "open-prs" })).toBe(
      'No surface "open-prs". Your surfaces: activity, now, create-panel.',
    );
  });

  it("appends a standing instruction to the captain skill and refuses a duplicate", async () => {
    const { run, events } = setup();
    expect(await run({ action: "instruction", text: "always use compact rows in my panels" })).toBe(
      'Standing instruction recorded in the captain skill (1 now): "Always use compact rows in my panels."',
    );
    expect(
      await run({ action: "instruction", text: "Always use compact rows in my panels." }),
    ).toBe('Already a standing instruction: "Always use compact rows in my panels."');
    expect(await run({ action: "instruction" })).toBe(
      "instruction needs text: one imperative line.",
    );
    expect(feed(events)).toEqual(["standing instruction - Always use compact rows in my panels."]);
  });

  it("keeps remove and instruction to the captain's own turn without changing theme", async () => {
    const { run, removed, settings } = setup({
      captainTurn: false,
      personal: { extensions: [extension("open-prs", "Open PRs")] },
    });
    expect(await run({ action: "remove", surface: "open-prs" })).toContain(
      "Only the captain's own turn removes a surface",
    );
    expect(removed).toEqual([]);
    expect(await run({ action: "instruction", text: "Always." })).toContain(
      "Only the captain's own turn writes a standing instruction",
    );
    expect(settings.getAppearance().theme).toBe("dark");
  });
});

describe("the your-surfaces section", () => {
  it("lists the app panels, the personal panels up to the cap, and the instruction count", () => {
    const many: PersonalSnapshot = {
      extensions: Array.from({ length: SURFACES_CONTEXT_LIMIT + 2 }, (_, index) =>
        extension(`panel-${index}`, `Panel ${index}`),
      ),
    };
    const lines = renderSurfacesSection(
      {
        appearance: { theme: "light" },
        layout: {
          collapsedPanels: { activity: true },
          hiddenPanels: { now: true },
          placements: { "panel-0": { x: "left", y: "bottom" } },
        },
        panels: { enabled: true, offReason: null },
      },
      many,
      3,
      STABLE,
    );
    expect(lines[0]).toBe(
      "your surfaces (app_change panel and personalize remove act on these ids; theme: light):",
    );
    expect(lines).toContain('- activity "Activity": left rail, bottom; shown, collapsed');
    expect(lines).toContain('- now "Tasks": right rail, bottom; hidden');
    expect(lines).toContain('- create-panel "Create your own panel": left rail, top; shown');
    expect(lines).toContain('- panel-0 "Panel 0" (yours): left rail, bottom; shown');
    expect(lines).toContain("- and 2 more personal panels");
    expect(lines.at(-1)).toBe("standing instructions in the captain skill: 3");
    expect(lines).toHaveLength(1 + 3 + SURFACES_CONTEXT_LIMIT + 1 + 1);
  });

  it("derives every surface's effective placement from the layout", () => {
    const surfaces = listSurfaces(
      { collapsedPanels: {}, hiddenPanels: {}, placements: { now: { x: "left", y: "top" } } },
      { extensions: [extension("open-prs", "Open PRs")] },
      STABLE,
    );
    expect(surfaces.map((surface) => [surface.id, surface.kind, surface.placement])).toEqual([
      ["activity", "app", { x: "left", y: "bottom" }],
      ["now", "app", { x: "left", y: "top" }],
      ["create-panel", "app", { x: "left", y: "top" }],
      ["open-prs", "personal", { x: "right", y: "top" }],
    ]);
  });

  it("lists the Knowledge panel only where the build keeps knowledge", () => {
    const ids = (gates: { knowledge: boolean }) =>
      listSurfaces(DEFAULT_LAYOUT, { extensions: [] }, gates).map((surface) => surface.id);
    expect(ids({ knowledge: true })).toEqual(["activity", "now", "knowledge", "create-panel"]);
    expect(ids(STABLE)).toEqual(["activity", "now", "create-panel"]);
    const section = (gates: { knowledge: boolean }) =>
      renderSurfacesSection(
        {
          appearance: { theme: "dark" },
          layout: DEFAULT_LAYOUT,
          panels: { enabled: true, offReason: null },
        },
        { extensions: [] },
        0,
        gates,
      );
    expect(section({ knowledge: true })).toContain(
      '- knowledge "Knowledge": right rail, bottom; shown',
    );
    expect(section(STABLE).some((line) => line.includes("nowledge"))).toBe(false);
  });
  /**
   * The host-owned switch (Step 5). The context has to SAY the panels are
   * off, or the Firstmate reads an empty list as "the captain has none" and
   * builds another one that will not show.
   */
  it("says the captain's panels are off, and why, and that the switch is not its to throw", () => {
    const lines = renderSurfacesSection(
      {
        appearance: { theme: "dark" },
        layout: DEFAULT_LAYOUT,
        panels: { enabled: false, offReason: "safe-mode" },
      },
      // Off, the core serves no personal extension at all.
      { extensions: [] },
      0,
      STABLE,
    );
    const off = lines.find((line) => line.startsWith("the captain's panels are off"));
    expect(off).toContain("the app closed twice just after starting");
    expect(off).toContain("Only the switch in Settings turns them on");
    expect(off).toContain("you have no tool for it");
    expect(lines).toContain('- activity "Activity": left rail, bottom; shown');

    const byHand = renderSurfacesSection(
      {
        appearance: { theme: "dark" },
        layout: DEFAULT_LAYOUT,
        panels: { enabled: false, offReason: "captain" },
      },
      { extensions: [] },
      0,
      STABLE,
    ).find((line) => line.startsWith("the captain's panels are off"));
    expect(byHand).toContain("the captain turned them off");

    // On, the section says nothing about the switch at all.
    expect(
      renderSurfacesSection(
        {
          appearance: { theme: "dark" },
          layout: DEFAULT_LAYOUT,
          panels: { enabled: true, offReason: null },
        },
        { extensions: [] },
        0,
        STABLE,
      ).some((line) => line.startsWith("your own panels are off")),
    ).toBe(false);
  });
});
