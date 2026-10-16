import { describe, expect, it } from "vitest";
import { panelCommandId } from "../keyboard";
import { personalManifestSchema } from "../personal/manifest";
import {
  PANEL_CARD_DATA_MAX_BYTES,
  panelCardEmitSchema,
  panelCardsProblem,
  panelCommandDeclarationSchema,
  parseSuggestedKey,
  withoutPanelCards,
} from "./panelCards";

describe("a suggested key, as a Mac writes it", () => {
  it("reads modifier glyphs in any order, then one character or a function key", () => {
    expect(parseSuggestedKey("⌘B")).toEqual({ key: "b", meta: true });
    expect(parseSuggestedKey("⇧⌘F")).toEqual({ key: "f", meta: true, shift: true });
    expect(parseSuggestedKey("⌘⇧F")).toEqual({ key: "f", meta: true, shift: true });
    expect(parseSuggestedKey("⌃⌥N")).toEqual({ key: "n", ctrl: true, alt: true });
    expect(parseSuggestedKey("⌘,")).toEqual({ key: ",", meta: true });
    expect(parseSuggestedKey("F7")).toEqual({ key: "F7" });
  });

  it("is no key at all when it names none, twice a modifier, or words", () => {
    expect(parseSuggestedKey("⌘")).toBeNull();
    expect(parseSuggestedKey("⌘⌘B")).toBeNull();
    expect(parseSuggestedKey("Cmd+B")).toBeNull();
    expect(parseSuggestedKey("⌘ ")).toBeNull();
    expect(parseSuggestedKey("F25")).toBeNull();
  });
});

describe("what a manifest declares about its cards", () => {
  const manifest = {
    title: "Reading list",
    cards: { reader: { view: "reader", title: "Reading", width: "regular" as const } },
    header: [{ id: "open", icon: "open" as const, label: "Open reading", emits: "reader" }],
    commands: [
      { id: "open", label: "Open reading", emits: "reader", key: "⌘J" },
      { id: "find", label: "Find a piece", presses: "search" },
    ],
  };

  it("parses as the one manifest, and a command names exactly one thing it does", () => {
    expect(personalManifestSchema.safeParse(manifest).success).toBe(true);
    expect(
      panelCommandDeclarationSchema.safeParse({
        id: "both",
        label: "Both",
        emits: "reader",
        presses: "open",
      }).success,
    ).toBe(false);
    expect(panelCommandDeclarationSchema.safeParse({ id: "none", label: "None" }).success).toBe(
      false,
    );
    expect(
      panelCommandDeclarationSchema.safeParse({
        id: "odd",
        label: "Odd key",
        emits: "reader",
        key: "Cmd+B",
      }).success,
    ).toBe(false);
  });

  it("names the first card, button or command that points at nothing it has", () => {
    const withSearch = {
      ...manifest,
      header: [...manifest.header, { id: "search", icon: "search" as const, label: "Search" }],
    };
    expect(panelCardsProblem(withSearch, ["reader"], "reading-list")).toBeNull();
    expect(panelCardsProblem(withSearch, [], "reading-list")).toContain(
      "there is no cards/reader.tsx",
    );
    expect(panelCardsProblem(manifest, ["reader"], "reading-list")).toContain(
      'presses "search", which header does not have',
    );
    expect(
      panelCardsProblem(
        { ...withSearch, header: [{ id: "x", icon: "add", label: "Add", emits: "missing" }] },
        ["reader"],
        "reading-list",
      ),
    ).toContain('puts up "missing", which cards does not name');
    expect(
      panelCardsProblem(
        {
          commands: [
            { id: "a", label: "A", emits: "reader" },
            { id: "a", label: "A again", emits: "reader" },
          ],
          cards: manifest.cards,
        },
        ["reader"],
        "reading-list",
      ),
    ).toContain('two with the id "a"');
  });

  it("refuses a command whose id with its panel's would be too long to keep a key by", () => {
    const panel = "a".repeat(48);
    const command = { id: "a-rather-long-command", label: "Long", emits: "reader" };
    expect(panelCommandId(panel, command.id).length).toBeGreaterThan(64);
    expect(
      panelCardsProblem({ cards: manifest.cards, commands: [command] }, ["reader"], panel),
    ).toContain("shorten the command's id");
  });

  it("keeps the rest of a manifest when its cards, buttons and commands are set aside", () => {
    expect(withoutPanelCards(manifest)).toEqual({ title: "Reading list" });
  });
});

describe("a card a panel puts up", () => {
  it("takes a view, a title, and bounded JSON data, and an id only of plain characters", () => {
    expect(
      panelCardEmitSchema.safeParse({
        id: "notes-FI3-12",
        view: "notes",
        title: "Notes on FI3-12",
        width: "wide",
        data: { taskId: "t1" },
      }).success,
    ).toBe(true);
    expect(panelCardEmitSchema.safeParse({ view: "notes" }).success).toBe(false);
    expect(
      panelCardEmitSchema.safeParse({ id: "a b", view: "notes", title: "Notes" }).success,
    ).toBe(false);
    expect(
      panelCardEmitSchema.safeParse({
        view: "notes",
        title: "Notes",
        data: "x".repeat(PANEL_CARD_DATA_MAX_BYTES),
      }).success,
    ).toBe(false);
    expect(
      panelCardEmitSchema.safeParse({ view: "notes", title: "Notes", script: "x" }).success,
    ).toBe(false);
  });
});
