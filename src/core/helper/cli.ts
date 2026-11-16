import { writeFileSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { runLabelOf } from "@shared/codeNames";
import { settingFrom } from "@shared/envSettings";
import { PROTOCOL_VERSION } from "@shared/ipc";
import { type WorkOutcome, workOutcomeLine } from "@shared/remoteLogin";
import type { ResourceMemory } from "@shared/resources";
import {
  type ExpectedHome,
  expectedHomeSchema,
  readSshMessage,
  type SshJoin,
  sshJoinSchema,
} from "@shared/sshConnection";
import { browserLookup } from "../browser/connectionGuard";
import { ClaudeAuthBackend } from "../claude/claudeAuth";
import { defaultClaudeConfigDir } from "../claude/claudeQuota";
import { ownComputerName } from "../devices/computerName";
import { homeFinder } from "../devices/findHome";
import { shellWord } from "../devices/shellWord";
import type { HostChildSpawner, HostKeychain, HostTaskBrowser } from "../host";
import type { MediaProbe, TypefaceProbe } from "../pi/cardImages";
import { hostPlatform } from "../platform";
import { adoptBundledGit, type BundledGitApp } from "../workspace/bundledGit";
import {
  agentProbe,
  type BackgroundContext,
  type Launcher,
  linuxReadiness,
  pauseInBackground,
  readInstalled,
  resumeInBackground,
  type ServiceManager,
  startInBackground,
} from "./background";
import { cleanUp } from "./cleanUp";
import { connectFromHome } from "./connect";
import { findTools } from "./found";
import { removeFromHome, restartInstalled, updateFromHome } from "./fromHome";
import { fetchedLauncher, type HelperIO, joinHome } from "./join";
import { moveWork } from "./moveWork";
import type { HelperPlace } from "./place";
import { finishRemoval, helperStatus, startHelper, workLog } from "./run";
import { startRunAgent, userUnitsDir } from "./runAgent";
import { helperWords } from "./words";

/**
 * The commands of the app's windowless mode (docs/helper.md), as one
 * function from the words after `work` to an exit code: 0 done, 1 refused
 * or failed, 2 not understood. The main process runs it when the app is
 * started as `<app> work <command>` (src/main/work.ts).
 */

export type CliContext = {
  source?: import("../selfSource/resolve").SelfSourceReader;
  /** The app's own version. */
  version: string;
  /** Where its data lives, and whether it runs from a packaged app. */
  place: HelperPlace;
  /** The app's own git helper, which every git it starts answers a host's sign-in with. */
  gitAskpass?: string;
  /**
   * Where this build keeps the app's own git (`workspace/bundledGit.ts`),
   * which every git it starts runs, as the app's own does; absent, every
   * git is the one the search path finds.
   */
  appGit?: BundledGitApp;
  /** This Mac's saved passwords, where Claude Code keeps its login; read only without asking. */
  keychain?: HostKeychain;
  /** This computer's decoder for a card's demo recording; absent, a card naming one is refused here. */
  probeMedia?: MediaProbe;
  /** This computer's loader for a preview's project font; absent, a card naming one is refused here. */
  probeTypeface?: TypefaceProbe;
  resourceMemory?: () => Promise<ResourceMemory | null>;
  /**
   * This computer's browser engine, the process a task's command runs in
   * and the launcher's folder: its tasks' own browsers run here
   * (docs/task-browser.md, "On another computer"). Absent, it keeps none.
   */
  browser?: { host: HostTaskBrowser; spawner: HostChildSpawner; binDir: string };
  /**
   * Starts the process each file the home copies from this computer is set
   * aside in (`FileReachOptions.setAsideProcess`); absent, in this process.
   */
  setAsideProcess?: HostChildSpawner;
  /** How this app starts itself, which the background starts again at each login. */
  launcher: Launcher;
  /**
   * The system's service manager - launchctl on a Mac, this user's systemd on
   * Linux - or a development run's stand-in (`INFINITARY_LAUNCHCTL`,
   * `INFINITARY_SYSTEMCTL`); null for a development run whose data a test
   * isolated, or a computer with neither, which sets up nothing in the
   * background.
   */
  serviceManager: ServiceManager | null;
  /**
   * What the background carries of this process's environment: a
   * development run's stand-ins alone, never anything of an installed app's.
   */
  backgroundEnv: Readonly<Record<string, string>>;
  env: NodeJS.ProcessEnv;
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  /** Resolves when the person asks the running process to stop (Ctrl-C, or a service stopping it). */
  stopSignal: () => Promise<void>;
  /**
   * Told the folder the run works from once the one-time move brought the
   * work into this app's own (`moveWork`), so the notes go there.
   */
  workingIn?: (dataDir: string) => void;
};

function terminalIO(context: CliContext): HelperIO {
  const write = (lines: readonly string[]) => {
    for (const line of lines) context.stdout.write(`${line}\n`);
  };
  return {
    say: write,
    ask: (lines, prompt) =>
      new Promise((resolve) => {
        write(lines);
        const reader = createInterface({ input: context.stdin, output: context.stdout });
        // A terminal shows what was typed; piped in, the answer is shown
        // here, so a transcript reads the same either way.
        const echo = (answer: string) => {
          if (!(context.stdin as { isTTY?: boolean }).isTTY) context.stdout.write(`${answer}\n`);
        };
        let answered = false;
        reader.question(prompt, (answer) => {
          answered = true;
          reader.close();
          echo(answer);
          resolve(answer);
        });
        reader.once("close", () => {
          if (answered) return;
          echo("");
          resolve("");
        });
      }),
  };
}

/**
 * Where this user's background agent lives and how its service manager is
 * asked about it; null when nothing is. Its label follows the folder the
 * work is in (`HelperPlace.folderSpelling`).
 */
function backgroundOf(
  context: CliContext,
  uid: number,
  at: { dataDir: string; spelling: HelperPlace["spelling"] } = {
    dataDir: context.place.dataDir,
    spelling: context.place.folderSpelling,
  },
): BackgroundContext | null {
  if (!context.serviceManager) return null;
  return {
    flavor: context.place.flavor,
    dataDir: at.dataDir,
    spelling: at.spelling,
    homeDir: homedir(),
    uid,
    ...context.serviceManager,
  };
}

/**
 * The words after a command: `--fetched <app>`, the copy of Firstmate the
 * home sent; `--from-home`, started by the home over Remote Login;
 * `--home <pin> --device <id>`, the home and computer the home expects this
 * folder to run work for (`expectedHomeSchema`), both public;
 * `--on-home-mac true|false`, whether this computer runs on the home's own
 * Mac, as the home's list found it; `--agreed`, the command for another
 * computer asked before it installed this program, or the home's captain
 * did before the home installed it over Remote Login; `--background <file>`,
 * where a joined command learns how its work runs in the background
 * (`InBackground`); and the rest. Null when a flag names nothing, or something it does not take.
 */
function readFlags(rest: readonly string[]): {
  fetched?: string;
  background?: string;
  fromHome: boolean;
  agreed: boolean;
  expected?: ExpectedHome;
  onHomeMac?: boolean;
  words: string[];
} | null {
  const words: string[] = [];
  let fetched: string | undefined;
  let background: string | undefined;
  let homeKey: string | undefined;
  let deviceId: string | undefined;
  let onHomeMac: boolean | undefined;
  let fromHome = false;
  let agreed = false;
  for (let index = 0; index < rest.length; index += 1) {
    const word = rest[index] as string;
    if (
      word === "--fetched" ||
      word === "--background" ||
      word === "--home" ||
      word === "--device"
    ) {
      const value = rest[index + 1];
      if (!value) return null;
      if (word === "--fetched") fetched = value;
      else if (word === "--background") background = value;
      else if (word === "--home") homeKey = value;
      else deviceId = value;
      index += 1;
    } else if (word === "--on-home-mac") {
      const value = rest[index + 1];
      if (value !== "true" && value !== "false") return null;
      onHomeMac = value === "true";
      index += 1;
    } else if (word === "--from-home") fromHome = true;
    else if (word === "--agreed") agreed = true;
    else words.push(word);
  }
  const expected =
    homeKey !== undefined || deviceId !== undefined
      ? expectedHomeSchema.safeParse({ homeKey, deviceId })
      : null;
  if (expected && !expected.success) return null;
  return {
    ...(fetched ? { fetched } : {}),
    ...(background ? { background } : {}),
    fromHome,
    agreed,
    ...(expected?.success ? { expected: expected.data } : {}),
    ...(onHomeMac === undefined ? {} : { onHomeMac }),
    words,
  };
}

/**
 * What the home sent on the input's first line over Remote Login, never in
 * an argument: the link, and the private socket its SSH session forwards
 * here for this join (`sshJoinSchema`).
 */
async function readJoin(stdin: NodeJS.ReadableStream): Promise<SshJoin | null> {
  return readSshMessage(sshJoinSchema, await readLine(stdin));
}

/** The first line of the input. */
function readLine(stdin: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve) => {
    const reader = createInterface({ input: stdin });
    let answered = false;
    reader.once("line", (line) => {
      answered = true;
      reader.close();
      resolve(line.trim());
    });
    reader.once("close", () => {
      if (!answered) resolve("");
    });
  });
}

