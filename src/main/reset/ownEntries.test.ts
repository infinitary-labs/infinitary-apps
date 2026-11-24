import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { loginAgentFile, sessionAgentFile } from "@core/helper/runAgent";
import { runLabelOf } from "@shared/codeNames";
import { afterEach, describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { bootEntryOff, forgetOwnRunEntries } from "./ownEntries";

// The review of a reset asked of a first mate with no window (docs/reset.md,
// "A first mate with no window"; the captain's answer command_home=finish):
// turning its own start-at-boot entry off through the service manager ended
// the run before its reset mark was written.

async function asked(inRun: boolean, platform: NodeJS.Platform): Promise<string[]> {
  const done: string[] = [];
  await bootEntryOff(
    { inRun, platform },
    {
      forget: () => {
        done.push("forget");
      },
      off: async () => {
        done.push("off");
      },
    },
  );
  return done;
}

describe("turning a reset's own start-at-boot entry off", () => {
  it("leaves a run on a Mac or Linux going, its entry's files taken away", async () => {
    expect(await asked(true, "darwin")).toEqual(["forget"]);
    expect(await asked(true, "linux")).toEqual(["forget"]);
  });

  it("turns the entry off through the system for a run on Windows and for any window", async () => {
    expect(await asked(true, "win32")).toEqual(["off"]);
    for (const platform of ["darwin", "linux", "win32"] as const)
      expect(await asked(false, platform)).toEqual(["off"]);
  });
});

describe("a run ending for good takes away what would start it again", () => {
  const home = process.env.HOME;
  afterEach(() => {
    process.env.HOME = home;
  });

  function entries() {
    const homeDir = scratchDir("inf-own-entries-home-");
    process.env.HOME = homeDir;
    const dataDir = scratchDir("inf-own-entries-data-");
    const login = loginAgentFile({ homeDir, label: runLabelOf("dev") });
    const session = sessionAgentFile({ dataDir });
    for (const file of [login, session]) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, "<plist/>");
    }
    return { dataDir, login, session };
  }

  it("on the person's own folder, its start-at-boot entry in the home folder and its agent in the folder", () => {
    const { dataDir, login, session } = entries();
    forgetOwnRunEntries("dev", dataDir, true);
    expect([existsSync(login), existsSync(session)]).toEqual([false, false]);
  });

  it("on a chosen or isolated folder, only its agent in the folder: the home folder's entry starts the person's own", () => {
    const { dataDir, login, session } = entries();
    forgetOwnRunEntries("dev", dataDir, false);
    expect([existsSync(login), existsSync(session)]).toEqual([true, false]);
  });
});
