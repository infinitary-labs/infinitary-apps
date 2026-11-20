// Renders the design skill's app-icon.svg to packaging/build/icon.png
// (1024x1024), the Linux icon, and on macOS rebuilds packaging/build/icon.icns,
// the Mac icon, and packaging/build/icon.ico, the Windows icon, from it
// (render-app-icns.mjs, render-app-ico.mjs).
// macOS 12–15 draw that icns as supplied: bake in the rounded body and
// 100px transparent margin instead of depending on macOS 26's system mask.
// Regenerate after any change to the skill's icon:
//   pnpm exec electron scripts/render-app-icon.mjs
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow } from "electron";
import { renderAppIco } from "./render-app-ico.mjs";
import { renderAppIcns } from "./render-app-icns.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const svgPath = join(root, ".claude", "skills", "infinitary-design", "assets", "app-icon.svg");
const outPath = join(root, "packaging", "build", "icon.png");

app.whenReady().then(async () => {
  const svg = readFileSync(svgPath, "utf8");
  const win = new BrowserWindow({
    show: false,
    width: 1024,
    height: 1024,
    transparent: true,
    backgroundColor: "#00000000",
    webPreferences: { offscreen: true },
  });
  const shaped = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" style="display:block" viewBox="0 0 1024 1024">
    <defs><clipPath id="mac-body"><rect x="100" y="100" width="824" height="824" rx="185"/></clipPath></defs>
    <g clip-path="url(#mac-body)">${svg.replace(/<svg /, '<svg x="100" y="100" width="824" height="824" ')}</g>
  </svg>`;
  const html = `<!doctype html><html style="overflow:hidden;background:transparent"><body style="margin:0;overflow:hidden;background:transparent">${shaped}</body></html>`;
  await win.loadURL(`data:text/html;base64,${Buffer.from(html).toString("base64")}`);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, image.toPNG());
  console.log(`wrote ${outPath} (${image.getSize().width}x${image.getSize().height})`);
  if (process.platform === "darwin") {
    renderAppIcns();
    renderAppIco();
  }
  app.exit(0);
});
