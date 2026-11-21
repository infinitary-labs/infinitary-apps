import { TASK_BROWSER_PLACES_MAX } from "@shared/taskBrowser";
import { describe, expect, it } from "vitest";
import { KEY_HIDDEN } from "../keyFormats";
import type { BrowserNode } from "./outline";
import { pagePlaces } from "./places";

/**
 * What Point at reads of a running page (docs/task-browser.md, "Pointing at a
 * page"): the things its outline names on screen, each with the box the window
 * shows it in. The tree below has the shape Chromium's accessibility tree gives
 * a small sign-up form once the host has marked what the window shows.
 */

type Spec = Partial<BrowserNode> & { role: string; children?: Spec[] };

function tree(root: Spec): BrowserNode[] {
  const nodes: BrowserNode[] = [];
  let next = 1;
  const walk = (spec: Spec): string => {
    const id = String(next);
    next += 1;
    const node: BrowserNode = {
      id,
      role: spec.role,
      name: spec.name ?? "",
      ignored: spec.ignored ?? false,
      childIds: [],
      properties: spec.properties ?? {},
      ...(spec.value !== undefined ? { value: spec.value } : {}),
      ...(spec.onScreen !== undefined ? { onScreen: spec.onScreen } : {}),
      ...(spec.box !== undefined ? { box: spec.box } : {}),
    };
    nodes.push(node);
    node.childIds = (spec.children ?? []).map(walk);
    return id;
  };
  walk(root);
  return nodes;
}

const shown = (x: number, y: number, width: number, height: number) => ({
  onScreen: true,
  box: { x, y, width, height },
});

const text = (name: string, at: Partial<Spec> = {}): Spec => ({
  role: "StaticText",
  name,
  ...at,
  children: [{ role: "InlineTextBox", name }],
});

const viewport = { width: 1280, height: 800 };

const signUp = (): BrowserNode[] =>
  tree({
    role: "RootWebArea",
    name: "Sign up",
    ...shown(0, 0, 1280, 2400),
    children: [
      {
        role: "generic",
        ...shown(0, 0, 1280, 2400),
        children: [
          {
            role: "heading",
            name: "Sign up",
            properties: { level: 1 },
            ...shown(40, 32.4, 320.5, 44.2),
            children: [text("Sign up", shown(40, 32.4, 140, 44.2))],
          },
          {
            role: "paragraph",
            ...shown(40, 92, 600, 20),
            children: [text("Tell us who is coming.", shown(40, 92, 168, 20))],
          },
          {
            role: "LabelText",
            ...shown(40, 132, 47, 18),
            children: [text("Name", shown(40, 132, 47, 18))],
          },
          {
            role: "textbox",
            name: "Name",
            value: "Ada Lovelace",
            properties: { editable: "plaintext" },
            ...shown(40, 154, 240, 28),
            children: [
              {
                role: "generic",
                properties: { editable: "plaintext" },
                ...shown(44, 158, 232, 20),
                children: [
                  {
                    ...text("Ada Lovelace", shown(44, 158, 90, 20)),
                    properties: { editable: "plaintext" },
                  },
                ],
              },
            ],
          },
          {
            role: "combobox",
            name: "Seat",
            value: "Aisle",
            ...shown(40, 204, 160, 28),
          },
          {
            role: "button",
            name: "Send",
            ...shown(40, 252, 72, 32),
            children: [text("Send", shown(56, 258, 40, 20))],
          },
          // A button the page gives no name: someone still points at it.
          { role: "button", ...shown(1240, 16, 24, 24) },
          {
            role: "link",
            name: "Terms",
            onScreen: false,
            box: { x: 40, y: 2300, width: 48, height: 18 },
            children: [text("Terms")],
          },
        ],
      },
    ],
  });