/** The commands that open the work folder. */
const FOLDER_COMMANDS: ReadonlySet<string> = new Set([
  "status",
  "join",
  "update",
  "remove",
  "connect",
  "run",
]);

/** Silence for a person: the home reads only the outcome line. */
const SILENT: HelperIO = { say: () => {}, ask: async () => "" };

export async function runCli(args: readonly string[], context: CliContext): Promise<number> {
  // Before any command looks for git or runs it: a clone, a crewmate's
  // shell, a removal's look at a working copy (docs/helper.md, "Running").
  if (context.appGit) adoptBundledGit(context.appGit, context.env);
  const io = terminalIO(context);
  const answerHome = (outcome: WorkOutcome): number => {
    context.stdout.write(`${workOutcomeLine(outcome)}\n`);
    return outcome.firstmate === "refused" ? 1 : 0;
  };
  const [command, ...rest] = args;
  const { place } = context;
  // This app's own folder moved to another app's: its work is that app's
  // now, and nothing here opens the copy left behind (docs/helper.md,
  // "Under the other name").
  if (place.retired && command && FOLDER_COMMANDS.has(command)) {
    if (rest.includes("--from-home"))
      return answerHome({ firstmate: "refused", reason: "not-joined" });
    io.say(helperWords.notJoined);
    return 1;
  }
  switch (command) {
    case "--version":
    case "version":
      io.say([`Infinitary ${context.version} · contract ${PROTOCOL_VERSION}`]);
      return 0;
    case "status":
      if (rest.length > 0) break;
      io.say(helperStatus(place.dataDir));
      return 0;
    case "join": {
      // `--fetched <app>`: a command on another Mac asked first, then got
      // this copy of Firstmate from the home (docs/helper.md, "Joining").
      // `--from-home`: the home sent the copy over Remote Login and the link
      // on the input, on its captain's click; the outcome is for the home.
      const flags = readFlags(rest);
      if (!flags) break;
      const { fetched, fromHome } = flags;
      // Over SSH, an Ubuntu package joins from the program already installed,
      // with no fetched copy. A command still names one word, the link.
      if (fromHome ? flags.words.length !== 0 : flags.words.length !== 1) break;
      const sent = fromHome ? await readJoin(context.stdin) : null;
      const text = fromHome ? (sent?.link ?? "") : (flags.words[0] ?? "");
      const user = userInfo();
      const uid = process.getuid?.() ?? user.uid;
      const background = backgroundOf(context, uid);
      const outcome = await joinHome({
        text,
        platform: hostPlatform(),
        dataDir: place.dataDir,
        io: fromHome ? SILENT : io,
        device: {
          name: await ownComputerName({ packaged: place.packaged, env: context.env }),
          user: { name: user.username, uid },
        },
        ...(fetched ? { fetched: { app: fetched } } : {}),
        ...(flags.agreed ? { agreed: true } : {}),
        // The home's captain agreed to leave a home this user runs work for that does not answer.
        ...(sent?.leave ? { leave: true } : {}),
        // Over the home's SSH, every dial with the link goes through the socket it forwards here.
        ...(sent?.socket ? { dial: { target: { socket: sent.socket } } } : {}),
        found: findTools,
        ...(background
          ? {
              background: ({ launcher, app }) =>
                startInBackground(background, {
                  launcher: launcher ?? context.launcher,
                  env: context.backgroundEnv,
                  app,
                }),
              // Finding its home again stops the run the background started first.
              pauseBackground: async () => {
                const { service } = readInstalled(place.dataDir);
                if (!service) return null;
                await pauseInBackground(background, service);
                return () => resumeInBackground(background, service);
              },
            }
          : {}),
        cleanUp: () => cleanUp({ dataDir: place.dataDir, background }),
      });
      if (fromHome)
        return answerHome(
          outcome.ok
            ? {
                firstmate: "joined",
                background: outcome.background,
                ...(outcome.left ? { left: outcome.left } : {}),
              }
            : { firstmate: "refused", reason: outcome.reason },
        );
      // The command reads this to say what keeps the work on after logout
      // (docs/devices.md, "Joining by a command"); unwritten, it says nothing.
      if (outcome.ok && flags.background) {
        try {
          writeFileSync(flags.background, outcome.background);
        } catch {}
      }
      if (
        outcome.ok &&
        (outcome.background === "unavailable" || outcome.background === "unknown")
      ) {
        const launcher = fetchedLauncher(readInstalled(place.dataDir).app) ?? context.launcher;
        const command = [launcher.executable, ...launcher.args, "work", "run"]
          .map(shellWord)
          .join(" ");
        io.say([`To run work here, start ${command} as ${user.username} and keep it running.`]);
      }
      return outcome.ok ? 0 : 1;
    }
    // The home's own, over Remote Login (docs/helper.md, "Started by the home").
    case "update":
    case "remove": {
      const flags = readFlags(rest);
      if (!flags?.fromHome || !flags.expected || flags.words.length !== 0) break;
      const uid = process.getuid?.() ?? userInfo().uid;
      const fromHomeContext = {
        dataDir: place.dataDir,
        expected: flags.expected,
        ...(flags.onHomeMac === undefined ? {} : { onHomeMac: flags.onHomeMac }),
        background: backgroundOf(context, uid),
        backgroundEnv: context.backgroundEnv,
      };
      if (command === "update" && !flags.fetched)
        return answerHome(await restartInstalled(fromHomeContext, context.launcher));
      return answerHome(
        command === "update" && flags.fetched
          ? await updateFromHome(fromHomeContext, flags.fetched)
          : await removeFromHome(fromHomeContext),
      );
    }
    // The far end of the home's own SSH connection, for as long as it lasts
    // (docs/helper.md, "Through the home's SSH"): it speaks only to the home.
    case "connect": {
      const flags = readFlags(rest);
      if (!flags?.fromHome || !flags.expected || flags.fetched || flags.words.length !== 0) break;
      const uid = process.getuid?.() ?? userInfo().uid;
      const background = backgroundOf(context, uid);
      const ended = await connectFromHome({
        dataDir: place.dataDir,
        expected: flags.expected,
        input: context.stdin,
        output: context.stdout,
        agent: (() => {
          const { service } = readInstalled(place.dataDir);
          const probe = background && service ? agentProbe(background, service) : null;
          return async () =>
            probe
              ? probe()
              : background && "systemctl" in background
                ? (await linuxReadiness(background)) === "unavailable"
                  ? "unavailable"
                  : "unknown"
                : "unknown";
        })(),
      });
      return typeof ended === "object" ? 1 : 0;
    }
    case "run": {
      if (rest.length > 0) break;
      const uid = process.getuid?.() ?? userInfo().uid;
      // Work still in an older spelling's folder comes into this app's own
      // first, and the background moves to this app's label with it.
      let dataDir = place.dataDir;
      let folderSpelling = place.folderSpelling;
      if (place.move) {
        const moved = await moveWork({
          place,
          background: (dir, spelling) => backgroundOf(context, uid, { dataDir: dir, spelling }),
          launcher: context.launcher,
          env: context.backgroundEnv,
          deps: {
            platform: hostPlatform(),
            claudeConfigDir: defaultClaudeConfigDir(),
            hostname: hostname(),
          },
          log: workLog(place.dataDir),
        });
        if (moved.kind === "handed-over") return 0;
        if (moved.kind === "later") return 1;
        if (moved.kind === "here") {
          dataDir = moved.dataDir;
          folderSpelling = place.spelling;
          context.workingIn?.(dataDir);
        }
      }
      // The run is where a Claude login Firstmate made here is signed out:
      // the service manager starts it in this user's login session, where
      // Claude's client keeps the login (docs/helper.md, "Removed").
      const claude = new ClaudeAuthBackend({
        ...(context.keychain ? { keychain: context.keychain } : {}),
        pasteCode: true,
      });
      const signOutClaude = (record: string) => claude.signOutMadeLogin(record);
      const inBackground = backgroundOf(context, uid, { dataDir, spelling: folderSpelling });
      const removing = () => cleanUp({ dataDir, background: inBackground, signOutClaude });
      // A removal an earlier run could not finish comes first: its home is gone.
      const finished = await finishRemoval({
        dataDir,
        say: io.say,
        cleanUp: removing,
      });
      if (finished === "busy") return 1;
      if (finished) return finished.unremoved ? 1 : 0;
      // A development run may stand in the publisher check a download here
      // runs, for a stand-in release a test serves; an installed app never does.
      const verifier = place.packaged ? undefined : settingFrom(context.env, "CODESIGN")?.trim();
      // Where this computer listens for its home's announcement once no
      // address it keeps answers: this computer's own Bonjour, or a
      // development run's dns-sd stand-in (docs/helper.md, "Finding the home again").
      const findHome = homeFinder(
        place.packaged ? undefined : settingFrom(context.env, "DNS_SD")?.trim() || undefined,
      );
      const { serviceManager } = context;
      const started = startHelper({
        dataDir,
        say: io.say,
        packaged: place.packaged,
        ...(findHome ? { findHome } : {}),
        appVersion: context.version,
        ...(context.source ? { source: context.source } : {}),
        ...(verifier ? { verifier } : {}),
        background: inBackground ? { context: inBackground, env: context.backgroundEnv } : null,
        ...(context.gitAskpass ? { gitAskpass: context.gitAskpass } : {}),
        ...(context.keychain ? { keychain: context.keychain } : {}),
        ...(context.probeMedia ? { probeMedia: context.probeMedia } : {}),
        ...(context.probeTypeface ? { probeTypeface: context.probeTypeface } : {}),
        ...(context.resourceMemory ? { resourceMemory: context.resourceMemory } : {}),
        ...(context.browser
          ? { browser: { ...context.browser, ...browserLookup(place.packaged) } }
          : {}),
        ...(context.setAsideProcess ? { setAsideProcess: context.setAsideProcess } : {}),
        signOutClaude,
        cleanUp: removing,
        // The first mate, when its home moves here (docs/devices.md, "Moving
        // the first mate"): the app's own run starts on the data folder beside
        // this work folder, in the background, as the window's would.
        ...(serviceManager
          ? {
              startHome: async () =>
                (await startRunAgent({
                  label: runLabelOf(place.flavor),
                  dataDir: dirname(dataDir),
                  homeDir: homedir(),
                  uid,
                  unitsDir: userUnitsDir(context.env, homedir()),
                  launcher: fetchedLauncher(readInstalled(dataDir).app) ?? context.launcher,
                  env: context.backgroundEnv,
                  ...serviceManager,
                })) === "running",
            }
          : {}),
      });
      if (!started.ok) return 1;
      // Updated by its home, the run ends and the background starts the
      // version kept here again (docs/helper.md, "Updated by its home").
      await Promise.race([started.run.ended, context.stopSignal()]);
      await started.run.stop();
      return 0;
    }
    case undefined:
    case "--help":
    case "help":
      io.say(helperWords.usage);
      return command === undefined ? 2 : 0;
  }
  io.say(helperWords.usage);
  return 2;
}
