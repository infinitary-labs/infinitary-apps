import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  HOME_RECEIVE_ORDER,
  type HomeMoveOrderChannel,
  type HomeMoveProgress,
} from "@shared/homeMove";
import { describe, expect, it, vi } from "vitest";
import { setup as cardServiceSetup } from "../../../tests/helpers/cardServiceHarness";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { DeviceOutOfReachError } from "../connection/connection";
import type { CoreServices } from "../coreServices";
import { readHomeNumber } from "../devices/homeNumber";
import { DevicePairing } from "../devices/pairing";
import type { CoreEventSink } from "../events";
import { openDatabase } from "../storage/db";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import { HOME_ARRIVING_DIR, IncomingHomeMove } from "./arriving";
import {
  type HomeHandOver,
  movePending,
  OutgoingHomeMove,
  type OutgoingHost,
  START_HERE_OFFER_MS,
} from "./outgoing";
import { MOVED_AWAY_DIR, restoreAside, setAsideRecord } from "./record";
import {
  askSignInsAgain,
  keepSignInsToAsk,
  SIGN_IN_AGAIN_CARD,
  SIGN_IN_AGAIN_FILE,
  type SignInToAsk,
} from "./signInAgain";
import { askSignInsAgainAt } from "./wiring";
import { HOME_MOVE_WORDS } from "./words";

// The move's git runs at the test run's own priority (docs/test-cohorts.md, "Budgets").
vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

// Real git, SQLite backups and files crossing between two folders: five times
// the slowest test's fastest measured run (1.3 s), rounded up (docs/test-cohorts.md).
vi.setConfig({ testTimeout: 10_000 });

const VERSION = "0.8.0-alpha.600";

function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/**
 * The old home's record as the app writes it: a migrated database holding a
 * started task and a project outside the data folder, a project repository
 * with a branch and a remote, and a conversation file of a crewmate's.
 */
function oldHome() {
  const root = scratchDir("infinitary-home-move-old-");
  const userData = join(root, "data");
  const homeDir = join(root, "home");
  const project = join(root, "code", "website");
  mkdirSync(project, { recursive: true });
  sh(project, "init", "-q", "-b", "main");
  sh(project, "config", "user.email", "test@example.com");
  sh(project, "config", "user.name", "Test");
  writeFileSync(join(project, "README.md"), "website\n");
  sh(project, "add", ".");
  sh(project, "commit", "-q", "-m", "first");
  sh(project, "branch", "fm/task-1");
  sh(project, "remote", "add", "origin", "https://example.com/acme/website.git");
  const db = openDatabase(userData);
  db.prepare(
    "INSERT INTO repos (id, path, name, added_at, setup_kind, origin, delivery, autonomy, rigor, kind) VALUES ('r1', ?, 'website', 1, 'adopt', NULL, 'direct-pr', 0, 'standard', 'project')",
  ).run(project);
  const tasks = new TaskService({ db, now: () => 5_000 });
  const task = seedTask(tasks, { id: "task-1", title: "Fix the footer", status: "idle" });
  db.close();
  mkdirSync(join(userData, "crewmates", "task-1", "sessions"), { recursive: true });
  writeFileSync(join(userData, "crewmates", "task-1", "sessions", "one.jsonl"), '{"a":1}\n');
  mkdirSync(join(userData, "devices"), { recursive: true });
  writeFileSync(join(userData, "devices", "devices.json"), "[]\n");
  return { userData, homeDir, project, key: task.key };
}

/** The destination: a computer that runs work, its app's data folder beside its work folder. */
function destination(startHome?: () => Promise<boolean>) {
  const root = scratchDir("infinitary-home-move-new-");
  const homeData = join(root, "data");
  const homeDir = join(root, "home");
  mkdirSync(join(homeData, "work"), { recursive: true });
  const started: string[] = [];
  const incomingAt = (start = startHome) =>
    new IncomingHomeMove({
      homeData,
      arrivingDir: join(homeData, "work", HOME_ARRIVING_DIR),
      homeDir,
      claudeDir: null,
      appVersion: VERSION,
      addresses: () => ["192.168.1.30:47213"],
      background: true,
      startHome:
        start ??
        (async () => {
          started.push(homeData);
          return true;
        }),
      log: () => {},
    });
  return { root, homeData, homeDir, incoming: incomingAt(), incomingAt, started } as {
    root: string;
    homeData: string;
    homeDir: string;
    incoming: IncomingHomeMove;
    incomingAt: typeof incomingAt;
    started: string[];
  };
}

/** The destination's own first mate's record and its window's grant, which a move sets aside. */
function ownRecord(to: ReturnType<typeof destination>) {
  writeFileSync(join(to.homeData, "firstmate.db"), "the mini's own record");
  mkdirSync(join(to.homeData, "joined"), { recursive: true });
  writeFileSync(join(to.homeData, "joined", "grant.json"), "the mini's own grant");
}

