import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { PAIRING_LINK_TTL_MS, parsePairingLink } from "../../shared/devices";
import {
  LINK_COMMAND_PATH,
  linkCommandAnswerSchema,
  PHONE_DOOR_FILES,
  PHONE_DOOR_FOLDER,
  PHONE_DOOR_KEY_HEADER,
  PHONE_DOOR_PATH,
  PHONE_KEY_PLACED,
  PHONE_LINK_COMMAND,
  PHONE_LINK_HEADER,
  PHONE_PLACE_KEY_COMMAND,
} from "../../shared/phoneLink";
import { DevicePairing } from "./pairing";
import { PhoneDoor } from "./phoneDoor";

/**
 * INF-1183, the captain's approved plan "join a home from the iOS app by SSH
 * address" (Macs and Linux homes in this build): the fixed commands a phone
 * runs over SSH, for real - each login shell this computer has running the
 * command line as sshd hands it over, the system's curl, and the door the
 * app opens over real pairing, so the link it answers is one pairing made.
 */

const doors: PhoneDoor[] = [];
afterEach(() => {
  for (const door of doors.splice(0)) door.close();
});

/** The login shells an account may have, as sshd runs a command: `<shell> -c <line>`. */
const SHELLS = ["/bin/sh", "/bin/bash", "/bin/zsh", "/bin/dash", "/bin/tcsh", "/bin/csh"].filter(
  (shell) => existsSync(shell),
);

function run(shell: string, line: string, env: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      shell,
      ["-c", line],
      { env: { PATH: "/usr/bin:/bin", ...env }, timeout: 10_000 },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`${shell}: ${error.message}\n${stderr}`));
        else resolve(stdout);
      },
    );
  });
}

/** The one answer line, as the phone reads it: the last line naming the door. */
function answer(stdout: string): string[] {
  const line = stdout
    .split("\n")
    .filter((each) => each.startsWith(`${PHONE_LINK_HEADER} `))
    .at(-1);
  if (!line) throw new Error(`No answer line in ${JSON.stringify(stdout)}`);
  return line.split(" ").slice(1);
}

async function openHome(data: string) {
  const pairing = new DevicePairing({ dir: join(data, "devices"), interfaces: () => ({}) });
  const door = await PhoneDoor.open({
    dir: join(data, PHONE_DOOR_FOLDER),
    invite: (phone) => pairing.invite({ kind: "mac", ...(phone ? { phone } : {}) }),
  });
  doors.push(door);
  return { pairing, door };
}

function post(
  address: string,
  headers: Record<string, string>,
  path = PHONE_DOOR_PATH,
  method = "POST",
): Promise<number> {
  return ask(address, headers, path, method).then(({ status }) => status);
}

function ask(
  address: string,
  headers: Record<string, string>,
  path: string,
  method = "POST",
): Promise<{ status: number; type: string | undefined; body: string }> {
  const [host, port] = address.split(":");
  return new Promise((resolve, reject) => {
    const sent = httpRequest({ host, port: Number(port), method, path, headers }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;
      });
      response.on("end", () =>
        resolve({
          status: response.statusCode ?? 0,
          type: response.headers["content-type"],
          body,
        }),
      );
    });
    sent.on("error", reject);
    sent.end();
  });
}

function doorKey(data: string): string {
  return readFileSync(join(data, PHONE_DOOR_FOLDER, PHONE_DOOR_FILES.key), "utf8")
    .split(": ")[1]
    ?.trim() as string;
}

