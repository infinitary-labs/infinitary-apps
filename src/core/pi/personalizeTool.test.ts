import { rmSync } from "node:fs";
import type { FmEvent } from "@shared/events";
import type { PersonalExtensionView, PersonalSnapshot } from "@shared/personal/manifest";
import { DEFAULT_LAYOUT, type Layout } from "@shared/preferences";
import { type AppPanelGates, runbookGatesOf } from "@shared/surfaces";
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
  it("names its action and the surface ids in its description, and never the machinery", () => {
    const { tool } = setup();
    expect(tool.name).toBe("personalize");
    // Theme and panel placement are app_change's (contract 4.54); the persona's
    // operate move says so once, and a call that asks for them here is refused.
    for (const word of ["remove", "your-surfaces"]) {
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
      "The captain's panels - their own and the ones they added - are off right now",
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
      'No surface "open-prs". Your surfaces: create-panel, activity, now.',
    );
  });

  it("names a runbook's panel as its runbook's and leaves its removal to the runbook's switch", async () => {
    // Intent: the captain's ask that runbooks can include panels; such a panel
    // goes when its runbook is turned off, never through an uninstall by panel id.
    const desk = {
      ...extension("desk-reading", "Reading"),
      source: "installed" as const,
      by: "Reading desk",
      runbook: "desk",
    };
    const { run, removed } = setup({ personal: { extensions: [desk] } });
    expect(await run({ action: "remove", surface: "desk-reading" })).toBe(
      "Reading comes with the runbook Reading desk: turning that runbook off in Settings, under Runbooks, takes it away.",
    );
    expect(removed).toEqual([]);
    const lines = renderSurfacesSection(
      {
        appearance: { theme: "light" },
        layout: DEFAULT_LAYOUT,
        panels: { enabled: true, offReason: null },
      },
      { extensions: [desk] },
      STABLE,
    );
    expect(lines.find((line) => line.includes("desk-reading"))).toContain(
      "(from the runbook Reading desk)",
    );
  });

  it("keeps remove to the captain's own turn without changing theme", async () => {
    const { run, removed, settings } = setup({
      captainTurn: false,
      personal: { extensions: [extension("open-prs", "Open PRs")] },
    });
    expect(await run({ action: "remove", surface: "open-prs" })).toContain(
      "Only the captain's own turn removes a surface",
    );
    expect(removed).toEqual([]);
    expect(settings.getAppearance().theme).toBe("dark");
  });
});

