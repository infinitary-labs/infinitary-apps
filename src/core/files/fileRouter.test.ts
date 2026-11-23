import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { FileOrderChannel } from "@shared/files";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { LOCAL_MACHINE_ID } from "../session/session";
import { deliverHandoverFile, handoverFileName } from "../tasks/handoverFiles";
import { FileReach, privateFolders, protectedPlaces } from "./fileReach";
import { type FileComputer, FileRouter, splitTarget } from "./fileRouter";

/**
 * The home's side of the files command (docs/files.md): every task's list
 * and copy, wherever the task runs and wherever the file is. Each computer
 * here is a real `FileReach` on a scratch home; an order to the computer
 * that runs work crosses as JSON, as it does on the connection.
 */

const MINI = "device-mini";
/** A computer that runs work as another macOS user on the home's own Mac. */
const BUILDER = "device-builder";

function reachOn(name: string) {
  // As the computer names it once links are followed, as a copy's `from` does.
  const home = realpathSync(scratchDir(`infinitary-files-${name}-home-`));
  const userData = join(home, "Library", "Application Support", "infinitary");
  mkdirSync(join(userData, "accounts"), { recursive: true });
  writeFileSync(join(userData, "accounts", "registry.json"), "{}");
  mkdirSync(join(home, "Documents"), { recursive: true });
  const stagingDir = join(scratchDir(`infinitary-files-${name}-staging-`), "set-aside");
  const reach = new FileReach({
    home,
    protectedPlaces: protectedPlaces({ userData, home }),
    privatePlaces: privateFolders(home),
    stagingDir,
  });
  return { home, userData, reach, stagingDir };
}

function setUp(options: { tamper?: boolean; builder?: boolean } = {}) {
  const home = reachOn("home");
  const mini = reachOn("mini");
  // Another macOS user on the home's own Mac: its reader runs as that user, on the same disk.
  const builder = reachOn("builder");
  // Folders of the captain's closed to that user. The test runs as one user, so each is
  // closed while that computer answers, as macOS closes a 0700 folder to every other user.
  const closedToBuilder: string[] = [];
  const tasks = new Map<string, { machine: string; running: boolean }>([
    ["task-home", { machine: LOCAL_MACHINE_ID, running: true }],
    ["task-mini", { machine: MINI, running: true }],
    ["task-builder", { machine: BUILDER, running: true }],
    ["task-closed", { machine: LOCAL_MACHINE_ID, running: false }],
  ]);
  const handover = new Map<string, string>(
    [...tasks.keys()].map((task) => [
      task,
      join(scratchDir(`infinitary-files-${task}-`), "handover"),
    ]),
  );
  const computers: FileComputer[] = [
    { id: MINI, name: "Kun's Mac mini", inReach: true, answers: true, onThisMac: false },
    { id: "device-imac", name: "Old iMac", inReach: true, answers: false, onThisMac: false },
    { id: "device-studio", name: "Studio", inReach: false, answers: true, onThisMac: false },
    ...(options.builder
      ? [{ id: BUILDER, name: "Builder", inReach: true, answers: true, onThisMac: true }]
      : []),
  ];
  const notes: { task: string; text: string }[] = [];
  const asked: FileOrderChannel[] = [];
  const orders: { machine: string; channel: FileOrderChannel; args: unknown }[] = [];
  const fetchedDir = join(scratchDir("infinitary-files-fetched-"), "fetched");
  const router = new FileRouter({
    here: home.reach,
    homeName: () => "Kun's MacBook Pro",
    computers: () => computers,
    ask: async (machine, channel, args) => {
      expect([MINI, BUILDER]).toContain(machine);
      asked.push(channel);
      orders.push({ machine, channel, args });
      const reader = machine === BUILDER ? builder : mini;
      const closing = machine === BUILDER ? closedToBuilder : [];
      for (const folder of closing) chmodSync(folder, 0o000);
      let said: unknown;
      try {
        said = await reader.reach.answer(channel, JSON.parse(JSON.stringify(args)));
      } finally {
        for (const folder of closing) chmodSync(folder, 0o700);
      }
      const answer = JSON.parse(JSON.stringify(said));
      if (options.tamper && channel === "inf:files:read") {
        const bytes = Buffer.from(answer.data, "base64");
        bytes[0] = (bytes[0] ?? 0) ^ 0xff;
        answer.data = bytes.toString("base64");
      }
      return answer;
    },
    machineOf: (task) => tasks.get(task)?.machine ?? LOCAL_MACHINE_ID,
    refusal: (task) =>
      tasks.get(task)?.running
        ? undefined
        : "this task is not running, so it has no hand-over folder to save into.",
    deliver: async (task, path, name, sha256) => {
      const file = handoverFileName(name, sha256);
      return { file, path: await deliverHandoverFile(path, handover.get(task) ?? "", file) };
    },
    note: (task, text) => notes.push({ task, text }),
    stagingDir: fetchedDir,
  });
  return {
    home,
    mini,
    builder,
    closedToBuilder,
    router,
    notes,
    asked,
    orders,
    handover,
    fetchedDir,
  };
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function leftIn(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir) : [];
}

