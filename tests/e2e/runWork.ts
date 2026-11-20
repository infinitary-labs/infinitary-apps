import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { type NetworkInterfaceInfo, userInfo } from "node:os";
import { join } from "node:path";
import electronPath from "electron";
import { type HomeConnection, startConnection } from "../../src/core/connection/connection";
import { claimLink } from "../../src/core/devices/dial";
import { APPIMAGE_LIBRARIES } from "../../src/core/devices/farSystems";
import { shellWord } from "../../src/core/devices/joinCommand";
import { JoinedHome } from "../../src/core/devices/joinedHome";
import { DevicePairing } from "../../src/core/devices/pairing";
import type { CoreDispatch } from "../../src/core/dispatcher";
import { CoreEventBus } from "../../src/core/events";
import { serviceLabel } from "../../src/core/helper/background";
import { HomeRoute } from "../../src/core/helper/route";
import { hostEnv } from "../../src/core/hostEnv";
import { claimedPort } from "../helpers/claimedPort";
import type { PlacedHome } from "../helpers/placedHome";
import { scratchDir } from "../helpers/scratchDirs";
import { forwardSocket, type SocketForward } from "../helpers/socketForward";
import type { SshServer } from "../helpers/sshServer";
import { trackChildTree } from "../helpers/stopChildTree";
import { builtAppDir, packagedEntry } from "./launch";
import { signedInClaudeHome, writeMockClaudeClient } from "./mockClaudeClient";
import type { MockProviderServer } from "./mockProvider";
import { writeWorkServiceManager } from "./workFixtures";

/**
 * What the work mode's journeys share (docs/helper.md): the home on this
 * Mac's loopback, a throwaway user whose work runs as `<app> work ...` from
 * Terminal, the commands a person types there, and what each test leaves
 * running, which `endRunWork` stops after each test.
 * `run-work.spec.ts`, `run-work-command.spec.ts`, `run-work-update.spec.ts`,
 * `run-work-ssh.spec.ts` and `run-work-tasks.spec.ts` import this file.
 */

export const ME = { name: userInfo().username, uid: process.getuid?.() ?? 0 };
export const THIS_MAC = { thisMac: true, host: "127.0.0.1" };

export const standIn = (async (channel) => {
  throw new Error(`Rejected ${channel}`);
}) as CoreDispatch;

export const connections: HomeConnection[] = [];
export const pairings: DevicePairing[] = [];
export const children: (() => Promise<void>)[] = [];
export const homes: PlacedHome[] = [];
export const providers: MockProviderServer[] = [];
export const sshServers: SshServer[] = [];
export const forwards: SocketForward[] = [];
export const sshStops: (() => Promise<void>)[] = [];

/** Stops what the test left running; each journey runs it after each test. */
export async function endRunWork(): Promise<void> {
  await Promise.all(sshStops.splice(0).map((stop) => stop()));
  await Promise.all(sshServers.splice(0).map((server) => server.stop()));
  await Promise.all(forwards.splice(0).map((forward) => forward.close()));
  // The approved leftover-program guard found shell-launched work apps and
  // their detached display keepers surviving the old direct-child kill.
  await Promise.all(children.splice(0).map((stop) => stop()));
  await Promise.all(homes.splice(0).map((home) => home.quit()));
  await Promise.all(connections.splice(0).map((connection) => connection.close()));
  for (const pairing of pairings.splice(0)) pairing.dispose();
  await Promise.all(providers.splice(0).map((provider) => provider.close()));
}