describe("the your-surfaces section", () => {
  // docs/runbooks.md, "Panels": a runbook's panel left off for a taken id is
  // named beside the panel that keeps it, never as it.
  it("names a runbook's panel left off beside the panel that holds its id", () => {
    const lines = renderSurfacesSection(
      {
        appearance: { theme: "light" },
        layout: { collapsedPanels: {}, hiddenPanels: {}, placements: {} },
        panels: { enabled: true, offReason: null },
      },
      {
        extensions: [
          { ...extension("desk-reading", "My reading"), source: "installed", by: "Studio" },
        ],
        refused: [
          {
            id: "desk-reading",
            runbook: "desk",
            by: "Reading desk",
            why: "another panel has that id",
          },
        ],
      },
      STABLE,
      {
        // The window lists the runbook's refused row first; the panel of
        // yours that keeps the id still answers for itself.
        panels: [
          {
            id: "desk-reading",
            kind: "installed",
            version: null,
            state: "refused",
            rail: null,
            why: "Reading desk's panel: another panel has that id",
            runbook: "desk",
          },
          {
            id: "desk-reading",
            kind: "installed",
            version: "v1",
            state: "drawn",
            rail: "right",
            why: null,
          },
        ],
      },
    );
    expect(lines.filter((line) => line.startsWith("- desk-reading"))).toEqual([
      expect.stringMatching(/"My reading" \(added, by .*\):.*drawn/),
      "- desk-reading (from the runbook Reading desk): not shown: another panel has that id",
    ]);
  });
  it("lists the app panels and the personal panels up to the cap", () => {
    // The second of the captain's panels is named after the app's Activity,
    // so the window refused it while the app's own Activity is drawn.
    const many: PersonalSnapshot = {
      extensions: Array.from({ length: SURFACES_CONTEXT_LIMIT + 2 }, (_, index) =>
        index === 1
          ? extension("activity", "My activity")
          : extension(`panel-${index}`, `Panel ${index}`),
      ),
    };
    const clash =
      'side-panel: "activity" from "personal-activity" is already registered by "firstmate"';
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
      STABLE,
      {
        panels: [
          {
            id: "activity",
            kind: "app",
            version: null,
            state: "collapsed",
            rail: "left",
            why: null,
          },
          {
            id: "create-panel",
            kind: "app",
            version: null,
            state: "drawn",
            rail: "left",
            why: null,
          },
          {
            id: "panel-0",
            kind: "personal",
            version: "v0",
            state: "drawn",
            rail: "left",
            why: null,
          },
          {
            id: "activity",
            kind: "personal",
            version: "v1",
            state: "refused",
            rail: "right",
            why: clash,
          },
        ],
      },
    );
    expect(lines[0]).toBe(
      "your surfaces (app_change panel and personalize remove act on these ids; theme: light):",
    );
    // Each state is the window's word (INF-607); the layout's hidden stands without one.
    // Each place is the panel's in its slot (INF-2344), so the first mate can say above or below.
    expect(lines).toContain('- activity "Activity": left rail, bottom, 1 of 2; drawn, collapsed');
    expect(lines).toContain('- now "Tasks": right rail, bottom, 1 of 1; hidden');
    expect(lines).toContain('- create-panel "Create your own panel": left rail, top; drawn');
    expect(lines).toContain('- panel-0 "Panel 0" (yours): left rail, bottom, 2 of 2; drawn');
    expect(lines).toContain(
      `- activity "My activity" (yours): right rail, top; refused by the window: ${clash}`,
    );
    expect(lines).toContain(
      '- panel-2 "Panel 2" (yours): right rail, top, 5 of 12; no word from the window',
    );
    expect(lines).toContain("- and 2 more personal panels");
    expect(lines).toHaveLength(1 + 3 + SURFACES_CONTEXT_LIMIT + 1);
  });

  it("says which panels a short rail folded for room or gathered into its More row, apart from drawn ones", () => {
    // INF-711: the window's answer names the rail's room ladder, so the
    // first mate can say where a panel went instead of calling it drawn.
    const clocks: PersonalSnapshot = {
      extensions: ["Tokyo", "Paris", "Sydney"].map((title, index) =>
        extension(`clock-${index}`, title),
      ),
    };
    const mount = (id: string, state: "drawn" | "folded" | "gathered") =>
      ({ id, kind: "personal", version: "v0", state, rail: "right", why: null }) as const;
    const lines = renderSurfacesSection(
      {
        appearance: { theme: "dark" },
        layout: { collapsedPanels: {}, hiddenPanels: {}, placements: {} },
        panels: { enabled: true, offReason: null },
      },
      clocks,
      STABLE,
      {
        panels: [
          mount("clock-0", "drawn"),
          mount("clock-1", "folded"),
          mount("clock-2", "gathered"),
        ],
      },
    );
    expect(lines).toContain('- clock-0 "Tokyo" (yours): right rail, top, 1 of 3; drawn');
    expect(lines).toContain(
      '- clock-1 "Paris" (yours): right rail, top, 2 of 3; folded to its header for room (the rail is too short for its body)',
    );
    expect(lines).toContain(
      `- clock-2 "Sydney" (yours): right rail, top, 3 of 3; in the More row at its rail's foot (the rail is too short for its header)`,
    );
  });

  // INF-2470: the first mate's surfaces context says which panels are paused,
  // so it can answer about one without the captain pressing Update panel.
  it("says which of the captain's panels have their background work paused", () => {
    const lines = renderSurfacesSection(
      {
        appearance: { theme: "dark" },
        layout: { collapsedPanels: {}, hiddenPanels: {}, placements: {} },
        panels: { enabled: true, offReason: null },
      },
      {
        extensions: [
          { ...extension("counter", "Counter"), paused: { api: 1, serves: [2], asked: true } },
          extension("clock", "Clock"),
        ],
      },
      STABLE,
    );
    expect(lines).toContain(
      '- counter "Counter" (yours): right rail, top, 2 of 2; no word from the window; background work paused: its server.ts is written for panel API 1 and this app serves 2; the captain pressed Update panel',
    );
    expect(lines).toContain(
      '- clock "Clock" (yours): right rail, top, 1 of 2; no word from the window',
    );
  });

  // INF-2344: the first mate reads the same arrangement the rails draw, in
  // its order, with each panel's place in its slot.
  it("derives every surface's slot and place from the layout, in the layout's order", () => {
    const where = (layout: Layout) =>
      listSurfaces(layout, { extensions: [extension("open-prs", "Open PRs")] }, STABLE).map(
        (surface) => [surface.id, surface.kind, surface.placement, surface.place, surface.of],
      );
    // Before an arrangement is saved, a placement the captain chose still decides.
    expect(
      where({
        collapsedPanels: {},
        hiddenPanels: {},
        placements: { now: { x: "left", y: "top" } },
      }),
    ).toEqual([
      ["create-panel", "app", { x: "left", y: "top" }, undefined, undefined],
      ["now", "app", { x: "left", y: "top" }, 1, 1],
      ["activity", "app", { x: "left", y: "bottom" }, 1, 1],
      ["open-prs", "personal", { x: "right", y: "top" }, 1, 1],
    ]);
    expect(
      where({
        collapsedPanels: {},
        hiddenPanels: {},
        placements: {},
        arrangement: {
          left: { top: [], bottom: ["open-prs", "activity"] },
          right: { top: [], bottom: ["now"] },
        },
      }),
    ).toEqual([
      ["create-panel", "app", { x: "left", y: "top" }, undefined, undefined],
      ["open-prs", "personal", { x: "left", y: "bottom" }, 1, 2],
      ["activity", "app", { x: "left", y: "bottom" }, 2, 2],
      ["now", "app", { x: "right", y: "bottom" }, 1, 1],
    ]);
  });

  // docs/runbooks.md, "Built-in panels": the Batches panel shows only while the
  // Batched pull requests runbook is on, and a copy that replaces the
  // built-in shows its own panel under the same id.
  it("lists a built-in runbook's panel only while that built-in is on, and frees its id for a copy", () => {
    const builtinOn = runbookGatesOf([{ id: "batches", source: "builtin", enabled: true }]);
    const copyOn = runbookGatesOf([
      { id: "batches", source: "builtin", enabled: false },
      { id: "batches", source: "personal", enabled: true },
    ]);
    expect(builtinOn).toEqual({ "runbook-batches": true });
    expect(copyOn).toEqual({ "runbook-batches": false });
    const copy = {
      extensions: [{ ...extension("batches-panel", "Batches"), source: "installed" as const }],
    };
    const surface = (gates: AppPanelGates) =>
      listSurfaces(DEFAULT_LAYOUT, copy, { ...STABLE, ...gates })
        .filter((entry) => entry.id === "batches-panel")
        .map((entry) => [entry.kind, entry.place !== undefined]);
    // On: the app's own panel holds the id and its place; a panel claiming it has none.
    expect(surface(builtinOn)).toEqual([
      ["app", true],
      ["installed", false],
    ]);
    // A copy on turns the built-in off: only the copy's panel, on the rails.
    expect(surface(copyOn)).toEqual([["installed", true]]);
  });

  it("lists the Knowledge panel only where the build keeps knowledge", () => {
    const ids = (gates: { knowledge: boolean }) =>
      listSurfaces(DEFAULT_LAYOUT, { extensions: [] }, gates).map((surface) => surface.id);
    expect(ids({ knowledge: true })).toEqual(["create-panel", "activity", "now", "knowledge"]);
    expect(ids(STABLE)).toEqual(["create-panel", "activity", "now"]);
    const section = (gates: { knowledge: boolean }) =>
      renderSurfacesSection(
        {
          appearance: { theme: "dark" },
          layout: DEFAULT_LAYOUT,
          panels: { enabled: true, offReason: null },
        },
        { extensions: [] },
        gates,
      );
    expect(section({ knowledge: true })).toContain(
      '- knowledge "Knowledge": right rail, bottom, 2 of 2; no word from the window',
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
      STABLE,
    );
    const off = lines.find((line) => line.startsWith("the captain's panels are off"));
    expect(off).toContain("the app closed twice just after starting");
    expect(off).toContain("Only the switch in Settings turns them on");
    expect(off).toContain("you have no tool for it");
    expect(lines).toContain(
      '- activity "Activity": left rail, bottom, 1 of 1; no word from the window',
    );

    const byHand = renderSurfacesSection(
      {
        appearance: { theme: "dark" },
        layout: DEFAULT_LAYOUT,
        panels: { enabled: false, offReason: "captain" },
      },
      { extensions: [] },
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
        STABLE,
      ).some((line) => line.startsWith("your own panels are off")),
    ).toBe(false);
  });
});
