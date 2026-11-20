import { readdirSync, readlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { settingFrom } from "@shared/envSettings";
import { app } from "electron";
import { hostPlatform } from "../../core/platform";

/**
 * The kernel drivers of the graphics cards the speech library's Linux build
 * runs Whisper on, through Vulkan: Intel's, AMD's and NVIDIA's on an x64
 * desktop (docs/architecture.md section 8, "Where speech runs"). A virtual
 * or display-only device is none of them, and neither is a processor
 * standing in for a card, which would take minutes over a sentence.
 */
const LINUX_GRAPHICS_DRIVERS = new Set(["i915", "xe", "amdgpu", "nvidia", "nouveau"]);

/**
 * Whether a Linux computer has a graphics card for speech: a render node the
 * kernel made for one of those cards (`/sys/class/drm/renderD*`, whose
 * device names its driver).
 */
export function linuxGraphicsCard(sysfs = "/sys"): boolean {
  const drm = join(sysfs, "class", "drm");
  let nodes: string[];
  try {
    nodes = readdirSync(drm).filter((entry) => entry.startsWith("renderD"));
  } catch {
    return false;
  }
  return nodes.some((node) => {
    try {
      return LINUX_GRAPHICS_DRIVERS.has(
        basename(readlinkSync(join(drm, node, "device", "driver"))),
      );
    } catch {
      return false;
    }
  });
}

/**
 * Whether this computer has a graphics card its speech library can run on.
 * Every Mac has one (Metal), and Linux reads the kernel's render nodes; a
 * system with no check of its own yet, such as Windows, leaves it to what its
 * library lists. A development or end-to-end run stands in the answer with
 * INFINITARY_GRAPHICS_CARD (`present` or `absent`), as it does the microphone's.
 */
export function hasGraphicsCard(platform: string = hostPlatform()): boolean {
  if (!app.isPackaged) {
    const standIn = settingFrom(process.env, "GRAPHICS_CARD")?.trim();
    if (standIn === "present" || standIn === "absent") return standIn === "present";
  }
  return platform === "linux" ? linuxGraphicsCard() : true;
}