export async function home(
  ownUid: number,
  app?: string,
  /** This Mac's own network addresses as the home reads them; none unless a test gives some. */
  network: () => NodeJS.Dict<NetworkInterfaceInfo[]> = () => ({}),
) {
  let port = await claimedPort();
  const pairing = new DevicePairing({
    dir: join(scratchDir("infinitary-run-work-home-"), "devices"),
    onProblem: () => {},
    interfaces: network,
    port,
    ownUid,
  });
  pairings.push(pairing);
  const listen = () => {
    const connection = startConnection({
      dispatch: standIn,
      events: new CoreEventBus(),
      devices: pairing,
      port,
      name: () => "MacBook Pro",
      // What a command on another Mac gets from this home.
      ...(app ? { app: () => app } : {}),
    });
    connections.push(connection);
    return connection;
  };
  let connection = listen();
  return {
    pairing,
    /** The home's connection now, which asks a computer its orders. */
    connection: () => connection,
    /** Where the home answers now. */
    at: () => `127.0.0.1:${port}`,
    link: async () => {
      const { link } = pairing.invite({ kind: "work", at: `127.0.0.1:${port}` });
      await connection.settled();
      return link;
    },
    /** The link inside the command for another user on this Mac, where the home sends it. */
    command: async () => {
      const { link } = pairing.invite({ kind: "work", command: "another-user" });
      await connection.settled();
      return link;
    },
    /** The home's address changes: it stops answering where it was, and answers somewhere else. */
    move: async () => {
      await connection.close();
      port = await claimedPort();
      connection = listen();
      await connection.settled();
    },
    /** Firstmate quits there, and later opens again where it was. */
    quit: () => connection.close(),
    reopen: async () => {
      connection = listen();
      await connection.settled();
    },
    /** Firstmate there is gone for good: nothing answers where it was. */
    gone: () => connection.close(),
    /**
     * A computer joined to this home as one that reaches it only through the
     * home's own SSH connection, with the far end of that connection on this
     * Mac (`forwardSocket`) and the home's name heard, as the join keeps them.
     * The test uses the link where the work mode there would (docs/helper.md,
     * "Through the home's SSH").
     */
    overSsh: async (dataDir: string) => {
      const forward = await forwardSocket(port);
      forwards.push(forward);
      const { link } = pairing.invite(
        { kind: "work" },
        { remoteLogin: "sam@mini.local", via: "ssh", locality: "elsewhere" },
      );
      await connection.settled();
      const grant = await claimLink(
        link,
        { kind: "work", name: "Studio Mac", user: { name: "sam", uid: ME.uid } },
        { target: { socket: forward.socket } },
      );
      const joined = new JoinedHome(dataDir);
      joined.join(grant, Date.now());
      joined.name("MacBook Pro");
      /** The home's connection keeps its route there now. */
      const publish = () => {
        const route = new HomeRoute(dataDir);
        route.publish(route.begin(), {
          socket: forward.socket,
          homeKey: grant.homeKey,
          deviceId: grant.deviceId,
        });
      };
      return { forward, grant, publish };
    },
  };
}

/** The built app's own version, which `work version` answers and a command carries from its home. */
export function appVersion(): string {
  return JSON.parse(readFileSync(join(builtAppDir(), "package.json"), "utf8")).version;
}

/** Whether this computer's background is a systemd user service, as on Linux, or a Mac's launchd agent. */
const SYSTEMD = process.platform === "linux";

/**
 * The background as this system's service manager keeps it
 * (src/core/helper/background.ts), for a user whose home folder is
 * `homeDir`: the agent's label and file, and each call its stand-in is asked
 * for setting it up, stopping its run, starting it again and taking it away.
 */
function backgroundOf(homeDir: string) {
  const label = serviceLabel("dev");
  if (SYSTEMD) {
    const unit = `${label}.service`;
    return {
      label: unit,
      file: join(homeDir, ".config", "systemd", "user", unit),
      /** The agent's file names a word of its command line. */
      holds: (word: string) => `"${word}"`,
      // Runtime/session checks precede setup and the actual manager load (INF-1617).
      started: [
        "--user show-environment",
        "--user show-environment",
        "--user daemon-reload",
        `--user restart ${unit}`,
      ],
      paused: [`--user stop ${unit}`],
      removed: [
        "--user daemon-reload",
        `--user reset-failed ${unit}`,
        `--user stop --no-block ${unit}`,
      ],
    };
  }
  const domain = `gui/${ME.uid}`;
  const file = join(homeDir, "Library", "LaunchAgents", `${label}.plist`);
  return {
    label,
    file,
    holds: (word: string) => `<string>${word}</string>`,
    started: [`bootout ${domain}/${label}`, `bootstrap ${domain} ${file}`],
    paused: [`bootout ${domain}/${label}`],
    removed: [`bootout ${domain}/${label}`],
  };
}

/**
 * One user's world: a throwaway home, and the folder its work keeps. With a
 * model, its Claude login is signed in and its client is the boxed one that
 * talks only to that mock provider (tests/e2e/mockClaudeClient.ts). Its
 * service manager - launchctl on a Mac, systemctl on Linux - is a stand-in
 * that writes down what it was asked, so no test ever loads a real agent;
 * stopping the agent also stops the run a test started as the agent's
 * (`agentPid`), as launchd and systemd stop an agent's process.
 */
