import { execFile } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { COMMAND_PATH, LOCAL_DOOR_KEY_HEADER } from "@shared/connection";
import { invokeContract } from "@shared/ipc";
import { decode } from "@toon-format/toon";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { bundleAxiProcess } from "../../../tests/helpers/axiProcessBundle";
import { fakeHost, quotaFixture, waitFor } from "../../../tests/helpers/bootedCore";
import { claimedPort } from "../../../tests/helpers/claimedPort";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { startConnection } from "../connection/connection";
import { readLocalDoor } from "../connection/localDoor";
import { type Core, startCore } from "../index";
import { INBOX_COMMAND, INFINITARY_COMMAND } from "../integrations/commandWords";
import { INBOX_ID } from "../integrations/providers/inbox";
import { catalogRefreshesSettled } from "../pi/modelRuntime";
import { forkChildProcess } from "../sql/forkChildProcess";
import { openDatabase } from "../storage/db";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import { SKILL_TEXT } from "./captainCommands";
import { openCommandDoor } from "./commandDoor";
import { AXI_KEY_HEADER } from "./protocol";

// The core chains real git here and is not about the utility-QoS clamp, so
// what it spawns runs at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

vi.setConfig({ testTimeout: 30_000 });

/**
 * INF-1894, from INF-1880's plan and INF-1893's agreed design (the captain's
 * picks: nouns with verbs, the raw verb `api`, the daily nouns with
 * automation and knowledge, setup as a thin skill): `infinitary-axi` runs
 * from any shell of the person's, reaches the running app through the
 * connection's local door with the door's key, and reads as the captain.
 * These run it for real: the shell launcher in `resources/axi-bin` by `sh`
 * with the system's curl, the local door's pinned TLS, the command process
 * bundled as the app builds it, and the whole core, which raises a stall
 * card for each stuck task at boot.
 */

const BIN_DIR = resolve(__dirname, "../../../resources/axi-bin");

let userDataDir: string;
let core: Core;
let connection: ReturnType<typeof startConnection>;
let closeDoor: () => void;
const stuck = ["axi-read", "axi-watch", "axi-off", "axi-act", "axi-api"] as const;

beforeAll(async () => {
  const entry = await bundleAxiProcess();
  userDataDir = scratchDir("infinitary-axi-captain-");
  quotaFixture("infinitary-axi-captain-quota-");
  process.env.PI_OFFLINE = "1";
  // Crewmates idle for an hour and a half, nudged and woken twice: each
  // gets its stall card at boot, a decision with buttons.
  const db = openDatabase(userDataDir);
  const tasks = new TaskService({ db });
  const now = Date.now();
  for (const id of stuck) {
    const worktreeDir = join(userDataDir, "worktrees", id);
    mkdirSync(worktreeDir, { recursive: true });
    seedTask(tasks, { id, title: `Tidy ${id}`, status: "completed", worktreeDir });
    tasks.turns.recordRecovery(id, {
      rung: 2,
      count: 2,
      at: now - 35 * 60_000,
      idleSince: now - 90 * 60_000,
    });
  }
  db.close();
  core = await startCore({
    ...fakeHost(userDataDir).host,
    axiProcess: forkChildProcess(entry),
  });
  // As the app wires it (src/main/app.ts): the door's command beside the connection.
  const door = openCommandDoor(core);
  if (!door) throw new Error("the core opened no command process");
  closeDoor = () => door.close();
  connection = startConnection({
    dispatch: core.dispatch,
    events: core.events,
    devices: core.services.devices,
    port: await claimedPort(),
    localDoor: core.paths.localDoorDir,
    command: door.serve,
  });
  await connection.settled();
  await core.services.integrations.signIn(INBOX_ID);
  const booted = core;
  await waitFor(
    () =>
      stuck.every((id) =>
        booted.services.supervisor.cards.snapshot().some((card) => card.id === `card-stall-${id}`),
      ),
    10_000,
  );
}, 90_000);

afterAll(async () => {
  closeDoor?.();
  await connection?.close();
  core?.dispose();
  await catalogRefreshesSettled();
  delete process.env.INFINITARY_QUOTA_FIXTURE_DIR;
});

