import { FRAME_BRIDGE_VERSION } from "@shared/plugins/bridge";
import { frameCsp } from "@shared/plugins/containment";
import { buildFrameDocument, type FrameTheme } from "@shared/plugins/frameDocument";
import { expect, test } from "vitest";
import { commands, page } from "vitest/browser";
import part from "../../resources/runbooks/architecture/skills/advanced-architecture/parts/map.html?raw";
import { cardStylesheet } from "../../src/renderer/src/cards/prototypeSrcdoc";
import { fillMapPart, MAP_DATA } from "../helpers/architectureMap";

/**
 * The Advanced architecture runbook's map part (the approved plan's "What
 * done looks like": any level opens as one flat diagram, a test refuses
 * overlaps; each state machine opens in its folder's frame; a change view
 * tags boxes, links, states and moves as added, removed or changed, with
 * counts). The part is the very file the runbook ships, filled as its skill
 * says with map files of this project and comparisons read from its
 * history, and drawn in a card's sandboxed frame with the card's stylesheet,
 * policy and bridge, as the window draws a card body that carries a script.
 */

const FRAME = "architecture-map";

type Box = {
  label: string;
  kind: string;
  opens: boolean;
  tag: string;
  rect: [number, number, number, number];
  text: number[];
  pills: { name: string; width: number; tag: string }[];
};
type Label = { text: string; rect: [number, number, number, number]; width: number };
type View = {
  crumbs: string;
  frame: string;
  boxes: Box[];
  labels: Label[];
  edges: { from: string; to: string; tag: string }[];
  changes: string;
  live: string;
  problems: string;
  fill: string;
};

function inFrame<T, A>(read: (argument: A) => T, argument: A): Promise<Awaited<T>> {
  return commands.evaluateInFrame(FRAME, read.toString(), argument) as Promise<Awaited<T>>;
}

/** The content policy's hash of an inline script, as the host pins a card's own script. */
async function scriptHash(script: string): Promise<string> {
  const text = script.replace(/\r\n?/g, "\n");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return `sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}`;
}

