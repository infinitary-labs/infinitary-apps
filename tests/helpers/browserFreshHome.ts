import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CARD_PICTURE_HOST } from "@shared/cardPictures";
import { APP_FRAME_SCHEME } from "@shared/csp";
import {
  type CoreInvokeChannel,
  type InvokeResponse,
  invokeContract,
  type PushChannel,
} from "@shared/ipc";
import type { TaskBoard } from "@shared/tasks";
import { DEFAULT_USAGE_QUERY, USAGE_TASK_PAGE } from "@shared/usage";
import type { TestProject } from "vitest/node";
import { absentKeychain } from "../../src/core/host";
import { type Core, startCore } from "../../src/core/index";
import { seedTask } from "../../src/core/tasks/seedTask";
import type { CrewStory, FreshHomeAnswers, StoryPush } from "./browserProvided";

/**
 * The fresh home (docs/testing.md, "The browser layer"): once per run, before
 * any browser test, a real core boots in this Node process on a throwaway
 * data folder, as the app's first launch does, and answers every read the
 * window may send with no arguments. Those answers are what a browser test's
 * fake bridge gives the window by default, so a test draws the window against
 * real readings of a fresh home rather than shapes typed by hand, and a core
 * change that moves an answer reaches the browser tests with no fixture to
 * re-record. After those reads the same core plays the short stories a
 * browser test replays (`CrewStory`), so their readings are real too.
 *
 * A seeded home is the same reading of a home that already holds what a
 * test's story needs - tasks, cards, rules - written through the core's own
 * stores before its core boots (`readHome` with a seed, asked by a page
 * through the `seededHome` command, ./browserCommands.ts).
 */

/** What a read with arguments is asked: its channel and the request the window sends. */
export type HomeRead = [CoreInvokeChannel, unknown[]];

/**
 * What a seeded home holds before its core boots, written on its throwaway
 * data folder through the core's own stores, as a journey seeded its
 * userData before the launch; `input` is what the test passed, the words
 * and numbers its story reads back.
 */
export type HomeSeed = (userDataDir: string, input: never) => void | Promise<void>;

/**
 * The reads with arguments the window sends a fresh home, each with the
 * request it sends: what Usage opens on.
 */
const ASKED: HomeRead[] = [
  ["inf:usage:summary", [DEFAULT_USAGE_QUERY]],
  ["inf:usage:tasks", [{ ...DEFAULT_USAGE_QUERY, limit: USAGE_TASK_PAGE }]],
];

/**
 * The environment the core reads at boot, as the journeys' launcher sets it:
 * no model catalog download, and an update source that answers nothing, so
 * the boot reaches no network.
 */
const OFFLINE: Record<string, string> = {
  PI_OFFLINE: "1",
  INFINITARY_UPDATE_TARGETS_URL: "http://127.0.0.1:9/targets",
  INFINITARY_UPDATE_RELEASES_URL: "http://127.0.0.1:9/releases",
};

/**
 * The environment a boot reads beside `OFFLINE`, as the journeys' launcher
 * gives the app a throwaway HOME and a Claude client of the test's own
 * (tests/e2e/launch.ts): a home folder of its own, `userHome`, so the core
 * reads no Claude login of this computer's (`~/.claude`), and a Claude Code
 * that is not there, which the core takes as no client and never looks past
 * (`resolveClaudeExecutable`). So a home reads the same on a computer with
 * Claude Code as on one without, its Claude chip saying to install it, and
 * no boot runs this computer's own.
 */
function bootEnv(userHome: string): Record<string, string> {
  return {
    ...OFFLINE,
    HOME: userHome,
    INFINITARY_CLAUDE_CLI: join(userHome, "no-claude-code", "claude"),
  };
}

/** The boot under way; one core boots at a time, as it sets the environment it reads. */
let booting: Promise<unknown> = Promise.resolve();