describe("the files command at the home", () => {
  it("names every computer, which ones are in reach, and the one the task runs on", async () => {
    const { router } = setUp();
    expect(await router.forTask("task-mini").computers()).toEqual({
      data: {
        computers: [
          {
            name: "Kun's MacBook Pro",
            role: "the computer where your first mate lives",
            reach: "in reach",
            thisTask: false,
          },
          { name: "Kun's Mac mini", role: "runs work", reach: "in reach", thisTask: true },
          {
            name: "Old iMac",
            role: "runs work",
            reach: "needs Infinitary updated",
            thisTask: false,
          },
          { name: "Studio", role: "runs work", reach: "out of reach", thisTask: false },
        ],
      },
    });
  });

  it("copies a file from a computer that runs work into a home task's hand-over folder, and notes it", async () => {
    const { mini, router, notes, asked, handover, fetchedDir } = setUp();
    const bytes = Buffer.from("clip,length\nintro,12\n".repeat(400_000));
    writeFileSync(join(mini.home, "Documents", "clips.csv"), bytes);
    const files = router.forTask("task-home");
    const listing = await files.list("kuns mac mini:~/Documents");
    expect(listing.data).toMatchObject({
      computer: "Kun's Mac mini",
      entries: [{ name: "clips.csv", kind: "file", size: bytes.length }],
    });
    const copied = await files.copy("Kun's Mac mini:~/Documents/clips.csv");
    const into = join(
      handover.get("task-home") ?? "",
      handoverFileName("clips.csv", sha256(bytes)),
    );
    expect(copied).toEqual({
      data: {
        copied: into,
        from: `Kun's Mac mini:${join(mini.home, "Documents", "clips.csv")}`,
        size: bytes.length,
        sha256: sha256(bytes),
      },
    });
    expect(readFileSync(into).equals(bytes)).toBe(true);
    expect(statSync(into).mode & 0o777).toBe(0o600);
    expect(asked.filter((channel) => channel === "inf:files:read").length).toBeGreaterThan(1);
    expect(asked.at(-1)).toBe("inf:files:release");
    expect(notes).toEqual([
      {
        task: "task-home",
        text: `copied ${join(mini.home, "Documents", "clips.csv")} from Kun's Mac mini into its hand-over folder (8.0 MB)`,
      },
    ]);
    expect(leftIn(mini.stagingDir)).toEqual([]);
    expect(leftIn(fetchedDir)).toEqual([]);
  });

  it("copies the home's database in use for a crewmate on a computer that runs work", async () => {
    const { home, router, handover, asked } = setUp();
    const file = join(home.userData, "firstmate.db");
    const db = new Database(file);
    try {
      db.pragma("journal_mode = WAL");
      db.exec("create table tasks (key text); insert into tasks values ('INF-2468')");
      const copied = await router.forTask("task-mini").copy(`home:${file}`);
      expect(copied.data).toMatchObject({
        from: `Kun's MacBook Pro:${file}`,
        database: "copied through its own backup, so it is complete",
      });
      const kept = String(copied.data?.copied);
      expect(kept.startsWith(handover.get("task-mini") ?? "-")).toBe(true);
      const copy = new Database(kept, { readonly: true });
      try {
        expect(copy.prepare("select key from tasks").all()).toEqual([{ key: "INF-2468" }]);
      } finally {
        copy.close();
      }
    } finally {
      db.close();
    }
    expect(asked).toEqual([]);
    expect(leftIn(home.stagingDir)).toEqual([]);
  });

  it("refuses in words a crewmate can act on, and copies nothing", async () => {
    const { home, mini, router, notes, handover } = setUp();
    writeFileSync(join(home.home, "Documents", "a.txt"), "a");
    writeFileSync(join(mini.home, "Documents", "b.txt"), "b");
    const cases: [string, string, string][] = [
      [
        "task-mini",
        "Kun's Mac mini:~/Documents/b.txt",
        "~/Documents/b.txt is on Kun's Mac mini, where this task runs: read it there with your own tools.",
      ],
      [
        "task-home",
        "Garage PC:~/x",
        "No computer is called Garage PC: name one of Kun's MacBook Pro, Kun's Mac mini, Old iMac, Studio.",
      ],
      ["task-home", "Studio:~/x", "Studio is out of reach now; ask again once it is back."],
      [
        "task-home",
        "Old iMac:~/x",
        "Infinitary on Old iMac must be updated before its files can be read.",
      ],
      [
        "task-home",
        "~/Documents/a.txt",
        "Name a computer and a path, such as home:~/Documents; run infinitary-files-axi for the computers' names.",
      ],
      [
        "task-closed",
        "Kun's Mac mini:~/Documents/b.txt",
        "Nothing was copied: this task is not running, so it has no hand-over folder to save into.",
      ],
      [
        "task-home",
        `Kun's Mac mini:${join(mini.userData, "accounts", "registry.json")}`,
        "holds the app's own sign-ins or keys, which the files command never copies.",
      ],
    ];
    for (const [task, target, words] of cases) {
      const answer = await router.forTask(task).copy(target);
      expect(answer.refused).toBe("refused");
      expect(answer.text).toContain(words);
    }
    expect(notes).toEqual([]);
    for (const dir of handover.values()) expect(leftIn(dir)).toEqual([]);
  });

  it("refuses a copy that did not arrive whole, and delivers nothing", async () => {
    const { mini, router, notes, handover, fetchedDir } = setUp({ tamper: true });
    writeFileSync(join(mini.home, "Documents", "b.txt"), "the real words");
    const answer = await router.forTask("task-home").copy("Kun's Mac mini:~/Documents/b.txt");
    expect(answer).toEqual({
      text: "The copy from Kun's Mac mini did not arrive whole; ask for it again.",
      refused: "refused",
    });
    expect(leftIn(handover.get("task-home") ?? "")).toEqual([]);
    expect(leftIn(fetchedDir)).toEqual([]);
    expect(leftIn(mini.stagingDir)).toEqual([]);
    expect(notes).toEqual([]);
  });

  it("reads a home file for another user on this Mac as that user, never one only the captain can read nor their private folders", async () => {
    const { home, builder, closedToBuilder, router, notes, orders, handover } = setUp({
      builder: true,
    });
    const homeReads = vi.spyOn(home.reach, "snapshot");
    // A file only the captain can read: in a folder of theirs closed to every other user.
    const project = join(home.home, "Projects", "private");
    mkdirSync(project, { recursive: true, mode: 0o700 });
    writeFileSync(join(project, "plan.txt"), "the captain's plan", { mode: 0o600 });
    closedToBuilder.push(project);
    writeFileSync(join(home.home, "Documents", "letter.txt"), "dear");
    mkdirSync(join(home.home, ".ssh"));
    writeFileSync(join(home.home, ".ssh", "id_ed25519"), "key");
    mkdirSync(join(home.home, "Public"));
    const shared = Buffer.from("for everyone on this Mac");
    writeFileSync(join(home.home, "Public", "shared.txt"), shared);
    // A link outside the private folders that leads into one, followed as that user reads it.
    symlinkSync(join(home.home, "Documents"), join(home.home, "Public", "letters"));
    const files = router.forTask("task-builder");

    // What that user can read itself arrives, read on its own computer and noted as the home's.
    const copied = await files.copy("home:~/Public/shared.txt");
    expect(copied.data).toMatchObject({
      from: `Kun's MacBook Pro:${join(home.home, "Public", "shared.txt")}`,
      size: shared.length,
      sha256: sha256(shared),
    });
    expect(
      orders
        .filter((order) => order.channel === "inf:files:snapshot")
        .map((order) => [order.machine, order.args]),
    ).toEqual([[BUILDER, [{ path: join(home.home, "Public", "shared.txt") }]]]);

    const privateWords =
      "is in a private folder - Desktop, Documents, Library or ~/.ssh - which the files command never copies for another user on the same computer.";
    const cases: [string, string][] = [
      ["home:~/Documents/letter.txt", `~/Documents/letter.txt ${privateWords}`],
      ["home:~/.ssh/id_ed25519", `~/.ssh/id_ed25519 ${privateWords}`],
      ["home:~/Public/letters/letter.txt", `~/Public/letters/letter.txt ${privateWords}`],
      [
        `home:${join(home.userData, "accounts", "registry.json")}`,
        "holds the app's own sign-ins or keys, which the files command never copies.",
      ],
    ];
    // macOS closes the captain's 0700 folder to that user; a test run as root reads every folder.
    if (process.getuid?.() !== 0)
      cases.push([
        "home:~/Projects/private/plan.txt",
        `${join(project, "plan.txt")} could not be read: this computer's user may not read it.`,
      ]);
    for (const [target, words] of cases) {
      const answer = await files.copy(target);
      expect(answer.refused).toBe("refused");
      expect(answer.text).toContain(words);
    }
    expect(notes).toEqual([
      {
        task: "task-builder",
        text: `copied ${join(home.home, "Public", "shared.txt")} from Kun's MacBook Pro into its hand-over folder (${shared.length} bytes)`,
      },
    ]);
    expect(leftIn(handover.get("task-builder") ?? "")).toEqual([
      handoverFileName("shared.txt", sha256(shared)),
    ]);
    expect(homeReads).not.toHaveBeenCalled();
    expect(leftIn(builder.stagingDir)).toEqual([]);

    const listing = await files.list("home:~");
    const kinds = Object.fromEntries(
      ((listing.data?.entries ?? []) as { name: string; kind: string }[]).map((entry) => [
        entry.name,
        entry.kind,
      ]),
    );
    expect(kinds).toEqual({
      ".ssh": "protected",
      Documents: "protected",
      Library: "protected",
      Projects: "folder",
      Public: "folder",
    });

    // A task on another Mac keeps the full reach: the file only the captain can read arrives.
    const full = await router.forTask("task-mini").copy("home:~/Projects/private/plan.txt");
    expect(full.data).toMatchObject({
      from: `Kun's MacBook Pro:${join(project, "plan.txt")}`,
      size: "the captain's plan".length,
    });
    expect(homeReads).toHaveBeenCalledTimes(1);
  });

  it("splits a target at the colon that starts its path", () => {
    expect(splitTarget("Kun's Mac mini:~/Documents")).toEqual({
      computer: "Kun's Mac mini",
      path: "~/Documents",
    });
    expect(splitTarget("home:/a:b.txt")).toEqual({ computer: "home", path: "/a:b.txt" });
    expect(splitTarget("home:")).toEqual({ computer: "home", path: "~" });
    expect(splitTarget("lab:1:/data")).toEqual({ computer: "lab:1", path: "/data" });
    expect(splitTarget("~/Documents")).toBeUndefined();
    expect(splitTarget(":/x")).toBeUndefined();
  });
});
