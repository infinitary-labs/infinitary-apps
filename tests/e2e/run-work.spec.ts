import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { type NetworkInterfaceInfo, userInfo } from "node:os";
import { basename, join } from "node:path";
import { expect, test } from "@playwright/test";
import type { FoundTools } from "@shared/connection";
import { deviceLabel } from "@shared/devices";
import { remoteLoginWords } from "@shared/remoteLogin";
import electronPath from "electron";
import { CLAUDE_CONTROL_PROFILE } from "../../src/core/claude/session";
import { type HomeConnection, startConnection } from "../../src/core/connection/connection";
import { claimLink } from "../../src/core/devices/dial";
import { FarBuilds } from "../../src/core/devices/farBuilds";
import { APPIMAGE_LIBRARIES, farSystemNamed } from "../../src/core/devices/farSystems";
import { joinCommand, shellWord } from "../../src/core/devices/joinCommand";
import { JoinedHome } from "../../src/core/devices/joinedHome";
import { DevicePairing } from "../../src/core/devices/pairing";
import { RemoteLogin } from "../../src/core/devices/remoteLogin";
import { SshConnections } from "../../src/core/devices/sshConnections";
import type { CoreDispatch } from "../../src/core/dispatcher";
import { CoreEventBus } from "../../src/core/events";
import { readInstalled, serviceLabel } from "../../src/core/helper/background";
import { HomeRoute } from "../../src/core/helper/route";
import { afterLogout, helperWords, macAsk } from "../../src/core/helper/words";
import { WorkingCopies } from "../../src/core/helper/workingCopies";
import { hostEnv } from "../../src/core/hostEnv";
import { writeLoginShellStub } from "../../src/core/loginShellStub";
import { crewmatePlacedDir, crewmateSessionsDir } from "../../src/core/paths";
import { PI_CONTROL_PROFILE } from "../../src/core/pi/controlProfile";
import { WorkDevices } from "../../src/core/placed/workDevices";
import { seedTask } from "../../src/core/tasks/seedTask";
import { git } from "../../src/core/workspace/git";
import { keptRefFor } from "../../src/core/workspace/workspaceService";
import { NO_SCREEN_WORDS } from "../../src/main/noScreen";
import { HERE } from "../../src/shared/deviceNames";
import { deviceChipOf } from "../../src/shared/platform";
import { claimedPort } from "../helpers/claimedPort";
import { macRelease } from "../helpers/macRelease";
import { type PlacedHome, startPlacedHome } from "../helpers/placedHome";
import { scratchDir, socketScratchDir } from "../helpers/scratchDirs";
import { forwardSocket, type SocketForward } from "../helpers/socketForward";
import { SSH_SERVER_AVAILABLE, type SshServer, startSshServer } from "../helpers/sshServer";
import { builtAppDir, packagedEntry } from "./launch";
import {
  claudeDefaultStore,
  seedSignedInClaudeStore,
  writeMockClaudeClient,
} from "./mockClaudeClient";
import {
  CLAUDE_CREW_PROMPT_MARKER,
  CLAUDE_STEER_MARKER,
  MOCK_CLAUDE_CARD_TITLE,
  MOCK_CLAUDE_HELD_PROGRESS,
  MOCK_CLAUDE_STEERED_REPORT,
  type MockProviderServer,
  startMockProvider,
} from "./mockProvider";
import { GIT_STATUS_PROMPT_MARKER, gitStatus, MOCK_GIT_REPORT_PREFIX } from "./scenarios/gitStatus";
import { MAC_ONLY_TAG } from "./tags";

/**
 * The app runs work for another Mac's Firstmate with no window
 * (docs/helper.md), as a person starts it from Terminal: the built app
 * itself, started as `<app> work ...` as its own process, joins a home with
 * a link and a typed yes, stays in reach of it, refuses a second run, stops
 * on a signal, and ends when the home removes it. The home here is the
 * real pairing and connection in this test's own process, on loopback, so
 * the app is on the home's own Mac; the home stands in another macOS user
 * for itself, as it is when the work runs as another user here, except
 * where the journey is the refusal to run as the home's own user.
 */

const ME = { name: userInfo().username, uid: process.getuid?.() ?? 0 };
const THIS_MAC = { thisMac: true, host: "127.0.0.1" };

const standIn = (async (channel) => {
  throw new Error(`Rejected ${channel}`);
}) as CoreDispatch;

