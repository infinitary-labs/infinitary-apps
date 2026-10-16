// Renders the top-bar icon a desktop without a Dock shows while Firstmate
// runs with its window closed (design skill readme, "Linux desktop
// conventions"): the app icon's mark from the skill's app-icon.svg - the
// outer ring, the inner ring turned 30 degrees and the centre dot - without
// its background or rounded body, drawn heavier so it reads at a top bar's
// 16 to 24 pixels. Writes src/main/assets/trayIcon.png (64x64), which the
// main bundle carries (src/main/trayIcon.ts). Regenerate after any change
// to the skill's icon:
//   pnpm exec electron scripts/render-tray-icon.mjs
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow } from "electron";

const SIZE = 64;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const svgPath = join(root, ".claude", "skills", "infinitary-design", "assets", "app-icon.svg");
const outPath = join(root, "src", "main", "assets", "trayIcon.png");

app.whenReady().then(async () => {
  const source = readFileSync(svgPath, "utf8");
  // The mark alone: its lines and dots, with the background and glow left out.
  const mark = [...source.matchAll(/<(line|circle)\b[^>]*>(?:<\/\1>)?/g)]
    .map(([element]) => element)
    .filter((element) => !element.includes("url(#"))
    .join("")
    .replace(/stroke-width="11"/g, 'stroke-width="44"')
    .replace(/stroke-width="6"/g, 'stroke-width="30"')
    .replace(/stroke-opacity="0.55"/g, 'stroke-opacity="0.85"')
    .replace(/ r="16"/g, ' r="40"')
    .replace(/ r="9"/g, ' r="24"')
    .replace(/ r="12"/g, ' r="48"');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" style="display:block" viewBox="112 112 800 800"><g stroke-linecap="round">${mark}</g></svg>`;
  const win = new BrowserWindow({
    show: false,
    width: SIZE,
    height: SIZE,
    transparent: true,
    backgroundColor: "#00000000",
    webPreferences: { offscreen: true },
  });
  const html = `<!doctype html><html style="overflow:hidden;background:transparent"><body style="margin:0;overflow:hidden;background:transparent">${svg}</body></html>`;
  await win.loadURL(`data:text/html;base64,${Buffer.from(html).toString("base64")}`);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE });
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, image.resize({ width: SIZE, height: SIZE }).toPNG());
  console.log(`wrote ${outPath} (${SIZE}x${SIZE})`);
  app.exit(0);
});
