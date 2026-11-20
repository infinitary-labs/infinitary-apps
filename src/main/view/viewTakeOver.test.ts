import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { type FSWatcher, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STANDBY_DIR } from "@core/standby/keeper";
import { type FolderWatch, readTakeOverAsk, TakeOverHere } from "@core/standby/takeOver";
import { TAKE_OVER_WORDS } from "@core/standby/words";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import {
  createWindowsFreshAuthentication,
  HELLO_AVAILABILITY,
} from "../host/windowsFreshAuthentication";
import {
  VIEW_TAKE_OVER_WORDS,
  VIEW_TAKE_OVER_WORDS_WINDOWS,
  ViewTakeOver,
  viewTakeOverWords,
} from "./viewTakeOver";

// A folder watch that misses every change, as the system's watch may.
const missesEveryChange: FolderWatch = () => {
  const watcher = new EventEmitter() as FSWatcher;
  watcher.close = () => {};
  return watcher;
};

/**
 * The window's Take over click (docs/devices.md, "Taking over"): a Mac
 * whose work keeps a whole copy and heard what taking over needs, with its
 * Touch ID confirming, and its work never answering the ask.
 */

const views: { dispose: () => void }[] = [];
afterEach(() => {
  for (const each of views.splice(0)) each.dispose();
});

/** A work folder as the work's copy leaves it: a whole copy, and what the home last said. */
function keptCopy(): string {
  const workDir = scratchDir("infinitary-view-take-over-");
  const stream = randomUUID();
  mkdirSync(join(workDir, STANDBY_DIR, "copy"), { recursive: true });
  writeFileSync(
    join(workDir, STANDBY_DIR, "state.json"),
    JSON.stringify({ version: 1, stream, seq: 12, at: 1_700_000_000_000 }),
  );
  writeFileSync(
    join(workDir, STANDBY_DIR, "home.json"),
    JSON.stringify({
      name: "MacBook Pro",
      from: {
        userData: "/Users/someone/Library/Application Support/infinitary",
        homeDir: "/Users/someone",
      },
      projects: [],
      homeNumber: 1,
      stream,
      seq: 12,
      at: 1_700_000_000_000,
      copies: [],
    }),
  );
  return workDir;
}

describe("the window's Take over", () => {
  it("ends the click's wait when the window stops waiting, with no answer from the work", async () => {
    const workDir = keptCopy();
    const view = new ViewTakeOver({
      workDir,
      deviceId: "studio",
      authentication: () => ({ available: async () => true, confirm: async () => true }),
      started: () => {},
      changed: () => {},
    });
    views.push(view);
    const click = view.takeOver("lost", "MacBook Pro");
    await vi.waitFor(() => expect(readTakeOverAsk(workDir)).not.toBeNull());
    view.dispose();
    await expect(click).resolves.toEqual({
      ok: false,
      text: VIEW_TAKE_OVER_WORDS.stoppedWaiting,
    });
  });

  it("the work takes up the ask, and the window hears its answer, when the folder's watch reports neither", async () => {
    const workDir = keptCopy();
    // The home still answers this Mac's work, so the work refuses at once.
    const work = new TakeOverHere({
      workDir,
      own: async () => ({ deviceId: "studio", name: "Mac Studio" }),
      homeNumber: () => 1,
      inReach: () => true,
      arrive: async () => ({ addresses: [] }),
      filesOf: (move) => join(scratchDir("infinitary-view-take-over-files-"), move),
      started: () => {},
      log: () => {},
      watch: missesEveryChange,
      lookMs: 10,
    });
    views.push(work);
    work.start();
    const view = new ViewTakeOver({
      workDir,
      deviceId: "studio",
      authentication: () => ({ available: async () => true, confirm: async () => true }),
      started: () => {},
      changed: () => {},
      watch: missesEveryChange,
      lookMs: 10,
    });
    views.push(view);
    await expect(view.takeOver("lost", "MacBook Pro")).resolves.toEqual({
      ok: false,
      text: TAKE_OVER_WORDS.homeInReach("MacBook Pro"),
    });
  });
});

/**
 * Take over on a Windows PC that keeps a copy (INF-4260's plan, piece 11),
 * from the captain's answer: "With Windows Hello on that PC, or your Windows
 * password when Hello is off." The PC's own confirmation, with Windows'
 * calls stood in: no test asks the real Windows Hello or password.
 */
describe("the window's Take over on a Windows PC", () => {
  function windows(answers: { hello: number; verified: boolean; password: boolean }) {
    const asked: string[] = [];
    const authentication = createWindowsFreshAuthentication(
      {},
      {
        helloAvailability: async () => answers.hello,
        helloVerify: async (reason) => {
          asked.push(`hello: ${reason}`);
          return answers.verified ? 0 : 3;
        },
        passwordConfirm: async (reason) => {
          asked.push(`password: ${reason}`);
          return answers.password;
        },
      },
    );
    return { asked, authentication };
  }

  it("confirms with Windows Hello where it is set up, then asks the PC's work", async () => {
    const workDir = keptCopy();
    const { asked, authentication } = windows({
      hello: HELLO_AVAILABILITY.available,
      verified: true,
      password: false,
    });
    const view = new ViewTakeOver({
      workDir,
      deviceId: "pc",
      authentication: () => authentication,
      words: viewTakeOverWords("win32"),
      started: () => {},
      changed: () => {},
    });
    views.push(view);
    const click = view.takeOver("lost", "MacBook Pro");
    await vi.waitFor(() => expect(readTakeOverAsk(workDir)).not.toBeNull());
    expect(asked).toEqual([`hello: ${VIEW_TAKE_OVER_WORDS_WINDOWS.reason("MacBook Pro")}`]);
    view.dispose();
    await click;
  });

  it("asks the Windows password where Hello is off, and takes nothing over when it is not given", async () => {
    const workDir = keptCopy();
    const { asked, authentication } = windows({
      hello: HELLO_AVAILABILITY.notConfiguredForUser,
      verified: false,
      password: false,
    });
    const view = new ViewTakeOver({
      workDir,
      deviceId: "pc",
      authentication: () => authentication,
      words: viewTakeOverWords("win32"),
      started: () => {},
      changed: () => {},
    });
    views.push(view);
    await expect(view.takeOver("lost", "MacBook Pro")).resolves.toEqual({
      ok: false,
      text: VIEW_TAKE_OVER_WORDS_WINDOWS.notConfirmed,
    });
    expect(asked).toEqual([`password: ${VIEW_TAKE_OVER_WORDS_WINDOWS.reason("MacBook Pro")}`]);
    expect(readTakeOverAsk(workDir)).toBeNull();
  });

  it("says in the PC's own words that it cannot confirm, where it has no way to", async () => {
    const view = new ViewTakeOver({
      workDir: keptCopy(),
      deviceId: "pc",
      authentication: () => undefined,
      words: viewTakeOverWords("win32"),
      started: () => {},
      changed: () => {},
    });
    views.push(view);
    await expect(view.takeOver("lost", "MacBook Pro")).resolves.toEqual({
      ok: false,
      text: VIEW_TAKE_OVER_WORDS_WINDOWS.noConfirm,
    });
  });
});
