import { appendFileSync } from "node:fs";
import { settingFrom } from "@shared/envSettings";

/**
 * Opening the window beside a first mate a command started, stood in for a
 * development or test run that names a file (`INFINITARY_OPEN_WINDOW_STAND_IN`):
 * where a Mac's run asks macOS to open the installed app, this notes each ask
 * in that file, and the journey opens the window as macOS would
 * (tests/e2e/home-update.spec.ts). A packaged build always asks macOS.
 */
export function openWindowStandIn(
  env: Readonly<Record<string, string | undefined>>,
  packaged: boolean,
): (() => void) | undefined {
  if (packaged) return undefined;
  const file = settingFrom(env, "OPEN_WINDOW_STAND_IN")?.trim();
  if (!file) return undefined;
  return () => appendFileSync(file, "open\n");
}