describe("what a page's outline names on screen", () => {
  it("lists each thing once by role and name, in the outline's order, with its box in whole pixels", () => {
    expect(pagePlaces(signUp(), viewport)).toEqual([
      { role: "heading", name: "Sign up", x: 40, y: 32, width: 321, height: 45 },
      { role: "text", name: "Tell us who is coming.", x: 40, y: 92, width: 168, height: 20 },
      // A label's words are text of their own; the label that holds them names nothing.
      { role: "text", name: "Name", x: 40, y: 132, width: 47, height: 18 },
      { role: "textbox", name: "Name", x: 40, y: 154, width: 240, height: 28 },
      { role: "combobox", name: "Seat", x: 40, y: 204, width: 160, height: 28 },
      { role: "button", name: "Send", x: 40, y: 252, width: 72, height: 32 },
      { role: "button", name: "", x: 1240, y: 16, width: 24, height: 24 },
    ]);
  });

  it("never reads what someone typed: a field's value, or the text inside an editable part", () => {
    const note = tree({
      role: "RootWebArea",
      name: "Delivery",
      children: [
        // A part of the page made editable is named by the text typed into it.
        {
          role: "generic",
          name: "Leave it with the concierge",
          properties: { editable: "richtext" },
          ...shown(40, 80, 400, 60),
          children: [
            {
              role: "paragraph",
              properties: { editable: "richtext" },
              ...shown(40, 80, 400, 20),
              children: [
                {
                  ...text("Leave it with the concierge", shown(40, 80, 190, 20)),
                  properties: { editable: "richtext" },
                },
              ],
            },
          ],
        },
        {
          role: "textbox",
          name: "Gate code",
          value: "4417",
          properties: { editable: "plaintext" },
          ...shown(40, 160, 120, 28),
          children: [{ ...text("4417", shown(44, 164, 30, 20)) }],
        },
      ],
    });
    const places = pagePlaces(note, viewport);
    expect(places).toEqual([
      { role: "textbox", name: "Gate code", x: 40, y: 160, width: 120, height: 28 },
    ]);
    expect(JSON.stringify(pagePlaces(signUp(), viewport))).not.toContain("Ada Lovelace");
    expect(JSON.stringify(pagePlaces(signUp(), viewport))).not.toContain("Aisle");
  });

  it("lists only what the window shows, cut at the window's edge", () => {
    const wide = tree({
      role: "RootWebArea",
      name: "Timetable",
      children: [
        // A table wider than the window, scrolled so its left edge is out of sight.
        { role: "table", name: "Departures", ...shown(-200, 700, 1800, 400) },
        // The host could not tell whether this one is shown.
        { role: "link", name: "Earlier trains", box: { x: 40, y: 660, width: 100, height: 18 } },
        // Less than a pixel of this one is inside the window.
        { role: "link", name: "Later trains", ...shown(1279.6, 660, 100, 18) },
      ],
    });
    expect(pagePlaces(wide, viewport)).toEqual([
      { role: "table", name: "Departures", x: 0, y: 700, width: 1280, height: 100 },
    ]);
    expect(pagePlaces(signUp(), viewport).map((place) => place.name)).not.toContain("Terms");
  });

  it("hides a key in a known format only where the crewmate's own reads hide it", () => {
    // An invented key in GitHub's personal token format, built here so no file holds one whole.
    const key = ["github", "pat", "11FIXTURE0INVENTED0NOT0A0KEY0000000"].join("_");
    const made = tree({
      role: "RootWebArea",
      name: "New token",
      children: [
        text(`Your key: ${key}`, shown(40, 120, 420, 20)),
        { role: "button", name: `Copy ${key}`, ...shown(480, 116, 64, 28) },
      ],
    });
    expect(pagePlaces(made, viewport, { hideKeys: true }).map((place) => place.name)).toEqual([
      `Your key: ${KEY_HIDDEN}`,
      `Copy ${KEY_HIDDEN}`,
    ]);
    expect(pagePlaces(made, viewport).map((place) => place.name)).toEqual([
      `Your key: ${key}`,
      `Copy ${key}`,
    ]);
  });

  it("stops at the most one read carries, keeping the page's first things", () => {
    const rows = Array.from({ length: TASK_BROWSER_PLACES_MAX + 25 }, (_, at) => ({
      role: "link",
      name: `Order ${at + 1}`,
      ...shown(40, 2 * at, 120, 2),
    }));
    const places = pagePlaces(tree({ role: "RootWebArea", name: "Orders", children: rows }), {
      width: 1280,
      height: 2 * rows.length,
    });
    expect(places).toHaveLength(TASK_BROWSER_PLACES_MAX);
    expect(places[0]?.name).toBe("Order 1");
    expect(places.at(-1)?.name).toBe(`Order ${TASK_BROWSER_PLACES_MAX}`);
  });
});
