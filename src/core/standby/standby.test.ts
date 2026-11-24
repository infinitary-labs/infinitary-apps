import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  type PathLike,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { HOME_MOVE_MANIFEST } from "@shared/homeMove";
import {
  STANDBY_APPLY_ORDER,
  STANDBY_FULL_ORDER,
  type StandbyOrderChannel,
  type StandbyView,
} from "@shared/standby";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recordDigest } from "../../../tests/helpers/recordDigest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { DeviceOutOfReachError } from "../connection/connection";
import { createKeyIdentity } from "../devices/identity";
import { openDatabase } from "../storage/db";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import { readStandbyState, STANDBY_COPY, STANDBY_DIR, StandbyKeeper } from "./keeper";
import { StandbyPeers } from "./peers";
import { StandbyStream, type StandbyStreamHost } from "./stream";
import {
  askTakeOver,
  phoneOffer,
  readTakeOver,
  readTakeOverAnswer,
  TAKE_OVER_ANSWER,
  TakeOverHere,
  writeTakeOverAsk,
} from "./takeOver";
import { readWal } from "./wal";
import { TAKE_OVER_WORDS } from "./words";

/**
 * Keeping a copy of the record on other computers (INF-4207 piece 7;
 * docs/devices.md, "Keeping a copy on another computer"): a home's real
 * database and files, and two computers' copies, the orders crossing as
 * JSON as they do over the connection.
 */

/**
 * While `silent` names a folder, every watch watches that empty folder
 * instead, so it names nothing, as a watch on a Mac may for a second or
 * more after a write.
 */
const watching = vi.hoisted(() => ({ silent: null as string | null }));

vi.mock("node:fs", async (load) => {
  const actual = await load<typeof import("node:fs")>();
  const watch = ((path: PathLike, ...rest: unknown[]) =>
    Reflect.apply(actual.watch, actual, [watching.silent ?? path, ...rest])) as typeof actual.watch;
  return { ...actual, watch };
});

/** Until the test ends, every watch the stream starts names nothing, so a change reaches it only through `rescan` or `flush`. */
function unwatched(): void {
  watching.silent = scratchDir("infinitary-standby-unwatched-");
}

type Home = {
  userData: string;
  db: ReturnType<typeof openDatabase>;
  tasks: TaskService;
  knowledge: Database.Database;
};

const opened: { close: () => void }[] = [];
afterEach(() => {
  for (const each of opened.splice(0).reverse()) each.close();
  watching.silent = null;
});

function home(): Home {
  const userData = scratchDir("infinitary-standby-home-");
  const db = openDatabase(userData);
  mkdirSync(join(userData, "knowledge"), { recursive: true });
  const knowledge = new Database(join(userData, "knowledge", "knowledge.db"));
  knowledge.pragma("journal_mode = WAL");
  knowledge.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, text TEXT)");
  mkdirSync(join(userData, "crewmates", "t1"), { recursive: true });
  writeFileSync(join(userData, "crewmates", "t1", "transcript.jsonl"), '{"line":1}\n');
  mkdirSync(join(userData, "devices"), { recursive: true });
  writeFileSync(join(userData, "devices", "devices.json"), "[]\n");
  return { userData, db, tasks: new TaskService({ db }), knowledge };
}

type Computer = {
  id: string;
  workDir: string;
  keeper: StandbyKeeper;
  reach: boolean;
  asks: string[];
  /** The next apply is applied there, and its answer never reaches the home. */
  loseApplyAnswer?: boolean;
  /** Every order fails there with something other than being out of reach. */
  failing?: boolean;
};

function computer(id: string, addresses?: () => string[]): Computer {
  const workDir = scratchDir(`infinitary-standby-${id}-`);
  return {
    id,
    workDir,
    reach: true,
    asks: [],
    keeper: new StandbyKeeper({ workDir, log: () => {}, ...(addresses ? { addresses } : {}) }),
  };
}