export function user(model?: MockProviderServer) {
  const homeDir = scratchDir("infinitary-run-work-user-");
  const dataDir = join(homeDir, "work");
  if (model) signedInClaudeHome(homeDir);
  const { manager, asked, agentPid } = writeWorkServiceManager(homeDir, SYSTEMD);
  return {
    homeDir,
    dataDir,
    /** Where a test writes the run it started as the agent's, for the stand-in's stop to end. */
    agentPid,
    /** This user's background as its service manager keeps it. */
    background: backgroundOf(homeDir),
    /** What the service manager was asked, one call a line. */
    managerAsked: () => (existsSync(asked) ? readFileSync(asked, "utf8").trim().split("\n") : []),
    env: hostEnv({
      HOME: homeDir,
      CFFIXED_USER_HOME: homeDir,
      INFINITARY_HELPER_DATA_DIR: dataDir,
      // Where this user's own systemd reads their services, inside its home.
      ...(SYSTEMD
        ? { XDG_CONFIG_HOME: join(homeDir, ".config"), INFINITARY_SYSTEMCTL: manager }
        : { INFINITARY_LAUNCHCTL: manager }),
      INFINITARY_DEVICE_NAME: "Studio Mac",
      ELECTRON_RENDERER_URL: "",
      PI_OFFLINE: "1",
      ...(model
        ? {
            INFINITARY_CLAUDE_CLI: writeMockClaudeClient(homeDir, {
              turns: { baseUrl: `http://127.0.0.1:${model.port}` },
            }),
          }
        : {}),
    }),
  };
}

/** `<app> work <args>` from Terminal, typing `input` when it asks. */
export function work(args: string[], env: NodeJS.ProcessEnv, input = "", packaged = false) {
  const child = spawn(
    electronPath as unknown as string,
    [packaged ? packagedEntry() : builtAppDir(), "work", ...args],
    {
      env,
      cwd: scratchDir("infinitary-run-work-cwd-"),
      detached: process.platform !== "win32",
    },
  );
  children.push(trackChildTree(child));
  let out = "";
  let error = "";
  child.stderr.on("data", (chunk) => {
    error += String(chunk);
  });
  child.stdout.on("data", (chunk) => {
    out += String(chunk);
  });
  child.stdin.end(input);
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  return { child, lines: () => out.split("\n").filter(Boolean), error: () => error, exited };
}

/**
 * A command typed into Terminal, typing `input` when it asks: the words the
 * command says, and apart from them what went to stderr, where Chromium on
 * Linux notes a session bus it cannot reach.
 */
export function terminal(command: string, env: NodeJS.ProcessEnv, input: string) {
  const child = spawn("/bin/sh", ["-c", command], {
    env,
    cwd: scratchDir("infinitary-run-work-cwd-"),
    detached: process.platform !== "win32",
  });
  children.push(trackChildTree(child));
  let out = "";
  let error = "";
  child.stdout.on("data", (chunk) => {
    out += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    error += String(chunk);
  });
  child.stdin.end(input);
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  return { lines: () => out.split("\n").filter(Boolean), error: () => error, exited };
}

/**
 * The environment a command for another computer runs in on a Linux
 * computer where the AppImage it gets runs as it should, so the command goes
 * on (src/core/devices/joinCommand.ts): stand-ins answer what a hosted
 * runner's own system may lack or refuse - the `unshare` probe, which its
 * kernel may refuse, as it answers in every session of the test's SSH server
 * (tests/helpers/sshServer.ts); FUSE 2's `fusermount`; `ldconfig`'s list of
 * the AppImage's libraries - and `loginctl`, which writes down what it was
 * asked into `loginctl.asked` in `record` and refuses to keep this user's
 * work on after logout, so no test changes the runner's own. Xvfb stays the system's own, which the work mode draws on.
 */
export function onLinuxThatRunsIt(
  env: NodeJS.ProcessEnv,
  record = scratchDir("infinitary-run-work-linux-record-"),
): NodeJS.ProcessEnv {
  if (process.platform !== "linux") return env;
  const bin = scratchDir("infinitary-run-work-linux-bin-");
  const tool = (name: string, lines: readonly string[]) =>
    writeFileSync(join(bin, name), ["#!/bin/sh", ...lines, ""].join("\n"), { mode: 0o755 });
  tool("unshare", ["exit 0"]);
  tool("fusermount", ["exit 0"]);
  tool("ldconfig", [
    `printf '\\t%s (libc6,x86-64) => /lib/x86_64-linux-gnu/%s\\n' ${[
      "libc.so.6",
      ...Object.values(APPIMAGE_LIBRARIES).flat(),
    ]
      .map((library) => `${library} ${library}`)
      .join(" ")}`,
  ]);
  const asked = shellWord(join(record, "loginctl.asked"));
  tool("loginctl", [
    `printf '%s\\n' "$*" >> ${asked}`,
    'if [ "$1" = show-user ]; then echo no; exit 0; fi',
    "exit 1",
  ]);
  return { ...env, PATH: `${bin}:${env.PATH ?? ""}` };
}

/**
 * Where a Linux computer the command runs on says its release and keeps the
 * Ubuntu package's program: neither there, so a hosted Ubuntu runner is
 * read as Linux with no Infinitary installed, which gets the AppImage.
 */
export function noUbuntuPackage() {
  const dir = scratchDir("infinitary-run-work-linux-files-");
  return { osRelease: join(dir, "os-release"), packageBin: join(dir, "infinitary") };
}
