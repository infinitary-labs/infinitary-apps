// Builds packaging/build/icon.ico, the Windows installer's and program's
// icon, from packaging/build/icon.png: each size is resized with macOS's sips
// and stored as PNG data, which Windows reads in an .ico (macOS only).
// electron-builder passes an .ico through unchanged; given the png, it runs
// a downloaded icon tool in a Node process of its own on the Windows build
// machine instead. render-app-icon.mjs runs this after it renders the png; to
// rebuild the ico alone:
//   node scripts/render-app-ico.mjs
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pngPath = join(root, "packaging", "build", "icon.png");
const icoPath = join(root, "packaging", "build", "icon.ico");

// The sizes Windows asks an app's icon for: Explorer's lists and tiles, the
// taskbar, the Start menu and the installer, at each display scale.
const SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];

/** An .ico holding each picture as PNG data, smallest first (the ICO file format). */
export function icoOf(pictures) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pictures.length, 4);
  const entries = [];
  let offset = 6 + 16 * pictures.length;
  for (const { size, png } of pictures) {
    const entry = Buffer.alloc(16);
    // 256 is written as 0: the field is one byte.
    entry.writeUInt8(size % 256, 0);
    entry.writeUInt8(size % 256, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += png.length;
  }
  return Buffer.concat([header, ...entries, ...pictures.map((picture) => picture.png)]);
}

export function renderAppIco() {
  const work = mkdtempSync(join(tmpdir(), "infinitary-ico-"));
  try {
    const pictures = SIZES.map((size) => {
      const out = join(work, `${size}.png`);
      execFileSync("sips", ["-z", String(size), String(size), pngPath, "--out", out], { stdio: "ignore" });
      return { size, png: readFileSync(out) };
    });
    writeFileSync(icoPath, icoOf(pictures));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  console.log(`wrote ${icoPath}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) renderAppIco();
