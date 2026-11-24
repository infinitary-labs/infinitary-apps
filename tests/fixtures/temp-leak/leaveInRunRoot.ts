import { mkdtempSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { BrowserCommand } from "vitest/node";

/** A file Chromium made from its temporary-file template and has since unlinked. */
const UNLINKED_CHROMIUM_FILE = /(\/.*\/\.org\.chromium\.Chromium\.\w{6}) \(deleted\)$/;

/**
 * The files Chromium's processes hold open under the run's root after
 * unlinking them, read from /proc on Linux: its shared memory.
 */
function chromiumSharedMemory(root: string): string[] {
  const found = new Set<string>();
  for (const pid of readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
    const held: string[] = [];
    try {
      for (const fd of readdirSync(`/proc/${pid}/fd`))
        held.push(readlinkSync(`/proc/${pid}/fd/${fd}`));
      held.push(...readFileSync(`/proc/${pid}/maps`, "utf8").split("\n"));
    } catch {
      // The process ended, or belongs to someone else.
    }
    for (const name of held) {
      const file = UNLINKED_CHROMIUM_FILE.exec(name)?.[1];
      if (file?.startsWith(`${root}/`)) found.add(file);
    }
  }
  return [...found];
}

/**
 * What the browser fixture leaves in its run's root, when the run asks.
 *
 * INFINITARY_FIXTURE_CHROMIUM names a file that receives Chromium's shared
 * memory files; one more file from Chromium's template is then left beside
 * them, as a Chromium process ending between making and unlinking one leaves
 * it. INFINITARY_FIXTURE_LEAK is the prefix of a folder the test itself
 * leaves behind.
 */
export const leaveInRunRoot: BrowserCommand<[]> = () => {
  const root = tmpdir();
  const record = process.env.INFINITARY_FIXTURE_CHROMIUM;
  if (record) {
    const files = chromiumSharedMemory(root);
    writeFileSync(record, files.map((file) => `${file}\n`).join(""));
    if (files[0]) writeFileSync(join(dirname(files[0]), ".org.chromium.Chromium.LEFTxx"), "");
  }
  const stray = process.env.INFINITARY_FIXTURE_LEAK;
  if (stray) mkdtempSync(join(root, stray));
};

declare module "vitest/browser" {
  interface BrowserCommands {
    leaveInRunRoot(): Promise<void>;
  }
}