describe("the phone's link command", () => {
  it.each(SHELLS)("answers a one-use phone link that pairing made, under %s", async (shell) => {
    const home = scratchDir("infinitary-phone-door-home-");
    const data = join(home, "data");
    const { pairing } = await openHome(data);
    const said = answer(
      await run(shell, PHONE_LINK_COMMAND, { HOME: home, INFINITARY_USER_DATA_DIR: data }),
    );
    expect(said.slice(0, 2)).toEqual(["1", "link"]);
    const link = parsePairingLink(said[2] ?? "");
    expect(link.kind).toBe("mac");
    expect(link.key).toBe(pairing.identity().pin);
    // A second ask is a second link: each is good for one use.
    const again = answer(
      await run(shell, PHONE_LINK_COMMAND, { HOME: home, INFINITARY_USER_DATA_DIR: data }),
    );
    expect(parsePairingLink(again[2] ?? "").code).not.toBe(link.code);
  });

  it("finds the door in a Mac's and a Linux computer's own data folder", async () => {
    for (const folder of [
      join("Library", "Application Support", "infinitary"),
      join(".config", "infinitary"),
    ]) {
      const home = scratchDir("infinitary-phone-door-home-");
      await openHome(join(home, folder));
      const said = answer(await run("/bin/sh", PHONE_LINK_COMMAND, { HOME: home }));
      expect(said.slice(0, 2), folder).toEqual(["1", "link"]);
    }
  });

  it("keeps the door's key and address to its owner, and empties the folder on close", async () => {
    const data = scratchDir("infinitary-phone-door-data-");
    const { door } = await openHome(data);
    const folder = join(data, PHONE_DOOR_FOLDER);
    expect(statSync(folder).mode & 0o777).toBe(0o700);
    for (const file of Object.values(PHONE_DOOR_FILES))
      expect(statSync(join(folder, file)).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(folder, PHONE_DOOR_FILES.address), "utf8").trim()).toBe(door.address);
    door.close();
    expect(existsSync(folder)).toBe(false);
  });

  it("refuses a request without the key, with another key, or from a web page", async () => {
    const data = scratchDir("infinitary-phone-door-data-");
    const { door } = await openHome(data);
    const key = doorKey(data);
    expect(await post(door.address, {})).toBe(401);
    expect(await post(door.address, { [PHONE_DOOR_KEY_HEADER]: "0".repeat(64) })).toBe(401);
    expect(
      await post(door.address, { [PHONE_DOOR_KEY_HEADER]: key, Origin: "https://example.com" }),
    ).toBe(403);
    expect(await post(door.address, { [PHONE_DOOR_KEY_HEADER]: key })).toBe(200);
  });

  it("says Infinitary is not open when no app holds the account's data folder", async () => {
    const home = scratchDir("infinitary-phone-door-home-");
    const data = join(home, "data");
    mkdirSync(data, { recursive: true });
    // A lock a crashed app left names a process that is gone.
    symlinkSync("a-mac-2147483646", join(data, "SingletonLock"));
    expect(
      answer(
        await run("/bin/sh", PHONE_LINK_COMMAND, { HOME: home, INFINITARY_USER_DATA_DIR: data }),
      ),
    ).toEqual(["1", "none", "not-open"]);
  });

  it("says Infinitary is not open when its door stays from an app that stopped", async () => {
    const home = scratchDir("infinitary-phone-door-home-");
    const data = join(home, "data");
    const { door } = await openHome(data);
    const files = Object.values(PHONE_DOOR_FILES).map((file) => {
      const path = join(data, PHONE_DOOR_FOLDER, file);
      return [path, readFileSync(path, "utf8")] as const;
    });
    door.close();
    mkdirSync(join(data, PHONE_DOOR_FOLDER), { recursive: true });
    for (const [path, text] of files) writeFileSync(path, text, { mode: 0o600 });
    expect(
      answer(
        await run("/bin/sh", PHONE_LINK_COMMAND, { HOME: home, INFINITARY_USER_DATA_DIR: data }),
      ),
    ).toEqual(["1", "none", "not-open"]);
  });

  it("says an open Infinitary with no door is too old", async () => {
    const home = scratchDir("infinitary-phone-door-home-");
    const data = join(home, "Library", "Application Support", "infinitary");
    mkdirSync(data, { recursive: true });
    // Chromium's single-instance lock names the running app's host and process.
    symlinkSync(`a-mac-${process.pid}`, join(data, "SingletonLock"));
    expect(answer(await run("/bin/sh", PHONE_LINK_COMMAND, { HOME: home }))).toEqual([
      "1",
      "none",
      "too-old",
    ]);
  });

  it("says pairing made no link when the door answers without one", async () => {
    const home = scratchDir("infinitary-phone-door-home-");
    const data = join(home, "data");
    doors.push(
      await PhoneDoor.open({
        dir: join(data, PHONE_DOOR_FOLDER),
        invite: () => {
          throw new Error("The saved device list cannot be read.");
        },
      }),
    );
    expect(
      answer(
        await run("/bin/sh", PHONE_LINK_COMMAND, { HOME: home, INFINITARY_USER_DATA_DIR: data }),
      ),
    ).toEqual(["1", "none", "refused"]);
  });
});

/**
 * INF-1228's approved plan, piece 3: "`infinitary link` prints a link for
 * another computer or a code for a phone". The command asks this door, with
 * its key, for either kind of link (docs/run.md, "A link by command").
 */