/**
 * Runs `boot` once every boot asked before it has ended, telling `waiting`
 * that it waits in line as it joins and that it no longer does as its turn starts.
 */
function inTurn<T>(boot: () => Promise<T>, waiting?: (inLine: boolean) => void): Promise<T> {
  waiting?.(true);
  const turn = booting.then(() => {
    waiting?.(false);
    return boot();
  });
  booting = turn.catch(() => undefined);
  return turn;
}

/**
 * Holds the boot line for `milliseconds`, as another page's boot holds it,
 * so a test shows a seeded home's wait in line does not count against its
 * limit (tests/browser/load-clock.test.ts). The hold has joined the line when it answers.
 */
export function holdLine(milliseconds: number): void {
  void inTurn(() => new Promise<void>((done) => setTimeout(done, milliseconds)));
}

/**
 * Boots a real core on a throwaway data folder, after `seed` has written
 * `input` to it, and reads every core read that takes no arguments plus `asked`, then
 * stops the core and removes the folder. Its boot waits in line behind every
 * boot asked before it, and `waiting` hears when it joins the line and when its turn starts.
 */
export async function readHome(
  seed?: HomeSeed,
  input?: unknown,
  asked: HomeRead[] = [],
  waiting?: (inLine: boolean) => void,
): Promise<FreshHomeAnswers> {
  const write = seed && ((home: string) => seed(home, input as never));
  const [answers] = await inTurn(() => bootAndRead(write, [...ASKED, ...asked]), waiting);
  return answers;
}

/**
 * Boots a core after `seed`, reads it as `readHome` does, then lets `play`
 * act on the same core before it stops, answering the reads and what `play`
 * gave back.
 */
