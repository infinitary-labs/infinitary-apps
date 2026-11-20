import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { APPIMAGE_LIBRARIES } from "../../src/core/devices/farSystems";
import { shellWord } from "../../src/core/devices/joinCommand";
import type { SshProgram } from "../../src/core/devices/ssh";
import { claimedPort } from "./claimedPort";
import { scratchDir, socketScratchDir } from "./scratchDirs";

/**
 * A throwaway SSH server on loopback, for the home reaching "another Mac"
 * over Remote Login (docs/devices.md, "Adding a computer by its address"): the
 * Mac's own `sshd`, started as the test's own user on a free port with
 * scratch host and user keys, never the Mac's Remote Login, never the
 * person's keys, agent, settings or known hosts.
 *
 * The home's side is the Mac's own `/usr/bin/ssh` run exactly as the app
 * runs it; what this adds stands in for the person's own SSH settings
 * (`-F`, which also keeps the real ones unread), for the app that holds
 * their key and asks before each use, as 1Password's agent does, and can
 * quit and open again (the Mac's own `ssh-agent`, never theirs), and, for
 * the user on the other Mac, a home folder and the development stand-ins
 * of its own, prefixed to the remote command as that user's shell would
 * have them.
 */

/**
 * Whether this computer has the system's own SSH server and client to stand
 * one up: a Mac's, or a Linux computer's OpenSSH (Ubuntu's `openssh-server`).
 */
export const SSH_SERVER_AVAILABLE =
  (process.platform === "darwin" || process.platform === "linux") &&
  existsSync("/usr/sbin/sshd") &&
  existsSync("/usr/bin/ssh") &&
  existsSync("/usr/bin/ssh-keygen");

/**
 * Which key the person's SSH offers: one the server lets in, one locked with
 * a passphrase, one it refuses, or the one it lets in held by an agent that
 * asks before each use (`agent`), which answers as `agentAnswers` says.
 */
export type SshKey = "good" | "locked" | "refused" | "agent";

export type SshServer = {
  port: number;
  /** The test's own user at loopback, as a person types an address. */
  address: string;
  /** The same server under another name its known hosts hold, as an address a person changes to. */
  alias: string;
  /**
   * The ssh the home runs: the Mac's own, offering `key`, at `port` (this
   * server's unless a test points it at nothing), with `remote` as the other
   * user's environment. With `password`, the one run that signs in with a
   * password (`PubkeyAuthentication=no`) asks for it as SSH does, through
   * the askpass the home gave it, and takes only that invented password:
   * this server, run as the test's own user, can check no password.
   */
  ssh: (options?: {
    key?: SshKey;
    port?: number;
    remote?: Record<string, string>;
    password?: string;
    downloads?: Record<string, string>;
    programs?: Record<string, string>;
    elsewhere?: boolean;
  }) => SshProgram;
  /**
   * Each run of an ssh made with `remote` or `password`, in order: its
   * arguments, and whether its environment held the invented password.
   */
  sshRuns: () => { args: string[]; envHeldPassword: boolean }[];
  /** What the person's known hosts say of this server: its own key, nothing, or another key. */
  knownHosts: (state: "known" | "unknown" | "changed") => void;
  /** The stand-in for the person's known hosts, so a test can see it was not written. */
  knownHostsFile: string;
  /** What the agent holding the `agent` key answers each time it asks: it declines until told. */
  agentAnswers: (answer: "approve" | "decline") => void;
  /**
   * Whether the app holding the `agent` key runs, at the socket the person's
   * settings name: it opens again, quits and takes its socket with it
   * (`quit`), or quits and leaves it behind with nothing answering
   * (`quit-left`). It runs until told.
   */
  agentRuns: (state: "open" | "quit" | "quit-left") => Promise<void>;
  /**
   * The network drops: this server and every session it holds stop answering,
   * with nothing refused on the wire, as when Wi-Fi goes away. `thaw` brings it back.
   */
  freeze: () => void;
  thaw: () => void;
  stop: () => Promise<void>;
};