describe("the door's answer to infinitary link", () => {
  it("answers a computer's link and a phone's, as pairing made them, with when each expires", async () => {
    const data = scratchDir("infinitary-link-door-data-");
    const pairing = new DevicePairing({ dir: join(data, "devices"), interfaces: () => ({}) });
    const asked: boolean[] = [];
    const door = await PhoneDoor.open({
      dir: join(data, PHONE_DOOR_FOLDER),
      invite: (phone) => {
        asked.push(phone);
        return pairing.invite({ kind: "mac", ...(phone ? { phone } : {}) });
      },
    });
    doors.push(door);
    const key = { [PHONE_DOOR_KEY_HEADER]: doorKey(data) };
    const codes: string[] = [];
    for (const kind of ["computer", "phone"] as const) {
      const said = await ask(door.address, key, `${LINK_COMMAND_PATH}?for=${kind}`);
      expect(said.status).toBe(200);
      expect(said.type).toBe("application/json; charset=utf-8");
      const answer = linkCommandAnswerSchema.parse(JSON.parse(said.body));
      if (!("link" in answer)) throw new Error(said.body);
      expect(answer.expiresAt - Date.now()).toBeGreaterThan(PAIRING_LINK_TTL_MS - 60_000);
      const link = parsePairingLink(answer.link);
      expect(link.kind).toBe("mac");
      expect(link.key).toBe(pairing.identity().pin);
      codes.push(link.code);
    }
    // The phone's asks pairing for a phone's link; each is its own one-use link.
    expect(asked).toEqual([false, true]);
    expect(new Set(codes).size).toBe(2);
  });

  it("refuses the command's request without the key, from a web page, or for another kind", async () => {
    const data = scratchDir("infinitary-link-door-data-");
    const { door } = await openHome(data);
    const key = doorKey(data);
    const path = `${LINK_COMMAND_PATH}?for=computer`;
    expect(await post(door.address, {}, path)).toBe(401);
    expect(
      await post(
        door.address,
        { [PHONE_DOOR_KEY_HEADER]: key, Origin: "https://example.com" },
        path,
      ),
    ).toBe(403);
    expect(await post(door.address, { [PHONE_DOOR_KEY_HEADER]: key }, path, "GET")).toBe(405);
    expect(
      await post(door.address, { [PHONE_DOOR_KEY_HEADER]: key }, `${LINK_COMMAND_PATH}?for=view`),
    ).toBe(400);
  });

  it("says why pairing made no link, in pairing's own words", async () => {
    const data = scratchDir("infinitary-link-door-data-");
    doors.push(
      await PhoneDoor.open({
        dir: join(data, PHONE_DOOR_FOLDER),
        invite: () => {
          throw new Error("The saved device list cannot be read.");
        },
      }),
    );
    const door = doors.at(-1) as PhoneDoor;
    const said = await ask(
      door.address,
      { [PHONE_DOOR_KEY_HEADER]: doorKey(data) },
      `${LINK_COMMAND_PATH}?for=phone`,
    );
    expect(said.status).toBe(503);
    expect(JSON.parse(said.body)).toEqual({ refused: "The saved device list cannot be read." });
  });
});

describe("the phone's key command", () => {
  const keyLine =
    "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBPhone infinitary-phone";

  it.each(SHELLS)("lets the phone's key in once, under %s", async (shell) => {
    const home = scratchDir("infinitary-phone-key-home-");
    mkdirSync(join(home, ".ssh"));
    // An account's own key, with no newline after it.
    writeFileSync(join(home, ".ssh", "authorized_keys"), "ssh-ed25519 AAAAC3Own own");
    const line = `${PHONE_PLACE_KEY_COMMAND} '${keyLine}'`;
    expect((await run(shell, line, { HOME: home })).trim()).toBe(PHONE_KEY_PLACED);
    expect((await run(shell, line, { HOME: home })).trim()).toBe(PHONE_KEY_PLACED);
    const file = join(home, ".ssh", "authorized_keys");
    expect(readFileSync(file, "utf8")).toBe(`ssh-ed25519 AAAAC3Own own\n${keyLine}\n`);
    expect(statSync(file).mode & 0o022).toBe(0);
  });

  it("makes the folder and the file when the account has neither", async () => {
    const home = scratchDir("infinitary-phone-key-home-");
    expect(
      (await run("/bin/sh", `${PHONE_PLACE_KEY_COMMAND} '${keyLine}'`, { HOME: home })).trim(),
    ).toBe(PHONE_KEY_PLACED);
    expect(statSync(join(home, ".ssh")).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(home, ".ssh", "authorized_keys"), "utf8")).toBe(`${keyLine}\n`);
  });
});