function stream(
  at: Home,
  computers: Computer[],
  takeOver?: Pick<
    StandbyStreamHost,
    "speaksTakeOver" | "homeFacts" | "nameOf" | "addressesChanged"
  >,
) {
  const listeners = new Set<(deviceId: string) => void>();
  let views: StandbyView[] = [];
  let gone = false;
  const underWay = new Set<Promise<unknown>>();
  const stagingDir = join(scratchDir("infinitary-standby-staging-"), "standby-stream");
  const s = new StandbyStream({
    userData: at.userData,
    claudeDir: null,
    stagingDir,
    pagesDatabases: () => [
      { path: "firstmate.db", connection: () => at.db },
      { path: "knowledge/knowledge.db", connection: () => at.knowledge },
    ],
    ask: (deviceId, channel, args) => {
      const asked = (async () => {
        const there = computers.find((each) => each.id === deviceId);
        if (gone || !there?.reach) throw new DeviceOutOfReachError();
        there.asks.push(channel);
        if (there.failing) throw new Error("the computer could not answer");
        // As over the connection: the order and its answer cross as JSON.
        const answer = await there.keeper.answer(
          channel as StandbyOrderChannel,
          JSON.parse(JSON.stringify(args)),
        );
        if (channel === STANDBY_APPLY_ORDER && there.loseApplyAnswer) {
          there.loseApplyAnswer = false;
          throw new Error("the answer was lost on the way back");
        }
        return JSON.parse(JSON.stringify(answer));
      })();
      underWay.add(asked);
      const landed = () => underWay.delete(asked);
      asked.then(landed, landed);
      return asked;
    },
    inReach: (deviceId) => computers.find((each) => each.id === deviceId)?.reach ?? false,
    speaksCopy: (deviceId) => computers.find((each) => each.id === deviceId)?.reach ?? false,
    onReach: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit: (next) => {
      views = next;
    },
    log: (line) => process.env.STANDBY_DEBUG && console.log(line),
    ...takeOver,
  });
  opened.push({ close: () => s.dispose() });
  return {
    s,
    stagingDir,
    state: (deviceId: string) => {
      if (process.env.STANDBY_DEBUG) console.log(JSON.stringify(views));
      return views.find((view) => view.deviceId === deviceId);
    },
    reach: (there: Computer, reach: boolean) => {
      there.reach = reach;
      for (const listener of listeners) listener(there.id);
    },
    /** The home stops as one that dies does: nothing more reaches a copy once each order under way has landed. */
    stop: async () => {
      gone = true;
      s.dispose();
      await Promise.allSettled([...underWay]);
    },
  };
}

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const copyOf = (there: Computer) => join(there.workDir, STANDBY_DIR, STANDBY_COPY);

vi.setConfig({ testTimeout: 20_000 });