const servers = new Set<ChildProcess>();
const agents = new Set<number>();
process.once("exit", () => {
  for (const server of servers) server.kill("SIGKILL");
  for (const pid of agents) stopAgent(pid);
});

function stopAgent(pid: number, signal: NodeJS.Signals = "SIGTERM"): void {
  agents.delete(pid);
  try {
    process.kill(pid, signal);
  } catch {
    // Already gone.
  }
}

function signalIfAlive(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // Already gone.
  }
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A process and everything under it. */
function processTree(pid: number): number[] {
  let kids: number[] = [];
  try {
    kids = execFileSync("/usr/bin/pgrep", ["-P", String(pid)], { encoding: "utf8" })
      .trim()
      .split("\n")
      .map(Number)
      .filter((each) => each > 0);
  } catch {
    // pgrep exits 1 when nothing is under it.
  }
  return [pid, ...kids.flatMap(processTree)];
}

function keygen(path: string, passphrase = ""): string {
  execFileSync("/usr/bin/ssh-keygen", ["-q", "-t", "ed25519", "-N", passphrase, "-f", path], {
    stdio: "ignore",
  });
  return readFileSync(`${path}.pub`, "utf8").trim().split(" ").slice(0, 2).join(" ");
}

/**
 * A throwaway SSH server; with `forwarding: false` its Remote Login refuses
 * every forward, as a server set up so does. With `passwords`, it offers
 * password sign-in, as macOS's Remote Login does by default, and refuses
 * every password, since it runs as the test's own user. With `home`, it
 * also lets in the keys in that folder's `.ssh/authorized_keys`, as the
 * other user's home folder there. With `env`, every session there gets
 * those variables, as that user's own settings would give them.
 */