const connections: HomeConnection[] = [];
const pairings: DevicePairing[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
const homes: PlacedHome[] = [];
const providers: MockProviderServer[] = [];
const sshServers: SshServer[] = [];
const forwards: SocketForward[] = [];
const sshStops: (() => Promise<void>)[] = [];
test.afterEach(async () => {
  await Promise.all(sshStops.splice(0).map((stop) => stop()));
  await Promise.all(sshServers.splice(0).map((server) => server.stop()));
  await Promise.all(forwards.splice(0).map((forward) => forward.close()));
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill("SIGKILL");
  await Promise.all(homes.splice(0).map((home) => home.quit()));
  await Promise.all(connections.splice(0).map((connection) => connection.close()));
  for (const pairing of pairings.splice(0)) pairing.dispose();
  await Promise.all(providers.splice(0).map((provider) => provider.close()));
});

/** This Mac's own network address, as `os.networkInterfaces()` lists it. */
const ownNetwork = (address: string): NodeJS.Dict<NetworkInterfaceInfo[]> => ({
  en0: [
    {
      address,
      netmask: "255.255.255.0",
      family: "IPv4",
      mac: "00:00:00:00:00:00",
      internal: false,
      cidr: `${address}/24`,
    },
  ],
});

async function home(
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
function appVersion(): string {
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
function user(model?: MockProviderServer) {
  const homeDir = scratchDir("infinitary-run-work-user-");
  const dataDir = join(homeDir, "work");
  if (model) seedSignedInClaudeStore(claudeDefaultStore(homeDir));
  const manager = join(homeDir, SYSTEMD ? "systemctl" : "launchctl");
  const asked = join(homeDir, "manager.asked");
  const agentPid = join(homeDir, "agent.pid");
  // launchd's bootout, and systemd's stop or restart, end the agent's run.
  const stops = SYSTEMD ? '[ "$2" = stop ] || [ "$2" = restart ]' : '[ "$1" = bootout ]';
  writeFileSync(
    manager,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> ${shellWord(asked)}`,
      // A loaded agent is active, as launchd's print of it succeeds.
      ...(SYSTEMD ? ['if [ "$2" = show ]; then echo active; fi'] : []),
      `if { ${stops}; } && [ -f ${shellWord(agentPid)} ]; then`,
      `  pid=$(cat ${shellWord(agentPid)}); rm -f ${shellWord(agentPid)}`,
      `  kill -TERM "$pid" 2>/dev/null`,
      `  while kill -0 "$pid" 2>/dev/null; do sleep 0.1; done`,
      "fi",
      "",
    ].join("\n"),
  );
  chmodSync(manager, 0o755);
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

/**
 * The home and computer a home starting the work mode over Remote Login
 * names, which it checks before it touches anything: the ones its folder joined.
 */
function expectedHome(dataDir: string): string[] {
  const grant = new JoinedHome(dataDir).read()?.grant;
  if (!grant) throw new Error("Nothing joined there.");
  return ["--home", grant.homeKey, "--device", grant.deviceId];
}

/** `<app> work <args>` from Terminal, typing `input` when it asks. */
function work(args: string[], env: NodeJS.ProcessEnv, input = "", packaged = false) {
  const child = spawn(
    electronPath as unknown as string,
    [packaged ? packagedEntry() : builtAppDir(), "work", ...args],
    {
      env,
      cwd: scratchDir("infinitary-run-work-cwd-"),
    },
  );
  children.push(child);
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
function terminal(command: string, env: NodeJS.ProcessEnv, input: string) {
  const child = spawn("/bin/sh", ["-c", command], {
    env,
    cwd: scratchDir("infinitary-run-work-cwd-"),
  });
  children.push(child);
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
 * The environment a command for another Mac runs in as if on a Mac: on any
 * other system its script stops at once, since it gets a Mac's Firstmate
 * (src/core/devices/joinCommand.ts), so a stand-in `uname` says Darwin, as
 * the bundle the home sends here stands in a Mac's app.
 */
function onAMac(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (process.platform === "darwin") return env;
  const bin = scratchDir("infinitary-run-work-mac-bin-");
  writeFileSync(join(bin, "uname"), "#!/bin/sh\necho Darwin\n");
  chmodSync(join(bin, "uname"), 0o755);
  return { ...env, PATH: `${bin}:${env.PATH ?? ""}` };
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
function onLinuxThatRunsIt(
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
function noUbuntuPackage() {
  const dir = scratchDir("infinitary-run-work-linux-files-");
  return { osRelease: join(dir, "os-release"), packageBin: join(dir, "infinitary") };
}

/**
 * A Firstmate whose program starts the built app, as an installed
 * Firstmate's own program is the app itself: what the home sends. On Linux
 * it is the AppImage the home sends there, one file that is its own program
 * (src/core/devices/farSystems.ts).
 */
function builtAppBundle(): string {
  if (process.platform === "linux") {
    const app = join(scratchDir("infinitary-run-work-bundle-"), "infinitary.AppImage");
    writeFileSync(
      app,
      `#!/bin/sh\nexec ${shellWord(electronPath as unknown as string)} ${shellWord(builtAppDir())} "$@"\n`,
      { mode: 0o755 },
    );
    return app;
  }
  const bundle = join(scratchDir("infinitary-run-work-bundle-"), "Firstmate 3000.app");
  mkdirSync(join(bundle, "Contents", "MacOS"), { recursive: true });
  writeFileSync(
    join(bundle, "Contents", "MacOS", "Firstmate 3000"),
    `#!/bin/sh\nexec ${shellWord(electronPath as unknown as string)} ${shellWord(builtAppDir())} "$@"\n`,
  );
  chmodSync(join(bundle, "Contents", "MacOS", "Firstmate 3000"), 0o755);
  return bundle;
}

/** The program a kept copy starts: inside a Mac's bundle, or the AppImage itself. */
function programOf(kept: string): string {
  return kept.endsWith(".AppImage") ? kept : join(kept, "Contents", "MacOS", "Firstmate 3000");
}

/**
 * Marks a copy so a later copy tells them apart: a file in a Mac's bundle,
 * or a last line of an AppImage, which its shell never reaches.
 */
function markCopy(app: string, text: string): void {
  if (app.endsWith(".AppImage")) appendFileSync(app, `# mark: ${text}\n`);
  else writeFileSync(join(app, "Contents", "version"), `${text}\n`);
}

function copyMark(app: string): string {
  if (!app.endsWith(".AppImage")) return readFileSync(join(app, "Contents", "version"), "utf8");
  const mark = /^# mark: (.*)$/m.exec(readFileSync(app, "utf8"))?.[1];
  return mark === undefined ? "" : `${mark}\n`;
}

/**
 * A home that adds Macs by their address: pairing kept in `dir`, answering
 * at a port of its own, with its own SSH connection to each Mac it reaches
 * that way, and `bundle` for a command or Remote Login to get. Started again
 * on the same folder at another port, it is the same home after it moved.
 * `said` holds each line it says, but the copy's moving count.
 */
async function sshHome(options: {
  sshd: SshServer;
  them: ReturnType<typeof user>;
  bundle: string;
  dir: string;
  controlBase: string;
  said: string[];
}) {
  const { sshd, them, bundle, dir, controlBase, said } = options;
  const remoteEnv = Object.fromEntries(
    [
      "HOME",
      "CFFIXED_USER_HOME",
      "INFINITARY_HELPER_DATA_DIR",
      "XDG_CONFIG_HOME",
      "INFINITARY_LAUNCHCTL",
      "INFINITARY_SYSTEMCTL",
      "INFINITARY_DEVICE_NAME",
      "ELECTRON_RENDERER_URL",
      "PI_OFFLINE",
    ].map((name) => [name, them.env[name] ?? ""]),
  );
  const port = await claimedPort();
  const pairing = new DevicePairing({
    dir,
    onProblem: () => {},
    interfaces: () => ({}),
    port,
    ownUid: ME.uid + 1,
  });
  pairings.push(pairing);
  // What a computer that names its system gets: this app's own, as the app's own wiring answers.
  const builds = new FarBuilds({
    own: () => bundle,
    published: null,
    chip: deviceChipOf(process.arch),
  });
  const connection = startConnection({
    dispatch: standIn,
    events: new CoreEventBus(),
    devices: pairing,
    port,
    name: () => "MacBook Pro",
    app: () => bundle,
    build: async (system, chip) => {
      const far = farSystemNamed(system);
      const on = chip ?? deviceChipOf(process.arch);
      const build = far && on ? await builds.for(far, on) : null;
      return build && !("refusal" in build) ? build : null;
    },
  });
  connections.push(connection);
  const work = new WorkDevices();
  work.attach(connection);
  const ssh = sshd.ssh({ remote: remoteEnv });
  const sshConnections: SshConnections = new SshConnections({
    pairing,
    ssh,
    flavor: "dev",
    listening: () => work.listening(),
    settled: () => work.settled(),
    welcomed: (deviceId) => work.inReach(deviceId) || work.version(deviceId) !== undefined,
    onWorkDevice: (listener) => work.onWorkDevice(listener),
    cleanUpThere: (cleanup) => remote.cleanUpThere(cleanup),
    emit: (event) => said.push(event.text),
    changed: () => {},
    controlBase,
    retryMs: [100, 200],
    beatMs: 1_000,
  });
  const remote: RemoteLogin = new RemoteLogin({
    pairing,
    ssh,
    flavor: "dev",
    appBundle: () => bundle,
    listening: () => connection.settled(),
    inReach: (deviceId) => work.inReach(deviceId),
    connections: sshConnections,
    controlBase,
    // Every line but the copy's moving count of what it sent so far.
    emit: (event) => {
      if (event.copy?.state !== "sending") said.push(event.text);
    },
  });
  const stopSsh = sshConnections.start();
  sshStops.push(stopSsh);
  return { pairing, port, connection, remote, sshConnections, stopSsh };
}

/**
 * The processes Chromium started beside a running app's own, by type:
 * graphics (`gpu-process`), network (`utility`) and the like. Linux's
 * zygote, which Chromium forks at every start to start any page later from,
 * is not one of them.
 */
function chromiumProcesses(pid: number | undefined): string[] {
  return execFileSync("ps", ["-A", "-o", "ppid=,command="], { encoding: "utf8" })
    .split("\n")
    .map((row) => row.trim().match(/^(\d+)\s.*--type=(\S+)/))
    .flatMap((match) => (match && Number(match[1]) === pid ? [match[2] ?? ""] : []))
    .filter((type) => type !== "zygote");
}

test("the app joins a home from Terminal with a typed yes, runs its work with no window, and ends when removed", async () => {
  const at = await home(ME.uid + 1);
  const me = user();

  await test.step("it says its version", async () => {
    const version = work(["version"], me.env);
    expect(await version.exited, version.error()).toBe(0);
    expect(version.lines()).toEqual([
      expect.stringMatching(/^Infinitary \d+\.\d+\.\d+ · contract /),
    ]);
  });

  await test.step("it joins only once the person types yes, as its own macOS user", async () => {
    const no = work(["join", await at.link()], me.env, "no\n");
    expect(await no.exited).toBe(1);
    expect(at.pairing.list()).toEqual([]);

    const yes = work(["join", await at.link()], me.env, "yes\n");
    expect(await yes.exited).toBe(0);
    expect(yes.lines().slice(-2)).toEqual(
      helperWords.joined(THIS_MAC, "MacBook Pro", ME.name, "running"),
    );
    expect(at.pairing.list()).toEqual([
      expect.objectContaining({ kind: "work", user: ME.name, onThisMac: true }),
    ]);
    expect(new JoinedHome(me.dataDir).read()).toMatchObject({ name: "MacBook Pro" });
  });

  await test.step("it sets itself to run in the background as this user, from this app", async () => {
    const { label, file, holds, started } = me.background;
    expect(me.managerAsked()).toEqual(started);
    expect(readInstalled(me.dataDir)).toEqual({ service: { label, file }, app: null });
    const agent = readFileSync(file, "utf8");
    for (const word of [electronPath as unknown as string, builtAppDir(), "work", "run"])
      expect(agent).toContain(holds(word));
  });

  const running = work(["run"], me.env);
  await test.step("it stays in reach as one process, and a second one is refused", async () => {
    await expect.poll(running.lines).toContain(helperWords.inReach(THIS_MAC, "MacBook Pro")[0]);
    // Nothing is drawn and the connection is Node's own, so Chromium starts
    // no graphics or network process beside it (docs/helper.md).
    expect(chromiumProcesses(running.child.pid)).toEqual([]);
    const second = work(["run"], me.env);
    expect(await second.exited).toBe(1);
    expect(second.lines()).toEqual(helperWords.busy);
  });

  await test.step("the home removes it, and it ends, forgets the grant and removes what was set up", async () => {
    const [device] = at.pairing.list();
    at.pairing.remove(device?.id ?? "");
    expect(await running.exited).toBe(0);
    expect(running.lines().slice(-3)).toEqual([
      ...helperWords.removed(THIS_MAC, "MacBook Pro"),
      ...helperWords.cleanedUp([]),
    ]);
    expect(new JoinedHome(me.dataDir).read()).toBeNull();
    expect(existsSync(me.background.file)).toBe(false);
    expect(me.managerAsked().slice(-me.background.removed.length)).toEqual(me.background.removed);
  });
});

test("the home's address changes: a new command finds it as the same computer, and after the home removed it joins it anew", async () => {
  const at = await home(ME.uid + 1);
  const me = user();
  /** `<app> work run` as the service manager starts it, which the stand-in's stop ends. */
  const agent = () => {
    const run = work(["run"], me.env);
    writeFileSync(me.agentPid, `${run.child.pid}\n`);
    return run;
  };
  const joined = work(["join", await at.link()], me.env, "yes\n");
  expect(await joined.exited).toBe(0);
  const [device] = at.pairing.list();
  const first = agent();
  await expect.poll(first.lines).toContain(helperWords.inReach(THIS_MAC, "MacBook Pro")[0]);

  await test.step("stranded where the home was, a new command finds it where it is now", async () => {
    await at.move();
    await expect
      .poll(() => first.lines().at(-1))
      .toBe(helperWords.quit(THIS_MAC, "MacBook Pro")[0]);
    const asked = me.managerAsked().length;
    // It asks nothing: this user already runs that home's work.
    const again = work(["join", await at.link()], me.env);
    expect(await again.exited).toBe(0);
    expect(again.lines()).toEqual(
      helperWords.foundAgain(THIS_MAC, "MacBook Pro", ME.name, "running"),
    );
    // The run the background started stopped first, and the background started again.
    expect(await first.exited).toBe(0);
    expect(me.managerAsked().slice(asked)).toEqual([
      ...me.background.paused,
      ...me.background.started,
    ]);
    // The same computer on the home's list, dialing where the home is now.
    expect(at.pairing.list()).toEqual([device]);
    expect(new JoinedHome(me.dataDir).read()?.grant).toMatchObject({
      at: at.at(),
      deviceId: device?.id,
    });
    const back = agent();
    await expect.poll(back.lines).toContain(helperWords.inReach(THIS_MAC, "MacBook Pro")[0]);
  });

  await test.step("removed there while out of reach, a new command removes what was set up here and joins it anew", async () => {
    await at.move();
    at.pairing.remove(device?.id ?? "", { farewell: true });
    const anew = work(["join", await at.link()], me.env, "yes\n");
    expect(await anew.exited).toBe(0);
    expect(anew.lines()).toEqual([
      ...helperWords.removedEarlier(THIS_MAC, "MacBook Pro"),
      ...helperWords.cleanedUp([]),
      ...helperWords.ask(THIS_MAC, ME.name, process.platform),
      `${helperWords.prompt}yes`,
      ...helperWords.joined(THIS_MAC, "MacBook Pro", ME.name, "running"),
    ]);
    const [listed] = at.pairing.list();
    expect(listed?.id).not.toBe(device?.id);
    expect(new JoinedHome(me.dataDir).read()?.grant).toMatchObject({
      at: at.at(),
      deviceId: listed?.id,
    });
  });
});

test("its home gone for good, a new home's command asks to leave it, and on a yes leaves as a removal would, keeping unmerged work", async () => {
  const gone = await home(ME.uid + 1);
  const me = user();
  /** `<app> work run` as the service manager starts it, which the stand-in's stop ends. */
  const agent = () => {
    const run = work(["run"], me.env);
    writeFileSync(me.agentPid, `${run.child.pid}\n`);
    return run;
  };
  expect(await work(["join", await gone.link()], me.env, "yes\n").exited).toBe(0);
  const joined = new JoinedHome(me.dataDir).read();
  const copies = new WorkingCopies(me.dataDir, { pool: false });
  const { dir } = await copies.prepare("t-unmerged", undefined);
  writeFileSync(join(dir, "only-copy.txt"), "unique uncommitted work\n");
  mkdirSync(join(me.dataDir, "accounts", "codex"), { recursive: true });
  const first = agent();
  await expect.poll(first.lines).toContain(helperWords.inReach(THIS_MAC, "MacBook Pro")[0]);
  await gone.gone();
  await expect.poll(() => first.lines().at(-1)).toBe(helperWords.quit(THIS_MAC, "MacBook Pro")[0]);
  const at = await home(ME.uid + 1);
  // Both homes are on this Mac, so the one it leaves is an earlier Firstmate here.
  const from = helperWords.earlierHome(THIS_MAC);
  const question = [
    ...helperWords.askLeave(from),
    ...helperWords.ask(THIS_MAC, ME.name, process.platform),
  ];

  await test.step("without a yes nothing changes, and its run keeps trying", async () => {
    const no = work(["join", await at.link()], me.env, "no\n");
    expect(await no.exited).toBe(1);
    expect(no.lines()).toEqual([...question, `${helperWords.prompt}no`, ...helperWords.declined]);
    expect(at.pairing.list()).toEqual([]);
    expect(new JoinedHome(me.dataDir).read()).toEqual(joined);
    expect(existsSync(join(me.dataDir, "accounts", "codex"))).toBe(true);
    expect(first.child.exitCode).toBeNull();
  });

  await test.step("on a yes it leaves as a removal would, keeps the unmerged work, and joins the new home", async () => {
    const asked = me.managerAsked().length;
    const yes = work(["join", await at.link()], me.env, "yes\n");
    expect(await yes.exited).toBe(0);
    expect(yes.lines()).toEqual([
      ...question,
      `${helperWords.prompt}yes`,
      ...helperWords.leftHome(from),
      ...helperWords.cleanedUp([dir], [], [], { triesAgain: false }),
      ...helperWords.joined(THIS_MAC, "MacBook Pro", ME.name, "running"),
    ]);
    // The old home's run stopped, its agent went with the removal, and the new one's started.
    expect(await first.exited).toBe(0);
    expect(me.managerAsked().slice(asked)).toEqual([
      ...me.background.paused,
      ...me.background.removed,
      ...me.background.started,
    ]);
    expect(readFileSync(join(dir, "only-copy.txt"), "utf8")).toBe("unique uncommitted work\n");
    expect(existsSync(join(me.dataDir, "accounts"))).toBe(false);
    const [listed] = at.pairing.list();
    expect(new JoinedHome(me.dataDir).read()?.grant).toMatchObject({
      at: at.at(),
      deviceId: listed?.id,
    });
    const back = agent();
    await expect.poll(back.lines).toContain(helperWords.inReach(THIS_MAC, "MacBook Pro")[0]);
  });
});

test("the command for another user on this Mac starts this Mac's app, which asks, joins, runs in the background, and stays in reach when this Mac's address changes", async () => {
  let address = "192.168.65.2";
  const at = await home(ME.uid + 1, undefined, () => ownNetwork(address));
  const me = user();
  const command = joinCommand({
    for: "another-user",
    link: await at.command(),
    homeName: "MacBook Pro",
    launcher: { executable: electronPath as unknown as string, args: [builtAppDir()] },
    version: appVersion(),
  });
  const ran = terminal(command, me.env, "yes\n");
  expect(await ran.exited).toBe(0);
  expect(ran.lines()).toEqual([
    ...helperWords.ask(THIS_MAC, ME.name, process.platform),
    `${helperWords.prompt}yes`,
    ...helperWords.joined(THIS_MAC, "MacBook Pro", ME.name, "running"),
  ]);
  const [device] = at.pairing.list();
  expect(device).toMatchObject({ kind: "work", user: ME.name, onThisMac: true });
  expect(me.managerAsked().slice(-me.background.started.length)).toEqual(me.background.started);

  await test.step("this Mac's network address changes, and its run comes back with no new command", async () => {
    // That user dials from this Mac itself, so its grant names loopback, not 192.168.65.2.
    expect(new JoinedHome(me.dataDir).read()?.grant.at).toBe(at.at());
    const running = work(["run"], me.env);
    const inReach = helperWords.inReach(THIS_MAC, "MacBook Pro")[0];
    await expect.poll(running.lines).toContain(inReach);
    // This Mac moves to another network, and the home listens anew there.
    address = "192.168.65.77";
    await at.quit();
    await expect
      .poll(() => running.lines().at(-1))
      .toBe(helperWords.quit(THIS_MAC, "MacBook Pro")[0]);
    await at.reopen();
    await expect.poll(() => running.lines().at(-1)).toBe(inReach);
    expect(at.pairing.list()).toEqual([device]);
    expect(new JoinedHome(me.dataDir).read()?.grant.at).toBe(at.at());
  });
});

test("the command for another Mac gets Firstmate from the home, and the copy it got joins and runs in the background", {
  tag: MAC_ONLY_TAG,
}, async () => {
  // The command gets a Mac's app bundle from the home and starts it: a Linux
  // computer joins by a link pasted into its own Firstmate (docs/devices.md).
  test.skip(process.platform !== "darwin", "the command for another Mac gets a Mac's app");
  // The home sends a bundle whose program starts the built app, as an
  // installed Firstmate's own program is the app itself.
  const bundle = join(scratchDir("infinitary-run-work-bundle-"), "Firstmate 3000.app");
  mkdirSync(join(bundle, "Contents", "MacOS"), { recursive: true });
  const program = join(bundle, "Contents", "MacOS", "Firstmate 3000");
  writeFileSync(
    program,
    `#!/bin/sh\nexec ${shellWord(electronPath as unknown as string)} ${shellWord(builtAppDir())} "$@"\n`,
  );
  chmodSync(program, 0o755);
  const at = await home(ME.uid + 1, bundle);
  const me = user();
  const link = await at.link();
  const command = joinCommand({
    for: "another-mac",
    link,
    homeName: "MacBook Pro",
    launcher: { executable: "/unused", args: [] },
    version: appVersion(),
  });
  const ran = terminal(command, me.env, "yes\n");
  expect(await ran.exited).toBe(0);
  // Asked once, before anything was fetched; the copy it got joined without asking again.
  expect(ran.lines()).toEqual([
    ...macAsk("MacBook Pro", ME.name),
    "Type yes to agree: Getting Infinitary from MacBook Pro… done.",
    ...helperWords.joined(THIS_MAC, "MacBook Pro", ME.name, "running"),
  ]);
  expect(at.pairing.list()).toEqual([
    expect.objectContaining({ kind: "work", name: "Studio Mac", user: ME.name }),
  ]);
  // It keeps the copy it got, and the background starts that copy.
  const kept = join(me.dataDir, "app", "Firstmate 3000.app");
  const installed = readInstalled(me.dataDir);
  expect(installed.app).toBe(kept);
  expect(readFileSync(installed.service?.file ?? "", "utf8")).toContain(
    `<string>${join(kept, "Contents", "MacOS", "Firstmate 3000")}</string>`,
  );
  expect(readFileSync(join(kept, "Contents", "MacOS", "Firstmate 3000"), "utf8")).toBe(
    readFileSync(program, "utf8"),
  );
});

/** This environment with no screen: neither an X nor a Wayland display. */
function noScreen(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { DISPLAY: _x, WAYLAND_DISPLAY: _wayland, ...rest } = env;
  return rest;
}

/**
 * INF-1181's accepted plan: on Linux with no display, Infinitary's window
 * says in two plain lines to use Run a command there, and exits 1 without
 * Chromium's crash. Data: the built app started as its window, with the
 * display unset. Completion: the process exits. Linux only: a Mac always
 * has its screen.
 */
test("on Linux with no screen, the window says to use Run a command there and exits 1", async () => {
  test.skip(process.platform !== "linux", "only Linux starts with no screen");
  const me = user();
  const child = spawn(electronPath as unknown as string, [builtAppDir()], {
    env: noScreen(me.env),
    cwd: scratchDir("infinitary-run-work-cwd-"),
  });
  children.push(child);
  let error = "";
  child.stderr.on("data", (chunk) => {
    error += String(chunk);
  });
  const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
  expect(code).toBe(1);
  expect(error).toBe(`${NO_SCREEN_WORDS.join("\n")}\n`);
});

/**
 * INF-1181's accepted plan and the captain's "linger" pick. Promise: on
 * Linux with no display, the command from Run a command there joins with
 * the Infinitary installed there - nothing downloaded or got from the home -
 * which asks its own yes and runs in the background, and the command's last
 * lines name the one sudo line that keeps the work on after logout where
 * systemd does not let this user. Data: the built app as the installed
 * program, the display unset, a home with nothing to send. Completion: the
 * command exits. Linux only: the command joins this way only there.
 */
test("on Linux with no screen, the command joins with the Infinitary installed there and names the line that keeps it on after logout", async () => {
  test.skip(process.platform !== "linux", "the command joins with an installed copy on Linux");
  const at = await home(ME.uid + 1);
  const me = user();
  const files = noUbuntuPackage();
  writeFileSync(
    files.packageBin,
    `#!/bin/sh\nexec ${shellWord(electronPath as unknown as string)} ${shellWord(builtAppDir())} "$@"\n`,
    { mode: 0o755 },
  );
  const record = scratchDir("infinitary-run-work-linux-record-");
  const command = joinCommand({
    for: "another-mac",
    link: await at.link(),
    homeName: "MacBook Pro",
    launcher: { executable: "/unused", args: [] },
    version: appVersion(),
    linux: files,
  });
  const ran = terminal(command, noScreen(onLinuxThatRunsIt(me.env, record)), "yes\n");
  expect(await ran.exited, ran.error()).toBe(0);
  expect(ran.lines()).toEqual([
    ...helperWords.ask(THIS_MAC, ME.name, process.platform),
    `${helperWords.prompt}yes`,
    ...helperWords.joined(THIS_MAC, "MacBook Pro", ME.name, "running"),
    ...afterLogout(ME.name, false),
  ]);
  expect(at.pairing.list()).toEqual([expect.objectContaining({ kind: "work", user: ME.name })]);
  expect(me.managerAsked().slice(-me.background.started.length)).toEqual(me.background.started);
  // It asked systemd to keep the work on, without a password, and was refused.
  expect(readFileSync(join(record, "loginctl.asked"), "utf8")).toContain(
    `enable-linger --no-ask-password ${ME.name}`,
  );
});

/**
 * INF-322 direction B, adding by a command (INF-330). Promise: the command
 * for another Mac downloads this computer's published version there, checks
 * it and joins with it, so the copy it downloaded is the one kept and run in
 * the background. Data: a real universal zip of a bundle whose program starts
 * the built app, served over local HTTPS which curl trusts here alone, its
 * publisher check stood in where the command names codesign; the home's own
 * copy is another bundle that is never sent. Completion: the command exits,
 * the computer is on the home's list, and its background starts the
 * downloaded copy. macOS only: the command downloads a Mac's app.
 */
test("the command for another Mac downloads the published version, and the copy it downloaded joins and runs in the background", {
  tag: MAC_ONLY_TAG,
}, async () => {
  test.skip(process.platform !== "darwin", "the command downloads a Mac's app");
  const program = (bundle: string) => join(bundle, "Contents", "MacOS", "Firstmate 3000");
  const app = (marker: string) => {
    const bundle = join(scratchDir("infinitary-run-work-bundle-"), "Firstmate 3000.app");
    mkdirSync(join(bundle, "Contents", "MacOS"), { recursive: true });
    mkdirSync(join(bundle, "Contents", "Resources"), { recursive: true });
    writeFileSync(
      program(bundle),
      `#!/bin/sh\nexec ${shellWord(electronPath as unknown as string)} ${shellWord(builtAppDir())} "$@"\n`,
    );
    chmodSync(program(bundle), 0o755);
    writeFileSync(join(bundle, "Contents", "Resources", "marker"), `${marker}\n`);
    return bundle;
  };
  const release = await macRelease(app("the published copy"), "0.13.0");
  try {
    const at = await home(ME.uid + 1, app("the home's own copy"));
    const me = user();
    let command = joinCommand({
      for: "another-mac",
      link: await at.link(),
      homeName: "MacBook Pro",
      launcher: { executable: "/unused", args: [] },
      version: appVersion(),
      download: {
        url: release.downloads[release.publicUrl] ?? "",
        sha256: release.sha256,
        expiresAt: Date.now() + 10 * 60_000,
      },
    });
    for (const [from, to] of Object.entries(release.programs))
      command = command.split(from).join(to);
    const ran = terminal(command, { ...me.env, CURL_CA_BUNDLE: release.cert }, "yes\n");
    expect(await ran.exited).toBe(0);
    // Asked once, before anything was downloaded; each count rewrote the line it stands on.
    const shown = ran.lines().map((line) => line.split("\r").at(-1)?.replace("\x1b[K", "") ?? "");
    expect(shown).toEqual([
      ...macAsk("MacBook Pro", ME.name),
      expect.stringMatching(/^Downloading Infinitary… \S+ [KMG]?B of \S+ [KMG]?B, done\.$/),
      ...helperWords.joined(THIS_MAC, "MacBook Pro", ME.name, "running"),
    ]);
    expect(at.pairing.list()).toEqual([
      expect.objectContaining({ kind: "work", name: "Studio Mac", user: ME.name }),
    ]);
    // It keeps the copy it downloaded, and the background starts that copy.
    const kept = join(me.dataDir, "app", "Firstmate 3000.app");
    expect(readInstalled(me.dataDir).app).toBe(kept);
    expect(readFileSync(join(kept, "Contents", "Resources", "marker"), "utf8")).toBe(
      "the published copy\n",
    );
    expect(readFileSync(readInstalled(me.dataDir).service?.file ?? "", "utf8")).toContain(
      `<string>${program(kept)}</string>`,
    );
    expect(release.requests()).toBe(1);
    expect(release.verifications()).toHaveLength(1);
  } finally {
    await release.stop();
  }
});

test("updated over the connection: the copy a command kept gets the home's Firstmate with its own key, keeps it, and ends for its background to start it again", async () => {
  // The home sends a bundle whose program starts the built app, as an
  // installed Firstmate's own program is the app itself.
  const bundle = join(scratchDir("infinitary-run-work-bundle-"), "Firstmate 3000.app");
  mkdirSync(join(bundle, "Contents", "MacOS"), { recursive: true });
  mkdirSync(join(bundle, "Contents", "Resources"), { recursive: true });
  const program = join(bundle, "Contents", "MacOS", "Firstmate 3000");
  writeFileSync(
    program,
    `#!/bin/sh\nexec ${shellWord(electronPath as unknown as string)} ${shellWord(builtAppDir())} "$@"\n`,
  );
  chmodSync(program, 0o755);
  writeFileSync(join(bundle, "Contents", "Resources", "marker"), "the copy the command got\n");
  const at = await home(ME.uid + 1, bundle);
  const me = user();
  const command = joinCommand({
    for: "another-mac",
    link: await at.link(),
    homeName: "MacBook Pro",
    launcher: { executable: "/unused", args: [] },
    version: appVersion(),
  });
  expect(await terminal(command, onAMac(me.env), "yes\n").exited).toBe(0);
  const [device] = at.pairing.list();
  const kept = join(me.dataDir, "app", "Firstmate 3000.app");
  const marker = () => readFileSync(join(kept, "Contents", "Resources", "marker"), "utf8").trim();
  expect(marker()).toBe("the copy the command got");

  // The home's Firstmate moves on; the background starts the copy kept there.
  writeFileSync(join(bundle, "Contents", "Resources", "marker"), "the home's newer copy\n");
  const started = () =>
    terminal(
      `${shellWord(join(kept, "Contents", "MacOS", "Firstmate 3000"))} work run`,
      me.env,
      "",
    );
  const before = started();
  const inReach = helperWords.inReach(THIS_MAC, "MacBook Pro")[0];
  await expect.poll(before.lines).toContain(inReach);

  // The home's update order: it keeps the home's copy in its place, answers, and ends.
  expect(
    await at.connection().ask(device?.id ?? "", "fm:firstmate:update", [], { anyVersion: true }),
  ).toEqual({ restarts: true });
  expect(await before.exited).toBe(0);
  expect(before.lines()).toEqual(
    expect.arrayContaining(helperWords.updated(THIS_MAC, "MacBook Pro", true)),
  );
  expect(marker()).toBe("the home's newer copy");
  expect(readInstalled(me.dataDir).app).toBe(kept);
  expect(readdirSync(me.dataDir).filter((entry) => entry.startsWith("update-"))).toEqual([]);

  // Its background starts the same path again, now this Mac's version.
  const after = started();
  await expect.poll(after.lines).toContain(inReach);
});

/**
 * INF-322 direction B, Update over the connection (INF-330). Promise: the
 * built app's work mode, asked the download order, downloads the published
 * version itself, says how far it got, keeps it in place of its copy and
 * ends for its background to start it again; asked again with a download
 * that does not match, it changes nothing and answers the fallback. Data: a
 * real universal zip over local HTTPS which curl trusts here alone, and a
 * development run's stand-in publisher check (`INFINITARY_CODESIGN`), as an
 * installed app never reads. Completion: the run exits, and the copy kept
 * there is the downloaded one. macOS only: it downloads a Mac's app.
 */
test("updated over the connection, the copy a command kept downloads the published version itself, keeps it, and ends", {
  tag: MAC_ONLY_TAG,
}, async () => {
  test.skip(process.platform !== "darwin", "a Mac downloads a Mac's app");
  const program = (bundle: string) => join(bundle, "Contents", "MacOS", "Firstmate 3000");
  const app = (marker: string) => {
    const bundle = join(scratchDir("infinitary-run-work-bundle-"), "Firstmate 3000.app");
    mkdirSync(join(bundle, "Contents", "MacOS"), { recursive: true });
    mkdirSync(join(bundle, "Contents", "Resources"), { recursive: true });
    writeFileSync(
      program(bundle),
      `#!/bin/sh\nexec ${shellWord(electronPath as unknown as string)} ${shellWord(builtAppDir())} "$@"\n`,
    );
    chmodSync(program(bundle), 0o755);
    writeFileSync(join(bundle, "Contents", "Resources", "marker"), `${marker}\n`);
    return bundle;
  };
  const release = await macRelease(app("the published copy"), "0.13.0");
  try {
    const at = await home(ME.uid + 1, app("the copy the command got"));
    const me = user();
    const command = joinCommand({
      for: "another-mac",
      link: await at.link(),
      homeName: "MacBook Pro",
      launcher: { executable: "/unused", args: [] },
      version: appVersion(),
    });
    expect(await terminal(command, onAMac(me.env), "yes\n").exited).toBe(0);
    const [device] = at.pairing.list();
    const kept = join(me.dataDir, "app", "Firstmate 3000.app");
    const marker = () => readFileSync(join(kept, "Contents", "Resources", "marker"), "utf8").trim();
    const env = {
      ...me.env,
      CURL_CA_BUNDLE: release.cert,
      INFINITARY_CODESIGN: release.programs["/usr/bin/codesign"] ?? "",
    };
    const started = () => terminal(`${shellWord(program(kept))} work run`, env, "");
    const inReach = helperWords.inReach(THIS_MAC, "MacBook Pro")[0];
    const ask = (channel: string, args: unknown) =>
      at.connection().ask(device?.id ?? "", channel, args, { anyVersion: true });
    const download = {
      url: release.downloads[release.publicUrl] ?? "",
      sha256: release.sha256,
    };

    // A download that does not match changes nothing, and it runs on.
    const first = started();
    await expect.poll(first.lines).toContain(inReach);
    release.mode("corrupt");
    expect(await ask("fm:firstmate:update-download", [download])).toEqual({
      fallback: "mismatch",
      received: release.size,
      total: release.size,
    });
    expect(marker()).toBe("the copy the command got");
    expect(await ask("fm:firstmate:update-progress", [])).toEqual({
      received: release.size,
      total: release.size,
      state: "mismatch",
    });

    // One that matches is kept in its place; the run answers and ends.
    release.mode("success");
    expect(await ask("fm:firstmate:update-download", [download])).toEqual({
      restarts: true,
      received: release.size,
      total: release.size,
    });
    expect(await first.exited).toBe(0);
    expect(first.lines()).toEqual(
      expect.arrayContaining(helperWords.updated(THIS_MAC, "MacBook Pro", true)),
    );
    expect(marker()).toBe("the published copy");
    expect(readInstalled(me.dataDir).app).toBe(kept);
    expect(readdirSync(me.dataDir).filter((entry) => entry.startsWith("update-"))).toEqual([]);
    expect(release.verifications()).toHaveLength(1);

    // Its background starts the same path again, now the downloaded copy.
    const after = started();
    await expect.poll(after.lines).toContain(inReach);
  } finally {
    await release.stop();
  }
});

test("a Mac added by its address over Remote Login: the copy joins through the home's own SSH connection, runs in the background over it, is updated, stays in reach when the home moves, and is removed", async () => {
  test.skip(!SSH_SERVER_AVAILABLE, "needs the Mac's own SSH server and client");
  const sshd = await startSshServer();
  sshServers.push(sshd);
  const bundle = builtAppBundle();
  // The user there: a home of its own, its work's folder, and a launchctl that writes down what it was asked.
  const them = user();
  const said: string[] = [];
  const dir = join(scratchDir("infinitary-run-work-home-"), "devices");
  const controlBase = socketScratchDir("fm-c-");
  const homeAt = () => sshHome({ sshd, them, bundle, dir, controlBase, said });
  const first = await homeAt();
  const { remote } = first;

  // Added: the copy got over SSH joined through the socket the home forwarded, kept itself and set up its agent.
  const asked = await remote.addOrAsk(sshd.address);
  if (!("asks" in asked) || asked.asks !== "confirm")
    throw new Error("The first reach did not ask for the check line.");
  const device = await remote.add(sshd.address, { confirm: asked.line });
  expect(device).toMatchObject({
    kind: "work",
    name: "Studio Mac",
    user: ME.name,
    remoteLogin: sshd.address,
  });
  expect(said.slice(0, 2)).toEqual([
    remoteLoginWords.reaching(sshd.address),
    remoteLoginWords.settingUp("Studio Mac"),
  ]);
  const kept = join(them.dataDir, "app", basename(bundle));
  const installed = readInstalled(them.dataDir);
  expect(installed.app).toBe(kept);
  expect(readFileSync(installed.service?.file ?? "", "utf8")).toContain(
    them.background.holds(programOf(kept)),
  );
  // Another user here, added at this Mac's own address: the home's look found
  // it on this Mac and its welcome says so, so its agent keeps the low
  // priority (captain on INF-255), and its grant keeps that word.
  expect(readFileSync(installed.service?.file ?? "", "utf8")).not.toContain("ProcessType");
  const grant = new JoinedHome(them.dataDir, () => {}).read()?.grant;
  expect(grant).toMatchObject({ deviceId: device.id, via: "ssh", onHomeMac: true });
  if (!grant) throw new Error("Nothing joined there.");
  // The home's SSH connection runs the copy's own controller, which keeps its route there.
  await expect
    .poll(() => new HomeRoute(them.dataDir).current(grant), { timeout: 30_000 })
    .not.toBeNull();
  expect(first.sshConnections.state(device.id)).toEqual({ state: "connecting" });

  // Its run dials that route, and is in reach of the home: connected using SSH.
  const place = { thisMac: false, host: "127.0.0.1", overSsh: true };
  const running = work(["run"], them.env);
  writeFileSync(them.agentPid, `${running.child.pid}\n`);
  await expect.poll(running.lines).toContain(helperWords.inReach(place, "MacBook Pro")[0]);
  await expect.poll(() => first.sshConnections.state(device.id)).toEqual({ state: "connected" });

  // A grant kept before its home said where it runs (INF-472), as a join
  // before alpha 0.5.0-alpha.5 kept it: the update below decides its agent.
  const joinedHome = new JoinedHome(them.dataDir, () => {});
  const joined = joinedHome.read();
  if (!joined) throw new Error("Nothing joined there.");
  const { onHomeMac: _said, ...unheard } = joined.grant;
  joinedHome.join(unheard, joined.joinedAt);
  if (joined.name) joinedHome.name(joined.name);

  // Updated: the connection lets go, this Mac's Firstmate goes there again, its agent
  // starts the new copy, and the connection is made again to that copy.
  markCopy(bundle, "the home's newer version");
  said.splice(0);
  await remote.update(device.id);
  expect(said).toEqual([
    remoteLoginWords.updating(device),
    remoteLoginWords.starting(deviceLabel(device)),
    remoteLoginWords.updated(device, "running"),
  ]);
  expect(await running.exited).toBe(0);
  expect(copyMark(kept)).toBe("the home's newer version\n");
  // The home held its connection, so the update could dial nothing: it kept
  // the home's word from its own arguments, and set the agent up by it.
  expect(new JoinedHome(them.dataDir, () => {}).read()?.grant).toMatchObject({ onHomeMac: true });
  expect(readFileSync(installed.service?.file ?? "", "utf8")).not.toContain("ProcessType");
  const updated = work(["run"], them.env);
  writeFileSync(them.agentPid, `${updated.child.pid}\n`);
  await expect
    .poll(updated.lines, { timeout: 30_000 })
    .toContain(helperWords.inReach(place, "MacBook Pro")[0]);

  // The home quits and starts again at another port: its new connection forwards there,
  // and the run comes back by itself, with nothing run there and nothing told.
  await first.connection.close();
  await first.stopSsh();
  await expect.poll(() => updated.lines().at(-1)).toBe(helperWords.quit(place, "MacBook Pro")[0]);
  const moved = await homeAt();
  await expect
    .poll(() => updated.lines().at(-1), { timeout: 30_000 })
    .toBe(helperWords.inReach(place, "MacBook Pro")[0]);
  await expect.poll(() => moved.sshConnections.state(device.id)).toEqual({ state: "connected" });
  expect(moved.pairing.list().map(({ id }) => id)).toEqual([device.id]);

  // Removed in reach: it hears it through the connection and removes what Firstmate
  // set up there; the home's connection lets go, and its cleanup over SSH finds nothing
  // of this home's left.
  moved.pairing.remove(device.id, { cleanUpThere: true });
  expect(await updated.exited).toBe(0);
  await expect.poll(() => moved.pairing.sshCleanups(), { timeout: 30_000 }).toEqual([]);
  expect(existsSync(join(them.dataDir, "home.json"))).toBe(false);
  expect(existsSync(kept)).toBe(false);
  expect(existsSync(installed.service?.file ?? "")).toBe(false);
  expect(existsSync(join(them.dataDir, "left.json"))).toBe(false);
  for (const gone of ["route.json", "work.log", "service.log", "chromium"])
    expect(existsSync(join(them.dataDir, gone)), gone).toBe(false);
  expect(new HomeRoute(them.dataDir).current(grant)).toBeNull();
  expect(readdirSync(controlBase)).toEqual([]);
});

test("a Mac a command joined, stranded when the home's address changes, is found by its address and kept on the home's own SSH from then on", async () => {
  test.skip(!SSH_SERVER_AVAILABLE, "needs the Mac's own SSH server and client");
  const sshd = await startSshServer();
  sshServers.push(sshd);
  const bundle = builtAppBundle();
  const them = user();
  const said: string[] = [];
  const dir = join(scratchDir("infinitary-run-work-home-"), "devices");
  const controlBase = socketScratchDir("fm-c-");
  const homeAt = () => sshHome({ sshd, them, bundle, dir, controlBase, said });
  const first = await homeAt();

  // Joined by the command for another Mac: it dials the home's address itself.
  const { link } = first.pairing.invite({ kind: "work", at: `127.0.0.1:${first.port}` });
  await first.connection.settled();
  const command = joinCommand({
    for: "another-mac",
    link,
    homeName: "MacBook Pro",
    launcher: { executable: "/unused", args: [] },
    version: appVersion(),
    linux: noUbuntuPackage(),
  });
  expect(await terminal(command, onLinuxThatRunsIt(them.env), "yes\n").exited).toBe(0);
  const joined = new JoinedHome(them.dataDir, () => {}).read();
  if (!joined) throw new Error("Nothing joined there.");
  expect(joined.grant).not.toHaveProperty("via");
  const deviceId = joined.grant.deviceId;
  // A sign-in it made there, which must stay.
  mkdirSync(join(them.dataDir, "accounts"), { recursive: true });
  writeFileSync(join(them.dataDir, "accounts", "kept"), "a sign-in\n");
  const running = work(["run"], them.env);
  writeFileSync(them.agentPid, `${running.child.pid}\n`);
  await expect.poll(running.lines).toContain(helperWords.inReach(THIS_MAC, "MacBook Pro")[0]);
  expect(first.sshConnections.state(deviceId)).toBeUndefined();

  // The home moves: the run keeps dialing where it was, out of reach.
  await first.connection.close();
  await first.stopSsh();
  await expect
    .poll(() => running.lines().at(-1))
    .toBe(helperWords.quit(THIS_MAC, "MacBook Pro")[0]);
  const moved = await homeAt();

  // Add it at its address finds it as the same computer, stops its stranded
  // run, and moves it onto the home's own SSH, with its sign-in kept.
  said.splice(0);
  const asked = await moved.remote.addOrAsk(sshd.address);
  if (!("asks" in asked) || asked.asks !== "confirm")
    throw new Error("The first reach did not ask for the check line.");
  expect(said).toEqual([]);
  const found = await moved.remote.add(sshd.address, { confirm: asked.line });
  expect(found).toMatchObject({ id: deviceId, remoteLogin: sshd.address });
  expect(said.slice(0, 2)).toEqual([
    remoteLoginWords.reaching(sshd.address),
    remoteLoginWords.finding(found),
  ]);
  await running.exited;
  const grant = new JoinedHome(them.dataDir, () => {}).read()?.grant;
  expect(grant).toMatchObject({ deviceId, homeKey: joined.grant.homeKey, via: "ssh" });
  expect(readFileSync(join(them.dataDir, "accounts", "kept"), "utf8")).toBe("a sign-in\n");
  expect(moved.pairing.list().map(({ id }) => id)).toEqual([deviceId]);

  // Its run reaches the home only through the home's SSH connection, which is made once the find is done.
  const place = { thisMac: false, host: "127.0.0.1", overSsh: true };
  const after = work(["run"], them.env);
  writeFileSync(them.agentPid, `${after.child.pid}\n`);
  await expect
    .poll(after.lines, { timeout: 30_000 })
    .toContain(helperWords.inReach(place, "MacBook Pro")[0]);
  await expect.poll(() => moved.sshConnections.state(deviceId)).toEqual({ state: "connected" });

  // The home moves again: nothing is run there, and it comes back by itself.
  await moved.connection.close();
  await moved.stopSsh();
  await expect.poll(() => after.lines().at(-1)).toBe(helperWords.quit(place, "MacBook Pro")[0]);
  const again = await homeAt();
  await expect
    .poll(() => after.lines().at(-1), { timeout: 30_000 })
    .toBe(helperWords.inReach(place, "MacBook Pro")[0]);
  await expect.poll(() => again.sshConnections.state(deviceId)).toEqual({ state: "connected" });
});

test("its home gone for good, a new home adds it by its address: asked once, its captain's yes leaves the old home as a removal would, keeping unmerged work", async () => {
  test.skip(!SSH_SERVER_AVAILABLE, "needs the Mac's own SSH server and client");
  const sshd = await startSshServer();
  sshServers.push(sshd);
  const old = await home(ME.uid + 1);
  const me = user();
  expect(await work(["join", await old.link()], me.env, "yes\n").exited).toBe(0);
  const joined = new JoinedHome(me.dataDir).read();
  const copies = new WorkingCopies(me.dataDir, { pool: false });
  const { dir } = await copies.prepare("t-unmerged", undefined);
  writeFileSync(join(dir, "only-copy.txt"), "unique uncommitted work\n");
  mkdirSync(join(me.dataDir, "accounts", "codex"), { recursive: true });

  // The new home adds that Mac by its address over the captain's own SSH.
  const said: string[] = [];
  const { pairing, remote } = await sshHome({
    sshd,
    them: me,
    bundle: builtAppBundle(),
    dir: join(scratchDir("infinitary-run-work-home-"), "devices"),
    controlBase: socketScratchDir("fm-c-"),
    said,
  });
  const unchanged = () => {
    expect(new JoinedHome(me.dataDir).read()).toEqual(joined);
    expect(existsSync(join(me.dataDir, "accounts", "codex"))).toBe(true);
    expect(pairing.list()).toEqual([]);
  };

  await test.step("Add it asks once, and sends nothing there", async () => {
    const asked = await remote.addOrAsk(sshd.address);
    expect(asked).toMatchObject({ asks: "confirm", address: sshd.address });
    expect(said).toEqual([]);
    unchanged();
    if (!("line" in asked)) throw new Error("The check line was not asked.");
    expect(await remote.addOrAsk(sshd.address, { confirm: asked.line })).toEqual({
      asks: "leave",
      address: sshd.address,
      name: "Studio Mac",
    });
    expect(said).toEqual([remoteLoginWords.reaching(sshd.address)]);
    unchanged();
  });

  await test.step("while the old home answers, the yes changes nothing there", async () => {
    said.splice(0);
    await expect(remote.add(sshd.address, { leave: true })).rejects.toMatchObject({
      refusal: "still-answers",
    });
    expect(said.slice(-2)).toEqual(
      remoteLoginWords.refused("still-answers", { address: sshd.address, doing: "add" }),
    );
    unchanged();
  });

  await test.step("once it is gone, the yes leaves it as a removal would, keeps the unmerged work, and joins", async () => {
    await old.gone();
    said.splice(0);
    const device = await remote.add(sshd.address, { leave: true });
    expect(device).toMatchObject({ kind: "work", name: "Studio Mac", remoteLogin: sshd.address });
    // Its SSH connection may say more after it joined.
    const setUp = [
      remoteLoginWords.reaching(sshd.address),
      remoteLoginWords.settingUp("Studio Mac"),
      remoteLoginWords.starting("Studio Mac"),
      ...remoteLoginWords.leftOther(device, { kept: 1, unremoved: 0 }),
    ];
    expect(said.slice(0, setUp.length)).toEqual(setUp);
    expect(readFileSync(join(dir, "only-copy.txt"), "utf8")).toBe("unique uncommitted work\n");
    expect(existsSync(join(me.dataDir, "accounts"))).toBe(false);
    expect(new JoinedHome(me.dataDir).read()?.grant).toMatchObject({
      deviceId: device.id,
      homeKey: pairing.identity().pin,
      via: "ssh",
    });
    expect(old.pairing.list().map(({ id }) => id)).toEqual([joined?.grant.deviceId]);
  });
});

test("the app will not run work as the user Firstmate itself runs as", async () => {
  const at = await home(ME.uid);
  const me = user();
  const join = work(["join", await at.link()], me.env, "yes\n");
  expect(await join.exited).toBe(1);
  expect(join.lines().slice(-2)).toEqual(helperWords.sameUser);
  expect(at.pairing.list()).toEqual([]);
  expect(new JoinedHome(me.dataDir).read()).toBeNull();
});

test("an installed build runs the work mode: it answers its version and that it has joined nothing", async () => {
  const me = user();
  const version = work(["version"], me.env, "", true);
  expect(await version.exited, version.error()).toBe(0);
  expect(version.lines()).toEqual([expect.stringMatching(/^Infinitary \S+ · contract \S+$/)]);
  const status = work(["status"], me.env, "", true);
  expect(await status.exited, status.error()).toBe(0);
  expect(status.lines()).toEqual(helperWords.notJoined);
});

test("a computer whose home reaches it over the home's own SSH connection dials only the route that connection keeps", async () => {
  const at = await home(ME.uid + 1);
  const me = user();
  const { forward, publish } = await at.overSsh(me.dataDir);
  const place = { thisMac: false, host: "127.0.0.1" };
  const run = work(["run"], me.env);
  // No route yet: out of reach, and the home's loopback the grant names,
  // where the home answers, is never dialed.
  await expect
    .poll(run.lines)
    .toEqual(expect.arrayContaining(helperWords.outOfReach(place, "MacBook Pro")));
  expect(forward.carried()).toBe(1);
  expect(at.pairing.list()).toEqual([expect.objectContaining({ onThisMac: false })]);
  // The home's connection keeps its route: in reach through that socket.
  publish();
  await expect
    .poll(run.lines)
    .toEqual(expect.arrayContaining(helperWords.inReach(place, "MacBook Pro")));
  expect(forward.carried()).toBe(2);
  run.child.kill("SIGTERM");
  expect(await run.exited).toBe(0);
});

for (const removal of ["from-home", "reconnect"] as const) {
  test(`removing a work computer preserves unreadable existing work and reports why it stays (${removal})`, async () => {
    const at = await home(ME.uid + 1);
    const me = user();
    expect(await work(["join", await at.link()], me.env, "yes\n").exited).toBe(0);
    const copies = new WorkingCopies(me.dataDir, { pool: false });
    const { dir } = await copies.prepare("t-protect", undefined);
    writeFileSync(join(dir, "only-copy.txt"), "unique uncommitted work\n");
    const metadata = readFileSync(join(dir, ".git"), "utf8");
    writeFileSync(join(dir, ".git"), `gitdir: ${join(me.homeDir, "missing")}\n`);
    if (removal === "reconnect")
      at.pairing.remove(at.pairing.list()[0]?.id ?? "", { farewell: true });
    const removed = work(
      removal === "from-home" ? ["remove", "--from-home", ...expectedHome(me.dataDir)] : ["run"],
      me.env,
    );
    expect(await removed.exited).toBe(0);
    if (removal === "from-home") {
      const outcome = JSON.parse(removed.lines().at(-1) ?? "{}");
      expect(outcome).toMatchObject({ firstmate: "removed", kept: [dir], unreadable: [dir] });
    } else {
      expect(removed.lines()).toEqual(expect.arrayContaining(helperWords.cleanedUp([dir], [dir])));
    }
    expect(new JoinedHome(me.dataDir).read()).toBeNull();
    expect(readFileSync(join(dir, "only-copy.txt"), "utf8")).toBe("unique uncommitted work\n");
    expect(existsSync(join(me.dataDir, "default-workspace", ".git"))).toBe(true);
    writeFileSync(join(dir, ".git"), metadata);
    expect(await copies.status("t-protect")).toMatchObject({
      present: true,
      dirty: true,
      unlandedCommits: 0,
    });
    console.log(
      JSON.stringify({
        removal,
        output: removed.lines(),
        preservedFile: readFileSync(join(dir, "only-copy.txt"), "utf8"),
        repairedStatus: await copies.status("t-protect"),
      }),
    );
  });
}

for (const removal of ["from-home", "in-reach"] as const) {
  test(`a removal that cannot remove everything goes on with the rest, and its agent's next run finishes it (${removal})`, async () => {
    const at = await home(ME.uid + 1);
    const me = user();
    expect(await work(["join", await at.link()], me.env, "yes\n").exited).toBe(0);
    const agent = readInstalled(me.dataDir).service?.file ?? "";
    const copies = new WorkingCopies(me.dataDir, { pool: false });
    const keep = await copies.prepare("t-keep", undefined);
    writeFileSync(join(keep.dir, "notes.md"), "unmerged\n");
    const clean = await copies.prepare("t-clean", undefined);
    mkdirSync(join(me.dataDir, "accounts", "codex"), { recursive: true });
    // Nothing can leave the working copies' own folder, so the clean copy cannot go yet.
    chmodSync(copies.worktreesDir, 0o555);
    try {
      await test.step("the removal removes everything else, says what stays, and keeps its agent", async () => {
        if (removal === "from-home") {
          const removed = work(["remove", "--from-home", ...expectedHome(me.dataDir)], me.env);
          expect(await removed.exited).toBe(0);
          expect(JSON.parse(removed.lines().at(-1) ?? "{}")).toEqual({
            firstmate: "removed",
            kept: [keep.dir],
            unremoved: [clean.dir],
          });
        } else {
          const running = work(["run"], me.env);
          await expect
            .poll(running.lines)
            .toContain(helperWords.inReach(THIS_MAC, "MacBook Pro")[0]);
          at.pairing.remove(at.pairing.list()[0]?.id ?? "");
          expect(await running.exited).toBe(0);
          expect(running.lines().slice(-3)).toEqual(
            helperWords.cleanedUp([keep.dir], [], [clean.dir]),
          );
        }
        expect(new JoinedHome(me.dataDir).read()).toBeNull();
        expect(existsSync(join(me.dataDir, "accounts"))).toBe(false);
        expect(existsSync(agent)).toBe(true);
        const status = work(["status"], me.env);
        expect(await status.exited, status.error()).toBe(0);
        expect(status.lines()).toEqual(helperWords.left(`Infinitary on ${HERE.this}`, [clean.dir]));
      });
    } finally {
      chmodSync(copies.worktreesDir, 0o755);
    }

    await test.step("its agent's next run, at the next login, finishes the removal and takes the agent away", async () => {
      const next = work(["run"], me.env);
      expect(await next.exited).toBe(0);
      expect(next.lines()).toEqual(helperWords.cleanedUp([keep.dir]));
      expect(existsSync(clean.dir)).toBe(false);
      expect(readFileSync(join(keep.dir, "notes.md"), "utf8")).toBe("unmerged\n");
      expect(existsSync(agent)).toBe(false);
      expect(me.managerAsked().slice(-me.background.removed.length)).toEqual(me.background.removed);
      const status = work(["status"], me.env);
      expect(await status.exited, status.error()).toBe(0);
      expect(status.lines()).toEqual(helperWords.left(`Infinitary on ${HERE.this}`));
    });
  });
}

test("a crewmate's turn runs on the app as a computer that runs work: the home holds it out of reach and catches up with nothing run twice", async () => {
  // The home is the home's own record, crew and connection, in this process;
  // the work is the built app as its own process, on Claude's client.
  const model = await startMockProvider({ scenarios: [gitStatus] });
  providers.push(model);
  const me = user(model);
  const userData = scratchDir("infinitary-run-work-home-");
  const port = await claimedPort();
  const pairing = new DevicePairing({
    dir: join(userData, "devices"),
    onProblem: () => {},
    ownUid: ME.uid + 1,
  });
  pairings.push(pairing);
  const home = startPlacedHome({
    userData,
    port,
    pairing: () => pairing,
    now: Date.now,
    binding: { backend: "claude", accountId: "claude" },
    profiles: { pi: PI_CONTROL_PROFILE, claude: CLAUDE_CONTROL_PROFILE },
  });
  homes.push(home);
  await home.listen();
  const { link } = pairing.invite({ kind: "work", at: `127.0.0.1:${port}` });
  await home.settled();
  expect(await work(["join", link], me.env, "yes\n").exited).toBe(0);
  const deviceId = pairing.list()[0]?.id ?? "";
  let running = work(["run"], me.env);
  await expect.poll(running.lines).toContain(helperWords.inReach(THIS_MAC, "MacBook Pro")[0]);
  await expect.poll(() => home.placed.ready(deviceId, "none")).toBe(true);
  const progress = () =>
    home.tasks.timeline("t-rivets").filter((event) => event.kind === "progress").length;

  await test.step("a task placed there runs its turn there, and its card is made here", async () => {
    seedTask(home.tasks, {
      id: "t-rivets",
      title: "website",
      prompt: `Count the rivets ${CLAUDE_CREW_PROMPT_MARKER}.`,
      status: "queued",
      deviceId,
    });
    await home.supervisor.dispatchQueuedTask("t-rivets");
    expect(home.tasks.get("t-rivets")).toMatchObject({ status: "active", deviceId });
    // The model's next step is held open there: the turn is mid-way.
    await expect.poll(() => model.heldRequests(), { timeout: 30_000 }).toBe(1);
    expect(home.supervisor.openCardsFor("t-rivets").map((card) => card.title)).toEqual([
      MOCK_CLAUDE_CARD_TITLE,
    ]);
  });

  await test.step("out of reach, the home holds the task and the turn goes on there", async () => {
    await home.drop();
    await expect.poll(() => home.devices.inReach(deviceId)).toBe(false);
    expect(await home.supervisor.steerCrewmate("t-rivets", `Please ${CLAUDE_STEER_MARKER}.`)).toBe(
      "recorded-held",
    );
    // The model goes on there; its progress note waits for the home.
    model.releaseHeldCrew();
    await expect.poll(() => model.heldRequests()).toBe(0);
    expect(progress()).toBe(0);
  });

  await test.step("back in reach, it catches up: each callback once, the held words into the running turn", async () => {
    await home.listen();
    // The progress note that waited is answered, and the held words reach
    // the running turn at a next step the model is let take.
    await expect
      .poll(
        () => {
          if (model.heldRequests() > 0) model.releaseHeldCrew();
          return home.tasks.get("t-rivets")?.outcome;
        },
        { timeout: 30_000 },
      )
      .toBe(MOCK_CLAUDE_STEERED_REPORT);
    expect(progress()).toBeGreaterThanOrEqual(1);
    for (const event of home.tasks.timeline("t-rivets").filter((each) => each.kind === "progress"))
      expect(event.text).toBe(MOCK_CLAUDE_HELD_PROGRESS);
    // One effect per callback: every answer the home kept, once.
    const calls = readFileSync(
      join(crewmatePlacedDir(home.paths, "t-rivets"), "calls.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { callId: string; channel: string });
    expect(new Set(calls.map((call) => call.callId)).size).toBe(calls.length);
    expect(calls.filter((call) => call.channel === "inf:work:progress")).toHaveLength(progress());
    // A copy of its record is home.
    await expect
      .poll(() =>
        readdirSync(crewmateSessionsDir(home.paths, "t-rivets")).some((name) =>
          name.endsWith(".jsonl"),
        ),
      )
      .toBe(true);
  });

  await test.step("stopped once its sign-ins loaded, the app there ends cleanly, restarts, and nothing runs twice", async () => {
    const asked = model.requests();
    const outcome = home.tasks.get("t-rivets")?.outcome;
    const noted = progress();
    // Its own sign-ins loaded there, as a task routed there loads them.
    expect(await home.signIns.signInsOf(deviceId)).not.toBeNull();
    running.child.kill("SIGTERM");
    expect(await running.exited).toBe(0);
    running = work(["run"], me.env);
    await expect.poll(running.lines).toContain(helperWords.inReach(THIS_MAC, "MacBook Pro")[0]);
    await expect.poll(() => home.placed.ready(deviceId, "t-rivets")).toBe(true);
    expect(model.requests()).toBe(asked);
    expect(home.tasks.get("t-rivets")?.outcome).toBe(outcome);
    expect(progress()).toBe(noted);
  });
});

test("a closed task with unreadable work history stays present and brings its work home after repair", async () => {
  // Where the project lives is a repository on this disk, and the home's
  // own clone of it is the project the home registered.
  const root = scratchDir("infinitary-run-work-project-");
  const origin = join(root, "origin.git");
  await git(root, ["init", "--quiet", "--bare", "--initial-branch=main", origin]);
  const website = join(root, "website");
  await git(root, ["clone", "--quiet", origin, website]);
  writeFileSync(join(website, "README.md"), "# website\n");
  const identity = ["-c", "user.name=Crewmate", "-c", "user.email=crew@localhost"];
  await git(website, ["add", "-A"]);
  await git(website, [...identity, "commit", "-q", "-m", "chore: start the website"]);
  await git(website, ["push", "--quiet", "origin", "HEAD:main"]);
  const main = await git(website, ["rev-parse", "HEAD"]);

  const model = await startMockProvider({ scenarios: [gitStatus] });
  providers.push(model);
  const me = user(model);
  const userData = scratchDir("infinitary-run-work-home-");
  const port = await claimedPort();
  const pairing = new DevicePairing({
    dir: join(userData, "devices"),
    onProblem: () => {},
    ownUid: ME.uid + 1,
  });
  pairings.push(pairing);
  const home = startPlacedHome({
    userData,
    port,
    pairing: () => pairing,
    now: Date.now,
    binding: { backend: "claude", accountId: "claude" },
    profiles: { pi: PI_CONTROL_PROFILE, claude: CLAUDE_CONTROL_PROFILE },
  });
  homes.push(home);
  await home.listen();
  const { repo } = await home.repos.setup({ kind: "adopt", path: website });
  const { link } = pairing.invite({ kind: "work", at: `127.0.0.1:${port}` });
  await home.settled();
  expect(await work(["join", link], me.env, "yes\n").exited).toBe(0);
  const deviceId = pairing.list()[0]?.id ?? "";
  const running = work(["run"], me.env);
  await expect.poll(running.lines).toContain(helperWords.inReach(THIS_MAC, "MacBook Pro")[0]);
  await expect.poll(() => home.placed.ready(deviceId, "none")).toBe(true);
  const copy = join(me.dataDir, "worktrees", "t-tidy");

  await test.step("the app there clones the project, and the task's turn runs in its own working copy", async () => {
    seedTask(home.tasks, {
      id: "t-tidy",
      title: "website",
      prompt: "Tidy the readme.",
      status: "queued",
      repoId: repo.id,
      deviceId,
    });
    await home.supervisor.dispatchQueuedTask("t-tidy");
    expect(home.tasks.get("t-tidy")).toMatchObject({
      status: "active",
      branch: "fm/task-t-tidy",
      worktreeDir: "",
      workspaceState: "present",
    });
    expect(await git(copy, ["rev-parse", "HEAD"])).toBe(main);
    expect(await git(copy, ["symbolic-ref", "--short", "HEAD"])).toBe("fm/task-t-tidy");
    await expect.poll(() => home.tasks.get("t-tidy")?.activity, { timeout: 30_000 }).toBe("idle");
  });

  await test.step("unreadable work refuses retirement without changing the record, then recovers after repair", async () => {
    writeFileSync(join(copy, "only-copy.txt"), "unique work\n");
    const metadata = readFileSync(join(copy, ".git"), "utf8");
    writeFileSync(join(copy, ".git"), `gitdir: ${join(me.homeDir, "missing")}\n`);
    await home.supervisor.interruptCrewmate("t-tidy", "cancel");
    await expect(home.placed.bringHome(deviceId)).rejects.toThrow();
    expect(home.tasks.get("t-tidy")?.workspaceState).toBe("present");
    expect(readFileSync(join(copy, "only-copy.txt"), "utf8")).toBe("unique work\n");
    writeFileSync(join(copy, ".git"), metadata);
    await home.placed.bringHome(deviceId);
    expect(home.tasks.get("t-tidy")?.workspaceState).toBe("removed");
    const kept = await git(website, ["rev-parse", keptRefFor("t-tidy")]);
    const contents = await git(website, ["show", `${kept}:only-copy.txt`]);
    expect(contents).toBe("unique work");
    expect(existsSync(copy)).toBe(false);
    console.log(
      JSON.stringify({
        recovery: "work brought home after metadata repair",
        state: home.tasks.get("t-tidy")?.workspaceState,
        keptFile: contents,
      }),
    );
  });
});

test("a task in a project works in a working copy the app that runs work cloned, and its unmerged work comes home before that copy is deleted", async () => {
  // Where the project lives is a repository on this disk, and the home's
  // own clone of it is the project the home registered.
  const root = scratchDir("infinitary-run-work-project-");
  const origin = join(root, "origin.git");
  await git(root, ["init", "--quiet", "--bare", "--initial-branch=main", origin]);
  const website = join(root, "website");
  await git(root, ["clone", "--quiet", origin, website]);
  writeFileSync(join(website, "README.md"), "# website\n");
  const identity = ["-c", "user.name=Crewmate", "-c", "user.email=crew@localhost"];
  await git(website, ["add", "-A"]);
  await git(website, [...identity, "commit", "-q", "-m", "chore: start the website"]);
  await git(website, ["push", "--quiet", "origin", "HEAD:main"]);
  const main = await git(website, ["rev-parse", "HEAD"]);

  const model = await startMockProvider({ scenarios: [gitStatus] });
  providers.push(model);
  const me = user(model);
  const userData = scratchDir("infinitary-run-work-home-");
  const port = await claimedPort();
  const pairing = new DevicePairing({
    dir: join(userData, "devices"),
    onProblem: () => {},
    ownUid: ME.uid + 1,
  });
  pairings.push(pairing);
  const home = startPlacedHome({
    userData,
    port,
    pairing: () => pairing,
    now: Date.now,
    binding: { backend: "claude", accountId: "claude" },
    profiles: { pi: PI_CONTROL_PROFILE, claude: CLAUDE_CONTROL_PROFILE },
  });
  homes.push(home);
  await home.listen();
  const { repo } = await home.repos.setup({ kind: "adopt", path: website });
  const { link } = pairing.invite({ kind: "work", at: `127.0.0.1:${port}` });
  await home.settled();
  expect(await work(["join", link], me.env, "yes\n").exited).toBe(0);
  const deviceId = pairing.list()[0]?.id ?? "";
  const running = work(["run"], me.env);
  await expect.poll(running.lines).toContain(helperWords.inReach(THIS_MAC, "MacBook Pro")[0]);
  await expect.poll(() => home.placed.ready(deviceId, "none")).toBe(true);
  const copy = join(me.dataDir, "worktrees", "t-tidy");

  await test.step("the app there clones the project, and the task's turn runs in its own working copy", async () => {
    seedTask(home.tasks, {
      id: "t-tidy",
      title: "website",
      prompt: "Tidy the readme.",
      status: "queued",
      repoId: repo.id,
      deviceId,
    });
    await home.supervisor.dispatchQueuedTask("t-tidy");
    expect(home.tasks.get("t-tidy")).toMatchObject({
      status: "active",
      branch: "fm/task-t-tidy",
      worktreeDir: "",
      workspaceState: "present",
    });
    expect(await git(copy, ["rev-parse", "HEAD"])).toBe(main);
    expect(await git(copy, ["symbolic-ref", "--short", "HEAD"])).toBe("fm/task-t-tidy");
    await expect.poll(() => home.tasks.get("t-tidy")?.activity, { timeout: 30_000 }).toBe("idle");
  });

  await test.step("closed, its work is kept there, comes home, and only then is the copy there deleted", async () => {
    // What the crewmate left: a commit, and an edit it never committed.
    writeFileSync(join(copy, "README.md"), "# website\n\nTidy.\n");
    await git(copy, ["add", "-A"]);
    await git(copy, [...identity, "commit", "-q", "-m", "docs: tidy the readme"]);
    writeFileSync(join(copy, "notes.txt"), "still thinking\n");
    await home.supervisor.interruptCrewmate("t-tidy", "cancel");
    await expect
      .poll(() => home.tasks.get("t-tidy")?.workspaceState, { timeout: 30_000 })
      .toBe("removed");
    expect(existsSync(copy)).toBe(false);
    const kept = await git(website, ["rev-parse", keptRefFor("t-tidy")]);
    expect(await git(website, ["show", `${kept}:notes.txt`])).toBe("still thinking");
    expect(await git(website, ["show", `${kept}:README.md`])).toContain("Tidy.");
  });
});

test("a Mac with no git of its own runs a project's work with the app's own git, and tells the home it has git", {
  tag: MAC_ONLY_TAG,
}, async () => {
  // Only the Mac app brings its own git (docs/forge.md, "The app's own git").
  test.skip(process.platform !== "darwin", "the app's own git is the Mac's");
  // A search path that holds no git at all - the system folders without
  // /usr/bin, whose `git` is Apple's prompt to install the developer tools -
  // and a login shell that adds nothing, as on a Mac that never had them.
  const NO_GIT_PATH = "/bin:/usr/sbin:/sbin";
  for (const dir of NO_GIT_PATH.split(":")) expect(existsSync(join(dir, "git"))).toBe(false);
  // The tree `pnpm install` vendored for this Mac (scripts/ensure-bundled-git.ts).
  const vendoredVersion = execFileSync(
    join(builtAppDir(), "vendor", "git", `darwin-${process.arch}`, "bin", "git"),
    ["--version"],
    { encoding: "utf8" },
  ).trim();
  const root = scratchDir("infinitary-run-work-project-");
  const origin = join(root, "origin.git");
  await git(root, ["init", "--quiet", "--bare", "--initial-branch=main", origin]);
  const website = join(root, "website");
  await git(root, ["clone", "--quiet", origin, website]);
  writeFileSync(join(website, "README.md"), "# website\n");
  const identity = ["-c", "user.name=Crewmate", "-c", "user.email=crew@localhost"];
  await git(website, ["add", "-A"]);
  await git(website, [...identity, "commit", "-q", "-m", "chore: start the website"]);
  await git(website, ["push", "--quiet", "origin", "HEAD:main"]);
  const main = await git(website, ["rev-parse", "HEAD"]);

  const model = await startMockProvider({ scenarios: [gitStatus] });
  providers.push(model);
  const me = user(model);
  const { shell } = writeLoginShellStub(scratchDir("infinitary-login-shell-"), {});
  const env = { ...me.env, PATH: NO_GIT_PATH, SHELL: shell };
  const userData = scratchDir("infinitary-run-work-home-");
  const port = await claimedPort();
  const found: (FoundTools | undefined)[] = [];
  const pairing = new DevicePairing({
    dir: join(userData, "devices"),
    onProblem: () => {},
    onJoined: (_device, tools) => found.push(tools),
    ownUid: ME.uid + 1,
  });
  pairings.push(pairing);
  const home = startPlacedHome({
    userData,
    port,
    pairing: () => pairing,
    now: Date.now,
    binding: { backend: "claude", accountId: "claude" },
    profiles: { pi: PI_CONTROL_PROFILE, claude: CLAUDE_CONTROL_PROFILE },
  });
  homes.push(home);
  await home.listen();
  const { repo } = await home.repos.setup({ kind: "adopt", path: website });

  await test.step("it joins and tells the home it has git", async () => {
    const { link } = pairing.invite({ kind: "work", at: `127.0.0.1:${port}` });
    await home.settled();
    expect(await work(["join", link], env, "yes\n").exited).toBe(0);
    expect(found).toEqual([expect.objectContaining({ git: true })]);
  });

  const deviceId = pairing.list()[0]?.id ?? "";
  const running = work(["run"], env);
  await expect.poll(running.lines).toContain(helperWords.inReach(THIS_MAC, "MacBook Pro")[0]);
  await expect.poll(() => home.placed.ready(deviceId, "none")).toBe(true);

  await test.step("it clones the project with its own git, and the crewmate's shell runs that git", async () => {
    seedTask(home.tasks, {
      id: "t-git",
      title: "website",
      prompt: `${GIT_STATUS_PROMPT_MARKER} in website.`,
      status: "queued",
      repoId: repo.id,
      deviceId,
    });
    await home.supervisor.dispatchQueuedTask("t-git");
    expect(home.tasks.get("t-git")).toMatchObject({ status: "active", branch: "fm/task-t-git" });
    const copy = join(me.dataDir, "worktrees", "t-git");
    expect(await git(copy, ["rev-parse", "HEAD"])).toBe(main);
    await expect
      .poll(() => home.tasks.get("t-git")?.outcome, { timeout: 45_000 })
      .toMatch(new RegExp(`^${MOCK_GIT_REPORT_PREFIX} ${vendoredVersion} on ## fm/task-t-git`));
  });

  await test.step("closed, its unmerged work comes home through its own git", async () => {
    const copy = join(me.dataDir, "worktrees", "t-git");
    writeFileSync(join(copy, "README.md"), "# website\n\nWhich git.\n");
    await git(copy, ["add", "-A"]);
    await git(copy, [...identity, "commit", "-q", "-m", "docs: say which git"]);
    await home.supervisor.interruptCrewmate("t-git", "cancel");
    await expect
      .poll(() => home.tasks.get("t-git")?.workspaceState, { timeout: 30_000 })
      .toBe("removed");
    expect(existsSync(copy)).toBe(false);
    const kept = await git(website, ["rev-parse", keptRefFor("t-git")]);
    expect(await git(website, ["show", `${kept}:README.md`])).toContain("Which git.");
  });
});
