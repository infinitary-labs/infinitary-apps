import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { plantProgram, writeLoginShellStub } from "../../src/core/loginShellStub";
import { scratchDir } from "../helpers/scratchDirs";
import { type LaunchedApp, launchApp } from "./launch";
import { SPAWN_PROMPT_MARKER } from "./mockProvider";
import { promptInput } from "./prompt";
import { reportLine, taskKey } from "./rails";
import {
  MOCK_NODE_REPORT_PREFIX,
  NODE_VERSION_PROMPT_MARKER,
  nodeVersion,
} from "./scenarios/nodeVersion";

/**
 * An app opened from the Dock or Finder inherits launchd's search path -
 * only the system folders - while the person's node, pnpm and gh live
 * where their shell's startup files say (nvm's, in .zshrc). Before the
 * host search path (src/core/hostEnv.ts) every crewmate shell and every
 * dependency install on such a launch failed to find them: nine crew
 * reports of "no node, pnpm or gh" and 20 of 21 installs failing.
 *
 * This launches the app the way the Dock does - PATH pinned to the system
 * folders - with the person's login shell standing in as `$SHELL`, whose
 * interactive startup file puts an nvm-shaped node on the path, and asks
 * the Firstmate for work whose crewmate runs `node --version`. The answer
 * the captain reads in the feed is that node's.
 */

const SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const PLANTED_VERSION = "v99.0.0-login-path";

let launched: LaunchedApp;

test.beforeAll(async () => {
  const shellDir = scratchDir("infinitary-login-shell-");
  // The stand-in reads the person's interactive startup file the way zsh
  // reads ~/.zshrc for `-ilc`, and nothing for a plain login shell.
  const { shell } = writeLoginShellStub(shellDir, {
    interactive: '[ -f "$HOME/.zshrc" ] && . "$HOME/.zshrc"',
  });
  launched = await launchApp({
    withMockProvider: true,
    scenarios: [nodeVersion],
    prepareHome: (home) => {
      const nvmBin = join(home, ".nvm", "versions", "node", "v99.0.0", "bin");
      plantProgram(nvmBin, "node", PLANTED_VERSION);
      writeFileSync(
        join(home, ".zshrc"),
        `echo "Welcome back"\nexport NVM_DIR="$HOME/.nvm"\nPATH="${nvmBin}:$PATH"\n`,
      );
    },
    env: { PATH: SYSTEM_PATH, SHELL: shell },
  });
});

test.afterAll(async () => {
  await launched.close();
});

test("a crewmate's shell on a Dock-launched app finds the node the person's shell sets up", async () => {
  const { page } = launched;
  const input = promptInput(page);
  await input.click();
  await input.fill(`${SPAWN_PROMPT_MARKER} ${NODE_VERSION_PROMPT_MARKER}`);
  await input.press("Enter");

  await expect(
    reportLine(page, await taskKey(page, NODE_VERSION_PROMPT_MARKER)).filter({
      hasText: `${MOCK_NODE_REPORT_PREFIX} ${PLANTED_VERSION}`,
    }),
  ).toBeVisible({ timeout: 45_000 });
});
