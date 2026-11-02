import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FRAME_BRIDGE_SCRIPT, FRAME_BRIDGE_SHA256 } from "@shared/plugins/bridge";
import {
  PANEL_CONFIG_ID,
  PANEL_ROOT_ID,
  type PanelMountRequest,
} from "@shared/plugins/frameDocument";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import {
  bytesHash,
  FrameMountCapError,
  FrameMountRegistry,
  PanelMountError,
  type PanelSources,
  scriptHash,
} from "./frameMounts";
import { answerFrameRequest } from "./frameProtocol";

/**
 * The frame realm's half in the shell (one plugin vehicle, Phase A item 4):
 * a panel mount's document, its policy and import map, the compiled files it
 * serves, and the lib host's pins. Driven through the registry and the
 * scheme handler the app uses, over a real directory for an added panel's
 * compiled graph.
 */

const lib: Record<string, string> = {
  "boot.mjs": "import './chunks/react-a.mjs';",
  "react.mjs": "export default {};",
  "chunks/react-a.mjs": "export const react = 1;",
  "builtin/activity/panel.mjs": "export default function Activity() {}",
};
const libPins = Object.fromEntries(
  Object.entries(lib).map(([file, text]) => [file, bytesHash(new TextEncoder().encode(text))]),
);

function graph(files: Record<string, string>): string {
  const dir = scratchDir("infinitary-panel-graph-");
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

/**
 * The core's compiled graphs, keyed `id@version` for an added panel, and
 * `yours:id@version` (`#draft` for a panel being built) for the captain's own.
 */
function sources(
  installed: Record<string, string> = {},
  pins: Record<string, string> = libPins,
): PanelSources {
  return {
    libPins: pins,
    panelDir: (source, id, version, draft) =>
      installed[
        source === "installed"
          ? `${id}@${version}`
          : `yours:${id}@${version}${draft ? "#draft" : ""}`
      ] ?? null,
  };
}

const base = { title: "Probe", theme: "dark" as const, style: "body{}" };

function installedRequest(version = "0123456789abcdef"): PanelMountRequest {
  return {
    ...base,
    kind: "panel",
    panel: { source: "installed", id: "token-meter", version },
    config: { id: "token-meter", reads: [], sql: ["v_usage_v1"] },
  };
}

const builtinRequest: PanelMountRequest = {
  ...base,
  kind: "panel",
  panel: { source: "builtin", id: "activity" },
  config: { id: "activity", reads: ["feed.recent"], sql: [] },
};

function inlineJson(body: string, id: string): unknown {
  const match = new RegExp(`<script type="application/json" id="${id}">(.*?)</script>`).exec(body);
  return match ? JSON.parse(match[1] ?? "") : null;
}

function importMapOf(body: string): { text: string; map: { integrity: Record<string, string> } } {
  const text = /<script type="importmap">(.*?)<\/script>/.exec(body)?.[1] ?? "";
  return { text, map: JSON.parse(text) };
}

describe("a panel mount", () => {
  it("serves an added panel's document at a host of its own, pinning the lib and exactly the files it read", async () => {
    const dir = graph({
      "panel.mjs": "import './lib/rows.mjs'; export default () => null;",
      "lib/rows.mjs": "export const rows = [];",
      "notes.txt": "not a module",
    });
    const mounts = new FrameMountRegistry({
      newId: () => "p1",
      panels: sources({ "token-meter@0123456789abcdef": dir }),
    });
    const mount = await mounts.mountPanel(installedRequest());
    expect(mount).toEqual({ mountId: "p1", url: "app-frame://panel-p1/" });

    const served = mounts.panelDocument("p1");
    const body = served?.body ?? "";
    const { text, map } = importMapOf(body);
    // Every lib file by its baked pin, and the mount's own modules by the
    // hashes of the bytes read now - nothing else, and no non-module file.
    expect(map.integrity).toEqual({
      "app-frame://lib/boot.mjs": libPins["boot.mjs"],
      "app-frame://lib/react.mjs": libPins["react.mjs"],
      "app-frame://lib/chunks/react-a.mjs": libPins["chunks/react-a.mjs"],
      "app-frame://lib/builtin/activity/panel.mjs": libPins["builtin/activity/panel.mjs"],
      "app-frame://panel-p1/panel.mjs": bytesHash(
        new TextEncoder().encode("import './lib/rows.mjs'; export default () => null;"),
      ),
      "app-frame://panel-p1/lib/rows.mjs": bytesHash(
        new TextEncoder().encode("export const rows = [];"),
      ),
    });
    // The policy runs the bridge and this import map by hash, and modules
    // from the lib and this mount's own host only.
    expect(served?.csp).toBe(
      `default-src 'none'; style-src 'unsafe-inline'; font-src app-frame:; img-src data: app-frame:; script-src '${FRAME_BRIDGE_SHA256}' '${scriptHash(text)}' app-frame://lib/ app-frame://panel-p1/`,
    );
    // The bridge first, the import map before any module, the config as
    // data, and the lib's boot as the one module script, itself pinned.
    const bridgeAt = body.indexOf(`<script>${FRAME_BRIDGE_SCRIPT}</script>`);
    const mapAt = body.indexOf('<script type="importmap">');
    const bootAt = body.indexOf(
      `<script type="module" src="app-frame://lib/boot.mjs" integrity="${libPins["boot.mjs"]}">`,
    );
    expect(bridgeAt).toBeGreaterThan(-1);
    expect(mapAt).toBeGreaterThan(bridgeAt);
    expect(bootAt).toBeGreaterThan(mapAt);
    expect(body).toContain(`<div id="${PANEL_ROOT_ID}"></div>`);
    expect(inlineJson(body, PANEL_CONFIG_ID)).toEqual({
      id: "token-meter",
      reads: [],
      sql: ["v_usage_v1"],
      module: "app-frame://panel-p1/panel.mjs",
    });
    // What the mount serves is what it read: a file written to the cache
    // afterwards reaches no frame, and neither does anything but a module.
    writeFileSync(join(dir, "panel.mjs"), "window.stolen = 1;");
    writeFileSync(join(dir, "late.mjs"), "export {};");
    expect(new TextDecoder().decode(mounts.panelFile("p1", "panel.mjs"))).toContain("rows.mjs");
    expect(mounts.panelFile("p1", "late.mjs")).toBeUndefined();
    expect(mounts.panelFile("p1", "notes.txt")).toBeUndefined();
  });

  it("draws one of an added panel's card views from the same pinned graph, with the card's id", async () => {
    const dir = graph({
      "panel.mjs": "export default () => null;",
      "cards/notes.mjs": "import '../lib/rows.mjs'; export default () => null;",
      "lib/rows.mjs": "export const rows = [];",
    });
    const mounts = new FrameMountRegistry({
      newId: () => "c1",
      panels: sources({ "token-meter@0123456789abcdef": dir }),
    });
    const request = installedRequest();
    await mounts.mountPanel({
      ...request,
      panel: { source: "installed", id: "token-meter", version: "0123456789abcdef", view: "notes" },
      config: { ...request.config, card: { id: "notes-1" } },
    });
    const body = mounts.panelDocument("c1")?.body ?? "";
    expect(inlineJson(body, PANEL_CONFIG_ID)).toEqual({
      id: "token-meter",
      reads: [],
      sql: ["v_usage_v1"],
      card: { id: "notes-1" },
      module: "app-frame://panel-c1/cards/notes.mjs",
    });
    expect(Object.keys(importMapOf(body).map.integrity)).toContain(
      "app-frame://panel-c1/cards/notes.mjs",
    );
    // A view the graph does not hold is refused, by name.
    await expect(
      mounts.mountPanel({
        ...request,
        panel: {
          source: "installed",
          id: "token-meter",
          version: "0123456789abcdef",
          view: "other",
        },
      }),
    ).rejects.toThrow("no entry: cards/other.mjs");
  });

  it("draws one of the app's own panels from the lib, with no files of its own", async () => {
    const mounts = new FrameMountRegistry({ newId: () => "b1", panels: sources() });
    await mounts.mountPanel(builtinRequest);
    const body = mounts.panelDocument("b1")?.body ?? "";
    expect(inlineJson(body, PANEL_CONFIG_ID)).toMatchObject({
      module: "app-frame://lib/builtin/activity/panel.mjs",
    });
    expect(Object.keys(importMapOf(body).map.integrity).sort()).toEqual(
      Object.keys(libPins)
        .map((file) => `app-frame://lib/${file}`)
        .sort(),
    );
    expect(mounts.panelFile("b1", "panel.mjs")).toBeUndefined();
  });

  it("draws one of the captain's own panels, and a draft of it, each only from its own graph (INF-2205 piece C)", async () => {
    const saved = graph({ "panel.mjs": "export default () => 'saved';" });
    const draft = graph({ "panel.mjs": "export default () => 'draft';" });
    const mounts = new FrameMountRegistry({
      newId: (() => {
        const ids = ["y1", "y2", "y3", "y4"];
        return () => ids.shift() ?? "spent";
      })(),
      panels: sources({
        "yours:notes@0123456789abcdef": saved,
        "yours:notes@0123456789abcdef#draft": draft,
      }),
    });
    const personal = (panel: { version?: string; draft?: true } = {}): PanelMountRequest => ({
      ...base,
      kind: "panel",
      panel: { source: "personal", id: "notes", version: "0123456789abcdef", ...panel },
      config: { id: "notes", reads: [], sql: [], server: true },
    });
    const request = personal();
    await mounts.mountPanel(request);
    await mounts.mountPanel(personal({ draft: true }));
    expect(new TextDecoder().decode(mounts.panelFile("y1", "panel.mjs"))).toContain("saved");
    expect(new TextDecoder().decode(mounts.panelFile("y2", "panel.mjs"))).toContain("draft");
    expect(inlineJson(mounts.panelDocument("y1")?.body ?? "", PANEL_CONFIG_ID)).toMatchObject({
      server: true,
      module: "app-frame://panel-y1/panel.mjs",
    });
    // Another version, or the same id as an added panel, is not served.
    await expect(mounts.mountPanel(personal({ version: "fedcba9876543210" }))).rejects.toThrow(
      "is not a panel of the captain's at version fedcba9876543210",
    );
    await expect(
      mounts.mountPanel({
        ...request,
        panel: { source: "installed", id: "notes", version: "0123456789abcdef" },
      }),
    ).rejects.toThrow("is not an added panel");
  });

  it("refuses a panel the core does not serve at that version, a build without the lib, and one past the cap", async () => {
    const mounts = new FrameMountRegistry({ panels: sources() });
    await expect(mounts.mountPanel(installedRequest("fedcba9876543210"))).rejects.toThrow(
      PanelMountError,
    );
    await expect(new FrameMountRegistry().mountPanel(installedRequest())).rejects.toThrow(
      "this build draws no panels in frames",
    );
    const noBoot = { ...libPins };
    delete noBoot["boot.mjs"];
    await expect(
      new FrameMountRegistry({ panels: sources({}, noBoot) }).mountPanel(builtinRequest),
    ).rejects.toThrow("panel library is missing");
    const noEntry = graph({ "other.mjs": "export {};" });
    await expect(
      new FrameMountRegistry({
        panels: sources({ "token-meter@0123456789abcdef": noEntry }),
      }).mountPanel(installedRequest()),
    ).rejects.toThrow("no entry");

    const capped = new FrameMountRegistry({ panelCap: 1, panels: sources() });
    await capped.mountPanel(builtinRequest);
    await expect(capped.mountPanel(builtinRequest)).rejects.toThrow(FrameMountCapError);
    // Panels have a cap of their own: templates still mount.
    expect(() => capped.mount({ ...base, template: { html: "<p>x</p>" } })).not.toThrow();
  });
});

describe("the frame scheme's panel and lib hosts", () => {
  const libDir = "/app/out/frame-lib";
  const onDisk: Record<string, Uint8Array> = Object.fromEntries(
    Object.entries(lib).map(([file, text]) => [
      `${libDir}/${file}`,
      new TextEncoder().encode(text),
    ]),
  );
  const read = async (path: string) => {
    const bytes = onDisk[path];
    if (!bytes) throw new Error("missing");
    return bytes;
  };
  const hosts = (mounts: FrameMountRegistry) => ({
    mounts,
    fonts: {},
    pictures: () => ({ root: "/user/crewmates" }),
    lib: { dir: libDir, pins: libPins },
  });

  it("serves a pinned lib file whose bytes still match, as a module an opaque frame may load", async () => {
    const response = await answerFrameRequest(
      "app-frame://lib/chunks/react-a.mjs",
      hosts(new FrameMountRegistry()),
      read,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toBe(lib["chunks/react-a.mjs"]);
  });

  it("serves nothing under the lib that is not pinned, or that no longer matches its pin", async () => {
    const tampered: Record<string, Uint8Array> = {
      ...onDisk,
      [`${libDir}/react.mjs`]: new TextEncoder().encode("evil()"),
    };
    const readTampered = async (path: string) => {
      const bytes = tampered[path];
      if (!bytes) throw new Error("missing");
      return bytes;
    };
    for (const url of [
      "app-frame://lib/evil.mjs",
      "app-frame://lib/",
      "app-frame://lib/chunks",
      "app-frame://lib/..%2Fmain%2Findex.js",
      "app-frame://lib/chunks/../boot.mjs/x",
    ]) {
      const response = await answerFrameRequest(url, hosts(new FrameMountRegistry()), read);
      expect(response.status, url).toBe(404);
    }
    const drifted = await answerFrameRequest(
      "app-frame://lib/react.mjs",
      hosts(new FrameMountRegistry()),
      readTampered,
    );
    expect(drifted.status).toBe(404);
    // A build that shipped no lib answers nothing under it.
    const bare = await answerFrameRequest(
      "app-frame://lib/boot.mjs",
      { mounts: new FrameMountRegistry(), fonts: {}, pictures: () => ({ root: "/x" }) },
      read,
    );
    expect(bare.status).toBe(404);
  });

  it("answers a panel host with its document and its own modules, and nothing of another mount", async () => {
    const ids = ["one", "two"];
    const mounts = new FrameMountRegistry({
      newId: () => ids.shift() ?? "",
      panels: sources({
        "token-meter@0123456789abcdef": graph({ "panel.mjs": "export default 1;" }),
      }),
    });
    await mounts.mountPanel(installedRequest());
    await mounts.mountPanel(builtinRequest);
    const document = await answerFrameRequest("app-frame://panel-one/", hosts(mounts), read);
    expect(document.status).toBe(200);
    expect(document.headers.get("content-security-policy")).toBe(mounts.panelDocument("one")?.csp);
    const module = await answerFrameRequest("app-frame://panel-one/panel.mjs", hosts(mounts), read);
    expect(module.status).toBe(200);
    expect(await module.text()).toBe("export default 1;");
    for (const url of [
      "app-frame://panel-two/panel.mjs",
      "app-frame://panel-one/other.mjs",
      "app-frame://mount/one",
      "app-frame://panel-three/",
    ]) {
      expect((await answerFrameRequest(url, hosts(mounts), read)).status, url).toBe(404);
    }
    mounts.unmount("one");
    expect(
      (await answerFrameRequest("app-frame://panel-one/panel.mjs", hosts(mounts), read)).status,
    ).toBe(404);
  });
});