async function bootAndRead<T>(
  seed: ((userDataDir: string) => void | Promise<void>) | undefined,
  asked: HomeRead[],
  play?: (core: Core) => Promise<T>,
): Promise<[FreshHomeAnswers, T | undefined]> {
  const home = mkdtempSync(join(tmpdir(), "infinitary-fresh-home-"));
  const userHome = mkdtempSync(join(tmpdir(), "infinitary-fresh-user-home-"));
  const env = bootEnv(userHome);
  const saved = Object.fromEntries(Object.keys(env).map((name) => [name, process.env[name]]));
  Object.assign(process.env, env);
  try {
    cpSync(
      join(process.cwd(), "resources/runbooks"),
      join(home, "resources/self-source/resources/runbooks"),
      { recursive: true },
    );
    await seed?.(home);
    const core = await startCore({
      app: {
        version: "9.9.9",
        platform: process.platform,
        packaged: false,
        userDataDir: home,
        appDir: process.cwd(),
        resourcesDir: join(home, "resources"),
      },
      openExternal: async () => {},
      notifications: { supported: () => true, focused: () => false, show: () => {} },
      presence: {
        getStartAtLogin: () => false,
        setStartAtLogin: () => {},
        setShowInDock: () => {},
      },
      voice: { modelReady: async () => false, ensureModel: async () => {} },
      keychain: absentKeychain,
    });
    const answers: FreshHomeAnswers = { plain: {}, asked: {} };
    let played: T | undefined;
    try {
      for (const [channel, entry] of Object.entries(invokeContract)) {
        if (entry.surface !== "core" || entry.effect !== "read") continue;
        // A read that needs arguments has no fresh-home answer; a test gives its own.
        if (!entry.request.safeParse([]).success) continue;
        try {
          answers.plain[channel] = await core.dispatch(channel as CoreInvokeChannel, [] as never);
        } catch {
          // Work-only reads refuse on a computer that runs no work; a test that needs one answers it.
        }
      }
      for (const [channel, request] of asked) {
        const byRequest = answers.asked[channel] ?? {};
        byRequest[JSON.stringify(request)] = await core.dispatch(channel, request as never);
        answers.asked[channel] = byRequest;
      }
      const cards = answers.plain["inf:cards:list"] as InvokeResponse<"inf:cards:list"> | undefined;
      if (cards) answers.plain["inf:cards:list"] = await picturesAsData(core, cards);
      played = await play?.(core);
    } finally {
      await core.dispose();
      await core.services.workspace.poolSettled();
      await core.services.workspace.deletionsSettled();
    }
    return [answers, played];
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(userHome, { recursive: true, force: true });
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

/** A verified picture's address in a card body, as the core writes it; its one segment is the picture's name. */
const PICTURE_ADDRESS = new RegExp(`${APP_FRAME_SCHEME}://${CARD_PICTURE_HOST}/([^"'\\s>)]+)`, "g");

/**
 * The cards with each verified picture as data. A card body names the core's
 * copy of a picture at the shell's own scheme, which main serves and a page
 * cannot load; the reading carries the very bytes main would serve, read as
 * a view's frames read them (`inf:cards:picture`), so a card body draws its
 * pictures in a page with the size and markup the core gave them.
 */
async function picturesAsData(
  core: Core,
  cards: InvokeResponse<"inf:cards:list">,
): Promise<InvokeResponse<"inf:cards:list">> {
  return Promise.all(
    cards.map(async (card) => {
      let body = card.body;
      for (const [address, name] of new Map(
        [...card.body.matchAll(PICTURE_ADDRESS)].map((found) => [found[0], found[1] ?? ""]),
      )) {
        const { contentType, data } = await core.dispatch("inf:cards:picture", [name]);
        body = body.replaceAll(address, `data:${contentType};base64,${data}`);
      }
      return { ...card, body };
    }),
  );
}

export default async function setup(project: TestProject): Promise<void> {
  const [answers, crew] = await inTurn(() => bootAndRead(undefined, ASKED, crewStory));
  project.provide("freshHome", answers);
  if (crew) project.provide("crewStory", crew);
}

/** The pushes that move the crew ring, as main forwards them to the window. */
const CREW_PUSHES: readonly PushChannel[] = ["inf:event", "inf:tasks", "inf:tasks:delta"];

/**
 * One crewmate sent out and then cancelled, played on the fresh home's core:
 * the board before it, every push the core sends the window as the crewmate
 * goes out and goes idle, the board then, every push as it is cancelled,
 * and the board after. Each part waits for the core's own board push,
 * so the next part's pushes start from the board the window holds.
 */
async function crewStory(core: Core): Promise<CrewStory> {
  const heard: StoryPush[] = [];
  let onPush = () => {};
  const detach = core.events.subscribe((channel, payload) => {
    if (!(CREW_PUSHES as readonly string[]).includes(channel)) return;
    heard.push({ channel, payload: structuredClone(payload) } as StoryPush);
    onPush();
  });
  /** Settles once the core has pushed the board at `seq` or later. */
  const pushedUpTo = (seq: number) =>
    new Promise<void>((done) => {
      onPush = () => {
        if (heard.some((push) => push.channel !== "inf:event" && push.payload.seq >= seq)) done();
      };
      onPush();
    });
  /** The pushes `act` makes the core send, through its board push. */
  const pushesOf = async (act: () => void): Promise<[StoryPush[], TaskBoard]> => {
    heard.length = 0;
    act();
    const board: TaskBoard = await core.dispatch("inf:tasks:board", []);
    await pushedUpTo(board.seq);
    return [[...heard], board];
  };
  try {
    const id = "crew-story";
    const fresh: TaskBoard = await core.dispatch("inf:tasks:board", []);
    const [arrive, crewed] = await pushesOf(() =>
      seedTask(core.services.tasks, {
        id,
        title: "write a cancellation probe note",
        status: "idle",
      }),
    );
    const [cancel, dropped] = await pushesOf(() =>
      core.services.tasks.close(id, { status: "dropped", reason: "cancelled", actor: "host" }),
    );
    return { fresh, arrive, crewed, cancel, dropped };
  } finally {
    detach();
  }
}