/** The command as a person's own shell runs it: by `sh`, with only a search path and a home. */
function run(
  args: string[],
  env: NodeJS.ProcessEnv = {},
  command: string = INFINITARY_COMMAND,
): Promise<{ stdout: string; exitCode: number }> {
  return new Promise((done) => {
    execFile(
      "/bin/sh",
      ["-c", `'${join(BIN_DIR, command)}' "$@"`, "sh", ...args],
      {
        env: {
          PATH: process.env.PATH ?? "",
          HOME: scratchDir("infinitary-axi-home-"),
          INFINITARY_DATA: userDataDir,
          ...env,
        },
      },
      (error, stdout) =>
        done({ stdout, exitCode: error ? Number((error as { code?: number }).code ?? 1) : 0 }),
    );
  });
}

/** What an answer printed above its help lines, as data. */
function answer(stdout: string): Record<string, unknown> {
  return decode(stdout.split(/\nhelp\[/)[0] ?? "") as Record<string, unknown>;
}

describe("infinitary-axi", () => {
  it("reads your cards, a task and the published contract as you", async () => {
    const cardId = "card-stall-axi-read";
    const key = core.services.tasks.get("axi-read")?.key;
    if (!key) throw new Error("the stuck task has no key");

    // Bare, it shows what waits on you first, then the next commands.
    const home = await run([]);
    expect(home.exitCode).toBe(0);
    // The bin line names the command's own file, the home folder shortened to ~.
    const bin = join(BIN_DIR, INFINITARY_COMMAND).replace(homedir(), "~");
    expect(home.stdout).toContain(`bin: ${bin}`);
    const homeRows = decode(home.stdout) as {
      cards: { id: string; kind: string }[];
      tasks: string;
      help: string[];
    };
    expect(homeRows.cards).toContainEqual(
      expect.objectContaining({ id: cardId, kind: "decision" }),
    );
    expect(homeRows.tasks).toMatch(/^\d+ waiting on you · \d+ working · /);
    expect(homeRows.help).toContain(`${INFINITARY_COMMAND} card show <id>`);

    // A card as plain words, with its buttons and the one recommended.
    const shown = await run(["card", "show", cardId]);
    expect(shown.exitCode).toBe(0);
    const card = answer(shown.stdout) as {
      id: string;
      body: string;
      actions: { id: string; recommended: boolean }[];
    };
    const live = core.services.supervisor.cards.snapshot().find((one) => one.id === cardId);
    expect(card.id).toBe(cardId);
    expect(card.body).not.toMatch(/<[a-z/]/i);
    expect(card.actions.map((action) => action.id)).toEqual(
      live?.actions.map((action) => action.id),
    );
    expect(card.actions.filter((action) => action.recommended)).toHaveLength(
      live?.actions.filter((action) => action.default).length ?? 0,
    );

    // A task by its key.
    const task = answer((await run(["task", "show", key])).stdout);
    expect(task).toMatchObject({ key, title: "Tidy axi-read" });

    // The raw verb: the contract's own arguments, and a read sent.
    const detail = answer((await run(["api", "show", "inf:tasks:detail"])).stdout);
    expect(detail).toMatchObject({ channel: "inf:tasks:detail", effect: "read", required: 1 });
    const read = await run(["api", "inf:tasks:detail", "axi-read"]);
    expect(read.exitCode).toBe(0);
    expect(answer(read.stdout)).toMatchObject({ value: { key, title: "Tidy axi-read" } });
    const malformed = await run(["api", "inf:tasks:detail"]);
    expect(malformed.exitCode).toBe(2);
    expect(malformed.stdout).toContain("inf:tasks:detail takes 1 argument, 0 given");
    // Nothing that stays the window's, such as Secrets, is listed.
    const listed = answer((await run(["api", "list"])).stdout) as {
      channels: { channel: string }[];
    };
    expect(listed.channels.length).toBeGreaterThan(0);
    expect(listed.channels.filter((row) => row.channel.includes("secret"))).toEqual([]);
  });

  it("changes as you, and records each change as yours from the command", async () => {
    // INF-1895, piece 2 of INF-1880's plan: changes as the captain, recorded in
    // the trail as from the command so the record tells them from a window click.
    const cardId = "card-stall-axi-act";
    const live = core.services.supervisor.cards.snapshot().find((one) => one.id === cardId);
    const button = live?.actions[0];
    if (!button) throw new Error("the stall card has no button");

    // A button the card does not have is a malformed ask, and nothing is pressed.
    const wrong = await run(["card", "act", cardId, "no-such-button"]);
    expect(wrong.exitCode).toBe(2);
    expect(wrong.stdout).toContain(`Buttons: ${live.actions.map((one) => one.id).join(", ")}`);

    const pressed = await run(["card", "act", cardId, button.id]);
    expect(pressed.exitCode).toBe(0);
    expect(answer(pressed.stdout)).toMatchObject({ card: cardId, pressed: button.label });
    expect(core.services.supervisor.cards.snapshot().map((one) => one.id)).not.toContain(cardId);
    const resolved = core.services.tasks
      .timeline("axi-act")
      .filter((event) => event.kind === "card_resolved");
    expect(resolved.at(-1)).toMatchObject({ actor: "captain", data: { through: "command" } });
    // The task's record says where the change came from.
    const detail = await core.dispatch("inf:tasks:detail", ["axi-act"]);
    expect(JSON.stringify(detail)).toContain(`From ${INFINITARY_COMMAND}.`);

    // Closing it again is nothing to do: an answer, exit 0.
    const again = await run(["card", "close", cardId]);
    expect(again.exitCode).toBe(0);
    expect(answer(again.stdout)).toMatchObject({ card: cardId, closed: "already" });

    // The raw verb sends a change of the contract as you, recorded the same way.
    expect(invokeContract["inf:cards:act"].effect).toBe("change");
    const viaApi = await run(["api", "inf:cards:act", "card-stall-axi-api", button.id, "chrome"]);
    expect(viaApi.exitCode).toBe(0);
    expect(
      core.services.tasks
        .timeline("axi-api")
        .filter((event) => event.kind === "card_resolved")
        .at(-1),
    ).toMatchObject({ actor: "captain", data: { through: "command" } });

    // Your words reach your first mate as from the window's input.
    const said = await run(["say", "What is waiting on me?"]);
    expect(said.exitCode).toBe(0);
    expect(answer(said.stdout)).toMatchObject({ sent: "yes" });
    expect(core.services.tasks.capture.lastTurn()?.you).toBe("What is waiting on me?");
  });

  it("watches a change after its cursor, and answers a cursor from before with reloaded", async () => {
    const cardId = "card-stall-axi-watch";
    const now = answer((await run(["watch", "--for", "0"])).stdout) as { cursor: string };
    expect(now.cursor).toMatch(/^[0-9a-f-]{36}-\d+$/);

    // The captain discards the card in the window; watch prints the cards' change.
    const watching = run(["watch", "--after", now.cursor, "--only", "cards", "--for", "20"]);
    await core.dispatch("inf:cards:act", [cardId, "discard", "chrome"], { kind: "captain" });
    const seen = await watching;
    expect(seen.exitCode).toBe(0);
    // A click in the window is the window's, never the command's.
    expect(
      core.services.tasks
        .timeline("axi-watch")
        .filter((event) => event.kind === "card_resolved")
        .at(-1)?.data?.through,
    ).toBeUndefined();
    const changes = answer(seen.stdout) as { changes: { channel: string }[]; cursor: string };
    expect(changes.changes.map((change) => change.channel)).toContain("inf:cards");
    expect(changes.cursor).not.toBe(now.cursor);

    const old = answer((await run(["watch", "--after", "00000000-1", "--for", "0"])).stdout);
    expect(old).toMatchObject({ reloaded: true });
  });

  it("admits only the door's key, never a task's shell, and is off with the inbox's switch", async () => {
    // A copy of the door's folder with another key reaches nothing.
    const door = readLocalDoor(core.paths.localDoorDir);
    if (!door) throw new Error("no local door");
    const elsewhere = scratchDir("infinitary-axi-wrong-");
    cpSync(core.paths.localDoorDir, join(elsewhere, "local-door"), { recursive: true });
    writeFileSync(join(elsewhere, "local-door", "key"), `${"0".repeat(64)}\n`, { mode: 0o600 });
    const wrong = await run(["allowance"], { INFINITARY_DATA: elsewhere });
    expect(wrong.exitCode).toBe(1);
    expect(wrong.stdout).toContain("code: NO_CHANNEL");

    // A task's shell is the crew's: the launcher refuses it, and so does the door.
    const shell = await run(["allowance"], { INFINITARY_AXI_KEY: "/nowhere" });
    expect(shell.exitCode).toBe(1);
    expect(shell.stdout).toContain("never for the crew");
    const [host, port] = door.address.split(":");
    const crew = await new Promise<string>((done, fail) => {
      const request = httpsRequest(
        {
          host,
          port: Number(port),
          method: "POST",
          path: COMMAND_PATH,
          rejectUnauthorized: false,
          headers: { [LOCAL_DOOR_KEY_HEADER]: door.key, [AXI_KEY_HEADER]: "a task's key" },
        },
        (response) => {
          let text = "";
          response.on("data", (chunk: Buffer) => {
            text += chunk.toString("utf8");
          });
          response.on("end", () => done(text));
        },
      );
      request.on("error", fail);
      request.end(`tool=${INFINITARY_COMMAND}&arg=allowance`);
    });
    expect(crew).toContain("code: REFUSED");

    // Switched off in Integrations, every verb refuses and nothing is kept for watch;
    // on again, it answers, and a cursor from before the switch went off reloads (INF-3639 F1).
    const before = answer((await run(["watch", "--for", "0"])).stdout) as { cursor: string };
    core.services.integrations.configure(INBOX_ID, { paused: true });
    try {
      const off = await run(["allowance"]);
      expect(off.exitCode).toBe(1);
      expect(off.stdout).toContain(`${INFINITARY_COMMAND} is off in Settings → Integrations`);
      // Turned on before, its notes are kept, and the refusal says so (the captain's answer on F17).
      expect(off.stdout).toContain("your saved notes stay");
      await core.dispatch("inf:cards:act", ["card-stall-axi-off", "discard", "chrome"], {
        kind: "captain",
      });
    } finally {
      core.services.integrations.configure(INBOX_ID, { paused: false });
    }
    expect((await run(["allowance"])).exitCode).toBe(0);
    const missed = answer((await run(["watch", "--after", before.cursor, "--for", "0"])).stdout);
    expect(missed).toMatchObject({ reloaded: true });
  });

  it("answers its old name for one release with a notice, and keeps the inbox's note", async () => {
    const noted = await run(["note", "--source", "ci", "Deploy finished"], {}, INBOX_COMMAND);
    expect(noted.exitCode).toBe(0);
    const [notice, ...rest] = noted.stdout.split("\n");
    expect(notice).toBe(`notice: ${INBOX_COMMAND} is now ${INFINITARY_COMMAND}`);
    expect(decode(rest.join("\n").split(/\nhelp\[/)[0] ?? "")).toMatchObject({ recorded: true });
  });

  it("says saved notes stay only while notes are kept, never after they are deleted", async () => {
    // The captain's answer on F17: "Say notes stay only while notes are actually kept".
    await core.services.integrations.remove(INBOX_ID);
    try {
      const deleted = await run(["allowance"]);
      expect(deleted.exitCode).toBe(1);
      expect(deleted.stdout).toContain(`${INFINITARY_COMMAND} is off in Settings → Integrations`);
      expect(deleted.stdout).not.toContain("notes");
    } finally {
      await core.services.integrations.signIn(INBOX_ID);
    }
    expect((await run(["allowance"])).exitCode).toBe(0);
  });

  it("writes the thin skill that points an agent at it, and checks it", async () => {
    const skills = scratchDir("infinitary-axi-skills-");
    const missing = await run(["setup", "--check", "--dir", skills]);
    expect(missing.exitCode).toBe(1);
    expect(missing.stdout).toContain("is missing");

    expect((await run(["setup", "skill", "--dir", skills])).exitCode).toBe(0);
    const path = join(skills, INFINITARY_COMMAND, "SKILL.md");
    expect(readFileSync(path, "utf8")).toBe(SKILL_TEXT);
    expect((await run(["setup", "--check", "--dir", skills])).exitCode).toBe(0);

    writeFileSync(path, "an older skill\n");
    const stale = await run(["setup", "--check", "--dir", skills]);
    expect(stale.exitCode).toBe(1);
    expect(stale.stdout).toContain("is stale");
  });
});