/** The data block deflated raw and in base64, as the skill packs a map too big for a card. */
async function packed(block: string): Promise<string> {
  const stream = new Blob([block]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

/** Readers installed in the frame: what the map draws now, and the presses a reader makes. */
function install() {
  const svg = document.querySelector("#map svg") as SVGSVGElement;
  const words = (element: Element | null) =>
    (element?.textContent ?? "").replace(/\s+/g, " ").trim();
  // a box or state carries s0, s1 or s2, a link add, rem or chg, and both carry same when unchanged
  const tagOf = (element: Element) => {
    const has = (...names: string[]) => names.some((name) => element.classList.contains(name));
    if (has("s0", "add")) return "added";
    if (has("s1", "rem")) return "removed";
    if (has("s2", "chg")) return "changed";
    return has("same") ? "same" : "";
  };
  const boxes = () => [...document.querySelectorAll<SVGGElement>("#map [data-box]")];
  const reader = {
    read() {
      const boxList = boxes().map((g) => {
        const [x = 0, y = 0] =
          (g.getAttribute("transform") ?? "").match(/-?[\d.]+/g)?.map(Number) ?? [];
        const rect = [...g.children].find(
          (child) => child.localName === "rect" && !child.getAttribute("class"),
        ) as SVGRectElement;
        const w = Number(rect.getAttribute("width"));
        const h = Number(rect.getAttribute("height"));
        const tag = g.querySelector(":scope > .tag");
        return {
          label: g.getAttribute("data-box") ?? "",
          kind: [...g.classList].find((name) => name.startsWith("k-"))?.slice(2) ?? "",
          opens: g.classList.contains("open"),
          tag: tag ? words(tag) : tagOf(g),
          rect: [x, y - (tag ? 16 : 0), x + w, y + h],
          text: [...g.querySelectorAll<SVGTextElement>(":scope > text")].map(
            (text) => text.getBBox().width - w,
          ),
          pills: [...g.querySelectorAll<SVGGElement>("[data-pill]")].map((pill) => ({
            name: pill.getAttribute("data-pill") ?? "",
            tag: tagOf(pill),
            width:
              (pill.querySelector("text") as SVGTextElement).getBBox().width +
              18 -
              Number(pill.querySelector("rect")?.getAttribute("width")),
          })),
        };
      });
      const labels = [...document.querySelectorAll<SVGGElement>("#map .elabels .el.show")].map(
        (g) => {
          const rect = g.querySelector("rect") as SVGRectElement;
          const [x = 0, y = 0, w = 0, h = 0] = ["x", "y", "width", "height"].map((name) =>
            Number(rect.getAttribute(name)),
          );
          return {
            text: words(g),
            rect: [x, y, x + w, y + h],
            width: (g.querySelector("text") as SVGTextElement).getBBox().width - w,
          };
        },
      );
      const edges = [...document.querySelectorAll<SVGPathElement>("#map path[data-from]")].map(
        (path) => ({
          from: path.getAttribute("data-from") ?? "",
          to: path.getAttribute("data-to") ?? "",
          tag: tagOf(path),
        }),
      );
      const first = document.querySelector("#map [data-box] rect:not([class])");
      return {
        crumbs: words(document.querySelector("#map [data-crumbs]")),
        frame: words(document.querySelector("#map .flabel")),
        boxes: boxList,
        labels,
        edges,
        changes: words(document.querySelector("#map [data-chg]:not([hidden])")),
        live: words(document.querySelector("#map [data-live]")),
        problems: words(document.querySelector("#map [data-bad]:not([hidden])")),
        fill: first ? getComputedStyle(first).fill : "",
      };
    },
    /** A double-click on the `index`th box, as a reader goes in. */
    open(index: number) {
      boxes()[index]?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    },
    /** A press on the crumb at `depth`, as a reader climbs back. */
    climb(depth: number) {
      document.querySelectorAll<HTMLButtonElement>("#map [data-crumbs] button")[depth]?.click();
    },
    /** A press on the comparison button named `label`. */
    compare(label: string) {
      const button = [
        ...document.querySelectorAll<HTMLButtonElement>("#map [data-cmps] button"),
      ].find((each) => words(each) === label);
      button?.click();
      return button?.getAttribute("aria-pressed") ?? "";
    },
    /** A key on the map, as the keyboard reaches it. */
    key(key: string) {
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      svg.dispatchEvent(event);
      return event.defaultPrevented;
    },
    /** A plain click on the map, and whether it reached the card's own handling. */
    click() {
      const event = new MouseEvent("click", { bubbles: true, cancelable: true });
      svg.dispatchEvent(event);
      return event.defaultPrevented;
    },
  };
  (window as unknown as { mapTest: typeof reader }).mapTest = reader;
}

type Reader = {
  read(): View;
  open(index: number): void;
  climb(depth: number): void;
  compare(label: string): string;
  key(key: string): boolean;
  click(): boolean;
};
const call = <K extends keyof Reader>(name: K, ...args: Parameters<Reader[K]>) =>
  inFrame(
    ([name, args]: [string, unknown[]]) =>
      (
        (window as unknown as { mapTest: Record<string, (...each: unknown[]) => unknown> }).mapTest[
          name
        ] as (...each: unknown[]) => unknown
      )(...args),
    [name, args] as [string, unknown[]],
  ) as Promise<ReturnType<Reader[K]>>;
const read = () => call("read");

type Heard = { type: string; of?: number; answers?: { name: string }[] };

async function mounted(
  theme: FrameTheme,
  options: {
    open?: { at: string; changes?: number };
    pack?: boolean;
    data?: object;
    /** Read the body's answers as the window does for a card (the frame controller's "form"). */
    form?: boolean;
  } = {},
): Promise<Heard[]> {
  const data = options.data ?? MAP_DATA;
  const block = JSON.stringify(options.open ? { ...data, open: options.open } : data);
  const html = fillMapPart(part, options.pack ? await packed(block) : block, options.pack ?? false);
  const scripts = [...new DOMParser().parseFromString(html, "text/html").querySelectorAll("script")]
    .filter((script) => !script.src && script.textContent)
    .map((script) => script.textContent ?? "");
  const heard: Heard[] = [];
  const frame = document.createElement("iframe");
  frame.name = FRAME;
  frame.setAttribute("sandbox", "allow-scripts");
  frame.style.cssText = "width:800px;height:900px;border:0";
  addEventListener("message", (event) => {
    if (event.source !== frame.contentWindow) return;
    const data = event.data as Heard & { document?: unknown };
    heard.push(data);
    if (data.type === "ready") {
      const post = (message: object) =>
        frame.contentWindow?.postMessage({ fm: FRAME_BRIDGE_VERSION, ...message }, "*");
      post({ type: "keys", pictures: true, escape: true });
      if (options.form) post({ type: "form", fill: null });
      post({ type: "initialize", document: data.document });
    }
  });
  frame.srcdoc = buildFrameDocument({
    csp: frameCsp(await Promise.all(scripts.map(scriptHash))),
    theme,
    style: cardStylesheet(),
    html,
  });
  document.body.replaceChildren(frame);
  await expect
    .poll(() => inFrame(() => document.querySelectorAll("#map [data-box]").length, null))
    .toBeGreaterThan(0);
  await inFrame(install, null);
  return heard;
}

/** Two boxes in the scene's units overlap when they share more than a hair. */
const overlap = (a: number[], b: number[]) =>
  (a[0] as number) < (b[2] as number) - 0.5 &&
  (b[0] as number) < (a[2] as number) - 0.5 &&
  (a[1] as number) < (b[3] as number) - 0.5 &&
  (b[1] as number) < (a[3] as number) - 0.5;

/** Everything a reader sees at once stands clear of everything else, and every word fits its box. */
function expectClear(view: View): void {
  const where = `at ${view.crumbs}`;
  for (const [i, a] of view.boxes.entries()) {
    for (const b of view.boxes.slice(i + 1))
      expect(overlap(a.rect, b.rect), `${a.label} and ${b.label} overlap ${where}`).toBe(false);
    for (const spare of a.text)
      expect(spare, `${a.label}'s words fit ${where}`).toBeLessThanOrEqual(-8);
    for (const pill of a.pills)
      expect(pill.width, `${pill.name} fits its pill ${where}`).toBeLessThanOrEqual(0.5);
  }
  for (const [i, label] of view.labels.entries()) {
    expect(label.width, `"${label.text}" fits its label ${where}`).toBeLessThanOrEqual(-4);
    for (const box of view.boxes)
      expect(overlap(label.rect, box.rect), `"${label.text}" covers ${box.label} ${where}`).toBe(
        false,
      );
    for (const other of view.labels.slice(i + 1))
      expect(
        overlap(label.rect, other.rect),
        `"${label.text}" covers "${other.text}" ${where}`,
      ).toBe(false);
  }
}

/** Every place a reader can go in to, depth first from the top, each read as it is drawn. */
async function walk(): Promise<View[]> {
  const seen = new Map<string, View>();
  const visit = async (depth: number) => {
    const view = await read();
    if (seen.has(view.crumbs)) return;
    seen.set(view.crumbs, view);
    // A box outside the frame, or a state that starts another machine, goes to a place of its
    // own elsewhere; the walk reaches each of those from the top instead.
    for (const [index, box] of view.boxes.entries()) {
      if (!box.opens || box.kind === "ext" || box.kind === "state") continue;
      await call("open", index);
      await visit(depth + 1);
      await call("climb", depth);
    }
  };
  await visit(0);
  return [...seen.values()];
}

test("every level, group, part and state machine of a real map draws clear, in dark and light", async () => {
  const fills: string[] = [];
  for (const theme of ["dark", "light"] as const) {
    await mounted(theme);
    const views = await walk();
    for (const view of views) {
      expect(view.problems, `no problems at ${view.crumbs}`).toBe("");
      expectClear(view);
    }
    const places = views.map((view) => view.crumbs);
    // Each map file is a place, and each of its machines opens in the frame of the folder that holds it.
    expect(places).toContain(MAP_DATA.maps[""].name);
    for (const [folder, map] of Object.entries(MAP_DATA.maps).filter(([folder]) => folder)) {
      expect(
        places.some((place) => place.endsWith(` › ${map.name}`)),
        folder,
      ).toBe(true);
      for (const machine of (map as { machines?: { name: string; in: string }[] }).machines ?? []) {
        const view = views.find((each) => each.crumbs.endsWith(` › ${machine.name}`));
        const holder = map.parts.find((each) => each.name === machine.in);
        expect(view?.frame, machine.name).toBe(`${holder?.path} › ${machine.name}`);
        // and its pill sits on its holder's box in the level that draws it
        const holders = views.flatMap((each) =>
          each.boxes.filter((box) => box.label === machine.in && box.kind === "part"),
        );
        expect(holders.length, `${machine.in} is drawn`).toBeGreaterThan(0);
        for (const box of holders)
          expect(
            box.pills.some((pill) => pill.name === machine.name),
            `${machine.name}'s pill`,
          ).toBe(true);
      }
    }
    fills.push((await read()).fill);
  }
  // The same map takes each theme's own colors.
  expect(fills[0]).not.toBe(fills[1]);
});

test("the map keeps its own presses and keys, and leaves Escape at the top to the card", async () => {
  const heard = await mounted("dark");
  // A click on the map is the map's: the card never opens it as a still picture.
  expect(await call("click")).toBe(true);
  expect(heard.filter((message) => message.type === "image")).toEqual([]);
  // Arrows choose a box, Enter goes in, Escape lets go of the choice and then climbs back.
  const topName = MAP_DATA.maps[""].name;
  const opening = new Set((await read()).boxes.filter((box) => box.opens).map((box) => box.label));
  let chosen = "";
  for (const key of ["ArrowRight", "ArrowDown", "ArrowRight", "ArrowDown", "ArrowRight"]) {
    expect(await call("key", key)).toBe(true);
    chosen = (await read()).live;
    if (opening.has(chosen.split(/:| · /)[0] as string)) break;
  }
  const name = chosen.split(/:| · /)[0] as string;
  expect(opening.has(name), `the arrows chose a box that opens, not "${chosen}"`).toBe(true);
  expect(await call("key", "Enter")).toBe(true);
  expect((await read()).crumbs.endsWith(` › ${name}`)).toBe(true);
  expect(await call("key", "Escape")).toBe(true);
  expect((await read()).crumbs).toBe(topName);
  // Back at the top the box it came from is chosen; Escape lets it go, then leaves for the card.
  expect(await call("key", "Escape")).toBe(true);
  expect(await call("key", "Escape")).toBe(false);
  await expect
    .poll(() => heard.filter((message) => message.type === "escape").length)
    .toBeGreaterThan(0);
});

test("a packed data block draws the same map", async () => {
  await mounted("dark");
  const plain = await read();
  await mounted("dark", { pack: true });
  const fromPacked = await read();
  expect(fromPacked.problems).toBe("");
  expect(fromPacked.boxes.map((box) => box.label)).toEqual(plain.boxes.map((box) => box.label));
  expect(fromPacked.edges).toEqual(plain.edges);
});

type Change = { label: string; files: [string, string, number, number][] };

test("a change view tags boxes, links, states and moves, with counts, and draws clear", async () => {
  const [turns, panels] = MAP_DATA.compare as unknown as [
    Change & {
      names: Record<string, Record<string, string>>;
      untraced: string[];
      was: Record<string, { machines: { name: string; states: string[]; moves: unknown[] }[] }>;
    },
    Change & {
      was: Record<
        string,
        { parts: { name: string }[]; links: { from: string; to: string; why: string }[] }
      >;
    },
  ];
  // The counts at the top of the list come from the files the comparison names.
  const counted = (change: Change) => {
    const of = (mark: string) => change.files.filter((file) => file[1] === mark);
    const sum = (index: 2 | 3) => change.files.reduce((total, file) => total + file[index], 0);
    return `${change.label}: ${of("+").length} files added, ${of("-").length} removed, ${of("~").length} changed · ${sum(2).toLocaleString("en-US")} lines added, ${sum(3).toLocaleString("en-US")} removed`;
  };

  // The turn rebuild, opened on the machine it changed.
  const machine = Object.keys(turns.names)[0] as string;
  await mounted("dark", { open: { at: machine, changes: 0 } });
  let view = await read();
  expect(view.crumbs.endsWith(` › ${machine}`)).toBe(true);
  expect(view.changes.startsWith(counted(turns))).toBe(true);
  expectClear(view);
  const core = MAP_DATA.maps["src/core"];
  const now = core.machines.find((each) => each.name === machine);
  const was = turns.was["src/core"]?.machines.find((each) => each.name === machine);
  if (!now || !was) throw new Error("The fixture's turn machine is missing.");
  const renamed = turns.names[machine] ?? {};
  for (const state of now.states) {
    const box = view.boxes.find((each) => each.label === state);
    const old = renamed[state];
    const expected = old ? "changed" : was.states.includes(state) ? "same" : "added";
    expect(box?.tag, state).toBe(expected);
  }
  // A move is matched by its two ends under their old names: a new pair is added, a new why changed.
  const oldName = (state: string) => renamed[state] ?? state;
  for (const move of now.moves) {
    const before = (was.moves as { from: string; to: string; why: string }[]).find(
      (each) => each.from === oldName(move.from) && each.to === oldName(move.to),
    );
    const edge = view.edges.find((each) => each.from === move.from && each.to === move.to);
    expect(edge?.tag, `${move.from} → ${move.to}`).toBe(
      !before ? "added" : before.why === move.why ? "same" : "changed",
    );
  }
  // The lists under a machine count its states alone, never a box that makes its moves (the
  // review's finding once outside boxes took tags).
  const states = view.boxes.filter((box) => box.kind === "state");
  for (const [name, tag] of [
    ["Added", "added"],
    ["Removed", "removed"],
    ["Changed", "changed"],
  ] as const)
    expect(
      Number(view.changes.match(new RegExp(`${name} here: (\\d+) state`))?.[1] ?? 0),
      name,
    ).toBe(states.filter((box) => box.tag === tag).length);
  // A machine nobody traced this time shows no tags, never "unchanged".
  const untraced = turns.untraced[0] as string;
  await call("climb", 0);
  const walked = await walk();
  const secret = walked.find((each) => each.crumbs.endsWith(` › ${untraced}`));
  expect(secret?.boxes.map((box) => box.tag).filter(Boolean)).toEqual([]);
  for (const each of walked) expectClear(each);

  // Panels in frames: the retired folder stays, removed, with its links; a link whose why moved is changed.
  await mounted("light");
  expect(await call("compare", panels.label)).toBe("true");
  view = await read();
  expect(view.changes.startsWith(counted(panels))).toBe(true);
  const main = MAP_DATA.maps["src/main"];
  const mainView = (await walk()).find((each) => each.crumbs.endsWith(` › ${main.name}`));
  if (!mainView) throw new Error("The main process's map is not drawn.");
  expectClear(mainView);
  const old = panels.was["src/main"];
  if (!old) throw new Error("The fixture's old main map is missing.");
  for (const gone of old.parts.filter(
    (each) => !main.parts.some((part) => part.name === each.name),
  ))
    expect(mainView.boxes.find((box) => box.label === gone.name)?.tag, gone.name).toBe("removed");
  for (const link of old.links) {
    const kept = main.links.find((each) => each.from === link.from && each.to === link.to);
    const edge = mainView.edges.find((each) => each.from === link.from && each.to === link.to);
    expect(edge?.tag, `${link.from} → ${link.to}`).toBe(
      !kept ? "removed" : kept.why === link.why ? "same" : "changed",
    );
  }
  expect(mainView.changes).toMatch(/Removed here: 1 box, \d+ links?/);
});

// The reviewer's finding on the change view: a level the next comparison cannot read (its map file
// is new since that version, so `was` names it null) kept the link tags of the comparison before.
test("switching comparisons keeps no link tags from the one before", async () => {
  const panels = MAP_DATA.compare[1] as unknown as Change & { was: Record<string, unknown> };
  const mainFolder = Object.keys(panels.was)[0] as string;
  // The same change, read against a version before the main process had a map file.
  const firstMap = { ...panels, label: "Before the main map", was: { [mainFolder]: null } };
  const data = { ...MAP_DATA, compare: [...MAP_DATA.compare, firstMap] };
  const main = MAP_DATA.maps[mainFolder as "src/main"];
  const mainEdges = async () =>
    (await walk()).find((each) => each.crumbs.endsWith(` › ${main.name}`))?.edges;

  await mounted("dark", { data });
  expect(await call("compare", panels.label)).toBe("true");
  const tagged = await mainEdges();
  expect(tagged?.some((edge) => edge.tag === "added" || edge.tag === "changed")).toBe(true);
  expect(await call("compare", firstMap.label)).toBe("true");
  const switched = await mainEdges();

  await mounted("dark", { data });
  expect(await call("compare", firstMap.label)).toBe("true");
  expect(switched).toEqual(await mainEdges());
});

// The captain's answer to the review of the change view: a removed state machine, outside boxes and
// a removed outside box's links show as the plan promised, "tag boxes, links, states and moves as
// added, removed or changed". Each comparison below is this project's own map file read against the
// same file with one thing more or less, as a map file reads before or after that edit.
type MapFile = (typeof MAP_DATA.maps)["src/main"] & {
  machines?: {
    name: string;
    in: string;
    states: string[];
    moves: { from: string; to: string }[];
  }[];
};
const changed = (maps: Record<string, MapFile>, folder: string, was: MapFile) => ({
  ...MAP_DATA,
  maps,
  compare: [{ label: "The edit", files: [], was: { [folder]: was } }],
});

test("a machine its map file no longer holds shows removed, in the part that held it", async () => {
  const core = MAP_DATA.maps["src/core"] as MapFile & {
    machines: NonNullable<MapFile["machines"]>;
  };
  // A machine no other machine opens, so the map without it still reads whole.
  const retired = core.machines.find(
    (each) =>
      !Object.keys((each as { opens?: object }).opens ?? {}).length &&
      !core.machines.some((other) =>
        Object.values((other as { opens?: object }).opens ?? {}).includes(each.name),
      ),
  );
  const holder = core.parts.find((each) => each.name === retired?.in);
  if (!retired || !holder) throw new Error("The fixture has no machine to retire.");
  const without = { ...core, machines: core.machines.filter((each) => each !== retired) };
  await mounted("dark", {
    data: changed({ ...MAP_DATA.maps, "src/core": without }, "src/core", core),
    open: { at: "", changes: 0 },
  });
  const walked = await walk();
  for (const each of walked) expectClear(each);
  const pills = walked.flatMap((each) =>
    each.boxes.filter((box) => box.label === holder.name && box.kind === "part"),
  );
  expect(pills.length).toBeGreaterThan(0);
  for (const box of pills)
    expect(box.pills.find((pill) => pill.name === retired.name)?.tag, box.label).toBe("removed");
  const inPart = walked.find((each) => each.crumbs.endsWith(` › ${holder.name}`));
  expect(inPart?.boxes.find((box) => box.label === retired.name)?.tag).toBe("removed");
  const machine = walked.find((each) => each.crumbs.endsWith(` › ${retired.name}`));
  const states = machine?.boxes.filter((box) => box.kind === "state");
  expect(Object.fromEntries(states?.map((box) => [box.label, box.tag]) ?? [])).toEqual(
    Object.fromEntries(retired.states.map((state) => [state, "removed"])),
  );
  for (const move of retired.moves)
    expect(
      machine?.edges.find((edge) => edge.from === move.from && edge.to === move.to)?.tag,
      `${move.from} → ${move.to}`,
    ).toBe("removed");
});

// The live proof of the change view: a card told to open at a machine or a part's folder that its
// comparison removed listed a problem to fix in the map files, which hold nothing wrong.
test("a card opens at a machine or a part its comparison removed, with no problem listed", async () => {
  const core = MAP_DATA.maps["src/core"] as MapFile & {
    machines: NonNullable<MapFile["machines"]>;
  };
  const retired = core.machines.find(
    (each) =>
      !Object.keys((each as { opens?: object }).opens ?? {}).length &&
      !core.machines.some((other) =>
        Object.values((other as { opens?: object }).opens ?? {}).includes(each.name),
      ),
  );
  if (!retired) throw new Error("The fixture has no machine to retire.");
  const without = { ...core, machines: core.machines.filter((each) => each !== retired) };
  await mounted("dark", {
    data: changed({ ...MAP_DATA.maps, "src/core": without }, "src/core", core),
    open: { at: retired.name, changes: 0 },
  });
  let view = await read();
  expect(view.problems).toBe("");
  expect(view.crumbs.endsWith(` › ${retired.name}`)).toBe(true);
  expect(
    view.boxes.filter((box) => box.kind === "state").every((box) => box.tag === "removed"),
  ).toBe(true);

  // Panels in frames retired the main process's plugins folder, a part of its map file.
  const panels = MAP_DATA.compare[1] as unknown as Change & {
    was: Record<string, { parts: { name: string; path: string }[] }>;
  };
  const [folder = ""] = Object.keys(panels.was);
  const gone = panels.was[folder]?.parts.find(
    (each) => !MAP_DATA.maps[folder as "src/main"].parts.some((part) => part.path === each.path),
  );
  if (!gone) throw new Error("The fixture's comparison removes no part.");
  await mounted("light", { open: { at: gone.path, changes: 1 } });
  view = await read();
  expect(view.problems).toBe("");
  expect(view.boxes.find((box) => box.label === gone.name)?.tag).toBe("removed");
});

/** The main process's map, and the same file before an outside box it links to was written in. */
function mainWithout(): { main: MapFile; out: string; without: MapFile } {
  const main = MAP_DATA.maps["src/main"] as MapFile;
  const linked = (name: string) =>
    main.links.some((each) => each.from === name || each.to === name);
  const out = main.outside.find((each) => linked(each.name))?.name;
  if (!out) throw new Error("The main process's map links no outside box.");
  const without = {
    ...main,
    outside: main.outside.filter((each) => each.name !== out),
    links: main.links.filter((each) => each.from !== out && each.to !== out),
  };
  return { main, out, without };
}

test("an outside box is tagged like any box: added when new, unchanged otherwise", async () => {
  const { main, out, without } = mainWithout();
  await mounted("light", {
    data: changed(MAP_DATA.maps, "src/main", without),
    open: { at: "src/main", changes: 0 },
  });
  const view = await read();
  expectClear(view);
  for (const each of main.outside)
    expect(view.boxes.find((box) => box.label === each.name)?.tag, each.name).toBe(
      each.name === out ? "added" : "same",
    );
  for (const link of main.links.filter((each) => each.from === out || each.to === out))
    expect(
      view.edges.find((edge) => edge.from === link.from && edge.to === link.to)?.tag,
      `${link.from} → ${link.to}`,
    ).toBe("added");
});

test("an outside box the map file no longer names stays, removed, with its links", async () => {
  const { main, out, without } = mainWithout();
  await mounted("dark", {
    data: changed({ ...MAP_DATA.maps, "src/main": without }, "src/main", main),
    open: { at: "src/main", changes: 0 },
  });
  const view = await read();
  expectClear(view);
  expect(view.boxes.find((box) => box.label === out)?.tag).toBe("removed");
  for (const link of main.links.filter((each) => each.from === out || each.to === out))
    expect(
      view.edges.find((edge) => edge.from === link.from && edge.to === link.to)?.tag,
      `${link.from} → ${link.to}`,
    ).toBe("removed");
});

// The captain's answer to the review: "Send nothing: drop it from every card". Going through every
// place and turning each comparison on gives the card no answer to show or send.
test("the map gives its card no answer to send, wherever the reader goes", async () => {
  const heard = await mounted("dark", { form: true });
  await walk();
  for (const change of MAP_DATA.compare) {
    expect(await call("compare", change.label)).toBe("true");
    await walk();
  }
  expect(heard.some((message) => message.type === "answers")).toBe(true);
  for (const message of heard.filter((each) => each.type === "answers")) {
    expect(message.of).toBe(0);
    expect(message.answers).toEqual([]);
  }
});

// The live proof in the window found that a double-click on a box, the map's own way in, also
// selected the box's words, and the window opens its note box over a card when words are selected.
test("a double-click goes in without selecting the box's words", async () => {
  await mounted("dark");
  const target = (await read()).boxes.find((box) => box.opens && box.kind === "grp");
  expect(target, "the top has a group to go in to").toBeDefined();
  const frame = page.frameLocator(
    page.elementLocator(document.querySelector(`iframe[name="${FRAME}"]`) as HTMLIFrameElement),
  );
  // the words selected as each press lifts, where the window's card frame reads them to offer a note
  await inFrame(() => {
    const seen: string[] = [];
    (window as unknown as { selected: string[] }).selected = seen;
    document.addEventListener(
      "pointerup",
      () => {
        const words = getSelection()?.toString() ?? "";
        if (words) seen.push(words);
      },
      true,
    );
  }, null);
  await frame
    .getByText(target?.label ?? "", { exact: true })
    .first()
    .dblClick();
  await expect.poll(async () => (await read()).crumbs).toMatch(new RegExp(`${target?.label}$`));
  expect(await inFrame(() => (window as unknown as { selected: string[] }).selected, null)).toEqual(
    [],
  );
});
