import { existsSync, rmSync } from "node:fs";
import { scratchDir } from "../../helpers/scratchDirs";
import { leaveProgram } from "./program";

// An unrelated daemon is still a leak when a runner owns a real browser.
export default async function setup(): Promise<() => void> {
  // Vitest initializes both the parent project and its Chromium instance.
  // The pid file is this fixture run's receipt, so only one starts daemons.
  if (
    !process.env.INFINITARY_FIXTURE_PROGRAM ||
    existsSync(process.env.INFINITARY_FIXTURE_PID ?? "")
  )
    return () => {};
  const folder = scratchDir("infinitary-browser-unowned-");
  await leaveProgram(folder);
  return () => rmSync(folder, { recursive: true, force: true });
}