describe("keeping a copy on other computers", () => {
  it("two copies take a full copy, then each change in order, and every file compares equal after a quiet moment", async () => {
    const at = home();
    const one = computer("one");
    const two = computer("two");
    const { s, state } = stream(at, [one, two]);
    s.start();
    s.name("one", true);
    s.name("two", true);
    await until(
      () => state("one")?.state === "in-sync" && state("two")?.state === "in-sync",
      "in sync",
    );
    expect(s.named()).toEqual(["one", "two"]);
    expect(recordDigest(copyOf(one))).toEqual(recordDigest(at.userData));

    for (let index = 0; index < 20; index++)
      seedTask(at.tasks, { id: `task-${index}`, title: `Task ${index}`, status: "queued" });
    at.knowledge.prepare("INSERT INTO notes (text) VALUES (?)").run("the captain likes tea");
    appendFileSync(join(at.userData, "crewmates", "t1", "transcript.jsonl"), '{"line":2}\n');
    mkdirSync(join(at.userData, "crewmates", "t2"), { recursive: true });
    writeFileSync(join(at.userData, "crewmates", "t2", "card.html"), "<p>hello</p>");
    rmSync(join(at.userData, "devices", "devices.json"));
    await s.rescan();
    s.flush();
    await until(
      () => state("one")?.state === "in-sync" && state("two")?.state === "in-sync",
      "in sync again",
    );
    const expected = recordDigest(at.userData);
    expect(recordDigest(copyOf(one))).toEqual(expected);
    expect(recordDigest(copyOf(two))).toEqual(expected);
    expect(one.asks.filter((ask) => ask === STANDBY_FULL_ORDER)).toHaveLength(1);
    // The copy is the work folder's own: nothing lands where a first mate would open it.
    expect(existsSync(join(one.workDir, "firstmate.db"))).toBe(false);
  });

  it("a copy's hello that says where it would answer tells the home's devices once, and again only when it changes", async () => {
    const at = home();
    let said = ["192.168.1.20:7443"];
    const one = computer("one", () => said);
    let told = 0;
    const { s, state, reach } = stream(at, [one], {
      addressesChanged: () => {
        told += 1;
      },
    });
    s.start();
    s.name("one", true);
    await until(() => state("one")?.state === "in-sync", "in sync");
    expect(s.addresses()).toEqual([["192.168.1.20:7443"]]);
    expect(told).toBe(1);

    // It goes out of reach while the home saves, and says hello again on its return.
    const away = async (save: string) => {
      reach(one, false);
      seedTask(at.tasks, { id: save, title: save, status: "queued" });
      await until(() => state("one")?.state !== "in-sync", "out of reach");
      reach(one, true);
      await until(() => state("one")?.state === "in-sync", "back in sync");
    };
    await away("first-save");
    expect(told).toBe(1);

    said = ["192.168.1.31:7443"];
    await away("second-save");
    expect(told).toBe(2);
    expect(s.addresses()).toEqual([["192.168.1.31:7443"]]);
  });

  it("one save on a quiet home reaches the copy by itself, with nothing asking the stream to look", async () => {
    const at = home();
    const one = computer("one");
    const { s, state } = stream(at, [one]);
    s.start();
    s.name("one", true);
    await until(() => state("one")?.state === "in-sync", "in sync");
    const before = readStandbyState(one.workDir).seq;
    // The record's main database sits at the data folder's top, whose own watch on a Mac names no write.
    seedTask(at.tasks, { id: "alone", title: "Alone", status: "queued" });
    await until(() => readStandbyState(one.workDir).seq > before, "the save in the copy");
    await until(() => state("one")?.state === "in-sync", "in sync again");
    expect(recordDigest(copyOf(one))).toEqual(recordDigest(at.userData));
  });

  it("the home's own write of the list reaches a copy back from away before it reads in sync, though the watch names nothing", async () => {
    const at = home();
    const one = computer("one");
    unwatched();
    const { s, state, reach } = stream(at, [one]);
    s.start();
    s.name("one", true);
    await until(() => state("one")?.state === "in-sync", "in sync");
    // Going away is a save of the home's own: when that copy is from, in the list every copy holds.
    reach(one, false);
    await until(() => state("one")?.state === "away", "away");
    reach(one, true);
    await until(() => state("one")?.state === "in-sync", "back in sync");
    expect(recordDigest(copyOf(one))).toEqual(recordDigest(at.userData));
  });

  it("a change too large to send inline ahead of a file's change still sends the file's change", async () => {
    const at = home();
    // A record larger than the change, so the home keeps the change rather than sending a full copy.
    at.knowledge.transaction(() => {
      for (let index = 0; index < 3000; index++)
        at.knowledge
          .prepare("INSERT INTO notes (text) VALUES (?)")
          .run(`before-${index}-${"b".repeat(4000)}`);
    })();
    const one = computer("one");
    // A watch's late report of the file, once the copy is back, would send the file's change
    // again on its own and hide one the stream left out behind the big change.
    unwatched();
    const { s, state, reach } = stream(at, [one]);
    s.start();
    s.name("one", true);
    await until(() => state("one")?.state === "in-sync", "in sync");
    // Away while they happen, so both wait in the stream when it is back, the big change first.
    reach(one, false);
    await until(() => state("one")?.state === "away", "away");
    // One commit whose pages fill more than an order holds, then a file the first mate wrote.
    at.knowledge.transaction(() => {
      for (let index = 0; index < 1600; index++)
        at.knowledge
          .prepare("INSERT INTO notes (text) VALUES (?)")
          .run(`${index}-${"z".repeat(4000)}`);
    })();
    mkdirSync(join(at.userData, "crewmates", "t3"), { recursive: true });
    writeFileSync(join(at.userData, "crewmates", "t3", "card.html"), "<p>after the big change</p>");
    await s.rescan();
    s.flush();
    reach(one, true);
    await until(() => state("one")?.state === "in-sync", "in sync again");
    expect(recordDigest(copyOf(one))).toEqual(recordDigest(at.userData));
    expect(one.asks.filter((ask) => ask === STANDBY_FULL_ORDER)).toHaveLength(1);
  });

  it("an apply whose answer was lost leaves the home no longer sure what the copy holds", async () => {
    const at = home();
    const one = computer("one");
    const card = join(at.userData, "crewmates", "t1", "card.html");
    writeFileSync(card, "<p>first</p>");
    // A watch's late report of the card, once the copy is back, would send it again in an apply
    // whose answer arrives, and the home would know what the copy holds after all.
    unwatched();
    const { s, state, reach } = stream(at, [one]);
    s.start();
    s.name("one", true);
    await until(() => state("one")?.state === "in-sync", "in sync");
    // The copy takes the new content in one batch, but the home never hears it did.
    reach(one, false);
    await until(() => state("one")?.state === "away", "away");
    writeFileSync(card, "<p>second</p>");
    await s.rescan();
    s.flush();
    one.loseApplyAnswer = true;
    reach(one, true);
    await until(
      () =>
        readFileSync(join(copyOf(one), "crewmates", "t1", "card.html"), "utf8") === "<p>second</p>",
      "the copy took it",
    );
    await until(() => state("one")?.state === "in-sync", "in sync after the lost answer");
    // Back to what the home last heard the copy held.
    writeFileSync(card, "<p>first</p>");
    await s.rescan();
    s.flush();
    await until(() => state("one")?.state === "in-sync", "in sync again");
    expect(recordDigest(copyOf(one))).toEqual(recordDigest(at.userData));
  });

  it("a change the home cannot keep on its disk sends every copy a full copy, never a gap", async () => {
    const at = home();
    const one = computer("one");
    const { s, state, stagingDir } = stream(at, [one]);
    s.start();
    s.name("one", true);
    await until(() => state("one")?.state === "in-sync", "in sync");
    chmodSync(join(stagingDir, "log"), 0o500);
    try {
      seedTask(at.tasks, { id: "unkept", title: "Unkept", status: "queued" });
      s.flush();
    } finally {
      chmodSync(join(stagingDir, "log"), 0o700);
    }
    seedTask(at.tasks, { id: "kept", title: "Kept", status: "queued" });
    s.flush();
    await until(
      () => one.asks.filter((ask) => ask === STANDBY_FULL_ORDER).length >= 2,
      "a second full copy",
    );
    await until(() => state("one")?.state === "in-sync", "in sync again");
    expect(recordDigest(copyOf(one))).toEqual(recordDigest(at.userData));
  });

  it("a copy whose orders keep failing waits its whole time before the next try, though the home keeps saving", async () => {
    const at = home();
    const one = computer("one");
    one.failing = true;
    const { s } = stream(at, [one]);
    s.start();
    s.name("one", true);
    await until(() => one.asks.length === 1, "the first try");
    // A second of saves, each flushed as the first mate's turn ends: none of them is a reason to ask again.
    const end = Date.now() + 1_000;
    for (let index = 0; Date.now() < end; index++) {
      seedTask(at.tasks, { id: `busy-${index}`, title: `Busy ${index}`, status: "queued" });
      s.flush();
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(one.asks).toHaveLength(1);
  });

  it("a home that stops without closing still knows, when it starts again, when each copy was last whole", async () => {
    const at = home();
    const one = computer("one");
    const { s, state } = stream(at, [one]);
    s.start();
    s.name("one", true);
    await until(() => state("one")?.state === "in-sync", "in sync");
    const saved = Date.now();
    seedTask(at.tasks, { id: "later", title: "Later", status: "queued" });
    s.flush();
    await until(
      () => readStandbyState(one.workDir).seq > 0 && state("one")?.state === "in-sync",
      "the save",
    );
    await until(() => (state("one")?.copyAt ?? 0) >= saved, "the copy holds the save");
    await s.rescan();
    // The home is gone without closing this stream; it starts again while the computer is out of reach.
    one.reach = false;
    const again = stream(at, [one]);
    again.s.start();
    await until(() => again.state("one")?.state === "away", "away");
    expect(again.state("one")?.copyAt ?? 0).toBeGreaterThanOrEqual(saved);
  });

  it("a copy that was away catches up from the stream, through logs folded back and begun again", async () => {
    const at = home();
    const one = computer("one");
    const { s, state, reach } = stream(at, [one]);
    s.start();
    s.name("one", true);
    await until(() => state("one")?.state === "in-sync", "in sync");
    reach(one, false);
    await until(() => state("one")?.state === "away", "away");
    const copyAt = state("one")?.copyAt;
    expect(copyAt).toEqual(expect.any(Number));
    // Enough writes to pass SQLite's own threshold, so the stream folds the log back and it begins again.
    for (let round = 0; round < 6; round++) {
      at.knowledge.transaction(() => {
        for (let index = 0; index < 300; index++)
          at.knowledge
            .prepare("INSERT INTO notes (text) VALUES (?)")
            .run(`${round}-${index}-${"x".repeat(400)}`);
      })();
      s.flush();
    }
    seedTask(at.tasks, { id: "while-away", title: "While away", status: "queued" });
    s.flush();
    expect(readWal(join(at.userData, "knowledge", "knowledge.db-wal"), null).kind).toBe("frames");
    reach(one, true);
    await until(() => state("one")?.state === "in-sync", "caught up");
    expect(recordDigest(copyOf(one))).toEqual(recordDigest(at.userData));
    expect(one.asks.filter((ask) => ask === STANDBY_FULL_ORDER)).toHaveLength(1);
    expect(readStandbyState(one.workDir).seq).toBeGreaterThan(0);
  });

  it("a copy further behind than a full copy is large takes a full copy again", async () => {
    const at = home();
    const one = computer("one");
    const { s, state, reach } = stream(at, [one]);
    s.start();
    s.name("one", true);
    await until(() => state("one")?.state === "in-sync", "in sync");
    reach(one, false);
    await until(() => state("one")?.state === "away", "away");
    // More changed pages than the whole record holds.
    const record = s.fullCopyBytes();
    let written = 0;
    while (written < record * 2 + 8 * 1024 * 1024) {
      at.knowledge.transaction(() => {
        for (let index = 0; index < 200; index++)
          at.knowledge.prepare("INSERT INTO notes (text) VALUES (?)").run("y".repeat(2000));
      })();
      at.knowledge.prepare("DELETE FROM notes").run();
      written += 200 * 2000;
      s.flush();
    }
    reach(one, true);
    await until(() => state("one")?.state === "in-sync", "in sync after a full copy");
    expect(one.asks.filter((ask) => ask === STANDBY_FULL_ORDER).length).toBeGreaterThanOrEqual(2);
    expect(recordDigest(copyOf(one))).toEqual(recordDigest(at.userData));
  });

  it("stopping a copy drops it there, and an apply a restart cut short is finished at start", async () => {
    const at = home();
    const one = computer("one");
    const { s, state } = stream(at, [one]);
    s.start();
    s.name("one", true);
    await until(() => state("one")?.state === "in-sync", "in sync");
    const kept = readStandbyState(one.workDir);
    // An apply written down and cut short before any file changed: a new keeper finishes it.
    const redo = {
      stream: kept.stream,
      from: kept.seq,
      through: kept.seq + 1,
      at: 1,
      changes: [
        {
          kind: "file",
          seq: kept.seq + 1,
          at: 1,
          path: "crewmates/t9/note.txt",
          sha256: createHash("sha256").update("hi").digest("hex"),
          size: 2,
          data: Buffer.from("hi").toString("base64"),
        },
      ],
    };
    writeFileSync(join(one.workDir, STANDBY_DIR, "redo.json"), JSON.stringify(redo));
    new StandbyKeeper({ workDir: one.workDir, log: () => {} });
    expect(readFileSync(join(copyOf(one), "crewmates", "t9", "note.txt"), "utf8")).toBe("hi");
    expect(readStandbyState(one.workDir).seq).toBe(kept.seq + 1);
    s.name("one", false);
    await until(() => !existsSync(join(one.workDir, STANDBY_DIR)), "the copy dropped");
    expect(s.named()).toEqual([]);
    expect(existsSync(dirname(copyOf(one)))).toBe(false);
  });

  it("a computer that no longer runs work for the home leaves the list, even one whose copy was still to go", async () => {
    const at = home();
    const one = computer("one");
    const { s, state, reach } = stream(at, [one]);
    s.start();
    s.name("one", true);
    await until(() => state("one")?.state === "in-sync", "in sync");
    // Stopped while out of reach: its copy is still to go.
    reach(one, false);
    s.name("one", false);
    expect(s.listed()).toEqual(["one"]);
    // Then it is removed, or the first mate moves there: nothing more is asked of it.
    s.forget("one");
    expect(s.listed()).toEqual([]);
    reach(one, true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(one.asks).not.toContain("inf:standby:drop");
  });
});

/** What the home tells a copy taking over needs, as the move reads it on the home (`takeOverFacts`). */
const facts = (at: Home) => ({
  name: "MacBook Pro",
  from: { userData: at.userData, homeDir: "/Users/captain" },
  projects: [
    {
      id: "p1",
      path: "/Users/captain/code/app",
      remotes: [{ name: "origin", url: "https://example.com/captain/app.git" }],
    },
  ],
  signIns: { providers: [{ id: "claude", name: "Claude" }], forges: [] },
  homeNumber: 1,
});

describe("taking over from a copy", () => {
  // Intent: the plan's "The home tells standbys in reach before a merge, a push or a secret use".
  it("the home's wait before an act ends once each copy in reach holds the record so far, and a copy out of reach holds nothing up", async () => {
    const at = home();
    const one = computer("one");
    const two = computer("two");
    const { s, state, reach } = stream(at, [one, two]);
    s.start();
    s.name("one", true);
    s.name("two", true);
    await until(
      () => state("one")?.state === "in-sync" && state("two")?.state === "in-sync",
      "in sync",
    );

    seedTask(at.tasks, { id: "merged", title: "Merged just now", status: "queued" });
    await s.settled();
    // Read straight after the wait: the copy already holds the change the act follows.
    const copy = new Database(join(copyOf(one), "firstmate.db"), { readonly: true });
    expect(copy.prepare("SELECT title FROM tasks WHERE id = ?").get("merged")).toEqual({
      title: "Merged just now",
    });
    copy.close();

    reach(two, false);
    seedTask(at.tasks, { id: "pushed", title: "Pushed while two slept", status: "queued" });
    await s.settled();
    const after = new Database(join(copyOf(one), "firstmate.db"), { readonly: true });
    expect(after.prepare("SELECT title FROM tasks WHERE id = ?").get("pushed")).toEqual({
      title: "Pushed while two slept",
    });
    after.close();
  });

  // Intent: the plan's "home dies" journey, on the copy's side: the captain's ask, and nothing without it.
  it("a copy lays its record out as a move's files with the next home number once asked, and refuses while the home answers", async () => {
    const at = home();
    const one = computer("one");
    const two = computer("two");
    const { s, state } = stream(at, [one, two], {
      speaksTakeOver: () => true,
      homeFacts: async () => facts(at),
      nameOf: (deviceId) => (deviceId === "one" ? "Mac mini" : "Mac Studio"),
    });
    s.start();
    s.name("one", true);
    s.name("two", true);
    await until(
      () => state("one")?.state === "in-sync" && state("two")?.state === "in-sync",
      "in sync",
    );
    seedTask(at.tasks, { id: "last", title: "The last change before it died", status: "queued" });
    await s.settled();
    await until(() => existsSync(join(one.workDir, STANDBY_DIR, "home.json")), "told the home");

    let homeAnswers = true;
    const arrived: { move: string; homeNumber: number; manifestSha256: string }[] = [];
    const started: number[] = [];
    const filesDir = scratchDir("infinitary-standby-take-over-");
    const here = new TakeOverHere({
      workDir: one.workDir,
      own: async () => ({ deviceId: "one", name: "Mac mini" }),
      homeNumber: () => 1,
      inReach: () => homeAnswers,
      filesOf: (move) => join(filesDir, move, "files"),
      arrive: async (order) => {
        arrived.push(order);
        return { addresses: ["192.168.1.20:7443"] };
      },
      started: (_addresses, homeNumber) => started.push(homeNumber),
      log: () => {},
    });
    opened.push({ close: () => here.dispose() });

    // The ask is there before the watch starts, which reads it at once.
    const asked = "1d7c3a8e-2f4b-4c6d-8e9f-0a1b2c3d4e5f";
    writeTakeOverAsk(one.workDir, { version: 1, id: asked, at: Date.now() });
    here.start();
    await until(() => readTakeOverAnswer(one.workDir)?.state === "refused", "refused");
    expect(arrived).toEqual([]);

    // The home went quiet; the captain asks again.
    homeAnswers = false;
    const taking = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
    writeTakeOverAsk(one.workDir, { version: 1, id: taking, at: Date.now() });
    await until(() => readTakeOverAnswer(one.workDir)?.state === "started", "started");
    expect(arrived).toHaveLength(1);
    expect(arrived[0]?.homeNumber).toBe(2);
    expect(started).toEqual([2]);
    const files = join(filesDir, taking, "files");
    const laid = new Database(join(files, "firstmate.db"), { readonly: true });
    expect(laid.prepare("SELECT title FROM tasks WHERE id = ?").get("last")).toEqual({
      title: "The last change before it died",
    });
    laid.close();
    expect(readTakeOver(files)).toMatchObject({ id: taking, homeNumber: 2, deviceId: "one" });
    const standbys = JSON.parse(readFileSync(join(files, "devices", "standbys.json"), "utf8"));
    expect(standbys.standbys.map((each: { deviceId: string }) => each.deviceId)).toEqual(["two"]);
    const manifest = JSON.parse(readFileSync(join(files, HOME_MOVE_MANIFEST), "utf8"));
    expect(manifest.projects).toEqual(facts(at).projects);
    expect(manifest.name).toBe("MacBook Pro");
    // The copy itself stays as it was.
    expect(existsSync(join(copyOf(one), "devices", "take-over.json"))).toBe(false);
  });

  // Intent: INF-4207 piece 9, the phone takes over: what the copy tells a phone, and the phone's
  // confirmed ask taken up as the copy's own window's is, once.
  it("a phone hears what Take over rests on there, and its ask takes over once, refused while the home answers", async () => {
    const at = home();
    const one = computer("one");
    const two = computer("two");
    const { s, state } = stream(at, [one, two], {
      speaksTakeOver: () => true,
      homeFacts: async () => facts(at),
      nameOf: (deviceId) => (deviceId === "one" ? "Mac mini" : "Mac Studio"),
    });
    s.start();
    s.name("one", true);
    s.name("two", true);
    await until(
      () => state("one")?.state === "in-sync" && state("two")?.state === "in-sync",
      "in sync",
    );
    await s.settled();
    await until(() => existsSync(join(one.workDir, STANDBY_DIR, "home.json")), "told the home");

    let homeAnswers = true;
    const arrived: string[] = [];
    const filesDir = scratchDir("infinitary-standby-phone-");
    const here = new TakeOverHere({
      workDir: one.workDir,
      own: async () => ({ deviceId: "one", name: "Mac mini" }),
      homeNumber: () => 1,
      inReach: () => homeAnswers,
      filesOf: (move) => join(filesDir, move, "files"),
      arrive: async (order) => {
        arrived.push(order.move);
        return { addresses: ["192.168.1.20:7443"] };
      },
      started: () => {},
      log: () => {},
      lookMs: 20,
    });
    opened.push({ close: () => here.dispose() });
    here.start();
    const offer = () =>
      phoneOffer({
        workDir: one.workDir,
        deviceId: "one",
        home: {
          contact: homeAnswers ? "in-reach" : "lost",
          heardAt: 1_763_000_000_000,
          slept: true,
        },
        homeNumber: 1,
      });

    const before = offer();
    expect(before.copyAt).toBe(readStandbyState(one.workDir).at);
    expect(before.home).toEqual({
      name: "MacBook Pro",
      contact: "in-reach",
      heardAt: 1_763_000_000_000,
      // A home still answering said no goodbye that holds.
      slept: false,
    });
    expect(before.copies.map((each) => each.name)).toEqual(["Mac Studio"]);
    expect(before.ready).toBe(true);
    expect(before.asked).toBeNull();

    const look = () => here.look();
    const refused = await askTakeOver(one.workDir, "5c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f", {
      look,
      lookMs: 20,
    });
    expect(refused.state).toBe("refused");
    expect(arrived).toEqual([]);

    homeAnswers = false;
    expect(offer().home).toMatchObject({ contact: "lost", slept: true });
    const id = "7e6d5c4b-3a2f-4e1d-9c8b-7a6f5e4d3c2b";
    expect(await askTakeOver(one.workDir, id, { look, lookMs: 20 })).toMatchObject({
      state: "started",
    });
    // The same ask again, as after a dropped link, is answered and takes over nothing more.
    expect(await askTakeOver(one.workDir, id, { look, lookMs: 20 })).toMatchObject({
      state: "started",
    });
    expect(arrived).toEqual([id]);
    expect(offer().asked?.state).toBe("started");
  });

  it("a copy behind another brings in the newer copy before it starts, and refuses once another copy heard a takeover", async () => {
    const at = home();
    const one = computer("one");
    const two = computer("two");
    const { s, state, reach, stop } = stream(at, [one, two], {
      speaksTakeOver: () => true,
      homeFacts: async () => facts(at),
      nameOf: (deviceId) => (deviceId === "one" ? "Mac mini" : "Mac Studio"),
    });
    s.start();
    s.name("one", true);
    s.name("two", true);
    await until(
      () => state("one")?.state === "in-sync" && state("two")?.state === "in-sync",
      "in sync",
    );
    await until(() => existsSync(join(one.workDir, STANDBY_DIR, "home.json")), "told the home");
    // One copy stops hearing the home; the home saves more, which only the other copy holds.
    reach(one, false);
    await until(() => state("one")?.state === "away", "away");
    seedTask(at.tasks, {
      id: "later",
      title: "Saved while the Mac mini was away",
      status: "queued",
    });
    await s.settled();
    await until(
      () => readStandbyState(two.workDir).seq > readStandbyState(one.workDir).seq,
      "ahead",
    );
    // Then the home dies, so nothing moves the other copy while it is read
    // from. A live home would: a watch on a Mac names writes a second or
    // more late, writes from before the watch began among them, and the
    // home sends each as a change.
    await stop();

    // The other copy answers as its link would, the orders and answers crossing as JSON.
    let twoHeard = 2;
    const own = createKeyIdentity("Firstmate device");
    const twoPeers = new StandbyPeers({
      workDir: two.workDir,
      own: { deviceId: "two", key: own.key, cert: own.cert },
      hosts: () => [],
      port: 0,
      homeNumber: () => twoHeard,
      log: () => {},
    });
    opened.push({ close: () => twoPeers.stop() });
    const filesDir = scratchDir("infinitary-standby-take-over-");
    const here = new TakeOverHere({
      workDir: one.workDir,
      own: async () => ({ deviceId: "one", name: "Mac mini" }),
      homeNumber: () => 1,
      inReach: () => false,
      filesOf: (move) => join(filesDir, move, "files"),
      arrive: async () => ({ addresses: ["192.168.1.20:7443"] }),
      started: () => {},
      copies: {
        inReach: () => [{ deviceId: "two", name: "Mac Studio", gathers: true }],
        ask: async (_deviceId, channel, args) =>
          JSON.parse(
            JSON.stringify(await twoPeers.answerCopy(channel, JSON.parse(JSON.stringify(args)))),
          ),
      },
      log: () => {},
    });
    opened.push({ close: () => here.dispose() });

    // The other copy heard home number 2: another computer took over already.
    // The ask is there before the watch starts, which reads it at once: a
    // write in the same moment as the watch starts may come before the
    // system reports changes.
    const refused = "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e";
    writeTakeOverAsk(one.workDir, { version: 1, id: refused, at: Date.now() });
    here.start();
    await until(() => readTakeOverAnswer(one.workDir)?.state === "refused", "refused");
    expect(readTakeOverAnswer(one.workDir)?.text).toContain("already took over");

    twoHeard = 1;
    const taking = "3c4d5e6f-7a8b-4c9d-8e0f-2a3b4c5d6e7f";
    writeTakeOverAsk(one.workDir, { version: 1, id: taking, at: Date.now() });
    await until(() => {
      const answer = readTakeOverAnswer(one.workDir);
      return answer?.id === taking && answer.state !== "running";
    }, "answered");
    expect(readTakeOverAnswer(one.workDir)).toMatchObject({ state: "started" });
    expect(readTakeOverAnswer(one.workDir)?.text).toContain("Mac Studio");
    const files = join(filesDir, taking, "files");
    const laid = new Database(join(files, "firstmate.db"), { readonly: true });
    expect(laid.prepare("SELECT title FROM tasks WHERE id = ?").get("later")).toEqual({
      title: "Saved while the Mac mini was away",
    });
    laid.close();
    expect(readTakeOver(files)?.seq).toBe(readStandbyState(two.workDir).seq);
    // This computer's own copy stays as it was.
    const kept = new Database(join(copyOf(one), "firstmate.db"), { readonly: true });
    expect(kept.prepare("SELECT title FROM tasks WHERE id = ?").get("later")).toBeUndefined();
    kept.close();
  });

  it("a takeover a restart cut short is settled or undone at start and answered, so the next ask is taken up", async () => {
    const one = computer("one");
    const filesDir = scratchDir("infinitary-standby-cut-short-");
    const started: { addresses: string[]; homeNumber: number }[] = [];
    const recovered: string[] = [];
    let recovers: { addresses: string[]; homeNumber: number } | null = null;
    const takeOverHere = () => {
      const here = new TakeOverHere({
        workDir: one.workDir,
        own: async () => ({ deviceId: "one", name: "Mac mini" }),
        homeNumber: () => 1,
        // The home is out of reach, and this computer keeps no copy: a fresh ask is refused.
        inReach: () => false,
        filesOf: (move) => join(filesDir, move, "files"),
        arrive: async () => ({ addresses: [] }),
        recover: async (move) => {
          recovered.push(move);
          return recovers;
        },
        started: (addresses, homeNumber) => started.push({ addresses, homeNumber }),
        log: () => {},
      });
      opened.push({ close: () => here.dispose() });
      return here;
    };
    // The work stopped while it answered running, its laid-out files left behind.
    const cut = "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a";
    writeTakeOverAsk(one.workDir, { version: 1, id: cut, at: Date.now() });
    writeFileSync(
      join(one.workDir, TAKE_OVER_ANSWER),
      `${JSON.stringify({ version: 1, id: cut, state: "running", text: TAKE_OVER_WORDS.running })}\n`,
    );
    mkdirSync(join(filesDir, cut, "files"), { recursive: true });
    const first = takeOverHere();
    first.start();
    await until(() => readTakeOverAnswer(one.workDir)?.state === "refused", "undone");
    expect(readTakeOverAnswer(one.workDir)?.text).toBe(TAKE_OVER_WORDS.cutShort);
    expect(recovered).toEqual([cut]);
    expect(existsSync(join(filesDir, cut))).toBe(false);
    expect(started).toEqual([]);

    // The captain asks again: the new ask is taken up, not held behind the old one.
    const again = "7e6d5c4b-3a29-4180-9f8e-7d6c5b4a3928";
    writeTakeOverAsk(one.workDir, { version: 1, id: again, at: Date.now() });
    await until(() => readTakeOverAnswer(one.workDir)?.id === again, "answered again");
    expect(readTakeOverAnswer(one.workDir)?.text).toBe(TAKE_OVER_WORDS.noCopy);

    // One whose first mate was in place when the work stopped is kept, with the number it took.
    const kept = "5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d";
    writeTakeOverAsk(one.workDir, { version: 1, id: kept, at: Date.now() });
    await until(() => readTakeOverAnswer(one.workDir)?.id === kept, "answered");
    // The work stops mid-takeover, and starts again.
    first.dispose();
    writeFileSync(
      join(one.workDir, TAKE_OVER_ANSWER),
      `${JSON.stringify({ version: 1, id: kept, state: "running", text: TAKE_OVER_WORDS.running })}\n`,
    );
    recovers = { addresses: ["192.168.1.20:7443"], homeNumber: 2 };
    takeOverHere().start();
    await until(() => readTakeOverAnswer(one.workDir)?.state === "started", "settled");
    expect(started).toEqual([{ addresses: ["192.168.1.20:7443"], homeNumber: 2 }]);
  });
});
