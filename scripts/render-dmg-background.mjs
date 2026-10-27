// Render the installer's committed artwork with the design system, in an isolated hidden window.
// Run Electron with a scratch HOME and --user-data-dir; this script never signs or packages an app.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow } from "electron";

if (!app.commandLine.getSwitchValue("user-data-dir")) throw new Error("A scratch --user-data-dir is required");
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const design = join(root, ".claude/skills/infinitary-design");
app.whenReady().then(async () => {
const window = new BrowserWindow({ show: false, width: 600, height: 360, webPreferences: { offscreen: true, sandbox: true } });
try {
  const font = readFileSync(join(design, "assets/fonts/spacegrotesk-latin.woff2")).toString("base64");
  const colors = readFileSync(join(design, "tokens/colors.css"), "utf8");
  const svg = readFileSync(join(root, "packaging/build/dmg-background.svg"), "utf8");
  const html = `<html data-theme="light"><style>${colors}@font-face{font-family:'Space Grotesk';src:url(data:font/woff2;base64,${font}) format('woff2');font-weight:300 700}body{margin:0;overflow:hidden}svg{display:block}</style><body>${svg}</body></html>`;
  await window.loadURL(`data:text/html;base64,${Buffer.from(html).toString("base64")}`);
  await window.webContents.executeJavaScript("document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))");
  const image = await window.webContents.capturePage({ x: 0, y: 0, width: 600, height: 360 });
  writeFileSync(join(root, "packaging/build/dmg-background.png"), image.resize({ width: 600, height: 360 }).toPNG());
} finally { window.destroy(); app.quit(); }

}).catch((error) => { console.error(error); app.exit(1); });