export async function startSshServer(
  options: {
    forwarding?: boolean;
    passwords?: boolean;
    home?: string;
    env?: Record<string, string>;
  } = {},
): Promise<SshServer> {
  const dir = scratchDir("infinitary-sshd-");
  const hostKey = keygen(join(dir, "host"));
  const otherHostKey = keygen(join(dir, "other-host"));
  const good = keygen(join(dir, "good"));
  const locked = keygen(join(dir, "locked"), "a passphrase nobody types");
  keygen(join(dir, "refused"));
  const authorized = join(dir, "authorized_keys");
  writeFileSync(authorized, `${good}\n${locked}\n`, { mode: 0o600 });
  const port = await claimedPort();
  // A Linux computer's work needs Xvfb and FUSE there, the libraries the
  // AppImage needs, and a user namespace for Chromium's sandbox
  // (src/core/devices/farSystems.ts), none of which the stand-in Firstmate
  // uses: one that does nothing stands in for each tool this computer lacks,
  // a library list that holds each library, and the namespace probe, which a
  // hosted runner's kernel may refuse, first on the search path every
  // session gets.
  const tools = join(dir, "tools");
  const searchPath = [
    "/usr/local/sbin",
    "/usr/local/bin",
    "/usr/sbin",
    "/usr/bin",
    "/sbin",
    "/bin",
  ];
  const standIns =
    process.platform === "linux"
      ? [
          ...["Xvfb", "fusermount"].filter(
            (tool) => !searchPath.some((folder) => existsSync(join(folder, tool))),
          ),
          "unshare",
        ]
      : [];
  if (standIns.length > 0) {
    mkdirSync(tools, { recursive: true });
    for (const tool of standIns)
      writeFileSync(join(tools, tool), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const libraries = ["libc.so.6", ...Object.values(APPIMAGE_LIBRARIES).flat()];
    writeFileSync(
      join(tools, "ldconfig"),
      `#!/bin/sh\n${libraries
        .map((library) => `printf '\\t%s (libc6,x86-64) => /stand-in/%s\\n' ${library} ${library}`)
        .join("\n")}\n`,
      { mode: 0o755 },
    );
  }
  // What every session there gets: the stand-ins first on its search path,
  // and, the far computer being this one, the sandbox helper its Electron
  // finds where a hosted runner configured one.
  const sessionEnv = [
    ...(standIns.length > 0 ? [`PATH=${[tools, ...searchPath].join(":")}`] : []),
    ...(process.platform === "linux" && process.env.CHROME_DEVEL_SANDBOX
      ? [`CHROME_DEVEL_SANDBOX=${process.env.CHROME_DEVEL_SANDBOX}`]
      : []),
    ...Object.entries(options.env ?? {}).map(([name, value]) => `"${name}=${value}"`),
  ];
  const config = join(dir, "sshd_config");
  writeFileSync(
    config,
    [
      `Port ${port}`,
      "ListenAddress 127.0.0.1",
      `HostKey ${join(dir, "host")}`,
      `AuthorizedKeysFile ${authorized}${options.home ? ` ${join(options.home, ".ssh", "authorized_keys")}` : ""}`,
      `PidFile ${join(dir, "sshd.pid")}`,
      "UsePAM no",
      `PasswordAuthentication ${options.passwords ? "yes" : "no"}`,
      "KbdInteractiveAuthentication no",
      "StrictModes no",
      // Failed sign-ins from loopback are the test's point: never penalized.
      "PerSourcePenalties no",
      ...(options.forwarding === false ? ["DisableForwarding yes"] : []),
      // sshd reads only its first SetEnv line, so every variable rides that one.
      ...(sessionEnv.length > 0 ? [`SetEnv ${sessionEnv.join(" ")}`] : []),
      "",
    ].join("\n"),
  );
  // An older sshd has no penalties to turn off, and refuses the setting.
  try {
    execFileSync("/usr/sbin/sshd", ["-t", "-f", config], { stdio: "pipe" });
  } catch (error) {
    const said = String((error as { stderr?: Buffer }).stderr ?? "");
    if (!said.includes("PerSourcePenalties")) throw error;
    writeFileSync(config, readFileSync(config, "utf8").replace(/^PerSourcePenalties.*\n/m, ""));
  }
  const server = spawn("/usr/sbin/sshd", ["-D", "-e", "-f", config], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  servers.add(server);
  let frozen: number[] = [];
  await new Promise<void>((resolve, reject) => {
    let said = "";
    const timer = setTimeout(() => reject(new Error(`sshd did not start: ${said}`)), 10_000);
    server.stderr?.on("data", (chunk: Buffer) => {
      said += chunk.toString("utf8");
      if (said.includes("Server listening")) {
        clearTimeout(timer);
        resolve();
      }
    });
    server.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`sshd exited ${code}: ${said}`));
    });
  });
  server.stderr?.resume();

  const knownHostsFile = join(dir, "known_hosts");
  const knownHosts = (state: "known" | "unknown" | "changed") =>
    writeFileSync(
      knownHostsFile,
      state === "unknown"
        ? ""
        : `[127.0.0.1]:${port},[localhost]:${port} ${state === "known" ? hostKey : otherHostKey}\n`,
    );
  knownHosts("known");

  // The person's agent, started the first time an ssh offers its key: the
  // Mac's own ssh-agent holding the key the server lets in, which asks
  // before every use (`ssh-add -c`) through an askpass that answers what
  // the answer file says, as an app such as 1Password asks the person.
  const answer = join(dir, "agent-answer");
  writeFileSync(answer, "decline\n");
  const askpass = join(dir, "askpass");
  writeFileSync(askpass, `#!/bin/sh\n[ "$(cat ${shellWord(answer)})" = approve ]\n`, {
    mode: 0o755,
  });
  const agentEnv = { PATH: "/usr/bin:/bin", SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: "force" };
  let socket: string | null = null;
  let agent: { pid: number } | null = null;
  let quit = false;
  let opened = 0;
  const openAgent = (at: string) => {
    // Publish the agent only once it holds the key, so a quiet SSH try
    // cannot find an open agent with no identities while it starts.
    const own = `${at}-${++opened}`;
    const said = execFileSync("/usr/bin/ssh-agent", ["-a", own], {
      env: agentEnv,
      encoding: "utf8",
    });
    const pid = Number(/SSH_AGENT_PID=(\d+)/.exec(said)?.[1]);
    if (!pid) throw new Error(`ssh-agent did not start: ${said}`);
    agents.add(pid);
    execFileSync("/usr/bin/ssh-add", ["-c", join(dir, "good")], {
      env: { ...agentEnv, SSH_AUTH_SOCK: own },
      stdio: "ignore",
    });
    // Replace the previous socket in one step. On quit the agent removes
    // its own socket, leaving this link dangling, just like a missing app.
    const link = `${at}.link`;
    rmSync(link, { force: true });
    symlinkSync(own, link);
    renameSync(link, at);
    agent = { pid };
  };
  const agentSocket = (): string => {
    socket ??= join(socketScratchDir("fm-a-"), "agent");
    if (!agent && !quit) openAgent(socket);
    return socket;
  };
  const agentRuns = async (state: "open" | "quit" | "quit-left") => {
    socket ??= join(socketScratchDir("fm-a-"), "agent");
    const at = socket;
    quit = state !== "open";
    if (!quit) {
      if (!agent) openAgent(at);
      return;
    }
    if (!agent) return;
    const { pid } = agent;
    agent = null;
    // Asked to quit, ssh-agent removes its socket; killed, it cannot.
    stopAgent(pid, state === "quit" ? "SIGTERM" : "SIGKILL");
    const deadline = Date.now() + 10_000;
    while (running(pid) || (state === "quit" && existsSync(at))) {
      if (Date.now() > deadline) throw new Error(`ssh-agent ${pid} did not quit.`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  let made = 0;
  const runs = join(dir, "ssh-runs.jsonl");
  const ssh = (
    options: {
      key?: SshKey;
      port?: number;
      remote?: Record<string, string>;
      password?: string;
      /** Stand in for release storage without letting a test reach the public network. */
      downloads?: Record<string, string>;
      programs?: Record<string, string>;
      elsewhere?: boolean;
    } = {},
  ) => {
    made += 1;
    const settings = join(dir, `ssh_config-${made}`);
    writeFileSync(
      settings,
      [
        "Host *",
        `  Port ${options.port ?? port}`,
        // The agent's key is named by its public half, as 1Password says to.
        options.key === "agent"
          ? `  IdentityFile ${join(dir, "good.pub")}`
          : `  IdentityFile ${join(dir, options.key ?? "good")}`,
        "  IdentitiesOnly yes",
        `  IdentityAgent ${options.key === "agent" ? agentSocket() : "none"}`,
        `  UserKnownHostsFile ${knownHostsFile}`,
        "  GlobalKnownHostsFile /dev/null",
        "",
      ].join("\n"),
    );
    const remote = Object.entries(options.remote ?? {});
    if (
      remote.length === 0 &&
      options.password === undefined &&
      !options.downloads &&
      !options.programs &&
      !options.elsewhere
    )
      return { program: "/usr/bin/ssh", args: ["-F", settings] };
    // The other user's environment, as its shell would have it: assignments
    // before the remote command, which the home quoted word by word.
    const prefix = remote.map(([name, value]) => `${name}=${shellWord(value)}`).join(" ");
    const program = join(dir, `ssh-${made}`);
    writeFileSync(
      program,
      [
        `#!${process.execPath}`,
        'const { spawn, spawnSync } = require("node:child_process");',
        'const { appendFileSync } = require("node:fs");',
        `const PASSWORD = ${JSON.stringify(options.password ?? null)};`,
        "let args = process.argv.slice(2);",
        `appendFileSync(${JSON.stringify(runs)}, JSON.stringify({ args, envHeldPassword: PASSWORD !== null && Object.values(process.env).some((value) => typeof value === "string" && value.includes(PASSWORD)) }) + "\\n");`,
        "const env = { ...process.env };",
        // The run that signs in with a password: asked as SSH asks, then
        // signed in with the key the server lets in, never asking again.
        "if (PASSWORD !== null && args.includes('PubkeyAuthentication=no')) {",
        "  const asked = spawnSync(process.env.SSH_ASKPASS, ['the password: '], { stdio: ['inherit', 'pipe', 'inherit'] });",
        "  const typed = asked.status === 0 ? asked.stdout.toString('utf8').replace(/\\n$/, '') : null;",
        "  if (typed !== PASSWORD) {",
        "    process.stderr.write('Permission denied (publickey,password).\\n');",
        "    process.exit(255);",
        "  }",
        "  const asking = /^(PubkeyAuthentication|PreferredAuthentications|PasswordAuthentication|KbdInteractiveAuthentication|NumberOfPasswordPrompts|BatchMode|IdentityAgent)=/;",
        "  args = args.filter((arg, at) => !asking.test(arg) && !(arg === '-o' && asking.test(args[at + 1] ?? '')));",
        `  args = ['-o', 'BatchMode=yes', '-i', ${JSON.stringify(join(dir, "good"))}, ...args];`,
        "  delete env.SSH_ASKPASS;",
        "  delete env.SSH_ASKPASS_REQUIRE;",
        "}",
        // Asking SSH where it would connect carries no remote command.
        "if (args.includes('-G')) {",
        `  const child = spawn("/usr/bin/ssh", ["-F", ${JSON.stringify(settings)}, ...args], { stdio: "inherit" });`,
        "  child.on('exit', (code) => { process.exitCode = code ?? 255; });",
        "  return;",
        "}",
        // A request on a control socket carries no remote command to prefix.
        'let command = args.includes("-O") ? undefined : args.pop();',
        `for (const [from, to] of Object.entries(${JSON.stringify({ ...options.downloads, ...options.programs })})) if (command) command = command.split(from).join(to);`,
        // Another Mac cannot read the home computer's locality challenge.
        ...(options.elsewhere
          ? [
              `if (command) command = command.replace(/'\\/tmp\\/infinitary-here-[^']+\\/here'/g, ${JSON.stringify(shellWord(join(dir, "elsewhere-no-token")))});`,
            ]
          : []),
        `const child = spawn("/usr/bin/ssh", ["-F", ${JSON.stringify(settings)}, ...args, ...(command === undefined ? [] : [${JSON.stringify(prefix)} + " " + command])], { stdio: "inherit", env });`,
        "for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => child.kill(signal));",
        "child.on('exit', (code) => { process.exitCode = code ?? 255; });",
        "",
      ].join("\n"),
    );
    chmodSync(program, 0o755);
    return { program, args: [] };
  };

  return {
    port,
    address: `${userInfo().username}@127.0.0.1`,
    alias: `${userInfo().username}@localhost`,
    ssh,
    knownHosts,
    knownHostsFile,
    sshRuns: () =>
      existsSync(runs)
        ? readFileSync(runs, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as { args: string[]; envHeldPassword: boolean })
        : [],
    agentAnswers: (said) => writeFileSync(answer, `${said}\n`),
    agentRuns,
    freeze: () => {
      frozen = server.pid === undefined ? [] : processTree(server.pid);
      for (const pid of frozen) signalIfAlive(pid, "SIGSTOP");
    },
    thaw: () => {
      for (const pid of frozen) signalIfAlive(pid, "SIGCONT");
      frozen = [];
    },
    stop: async () => {
      for (const pid of frozen) signalIfAlive(pid, "SIGCONT");
      frozen = [];
      if (agent) stopAgent(agent.pid);
      servers.delete(server);
      if (server.exitCode !== null) return;
      const exited = new Promise((resolve) => server.once("exit", resolve));
      server.kill("SIGTERM");
      await exited;
    },
  };
}