/** Every file under `dir`, relative to it, sorted; none when it is gone. */
function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return execFileSync("find", [".", "-type", "f"], { cwd: dir, encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .sort();
}

/** Both sides joined as the connection joins them: every order and answer crosses as JSON. */
function move(
  old: ReturnType<typeof oldHome>,
  to: ReturnType<typeof destination>,
  overrides: Partial<OutgoingHost> = {},
) {
  const progress: HomeMoveProgress[] = [];
  const handOvers: (HomeHandOver | null)[] = [];
  const held: (string | null)[] = [];
  const orders: string[] = [];
  const host: OutgoingHost = {
    userData: old.userData,
    homeDir: old.homeDir,
    claudeDir: null,
    appVersion: VERSION,
    ownName: async () => "MacBook Pro",
    computer: (id) => (id === "mini" ? { name: "Mac mini", runsWork: true } : undefined),
    ask: async (_id, channel, args) => {
      orders.push(channel);
      const answer = await to.incoming.answer(
        channel as HomeMoveOrderChannel,
        JSON.parse(JSON.stringify(args)),
      );
      return JSON.parse(JSON.stringify(answer));
    },
    speaksMove: () => true,
    inReach: () => false,
    homeNumber: () => 1,
    raiseHomeNumber: () => {},
    homeKey: () => "pin-of-the-home",
    addMovedHome: () => ({ deviceId: "old-home", key: "key", cert: "cert" }),
    removeMovedHome: () => {},
    localTasks: async () => [],
    moveTask: async () => ({ ok: true, text: "" }),
    cancelTask: () => {},
    projects: () => [{ id: "r1", path: old.project }],
    providers: () => [{ id: "claude", name: "Claude" }],
    forges: () => [],
    sshComputers: () => [],
    secretsKept: () => false,
    integrationsSignedIn: () => [],
    dictationOn: () => false,
    quiesce: async () => {},
    hold: (why) => held.push(why),
    tellMoved: async () => {},
    onMoved: (handOver) => handOvers.push(handOver),
    onStopped: () => handOvers.push(null),
    emit: (step) => progress.push(step),
    stagingDir: join(old.userData, "home-moving"),
    ...overrides,
  };
  const outgoing = new OutgoingHomeMove(host);
  return { outgoing, progress, handOvers, held, orders };
}

async function finished(progress: HomeMoveProgress[]): Promise<HomeMoveProgress> {
  await vi.waitFor(() => {
    const last = progress.at(-1);
    if (!last || !["moved", "failed", "cancelled"].includes(last.stage)) throw new Error("moving");
  });
  return progress.at(-1) as HomeMoveProgress;
}

describe("moving the first mate to a computer that runs work", () => {
  it("carries the whole record with the next home number, keeps each task's key, and clones each project with its branches", async () => {
    const old = oldHome();
    const to = destination();
    const { outgoing, progress, handOvers, held } = move(old, to);

    // Nothing signed in here crosses: the only line says the captain signs in again there.
    expect((await outgoing.ready("mini")).gaps).toEqual([
      { id: "sign-ins", level: "notes", text: HOME_MOVE_WORDS.signInAgain("Mac mini", ["Claude"]) },
    ]);
    expect(await outgoing.start("mini")).toEqual({
      ok: true,
      text: HOME_MOVE_WORDS.started("Mac mini"),
    });
    expect(await finished(progress)).toMatchObject({ stage: "moved" });

    // The old home stopped acting before the last copy, and hands over the grant of a computer that controls and runs work.
    expect(held).toEqual([HOME_MOVE_WORDS.holding("Mac mini")]);
    expect(handOvers).toEqual([
      expect.objectContaining({
        homeNumber: 2,
        name: "Mac mini",
        grant: expect.objectContaining({
          at: "192.168.1.30:47213",
          homeKey: "pin-of-the-home",
          kind: "mac",
        }),
      }),
    ]);
    // The new home's record: the next number, the task under its key, the crewmate's conversation.
    expect(readHomeNumber(join(to.homeData, "devices"))).toBe(2);
    const db = openDatabase(to.homeData);
    const landed = new TaskService({ db, now: () => 5_000 }).get("task-1");
    const repo = db.prepare("SELECT path FROM repos WHERE id = 'r1'").get() as { path: string };
    db.close();
    expect(landed?.key).toBe(old.key);
    expect(
      readFileSync(join(to.homeData, "crewmates", "task-1", "sessions", "one.jsonl"), "utf8"),
    ).toBe('{"a":1}\n');
    // The project lands beside the others with every branch and its remote, and the record names it there.
    expect(repo.path).toBe(join(to.homeData, "fleet", "website"));
    expect(sh(repo.path, "branch", "--format=%(refname:short)", "--all")).toContain("fm/task-1");
    expect(sh(repo.path, "remote", "get-url", "origin")).toBe(
      "https://example.com/acme/website.git",
    );
    expect(to.started).toEqual([to.homeData]);
    expect(existsSync(join(to.homeData, "work", HOME_ARRIVING_DIR))).toBe(true);
  });

  it("carries no way back and no takeover: the new home lists the old one once, as the Mac it joins as", async () => {
    const old = oldHome();
    rmSync(join(old.userData, "devices", "devices.json"));
    const pairingAt = (dir: string) =>
      new DevicePairing({ dir, onProblem: () => {}, interfaces: () => ({}), ownUid: 501 });
    const pairing = pairingAt(join(old.userData, "devices"));
    // The old home kept copies, so it made its way back; it was itself made by a takeover.
    const wayBack = pairing.returningIdentity("MacBook Pro");
    expect(wayBack).not.toBeNull();
    writeFileSync(
      join(old.userData, "devices", "take-over.json"),
      `${JSON.stringify({ version: 1, id: "0b8f6c2e-4a1d-4e3b-9c7f-5d2a1e8b6c4f", at: 1, homeNumber: 1, deviceId: "studio", name: "Mac Studio", stream: null, seq: 0 })}\n`,
    );
    const to = destination();
    const movedHomes: string[] = [];
    const { outgoing, progress } = move(old, to, {
      addMovedHome: (name) => {
        const made = pairing.addMovedHome(name);
        movedHomes.push(made.deviceId);
        return made;
      },
      removeMovedHome: (deviceId) => pairing.removeMovedHome(deviceId),
    });
    pairing.dispose();
    expect((await outgoing.start("mini")).ok).toBe(true);
    expect(await finished(progress)).toMatchObject({ stage: "moved" });

    const devices = join(to.homeData, "devices");
    expect(existsSync(join(devices, "take-over.json"))).toBe(false);
    expect(existsSync(join(devices, "returning-key.json"))).toBe(false);
    const arrived = pairingAt(devices);
    expect(arrived.takeOver()).toBeNull();
    expect(arrived.list().map((device) => device.id)).toEqual(movedHomes);
    expect(existsSync(join(devices, "returning.json"))).toBe(false);
    arrived.dispose();
  });

  it("asks the commit again when the connection goes mid-arrive, and the destination answers the arrive it is running, starting one first mate", async () => {
    const old = oldHome();
    const to = destination();
    let releaseStart = () => {};
    const starting = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const slow = to.incomingAt(async () => {
      await starting;
      to.started.push(to.homeData);
      return true;
    });
    const arrives: string[] = [];
    let dropped: unknown;
    const { outgoing, progress, handOvers } = move(old, to, {
      ask: async (_id, channel, args) => {
        const sent = JSON.parse(JSON.stringify(args));
        const answer = slow.answer(channel as HomeMoveOrderChannel, sent);
        if (channel === "inf:home:arrive" && arrives.push(channel) === 1) {
          // The connection goes while the destination still puts the record in place.
          answer.catch(() => {});
          await vi.waitFor(() => expect(existsSync(join(to.homeData, "firstmate.db"))).toBe(true));
          // An abandon now is refused: the first mate is being put in place there.
          dropped = await slow.answer("inf:home:abandon", [{ move: sent[0].move }]);
          setTimeout(releaseStart, 50);
          throw new DeviceOutOfReachError();
        }
        return JSON.parse(JSON.stringify(await answer));
      },
    });
    await outgoing.start("mini");
    expect(await finished(progress)).toMatchObject({ stage: "moved" });
    expect(dropped).toEqual({ dropped: false });
    expect(progress.map((step) => step.text)).toContain(HOME_MOVE_WORDS.waitingFor("Mac mini"));
    expect(arrives).toHaveLength(2);
    expect(to.started).toHaveLength(1);
    // The old home never starts again beside the new one.
    expect(handOvers).toEqual([expect.objectContaining({ homeNumber: 2 })]);
  });

  it("copies no sign-in, and the new home asks once for each one the old home had until it is signed in there", async () => {
    const old = oldHome();
    const to = destination();
    const { outgoing, progress } = move(old, to, {
      forges: () => [{ host: "github.com", name: "GitHub" }],
    });
    await outgoing.start("mini");
    expect(await finished(progress)).toMatchObject({ stage: "moved" });
    const asked: string[] = [];
    const cleared: string[] = [];
    const cards = {
      ask: (id: string, signIn: SignInToAsk, from: string) =>
        asked.push(`${id} ${signIn.name} from ${from}`),
      clear: (id: string) => cleared.push(id),
    };
    const signedIn = { providers: [] as string[], forges: [] as string[] };
    const here = { providers: () => signedIn.providers, forges: () => signedIn.forges };
    askSignInsAgain(to.homeData, here, cards);
    expect(asked).toEqual([
      `${SIGN_IN_AGAIN_CARD}provider-claude Claude from MacBook Pro`,
      `${SIGN_IN_AGAIN_CARD}forge-github.com GitHub from MacBook Pro`,
    ]);
    // Asked once: a card put away is not raised again.
    askSignInsAgain(to.homeData, here, cards);
    expect(asked).toHaveLength(2);
    signedIn.providers.push("claude");
    signedIn.forges.push("github.com");
    askSignInsAgain(to.homeData, here, cards);
    expect(cleared).toEqual([
      `${SIGN_IN_AGAIN_CARD}provider-claude`,
      `${SIGN_IN_AGAIN_CARD}forge-github.com`,
    ]);
    expect(existsSync(join(to.homeData, SIGN_IN_AGAIN_FILE))).toBe(false);
  });

  it("sets the destination's own first mate's record aside and deletes nothing", async () => {
    const old = oldHome();
    const to = destination();
    ownRecord(to);
    const { outgoing, progress } = move(old, to);
    expect((await outgoing.ready("mini")).gaps.map((gap) => gap.id)).toEqual([
      "own-record",
      "sign-ins",
    ]);
    await outgoing.start("mini");
    expect(await finished(progress)).toMatchObject({ stage: "moved" });
    const aside = join(to.homeData, MOVED_AWAY_DIR);
    const [moveId] = execFileSync("ls", [aside], { encoding: "utf8" }).trim().split("\n");
    expect(readFileSync(join(aside, moveId ?? "", "firstmate.db"), "utf8")).toBe(
      "the mini's own record",
    );
  });

  it("names each gap on the destination before the click, and refuses to start while one blocks", async () => {
    const old = oldHome();
    const to = destination();
    const { outgoing, orders } = move(old, to, {
      appVersion: "0.8.0-alpha.599",
      providers: () => [
        { id: "claude", name: "Claude" },
        { id: "openai-codex", name: "Codex" },
      ],
      forges: () => [{ host: "github.com", name: "GitHub" }],
      sshComputers: () => [{ id: "studio", name: "Mac Studio" }],
      secretsKept: () => true,
      integrationsSignedIn: () => [{ name: "Slack" }],
      dictationOn: () => true,
      localTasks: async () => [
        {
          id: "task-1",
          handle: 'INF-1 "Fix the footer"',
          movable: false,
          refusal: "Fix the footer is waiting on its checks.",
        },
      ],
    });
    // A change the captain has not committed in the project's folder.
    writeFileSync(join(old.project, "draft.md"), "not committed\n");
    const ready = await outgoing.ready("mini");
    expect(ready.gaps.map((gap) => [gap.id, gap.level])).toEqual([
      ["version", "blocks"],
      ["task-task-1", "blocks"],
      ["sign-ins", "notes"],
      ["ssh-studio", "notes"],
      ["secrets", "notes"],
      ["integrations", "notes"],
      ["uncommitted-r1", "notes"],
      ["dictation", "notes"],
    ]);
    expect(ready.gaps.find((gap) => gap.id === "integrations")?.text).toBe(
      HOME_MOVE_WORDS.integrations("Mac mini", ["Slack"]),
    );
    expect(ready.gaps.find((gap) => gap.id === "uncommitted-r1")?.text).toBe(
      HOME_MOVE_WORDS.uncommitted(old.project),
    );
    expect(ready.gaps.find((gap) => gap.id === "dictation")?.text).toBe(
      HOME_MOVE_WORDS.dictation("Mac mini"),
    );
    expect(ready.gaps.find((gap) => gap.id === "sign-ins")?.text).toBe(
      HOME_MOVE_WORDS.signInAgain("Mac mini", ["Claude", "Codex", "GitHub"]),
    );
    expect(ready.gaps.find((gap) => gap.id === "ssh-studio")?.text).toBe(
      HOME_MOVE_WORDS.overSsh("Mac Studio", "Mac mini"),
    );
    expect(await outgoing.start("mini")).toEqual({
      ok: false,
      text: HOME_MOVE_WORDS.version("Mac mini", VERSION, "0.8.0-alpha.599"),
    });
    expect(orders.filter((order) => order !== "inf:home:ready")).toEqual([]);
  });

  it("names a host's own sign-in once: GitHub's integration row is not signed in here only as well", async () => {
    const old = oldHome();
    const to = destination();
    // GitHub's integration row is the github.com sign-in, and the move's sign-ins note names it.
    const github = { name: "GitHub", forgeHost: "github.com" };
    const { outgoing } = move(old, to, {
      providers: () => [],
      forges: () => [{ host: "github.com", name: "GitHub" }],
      integrationsSignedIn: () => [github, { name: "Slack" }],
    });
    const ready = await outgoing.ready("mini");
    expect(ready.gaps.find((gap) => gap.id === "sign-ins")?.text).toBe(
      HOME_MOVE_WORDS.signInAgain("Mac mini", ["GitHub"]),
    );
    expect(ready.gaps.find((gap) => gap.id === "integrations")?.text).toBe(
      HOME_MOVE_WORDS.integrations("Mac mini", ["Slack"]),
    );
    expect(ready.gaps.filter((gap) => gap.text.includes("GitHub"))).toHaveLength(1);
    // With no other integration, the list has no line on integrations at all.
    const alone = move(old, to, {
      providers: () => [],
      forges: () => [{ host: "github.com", name: "GitHub" }],
      integrationsSignedIn: () => [github],
    });
    const gaps = (await alone.outgoing.ready("mini")).gaps;
    expect(gaps.map((gap) => gap.id)).not.toContain("integrations");
    expect(gaps.filter((gap) => gap.text.includes("GitHub"))).toHaveLength(1);
  });

  it("blocks the move to a computer that cannot take it now, and asks it nothing", async () => {
    const old = oldHome();
    const to = destination();
    // In reach on a version that does not speak the move, or out of reach altogether.
    const silent = move(old, to, { speaksMove: () => false });
    expect((await silent.outgoing.ready("mini")).gaps).toEqual([
      { id: "out-of-reach", level: "blocks", text: HOME_MOVE_WORDS.outOfReach("Mac mini") },
    ]);
    expect(await silent.outgoing.start("mini")).toEqual({
      ok: false,
      text: HOME_MOVE_WORDS.outOfReach("Mac mini"),
    });
    expect(silent.orders).toEqual([]);
    expect(silent.held).toEqual([]);
    // It went out of reach between the offer and the click: the Ready list's own ask fails.
    const gone = move(old, to, {
      ask: async () => {
        throw new DeviceOutOfReachError();
      },
    });
    expect(await gone.outgoing.start("mini")).toEqual({
      ok: false,
      text: HOME_MOVE_WORDS.outOfReach("Mac mini"),
    });
    expect(gone.held).toEqual([]);
    expect(to.started).toEqual([]);
  });

  it("leaves every sign-in file on the old home, and the new home asks nothing for a sign-in it already has", async () => {
    const old = oldHome();
    const to = destination();
    // The old home's sign-ins as their owners keep them: Pi's store, an account's own, and a host's.
    const signInFiles = [
      join("auth", "auth.json"),
      join("accounts", "claude", "acct-1", "auth.json"),
      join("forges", "github.com", "token.json"),
    ];
    for (const file of signInFiles) {
      mkdirSync(join(old.userData, file, ".."), { recursive: true });
      writeFileSync(join(old.userData, file), '{"secret":"sign-in-of-the-old-home"}\n');
    }
    const { outgoing, progress } = move(old, to, {
      forges: () => [{ host: "github.com", name: "GitHub" }],
    });
    await outgoing.start("mini");
    expect(await finished(progress)).toMatchObject({ stage: "moved" });
    const landed = filesUnder(to.homeData);
    for (const root of ["auth", "accounts", "forges"])
      expect(landed.filter((file) => file.startsWith(`./${root}/`))).toEqual([]);
    expect(
      landed.some((file) =>
        readFileSync(join(to.homeData, file)).includes("sign-in-of-the-old-home"),
      ),
    ).toBe(false);
    // Claude is signed in on the new home before its first ask: only GitHub's card goes up.
    const asked: string[] = [];
    askSignInsAgain(
      to.homeData,
      { providers: () => ["claude"], forges: () => [] },
      { ask: (id) => asked.push(id), clear: () => {} },
    );
    expect(asked).toEqual([`${SIGN_IN_AGAIN_CARD}forge-github.com`]);
  });

  it("restarts the first mate here, with nothing lost, once the destination undid an arrive that failed after the stop", async () => {
    const old = oldHome();
    const to = destination(async () => {
      throw new Error("The disk there is full.");
    });
    ownRecord(to);
    const before = filesUnder(to.homeData);
    const { outgoing, progress, handOvers, held, orders } = move(old, to);
    await outgoing.start("mini");
    expect(await finished(progress)).toEqual(
      expect.objectContaining({
        stage: "failed",
        text: HOME_MOVE_WORDS.failedAfterStop(
          "Mac mini",
          "This computer could not start the first mate.",
        ),
      }),
    );
    expect(held).toEqual([HOME_MOVE_WORDS.holding("Mac mini")]);
    expect(handOvers).toEqual([null]);
    expect(existsSync(join(old.userData, "firstmate.db"))).toBe(true);
    // The old home started again only after the destination said it dropped the move.
    expect(orders.slice(-2)).toEqual(["inf:home:arrive", "inf:home:abandon"]);
    // The destination is as it was: its own record and grant back, nothing of the move left.
    expect(filesUnder(to.homeData)).toEqual(before);
    expect(readFileSync(join(to.homeData, "firstmate.db"), "utf8")).toBe("the mini's own record");
    expect(existsSync(join(to.homeData, "fleet", "website"))).toBe(false);
    expect(filesUnder(join(to.homeData, "work", HOME_ARRIVING_DIR))).toEqual([]);
  });

  it("undoes an arrive a restart cut short, where the first mate does not start, when the old home asks again, and then lets it go", async () => {
    const old = oldHome();
    // The destination stops while it starts the first mate: its arrive never answers.
    const to = destination(() => new Promise<boolean>(() => {}));
    ownRecord(to);
    const before = filesUnder(to.homeData);
    let order: unknown;
    const { outgoing, progress } = move(old, to, {
      ask: async (_id, channel, args) => {
        const sent = JSON.parse(JSON.stringify(args));
        if (channel === "inf:home:arrive") {
          order = sent;
          void to.incoming.answer(channel, sent);
          // It stops as it starts the first mate, its record already in place; its connection goes with it.
          await vi.waitFor(() =>
            expect(existsSync(join(to.homeData, "devices", "home-number.json"))).toBe(true),
          );
          throw new DeviceOutOfReachError();
        }
        return JSON.parse(
          JSON.stringify(await to.incoming.answer(channel as HomeMoveOrderChannel, sent)),
        );
      },
    });
    await outgoing.start("mini");
    await vi.waitFor(() => {
      expect(order).toBeDefined();
      expect(existsSync(join(to.homeData, "devices", "home-number.json"))).toBe(true);
    });
    // The work mode there starts again, with nothing in memory of the arrive, and cannot start the first mate.
    const restarted = to.incomingAt(async () => false);
    await expect(restarted.answer("inf:home:arrive", order)).rejects.toThrow(
      "The move was cut short here and is undone.",
    );
    // The record is as it was; the move's own files wait in the work folder until it is let go.
    expect(
      filesUnder(to.homeData).filter((path) => !path.startsWith(`./work/${HOME_ARRIVING_DIR}/`)),
    ).toEqual(before);
    expect(to.started).toEqual([]);
    const [{ move: moveId }] = order as [{ move: string }];
    expect(await restarted.answer("inf:home:abandon", [{ move: moveId }])).toEqual({
      dropped: true,
    });
    expect(filesUnder(join(to.homeData, "work", HOME_ARRIVING_DIR, moveId))).toEqual([]);
    expect(progress.at(-1)?.stage).toBe("arriving");
  });

  it("keeps a move a restart cut short while the first mate started, since it may run on the placed record, and refuses its abandon", async () => {
    const old = oldHome();
    // The destination stops while it starts the first mate: its arrive never answers.
    const to = destination(() => new Promise<boolean>(() => {}));
    let order: unknown;
    const { outgoing, progress, handOvers } = move(old, to, {
      ask: async (_id, channel, args) => {
        const sent = JSON.parse(JSON.stringify(args));
        if (channel === "inf:home:arrive" && order === undefined) {
          order = sent;
          void to.incoming.answer(channel, sent);
          await vi.waitFor(() =>
            expect(existsSync(join(to.homeData, "devices", "home-number.json"))).toBe(true),
          );
          // The work mode there starts again; the first mate it starts now answers.
          to.incoming = to.incomingAt(async () => {
            to.started.push(to.homeData);
            return true;
          });
          throw new DeviceOutOfReachError();
        }
        return JSON.parse(
          JSON.stringify(await to.incoming.answer(channel as HomeMoveOrderChannel, sent)),
        );
      },
    });
    await outgoing.start("mini");
    // The work mode there started again, and the first mate it started answers.
    expect(await finished(progress)).toMatchObject({ stage: "moved" });
    expect(handOvers).toEqual([expect.objectContaining({ homeNumber: 2 })]);
    expect(to.started).toEqual([to.homeData]);
    expect(readHomeNumber(join(to.homeData, "devices"))).toBe(2);
    expect(existsSync(join(to.homeData, "firstmate.db"))).toBe(true);
    const [{ move: moveId }] = order as [{ move: string }];
    expect(await to.incoming.answer("inf:home:abandon", [{ move: moveId }])).toEqual({
      dropped: false,
    });
  });

  it("settles an arrive a restart cut short once, however many abandons and arrives the old home asks meanwhile", async () => {
    const old = oldHome();
    // The destination stops while it starts the first mate: its arrive never answers.
    const to = destination(() => new Promise<boolean>(() => {}));
    let order: [{ move: string; homeNumber: number; manifestSha256: string }] | undefined;
    const { outgoing } = move(old, to, {
      ask: async (_id, channel, args) => {
        const sent = JSON.parse(JSON.stringify(args));
        if (channel === "inf:home:arrive") {
          order = sent;
          void to.incoming.answer(channel, sent);
          // The old home quits here; the test asks its orders itself.
          return new Promise(() => {});
        }
        return JSON.parse(
          JSON.stringify(await to.incoming.answer(channel as HomeMoveOrderChannel, sent)),
        );
      },
    });
    await outgoing.start("mini");
    await vi.waitFor(() =>
      expect(existsSync(join(to.homeData, "devices", "home-number.json"))).toBe(true),
    );
    // The work mode there starts again; starting the first mate takes a moment.
    let starts = 0;
    let letStart: (started: boolean) => void = () => {};
    to.incoming = to.incomingAt(() => {
      starts++;
      return new Promise<boolean>((resolve) => {
        letStart = resolve;
      });
    });
    const [{ move: moveId }] = order as NonNullable<typeof order>;
    const abandons = [
      to.incoming.answer("inf:home:abandon", [{ move: moveId }]),
      to.incoming.answer("inf:home:abandon", [{ move: moveId }]),
    ];
    const arrive = to.incoming.answer("inf:home:arrive", order as NonNullable<typeof order>);
    await vi.waitFor(() => expect(starts).toBe(1));
    letStart(true);
    expect(await Promise.all(abandons)).toEqual([{ dropped: false }, { dropped: false }]);
    expect(await arrive).toMatchObject({ addresses: ["192.168.1.30:47213"] });
    expect(starts).toBe(1);
    expect(existsSync(join(to.homeData, "firstmate.db"))).toBe(true);
  });

  it("keeps the first mate stopped across a restart of the old home, and asks the destination again from its mark", async () => {
    const old = oldHome();
    const to = destination();
    const first = move(old, to, {
      ask: async (_id, channel, args) => {
        const answer = await to.incoming.answer(
          channel as HomeMoveOrderChannel,
          JSON.parse(JSON.stringify(args)),
        );
        // The old home quits before the destination's answer reaches it.
        if (channel === "inf:home:arrive") return new Promise(() => {});
        return JSON.parse(JSON.stringify(answer));
      },
    });
    await first.outgoing.start("mini");
    await vi.waitFor(() => expect(to.started).toHaveLength(1));
    expect(movePending(join(old.userData, "home-moving"))).toBe(true);
    expect(first.handOvers).toEqual([]);
    // It launches again on the same data folder: its first mate stays stopped and the move ends.
    const second = move(old, to);
    expect(await second.outgoing.resume()).toBe(true);
    expect(await finished(second.progress)).toMatchObject({ stage: "moved" });
    expect(second.held).toEqual([HOME_MOVE_WORDS.holding("Mac mini")]);
    expect(second.handOvers).toEqual([expect.objectContaining({ homeNumber: 2 })]);
    expect(to.started).toHaveLength(1);
    // A launch with no mark finds nothing to resume.
    expect(await move(oldHome(), destination()).outgoing.resume()).toBe(false);
  });

  it("keeps asking the abandon when the destination refuses it, and starts the first mate here only once it dropped the move", async () => {
    const old = oldHome();
    const to = destination(async () => false);
    let refusals = 0;
    const { outgoing, progress, handOvers } = move(old, to, {
      ask: async (_id, channel, args) => {
        if (channel === "inf:home:abandon" && refusals++ === 0)
          throw new Error("A folder there is in use.");
        return JSON.parse(
          JSON.stringify(
            await to.incoming.answer(
              channel as HomeMoveOrderChannel,
              JSON.parse(JSON.stringify(args)),
            ),
          ),
        );
      },
    });
    await outgoing.start("mini");
    expect(await finished(progress)).toMatchObject({ stage: "failed" });
    expect(progress.map((step) => step.text)).toContain(
      HOME_MOVE_WORDS.notDropped("Mac mini", "A folder there is in use."),
    );
    expect(handOvers).toEqual([null]);
    expect(movePending(join(old.userData, "home-moving"))).toBe(false);
  }, 15_000);

  it("offers to start the first mate here again only once the destination stayed out of reach a while, and then the old home takes the higher home number and stops asking", async () => {
    const old = oldHome();
    const to = destination();
    let clock = 1_000_000;
    let arrives = 0;
    let back = false;
    const raised: number[] = [];
    const removed: string[] = [];
    const { outgoing, progress, handOvers } = move(old, to, {
      now: () => clock,
      inReach: () => back,
      raiseHomeNumber: (homeNumber) => raised.push(homeNumber),
      removeMovedHome: (deviceId) => removed.push(deviceId),
      ask: async (_id, channel, args) => {
        // The destination goes dark for good once the old home stopped.
        if (channel === "inf:home:arrive") {
          arrives++;
          throw new DeviceOutOfReachError();
        }
        return JSON.parse(
          JSON.stringify(
            await to.incoming.answer(
              channel as HomeMoveOrderChannel,
              JSON.parse(JSON.stringify(args)),
            ),
          ),
        );
      },
    });
    await outgoing.start("mini");
    await vi.waitFor(() => expect(arrives).toBe(1));
    // Too soon: the old home keeps asking and offers nothing.
    expect(progress.some((step) => step.startHere)).toBe(false);
    expect(outgoing.startHere()).toEqual({
      ok: false,
      text: HOME_MOVE_WORDS.stillAsking("Mac mini"),
    });
    clock += START_HERE_OFFER_MS;
    await vi.waitFor(() => expect(progress.at(-1)).toMatchObject({ startHere: true }), {
      timeout: 5_000,
    });
    // The destination comes back for a moment: the offer goes and Start here is refused.
    back = true;
    await vi.waitFor(() => expect(progress.at(-1)?.startHere).toBeUndefined(), { timeout: 5_000 });
    expect(outgoing.startHere().ok).toBe(false);
    // Out of reach again, the wait starts over.
    back = false;
    const asked = arrives;
    await vi.waitFor(() => expect(arrives).toBeGreaterThan(asked), { timeout: 5_000 });
    expect(outgoing.startHere().ok).toBe(false);
    clock += START_HERE_OFFER_MS;
    await vi.waitFor(() => expect(progress.at(-1)).toMatchObject({ startHere: true }), {
      timeout: 5_000,
    });
    expect(outgoing.startHere()).toEqual({
      ok: true,
      text: HOME_MOVE_WORDS.startedHere("Mac mini"),
    });
    // One above the number the destination would take, so devices refuse it if it comes back.
    expect(raised).toEqual([3]);
    expect(removed).toEqual(["old-home"]);
    expect(movePending(join(old.userData, "home-moving"))).toBe(false);
    expect(handOvers).toEqual([null]);
    expect(progress.at(-1)).toMatchObject({
      stage: "failed",
      text: HOME_MOVE_WORDS.startedHere("Mac mini"),
    });
    // It never asks the destination again, and a second click finds nothing.
    const last = arrives;
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(arrives).toBe(last);
    expect(handOvers).toEqual([null]);
    expect(outgoing.startHere().ok).toBe(false);
  }, 30_000);

  it("puts back what a move set aside even where something was made again since, setting that aside in turn", () => {
    const to = destination();
    ownRecord(to);
    setAsideRecord(to.homeData, "m1", ["joined"]);
    writeFileSync(join(to.homeData, "firstmate.db"), "made since");
    restoreAside(to.homeData, "m1", ["joined"]);
    expect(readFileSync(join(to.homeData, "firstmate.db"), "utf8")).toBe("the mini's own record");
    expect(readFileSync(join(to.homeData, "joined", "grant.json"), "utf8")).toBe(
      "the mini's own grant",
    );
    expect(filesUnder(join(to.homeData, MOVED_AWAY_DIR, "m1"))).toEqual([
      "./made-since/firstmate.db",
    ]);
  });

  it("refuses an abandon once the first mate arrived, so the old home never starts beside it", async () => {
    const old = oldHome();
    const to = destination();
    let moveId = "";
    const { outgoing, progress } = move(old, to, {
      ask: async (_id, channel, args) => {
        const sent = JSON.parse(JSON.stringify(args));
        if (channel === "inf:home:arrive") moveId = sent[0].move;
        return JSON.parse(
          JSON.stringify(await to.incoming.answer(channel as HomeMoveOrderChannel, sent)),
        );
      },
    });
    await outgoing.start("mini");
    expect(await finished(progress)).toMatchObject({ stage: "moved" });
    expect(await to.incoming.answer("inf:home:abandon", [{ move: moveId }])).toEqual({
      dropped: false,
    });
    expect(existsSync(join(to.homeData, "firstmate.db"))).toBe(true);
  });

  it("carries the local-only repository of tasks with no project, setting the destination's own aside", async () => {
    const old = oldHome();
    const own = join(old.userData, "default-workspace");
    mkdirSync(own, { recursive: true });
    sh(own, "init", "-q", "-b", "main");
    sh(own, "config", "user.email", "test@example.com");
    sh(own, "config", "user.name", "Test");
    writeFileSync(join(own, "notes.md"), "notes\n");
    sh(own, "add", ".");
    sh(own, "commit", "-q", "-m", "notes");
    sh(own, "branch", "fm/task-2");
    const to = destination();
    mkdirSync(join(to.homeData, "default-workspace"), { recursive: true });
    writeFileSync(join(to.homeData, "default-workspace", "mine.md"), "the mini's own\n");
    const { outgoing, progress } = move(old, to, {
      projects: () => [
        { id: "r1", path: old.project },
        { id: "default-workspace", path: own },
      ],
    });
    await outgoing.start("mini");
    expect(await finished(progress)).toMatchObject({ stage: "moved" });
    const landed = join(to.homeData, "default-workspace");
    expect(sh(landed, "branch", "--format=%(refname:short)")).toContain("fm/task-2");
    const [moveId] = execFileSync("ls", [join(to.homeData, MOVED_AWAY_DIR)], { encoding: "utf8" })
      .trim()
      .split("\n");
    expect(
      readFileSync(
        join(to.homeData, MOVED_AWAY_DIR, moveId ?? "", "default-workspace", "mine.md"),
        "utf8",
      ),
    ).toBe("the mini's own\n");
  });

  it("stops before the stop when a project with commits cannot be bundled, never cloning it empty", async () => {
    const old = oldHome();
    // A branch that names a commit the repository does not hold.
    writeFileSync(join(old.project, ".git", "refs", "heads", "broken"), `${"1".repeat(40)}\n`);
    const to = destination();
    const { outgoing, progress, held } = move(old, to);
    await outgoing.start("mini");
    expect(await finished(progress)).toMatchObject({ stage: "failed" });
    expect(progress.at(-1)?.text).toContain(HOME_MOVE_WORDS.failed("Mac mini", ""));
    expect(held).toEqual([]);
    expect(existsSync(join(to.homeData, "fleet", "website"))).toBe(false);
  });

  it("stops with the task's own reason when a task asked to move waits on a problem", async () => {
    const old = oldHome();
    const to = destination();
    const asked: string[] = [];
    const handle = 'INF-1 "Fix the footer"';
    const { outgoing, progress, held } = move(old, to, {
      localTasks: async () => [
        asked.length
          ? {
              id: "task-1",
              handle,
              movable: false,
              refusal: `${handle} is moving.`,
              moving: {
                to: "mini",
                problem: `${handle} cannot move: its work could not be packed.`,
              },
            }
          : { id: "task-1", handle, movable: true },
      ],
      moveTask: async (id) => {
        asked.push(id);
        return { ok: true, text: "" };
      },
    });
    await outgoing.start("mini");
    expect(await finished(progress)).toMatchObject({
      stage: "failed",
      text: HOME_MOVE_WORDS.failed(
        "Mac mini",
        HOME_MOVE_WORDS.taskStays(`${handle} cannot move: its work could not be packed.`),
      ),
    });
    expect(held).toEqual([]);
  });

  it("says its first step as the click is accepted, before anything crosses", async () => {
    const old = oldHome();
    const to = destination();
    const { outgoing, progress, orders } = move(old, to);
    expect(await outgoing.start("mini")).toEqual({
      ok: true,
      text: HOME_MOVE_WORDS.started("Mac mini"),
    });
    // The Ready list shows this step from the click on, however long the project and the record take to cross.
    expect(orders).not.toContain(HOME_RECEIVE_ORDER);
    expect(progress).toEqual([
      {
        deviceId: "mini",
        name: "Mac mini",
        stage: "copying",
        text: HOME_MOVE_WORDS.started("Mac mini"),
      },
    ]);
    expect(await finished(progress)).toMatchObject({ stage: "moved" });
  });

  it("refuses a second click while the first one's Ready list is still read", async () => {
    const old = oldHome();
    const to = destination();
    const { outgoing, progress } = move(old, to);
    const [first, second] = await Promise.all([outgoing.start("mini"), outgoing.start("mini")]);
    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, text: HOME_MOVE_WORDS.alreadyMoving });
    expect(await finished(progress)).toMatchObject({ stage: "moved" });
  });

  it("stops a move cancelled before the stop, and the first mate never stops", async () => {
    const old = oldHome();
    const to = destination();
    const cancelled: string[] = [];
    const { outgoing, progress, held } = move(old, to, {
      // The task is still crossing when the captain cancels.
      localTasks: async () => [
        { id: "task-1", handle: 'INF-1 "Fix the footer"', movable: true, moving: { to: "mini" } },
      ],
      cancelTask: (id) => cancelled.push(id),
    });
    await outgoing.start("mini");
    await vi.waitFor(() => expect(progress.at(-1)?.stage).toBe("tasks"));
    expect(outgoing.cancel()).toEqual({ ok: true, text: HOME_MOVE_WORDS.cancelling });
    expect(await finished(progress)).toMatchObject({
      stage: "cancelled",
      text: HOME_MOVE_WORDS.cancelled,
    });
    expect(held).toEqual([]);
    expect(cancelled).toEqual(["task-1"]);
    expect(outgoing.moving()).toBe(false);
  });

  it("stops a project part-way across when the move is cancelled, sending none of its later pieces", async () => {
    const old = oldHome();
    // A project whose bundle takes three pieces: a committed nine-megabyte file that does not compress, such as a photo.
    writeFileSync(join(old.project, "photo.jpg"), randomBytes(9 * 1024 * 1024));
    sh(old.project, "add", ".");
    sh(old.project, "commit", "-q", "-m", "photo");
    const to = destination();
    const pieces: { path: string; offset: number }[] = [];
    const answers: { ok: boolean; text: string }[] = [];
    let cancel = () => ({ ok: false, text: "" });
    const { outgoing, progress, held } = move(old, to, {
      ask: async (_id, channel, args) => {
        if (channel === HOME_RECEIVE_ORDER) {
          const [{ path, offset }] = args as [{ path: string; offset: number }];
          pieces.push({ path, offset });
          // The captain presses Cancel the move while the project's first piece crosses.
          if (pieces.length === 1) answers.push(cancel());
        }
        const answer = await to.incoming.answer(
          channel as HomeMoveOrderChannel,
          JSON.parse(JSON.stringify(args)),
        );
        return JSON.parse(JSON.stringify(answer));
      },
    });
    cancel = () => outgoing.cancel();
    await outgoing.start("mini");
    expect(await finished(progress)).toMatchObject({
      stage: "cancelled",
      text: HOME_MOVE_WORDS.cancelled,
    });
    expect(answers).toEqual([{ ok: true, text: HOME_MOVE_WORDS.cancelling }]);
    expect(pieces).toEqual([{ path: "projects/0.bundle", offset: 0 }]);
    expect(held).toEqual([]);
    expect(outgoing.moving()).toBe(false);
    // The destination drops the piece that crossed.
    await vi.waitFor(() =>
      expect(filesUnder(join(to.homeData, "work", HOME_ARRIVING_DIR))).toEqual([]),
    );
  });

  it("raises the new home's real sign-in cards only for what is missing, counting a host sign-in it cannot read now as present", () => {
    const to = destination();
    keepSignInsToAsk(to.homeData, "MacBook Pro", {
      providers: [{ id: "claude", name: "Claude" }],
      forges: [
        { host: "github.com", name: "GitHub" },
        { host: "gitlab.com", name: "GitLab" },
        { host: "codeberg.org", name: "Codeberg" },
      ],
    });
    const cards = cardServiceSetup().make();
    const accounts: { providerId: string }[] = [];
    const sinks: CoreEventSink[] = [];
    const services = {
      paths: { userData: to.homeData },
      supervisor: { cards },
      vault: { list: () => accounts },
      forges: {
        view: () => ({
          signIns: [
            // A saved sign-in reads unknown at start and unavailable offline; only the host's refusal is absent.
            { host: "github.com", state: "unknown" },
            { host: "gitlab.com", state: "unavailable" },
            { host: "codeberg.org", state: "needs_reauth" },
          ],
        }),
      },
    } as unknown as CoreServices;
    askSignInsAgainAt(services, (sink) => {
      sinks.push(sink);
      return () => {};
    });
    const up = () =>
      [
        `${SIGN_IN_AGAIN_CARD}provider-claude`,
        `${SIGN_IN_AGAIN_CARD}forge-github.com`,
        `${SIGN_IN_AGAIN_CARD}forge-gitlab.com`,
        `${SIGN_IN_AGAIN_CARD}forge-codeberg.org`,
      ].filter((id) => cards.get(id) !== undefined);
    expect(up()).toEqual([
      `${SIGN_IN_AGAIN_CARD}provider-claude`,
      `${SIGN_IN_AGAIN_CARD}forge-codeberg.org`,
    ]);
    expect(cards.get(`${SIGN_IN_AGAIN_CARD}provider-claude`)).toMatchObject({
      author: "host",
      title: expect.stringContaining("Claude"),
      actions: [expect.objectContaining({ effect: { kind: "open", target: "subscriptions" } })],
    });
    // Claude is signed in there: the next quota push takes its card down, and Codeberg's stays.
    accounts.push({ providerId: "claude" });
    for (const sink of sinks) sink("inf:quota", {} as never);
    expect(up()).toEqual([`${SIGN_IN_AGAIN_CARD}forge-codeberg.org`]);
  });
});
