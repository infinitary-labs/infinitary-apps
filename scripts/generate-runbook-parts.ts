import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { transformWithEsbuild } from "vite";

// A card part a runbook ships is copied whole into a card body, whose size is capped, so the
// readable sources under src/core/runbooks/parts/ are minified into the served part here.
// Its page is the same part in a document with the app's colors, which a card's frame gives
// it, so a crewmate can open it in a browser and photograph it for a pull request.
const parts = [
  {
    source: "map",
    output: "../resources/runbooks/architecture/skills/advanced-architecture/parts/map.html",
    page: "../resources/runbooks/architecture/skills/advanced-architecture/parts/map-page.html",
  },
];
const TOKENS = ["colors", "effects", "spacing", "typography"];
// A card's raised surface; the map takes the page's width, so its picture is legible at a pull
// request's width.
const PAGE_STYLE = "body{margin:0;padding:24px;background:var(--bg-2);color:var(--fg-2)}";

const minified = async (text: string, name: string, loader: "css" | "js") =>
  (await transformWithEsbuild(text, name, { loader, minify: true, target: "es2022" })).code.trim();

const outputs: [string, string][] = [];
for (const part of parts) {
  const from = (extension: string) =>
    readFileSync(new URL(`../src/core/runbooks/parts/${part.source}.${extension}`, import.meta.url), "utf8");
  const css = await minified(from("css"), `${part.source}.css`, "css");
  const js = await minified(from("js"), `${part.source}.js`, "js");
  if (/<\/(script|style)/i.test(js + css)) throw new Error(`${part.source}: a closing tag inside the minified part.`);
  const template = from("html");
  for (const slot of ["<style data-source></style>", "<script data-source></script>"]) {
    if (template.split(slot).length !== 2) throw new Error(`${part.source}.html needs one ${slot}.`);
  }
  const text = template
    .replace("<style data-source></style>", () => `<style>${css}</style>`)
    .replace("<script data-source></script>", () => `<script>${js}</script>`);
  outputs.push([part.output, text]);
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

for (const [path, text] of outputs) {
  const output = fileURLToPath(new URL(path, import.meta.url));
  if (process.argv.includes("--check")) {
    if (readFileSync(output, "utf8") !== text) throw new Error("Run node scripts/generate-runbook-parts.ts to refresh the runbook parts.");
  } else writeFileSync(output, text);
}
