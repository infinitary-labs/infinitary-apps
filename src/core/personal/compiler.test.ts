import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { compilePersonalModule, PersonalCompileError } from "./compiler";

/**
 * The compiler's contract (docs/ui-plugins.md "Personal extensions"): the
 * allowlist and the escape check refuse with the offending path named,
 * host imports become the served shims, local imports keep their shape,
 * and the output is content-addressed so an edit is a new URL.
 */

function workspace(files: Record<string, string>): { root: string; cache: string } {
  // realpath: macOS hands out /var, which is /private/var.
  const root = realpathSync(scratchDir("infinitary-personal-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  const cache = scratchDir("infinitary-personal-cache-");
  return { root, cache };
}

describe("compilePersonalModule", () => {
  it("transpiles a panel graph, rewrites host imports to the shims, and keeps local imports relative", async () => {
    const { root, cache } = workspace({
      "clock/panel.tsx": [
        'import React, { useState } from "react";',
        'import * as All from "react";',
        'import { Badge as Chip, Button } from "@firstmate/ui";',
        'import type { PanelProps } from "@firstmate/contracts";',
        'import { label } from "./lib/format";',
        'import { deep } from "./lib";',
        "export default function Panel(props: PanelProps) {",
        "  const [n] = useState(1);",
        "  return <Chip>{label(n)}{deep}</Chip>;",
        "}",
      ].join("\n"),
      "clock/lib/format.ts": "export const label = (n: number): string => String(n);",
      "clock/lib/index.ts": 'export const deep = "deep";',
    });
    const compiled = await compilePersonalModule({
      extensionId: "clock",
      extensionDir: join(root, "clock"),
      kind: "panel",
      cacheRoot: cache,
    });
    expect(compiled.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(compiled.entryPath).toBe(join(cache, "clock", compiled.hash, "panel.mjs"));
    expect(compiled.sourceFiles.map((file) => file.slice(root.length + 1))).toEqual([
      "clock/lib/format.ts",
      "clock/lib/index.ts",
      "clock/panel.tsx",
    ]);
    const panel = readFileSync(compiled.entryPath, "utf8");
    // Each host import becomes a default import of its shim plus a
    // destructuring; `All` and `Button` are unused, so the transpile elided
    // them before the rewrite ever saw them.
    expect(panel).toMatch(
      /import (__fm_host\d) from "app-plugin:\/\/host\/react\.mjs";\nconst React = \1;\nconst \{ useState \} = \1;/,
    );
    expect(panel).toMatch(
      /import (__fm_host\d) from "app-plugin:\/\/host\/ui\.mjs";\nconst \{ Badge: Chip \} = \1;/,
    );
    // The automatic JSX runtime's own import is a host import too.
    expect(panel).toMatch(
      /import (__fm_host\d) from "app-plugin:\/\/host\/jsxRuntime\.mjs";\nconst \{ jsxs: _jsxs \} = \1;/,
    );
    expect(panel).not.toContain("@firstmate/contracts");
    expect(panel).not.toContain('"react"');
    expect(panel).toContain('import { label } from "./lib/format.mjs";');
    expect(panel).toContain('import { deep } from "./lib/index.mjs";');
    expect(readFileSync(join(compiled.outputDir, "lib", "format.mjs"), "utf8")).toContain("label");
    expect(readFileSync(join(compiled.outputDir, "lib", "index.mjs"), "utf8")).toContain("deep");
  });

  it("compiles a panel written with Infinitary's names for the host modules as the same modules", async () => {
    const { root, cache } = workspace({
      "clock/panel.tsx": [
        'import { Badge } from "@infinitary/ui";',
        'import type { PanelProps } from "@infinitary/contracts";',
        "export default function Panel(_props: PanelProps) {",
        "  return <Badge>On</Badge>;",
        "}",
      ].join("\n"),
      "values/panel.tsx": [
        'import { PanelProps } from "@infinitary/contracts";',
        "export default function Panel() { return PanelProps; }",
      ].join("\n"),
    });
    const compiled = await compilePersonalModule({
      extensionId: "clock",
      extensionDir: join(root, "clock"),
      kind: "panel",
      cacheRoot: cache,
    });
    const panel = readFileSync(compiled.entryPath, "utf8");
    expect(panel).toMatch(
      /import (__fm_host\d) from "app-plugin:\/\/host\/ui\.mjs";\nconst \{ Badge \} = \1;/,
    );
    expect(panel).not.toContain("@infinitary/");
    // Still type-only under its other name.
    await expect(
      compilePersonalModule({
        extensionId: "values",
        extensionDir: join(root, "values"),
        kind: "panel",
        cacheRoot: cache,
      }),
    ).rejects.toThrow('imports "@infinitary/contracts" as a value');
  });

  it("compiles a panel for the frame realm against the served lib, as a version of its own", async () => {
    // A panel the captain added runs in the frame realm (one plugin vehicle,
    // Phase A item 4): the same allowlist, its host imports pointed at the
    // lib the shell serves at app-frame://lib/ instead of the window's shims.
    const { root, cache } = workspace({
      "meter/panel.tsx": [
        'import { useState } from "react";',
        'import { Badge } from "@firstmate/ui";',
        "export default function Panel() {",
        "  const [n] = useState(1);",
        "  return <Badge>{n}</Badge>;",
        "}",
      ].join("\n"),
    });
    const options = {
      extensionId: "meter",
      extensionDir: join(root, "meter"),
      kind: "panel" as const,
      cacheRoot: cache,
    };
    const frame = await compilePersonalModule({ ...options, realm: "frame" });
    const panel = readFileSync(frame.entryPath, "utf8");
    expect(panel).toMatch(/from "app-frame:\/\/lib\/react\.mjs";\nconst \{ useState \} = /);
    expect(panel).toMatch(/from "app-frame:\/\/lib\/ui\.mjs";\nconst \{ Badge \} = /);
    expect(panel).toMatch(/from "app-frame:\/\/lib\/jsx-runtime\.mjs";/);
    expect(panel).not.toContain("app-plugin:");
    // The window's compile of the same sources is another version, and keeps
    // the shims.
    const window = await compilePersonalModule(options);
    expect(window.hash).not.toBe(frame.hash);
    expect(readFileSync(window.entryPath, "utf8")).toContain("app-plugin://host/react.mjs");
    // The allowlist does not move with the realm.
    writeFileSync(
      join(root, "meter", "panel.tsx"),
      'import lodash from "lodash";\nexport default lodash;',
    );
    await expect(compilePersonalModule({ ...options, realm: "frame" })).rejects.toThrow(
      'imports "lodash", which a panel cannot use',
    );
  });

  it("emits a server graph the core can import, admitting node: built-ins", async () => {
    const { root, cache } = workspace({
      "clock/server.ts": [
        'import { hostname } from "node:os";',
        'import path from "path";',
        'import { twice } from "./math";',
        "export const actions = {",
        "  where: () => ({ host: typeof hostname(), sep: path.sep, four: twice(2) }),",
        "};",
      ].join("\n"),
      "clock/math.ts": "export const twice = (n: number) => n * 2;",
    });
    const compiled = await compilePersonalModule({
      extensionId: "clock",
      extensionDir: join(root, "clock"),
      kind: "server",
      cacheRoot: cache,
    });
    const module = (await import(pathToFileURL(compiled.entryPath).href)) as {
      actions: { where: () => { host: string; sep: string; four: number } };
    };
    expect(module.actions.where()).toEqual({ host: "string", sep: "/", four: 4 });
  });

  it("is content-addressed: the same sources reuse the output, an edit gets a new hash", async () => {
    const { root, cache } = workspace({ "a/panel.tsx": "export default () => null;" });
    const first = await compilePersonalModule({
      extensionId: "a",
      extensionDir: join(root, "a"),
      kind: "panel",
      cacheRoot: cache,
    });
    const again = await compilePersonalModule({
      extensionId: "a",
      extensionDir: join(root, "a"),
      kind: "panel",
      cacheRoot: cache,
    });
    expect(again.hash).toBe(first.hash);
    writeFileSync(join(root, "a", "panel.tsx"), "export default () => 1;");
    const edited = await compilePersonalModule({
      extensionId: "a",
      extensionDir: join(root, "a"),
      kind: "panel",
      cacheRoot: cache,
    });
    expect(edited.hash).not.toBe(first.hash);
    expect(edited.outputDir).not.toBe(first.outputDir);
  });

  it("refuses every import off the allowlist with the offending path named", async () => {
    const cases: [string, string, "panel" | "server", string][] = [
      // An unused import is elided by the transpile (it never reaches the
      // output), so every case here uses what it imports.
      [
        "npm in a panel",
        'import _ from "lodash"; _;',
        "panel",
        'bad/panel.tsx imports "lodash", which a panel cannot use (react, @infinitary/ui, and files inside bad/)',
      ],
      [
        "node in a panel",
        'import { readFileSync } from "node:fs"; readFileSync;',
        "panel",
        'bad/panel.tsx imports "node:fs", which a panel cannot use',
      ],
      [
        "react in a server",
        'import React from "react"; React;',
        "server",
        'bad/server.ts imports "react", which a server module cannot use (node:* built-ins and files inside bad/)',
      ],
      [
        "npm in a server",
        'import x from "axios"; x;',
        "server",
        'bad/server.ts imports "axios", which a server module cannot use',
      ],
      [
        "contracts as a value",
        'import { PanelProps } from "@firstmate/contracts"; console.log(PanelProps);',
        "panel",
        'bad/panel.tsx imports "@firstmate/contracts" as a value; it is type-only',
      ],
      [
        "dynamic import",
        'export const f = () => import("./x");',
        "panel",
        "bad/panel.tsx uses a dynamic import()",
      ],
      [
        "re-export of a host module",
        'export { useState } from "react";',
        "panel",
        'bad/panel.tsx re-exports "react"',
      ],
      [
        "a missing local file",
        'import { x } from "./nowhere"; x;',
        "panel",
        'bad/panel.tsx imports "./nowhere", which is not a file in bad/',
      ],
      [
        "a local escape",
        'import { x } from "../other/secret"; x;',
        "panel",
        'bad/panel.tsx imports "../other/secret", which leaves bad/',
      ],
    ];
    for (const [name, source, kind, message] of cases) {
      const { root, cache } = workspace({
        [`bad/${kind === "panel" ? "panel.tsx" : "server.ts"}`]: source,
        "other/secret.ts": "export const x = 1;",
      });
      const run = compilePersonalModule({
        extensionId: "bad",
        extensionDir: join(root, "bad"),
        kind,
        cacheRoot: cache,
      });
      await expect(run, name).rejects.toThrow(PersonalCompileError);
      await expect(run, name).rejects.toThrow(message);
    }
  });

  it("treats a symlink out of the extension as the same escape, and names the importing file inside a subdirectory", async () => {
    const { root, cache } = workspace({
      "bad/panel.tsx": 'import { y } from "./lib/inner"; export default () => y;',
      "bad/lib/inner.ts": 'import { x } from "./linked"; export const y = x;',
      "elsewhere/leak.ts": "export const x = 1;",
    });
    symlinkSync(join(root, "elsewhere", "leak.ts"), join(root, "bad", "lib", "linked.ts"));
    const run = compilePersonalModule({
      extensionId: "bad",
      extensionDir: join(root, "bad"),
      kind: "panel",
      cacheRoot: cache,
    });
    await expect(run).rejects.toThrow('bad/lib/inner.ts imports "./linked", which leaves bad/');
    await expect(run).rejects.toMatchObject({ extensionId: "bad", file: "bad/lib/inner.ts" });
  });
});

describe("a panel's card views (docs/ui-plugins.md, \"A panel's cards\")", () => {
  const PANEL = "export default function Panel() { return null; }";
  const VIEW = [
    'import { Badge } from "@firstmate/ui";',
    'import { shared } from "../lib/shared";',
    "export default function Notes() { return <Badge>{shared}</Badge>; }",
  ].join("\n");

  it("compiles every cards/*.tsx with the panel, one graph and one version", async () => {
    const { root, cache } = workspace({
      "notes/panel.tsx": PANEL,
      "notes/cards/notes.tsx": VIEW,
      "notes/cards/weekly-review.tsx": PANEL,
      "notes/cards/helpers.ts": "export const helper = 1;",
      "notes/lib/shared.ts": 'export const shared = "shared";',
    });
    const compiled = await compilePersonalModule({
      extensionId: "notes",
      extensionDir: join(root, "notes"),
      kind: "panel",
      cacheRoot: cache,
    });
    expect(compiled.views).toEqual(["notes", "weekly-review"]);
    const view = readFileSync(join(compiled.outputDir, "cards", "notes.mjs"), "utf8");
    expect(view).toContain('import { shared } from "../lib/shared.mjs";');
    expect(view).toMatch(/app-plugin:\/\/host\/ui\.mjs/);
    expect(readFileSync(join(compiled.outputDir, "cards", "weekly-review.mjs"), "utf8")).toContain(
      "Panel",
    );
    // A card view is part of the version: editing it is a new one.
    writeFileSync(join(root, "notes/cards/notes.tsx"), `${VIEW}\n// edited`);
    const edited = await compilePersonalModule({
      extensionId: "notes",
      extensionDir: join(root, "notes"),
      kind: "panel",
      cacheRoot: cache,
    });
    expect(edited.hash).not.toBe(compiled.hash);
  });

  it("keeps a panel without cards at the version it always had", async () => {
    const { root, cache } = workspace({ "plain/panel.tsx": PANEL });
    const compiled = await compilePersonalModule({
      extensionId: "plain",
      extensionDir: join(root, "plain"),
      kind: "panel",
      cacheRoot: cache,
    });
    expect(compiled.views).toEqual([]);
    mkdirSync(join(root, "plain", "cards"));
    const again = await compilePersonalModule({
      extensionId: "plain",
      extensionDir: join(root, "plain"),
      kind: "panel",
      cacheRoot: cache,
    });
    expect(again.hash).toBe(compiled.hash);
  });

  it("refuses a card view whose name is not kebab-case, naming its file", async () => {
    const { root, cache } = workspace({
      "notes/panel.tsx": PANEL,
      "notes/cards/Notes.tsx": PANEL,
    });
    await expect(
      compilePersonalModule({
        extensionId: "notes",
        extensionDir: join(root, "notes"),
        kind: "panel",
        cacheRoot: cache,
      }),
    ).rejects.toThrow("notes/cards/Notes.tsx: a card view's file name is kebab-case");
  });

  it("refuses a card view's import the allowlist does not admit, as it refuses a panel's", async () => {
    const { root, cache } = workspace({
      "notes/panel.tsx": PANEL,
      "notes/cards/notes.tsx": 'import x from "lodash";\nexport default () => x;',
    });
    await expect(
      compilePersonalModule({
        extensionId: "notes",
        extensionDir: join(root, "notes"),
        kind: "panel",
        cacheRoot: cache,
      }),
    ).rejects.toBeInstanceOf(PersonalCompileError);
  });
});

describe("a panel's own stylesheet (docs/ui-plugins.md, \"A panel's cards\", piece 6)", () => {
  it("admits a local .css as text, a module of the graph that imports nothing, hashed with the rest", async () => {
    const css = ".board { color: var(--fg-1); }\n";
    const { root, cache } = workspace({
      "board/panel.tsx": [
        'import styles from "./board.css";',
        "export default function Panel() {",
        "  return <style>{styles}</style>;",
        "}",
      ].join("\n"),
      "board/board.css": css,
      "board/board.tsx": "export const x = 1;",
    });
    const compiled = await compilePersonalModule({
      extensionId: "board",
      extensionDir: join(root, "board"),
      kind: "panel",
      cacheRoot: cache,
    });
    const panel = readFileSync(compiled.entryPath, "utf8");
    expect(panel).toContain('import styles from "./board.css.mjs";');
    const sheet = join(compiled.outputDir, "board.css.mjs");
    expect(readFileSync(sheet, "utf8")).toBe(`export default ${JSON.stringify(css)};\n`);
    expect((await import(pathToFileURL(sheet).href)).default).toBe(css);
    // An edit to the stylesheet is a new version.
    writeFileSync(join(root, "board/board.css"), ".board { color: var(--fg-2); }\n");
    const edited = await compilePersonalModule({
      extensionId: "board",
      extensionDir: join(root, "board"),
      kind: "panel",
      cacheRoot: cache,
    });
    expect(edited.hash).not.toBe(compiled.hash);
  });

  it("refuses a stylesheet imported without a name, and one in server code", async () => {
    const { root, cache } = workspace({
      "named/panel.tsx": 'import { a } from "./a.css";\nexport default () => a;',
      "named/a.css": ".a {}",
      "bare/panel.tsx": 'import "./a.css";\nexport default () => null;',
      "bare/a.css": ".a {}",
      "srv/server.ts": 'import sheet from "./a.css";\nexport const actions = { a: () => sheet };',
      "srv/a.css": ".a {}",
    });
    for (const id of ["named", "bare"]) {
      await expect(
        compilePersonalModule({
          extensionId: id,
          extensionDir: join(root, id),
          kind: "panel",
          cacheRoot: cache,
        }),
      ).rejects.toThrow('a stylesheet is text: import styles from "./a.css"');
    }
    await expect(
      compilePersonalModule({
        extensionId: "srv",
        extensionDir: join(root, "srv"),
        kind: "server",
        cacheRoot: cache,
      }),
    ).rejects.toThrow("a stylesheet belongs to the panel, not server code");
  });
});
