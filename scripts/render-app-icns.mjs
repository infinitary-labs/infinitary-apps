// Builds packaging/build/icon.icns, the Mac package's icon, from
// packaging/build/icon.png with Apple's own iconutil (macOS only).
// electron-builder 26.15's icon tool stores PNG data in the 16-64px icp4,
// icp5 and icp6 entries, which macOS's icon service draws as a striped square
// at small sizes on a 1x display (System Settings' Privacy & Security list);
// iconutil writes those sizes as the ARGB entries macOS reads. electron-builder
// passes an .icns through unchanged. render-app-icon.mjs runs this after it
// renders the png; to rebuild the icns alone:
//   node scripts/render-app-icns.mjs
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pngPath = join(root, "packaging", "build", "icon.png");
const icnsPath = join(root, "packaging", "build", "icon.icns");

export function renderAppIcns() {
  const work = mkdtempSync(join(tmpdir(), "infinitary-iconset-"));
  try {
    const iconset = join(work, "icon.iconset");
    mkdirSync(iconset);
    for (const points of [16, 32, 128, 256, 512]) {
      for (const scale of [1, 2]) {
        const name = scale === 1 ? `icon_${points}x${points}.png` : `icon_${points}x${points}@2x.png`;
        const pixels = String(points * scale);
        execFileSync("sips", ["-z", pixels, pixels, pngPath, "--out", join(iconset, name)], { stdio: "ignore" });
      }
    }
    execFileSync("iconutil", ["--convert", "icns", "--output", icnsPath, iconset]);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  console.log(`wrote ${icnsPath}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) renderAppIcns();
