import { readFileSync, writeFileSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { build, transformWithEsbuild } from "vite";
import { staleGeneratedFile } from "./github-errors.ts";

// A card part a runbook ships is copied into a card body, whose size is capped. Its code - the
// readable sources under src/core/runbooks/parts/, minified here - is the app's own part
// (src/shared/appParts.generated.json), which every reader puts in place of the part's reference
// (docs/card-authoring.md, "Parts by reference"), so the part a crewmate copies holds only its
// markup, its data block and that reference.
// Its page is the whole part, code included, in a document with the app's colors, which a
// card's frame gives it, so a crewmate can open it in a browser and photograph it for a pull
// request.
const parts = [
  {
    source: "map",
    output: "../resources/runbooks/architecture/skills/advanced-architecture/parts/map.html",
    page: "../resources/runbooks/architecture/skills/advanced-architecture/parts/map-page.html",
    // The script is one closure, so its owners are fragments of it, joined in this order with nothing
    // between: map.js (the model, a comparison, views), then layout, draw (drawing and its words) and
    // input (the camera and the input), each a file beside it named <source>.<fragment>.js.
    fragments: ["layout", "draw", "input"],
  },
];
const TOKENS = ["colors", "effects", "spacing", "typography"];
// A card's raised surface; the map takes the page's width, so its picture is legible at a pull
// request's width.
const PAGE_STYLE = "body{margin:0;padding:24px;background:var(--bg-2);color:var(--fg-2)}";

const minified = async (text: string, name: string, loader: "css" | "js") =>
  (await transformWithEsbuild(text, name, { loader, minify: true, target: "es2022", charset: "utf8" })).code.trim();

const APP_PARTS = "../src/shared/appParts.generated.json";

const outputs: [string, string][] = [];
const appParts: Record<string, { style: string; script: string }> = {};
for (const part of parts) {
  const from = (extension: string) =>
    readFileSync(new URL(`../src/core/runbooks/parts/${part.source}.${extension}`, import.meta.url), "utf8");
  const css = await minified(from("css"), `${part.source}.css`, "css");
  const source = [from("js"), ...part.fragments.map((name) => from(`${name}.js`))].join("");
  const js = await minified(source, `${part.source}.js`, "js");
  if (/<\/(script|style)|<!--|-->/i.test(js + css))
    throw new Error(`${part.source}: a closing tag or a comment mark inside the minified part.`);
  const template = from("html");
  for (const slot of ["<style data-source></style>", "<script data-source></script>"]) {
    if (template.split(slot).length !== 2) throw new Error(`${part.source}.html needs one ${slot}.`);
  }
  const text = template
    .replace("<style data-source></style>", () => `<style>${css}</style>`)
    .replace("<script data-source></script>", () => `<script>${js}</script>`);
  outputs.push([
    part.output,
    template
      .replace("<style data-source></style>\n", "")
      .replace("<script data-source></script>", () => `<script data-inf-part="${part.source}"></script>`),
  ]);
  appParts[part.source] = { style: css, script: js };
  const tokens = await minified(
    TOKENS.map((name) =>
      readFileSync(new URL(`../src/renderer/src/design/tokens/${name}.css`, import.meta.url), "utf8"),
    ).join("\n"),
    "tokens.css",
    "css",
  );
  outputs.push([
    part.page,
    `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>${part.source}</title>\n<style>${tokens}${PAGE_STYLE}</style>\n</head>\n<body>\n${text}</body>\n</html>\n`,
  ]);
}

// The app's own parts, which no runbook ships and only the app's own cards name
// (`APP_ONLY_PARTS`, src/shared/appParts.ts): each is bundled from its entry with
// what it imports, so a part such as the stage draws with the app's own code.
const appOnlyParts = [
  {
    name: "stage",
    entry: "../src/renderer/src/character/stage/cardStagePart.ts",
    style: "../src/renderer/src/character/stage/cardStage.css",
  },
];
for (const part of appOnlyParts) {
  const result = await build({
    configFile: false,
    logLevel: "error",
    resolve: { alias: { "@shared": fileURLToPath(new URL("../src/shared", import.meta.url)) } },
    build: {
      write: false,
      minify: true,
      target: "es2022",
      lib: { entry: fileURLToPath(new URL(part.entry, import.meta.url)), name: "InfinitaryPart", formats: ["iife"] },
    },
  });
  const chunk = Array.isArray(result) ? result[0]?.output[0] : undefined;
  if (chunk?.type !== "chunk") throw new Error(`${part.name}: the bundle produced no script.`);
  const js = chunk.code.trim();
  const css = await minified(readFileSync(new URL(part.style, import.meta.url), "utf8"), `${part.name}.css`, "css");
  if (/<\/(script|style)|<!--|-->/i.test(js + css))
    throw new Error(`${part.name}: a closing tag or a comment mark inside the bundled part.`);
  appParts[part.name] = { style: css, script: js };
}

outputs.push([APP_PARTS, `${JSON.stringify(appParts, null, 2)}\n`]);

for (const [path, text] of outputs) {
  const output = fileURLToPath(new URL(path, import.meta.url));
  if (process.argv.includes("--check")) {
    if (readFileSync(output, "utf8") !== text) throw staleGeneratedFile(relative(fileURLToPath(new URL("..", import.meta.url)), output), "node scripts/generate-runbook-parts.ts");
  } else writeFileSync(output, text);
}
