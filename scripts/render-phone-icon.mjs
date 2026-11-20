// INF-80: the captain's existing square asset, flat, opaque and 1024px for iOS.
// Run with HOME=CFFIXED_USER_HOME=INFINITARY_ICON_HOME set to a scratch folder.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import { app, BrowserWindow } from "electron";

const home = process.env.INFINITARY_ICON_HOME;
if (!home || process.env.HOME !== home || process.env.CFFIXED_USER_HOME !== home) {
  throw new Error("Render the phone icon under a scratch HOME and CFFIXED_USER_HOME.");
}
app.setPath("userData", join(home, "icon-renderer"));
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "ios/Infinitary/InfinitaryApp/Assets.xcassets/AppIcon.appiconset/AppIcon.png");

// An opaque RGB PNG, not an RGBA PNG whose alpha happens to be 255: Apple
// refuses an alpha channel on the store icon. NativeImage's bitmap is BGRA.
function rgbPng(image) {
  const bitmap = image.toBitmap();
  const rows = Buffer.alloc(1024 * (1 + 1024 * 3));
  for (let y = 0; y < 1024; y++) {
    for (let x = 0; x < 1024; x++) {
      const input = (y * 1024 + x) * 4;
      if (bitmap[input + 3] !== 255) throw new Error("The square source icon must be fully opaque.");
      const out = y * (1 + 1024 * 3) + 1 + x * 3;
      rows[out] = bitmap[input + 2]; rows[out + 1] = bitmap[input + 1]; rows[out + 2] = bitmap[input];
    }
  }
  const chunk = (kind, data) => {
    const body = Buffer.concat([Buffer.from(kind), data]);
    const size = Buffer.alloc(4); size.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(body));
    return Buffer.concat([size, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1024, 0); header.writeUInt32BE(1024, 4);
  header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

app.whenReady().then(async () => {
  const svg = readFileSync(join(root, ".claude/skills/infinitary-design/assets/app-icon.svg"), "utf8");
  const window = new BrowserWindow({ show: false, width: 1024, height: 1024, webPreferences: { offscreen: true } });
  await window.loadURL(`data:text/html;base64,${Buffer.from(`<html><body style="margin:0;overflow:hidden">${svg}</body></html>`).toString("base64")}`);
  await window.webContents.executeJavaScript("new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))");
  const image = (await window.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 })).resize({ width: 1024, height: 1024 });
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, rgbPng(image));
  console.log("Rendered the existing Infinitary square asset as an opaque 1024px phone icon.");
  app.exit(0);
}).catch((error) => { console.error(error); app.exit(1); });
