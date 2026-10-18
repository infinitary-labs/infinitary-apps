import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Writable } from "node:stream";
import { hostEnv } from "../hostEnv";
import { hostPlatform } from "../platform";
import { findOnPath } from "../userBin";
import { shellWord } from "./joinCommand";

/**
 * The captain's own SSH, as the home runs it to reach another Mac over
 * Remote Login (docs/devices.md, "Adding a computer by its address"): the Mac's
 * own `/usr/bin/ssh`, with the person's own agent from the app's
 * environment (`hostEnv`), in batch mode so it never asks anything.
 *
 * The app reads no SSH settings or keys: SSH reads the person's own, so an
 * alias they set up works. What the app adds only ever narrows what SSH
 * does - no terminal, no agent or display forwarding, no port forwarding a
 * setting asks for, no local command, no shared connection left behind -
 * and never loosens how SSH checks the other Mac is the one it reached
 * before. A yes on the check line is checked against Firstmate's own list,
 * not written into the person's SSH settings. It stores no password. The one
 * run that types a password, once, to let Firstmate's own key in is
 * `./sshPassword.ts`; every other run asks nothing.
 */

/** The ssh the home starts: the system's own, or a development run's stand-in (`INFINITARY_SSH`). */
export type SshProgram = { program: string; args: readonly string[] };

/**
 * One of the system's own SSH tools: a Mac's, in `/usr/bin`; on Linux the
 * one its search path finds, since NixOS keeps none in `/usr/bin`, else
 * `/usr/bin`'s.
 */
export function systemSshTool(
  name: "ssh" | "ssh-keyscan" | "ssh-keygen",
  platform: string = hostPlatform(),
): string {
  if (platform === "darwin") return `/usr/bin/${name}`;
  return findOnPath(name, hostEnv()) ?? `/usr/bin/${name}`;
}

/** The system's own ssh, as the home runs it. */
export function systemSsh(): SshProgram {
  return { program: systemSshTool("ssh"), args: [] };
}

/**
 * What every ssh the home starts carries before the address. `-v` keeps
 * SSH's own notes on stderr, which are read only to tell a key locked with
 * a passphrase, one its agent did not sign with, or an agent that did not
 * answer, from a key the other Mac refused (`sshRefusal`).
 */
export const SSH_OPTIONS: readonly string[] = [
  "-T",
  "-v",
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=15",
  "-o",
  "ServerAliveInterval=15",
  "-o",
  "ServerAliveCountMax=4",
  "-o",
  "ForwardAgent=no",
  "-o",
  "ForwardX11=no",
  "-o",
  "ClearAllForwardings=yes",
  "-o",
  "PermitLocalCommand=no",
  "-o",
  "ControlMaster=no",
  "-o",
  "RequestTTY=no",
];

/** SSH's own way of saying it could not reach, or sign in to, the other Mac. */
export const SSH_FAILED = 255;

export type SshResult = {
  /** The remote command's exit code, `SSH_FAILED` when SSH itself failed, null when stopped. */
  code: number | null;
  stdout: string;
  /** The end of stderr: SSH's own notes and what the remote command said there. */
  stderr: string;
  stopped?: "timeout" | "inactive";
};

/** How much of each stream is kept: the outcome line and SSH's notes fit well inside. */
const KEEP_BYTES = 64 * 1024;

/** Movement renews only the transfer phase; end hands the remaining work to its backstop. */
export type SshActivity = (() => void) & { end: () => void };

export type RunSshOptions = {
  ssh: SshProgram;
  /** Where to reach, as the person typed it (`remoteLoginAddressSchema`). */
  address: string;
  /** The remote command, word by word; each is quoted for the other Mac's shell. None for a request on a control socket. */
  command?: readonly string[];
  /** What it carries before the address; `SSH_OPTIONS` unless it goes over the app's own control socket. */
  options?: readonly string[];
  /** Writes what the remote command reads; the stream is ended after it resolves. */
  stdin?: (sink: Writable, activity: SshActivity) => Promise<void>;
  /** Only real byte movement renews this transfer deadline; activity.end() ends that phase. */
  idleTimeoutMs?: number;
  /** Returns true for new bytes; activity.end() hands silent checking/start work to its backstop. */
  onLine?: (line: string, activity: SshActivity) => boolean;
  /** Backstop for silent work: after activity.end() with an idle deadline, immediately otherwise. */
  timeoutMs?: number;
};

/** The arguments ssh is started with: its options, the address, and the remote command as one line. */
export function sshArguments(
  ssh: SshProgram,
  address: string,
  command: readonly string[] | undefined,
  options: readonly string[] = SSH_OPTIONS,
) {
  if (address.startsWith("-")) throw new Error("An address never starts with a dash.");
  return [
    ...ssh.args,
    ...options,
    "--",
    address,
    ...(command?.length ? [command.map(shellWord).join(" ")] : []),
  ];
}

/** The app's environment for ssh: batch mode asks nothing, and nothing may ask on its behalf. */
export function sshEnv(): NodeJS.ProcessEnv {
  const env = hostEnv();
  delete env.SSH_ASKPASS;
  delete env.SSH_ASKPASS_REQUIRE;
  return env;
}

/** Runs one remote command over the captain's own SSH; never rejects for what the other Mac answered. */
export function runSsh(options: RunSshOptions): Promise<SshResult> {
  const args = sshArguments(options.ssh, options.address, options.command, options.options);
  return new Promise((resolve) => {
    const child = spawn(options.ssh.program, args, {
      env: sshEnv(),
      stdio: [options.stdin ? "pipe" : "ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let stopped: SshResult["stopped"];
    let settled = false;
    let idle: ReturnType<typeof setTimeout> | undefined;
    let force: ReturnType<typeof setTimeout> | undefined;
    const stop = (why: NonNullable<SshResult["stopped"]>) => {
      stopped ??= why;
      child.kill("SIGTERM");
      force ??= setTimeout(() => child.kill("SIGKILL"), 2_000);
      force.unref();
    };
    let transferring = options.idleTimeoutMs !== undefined;
    let backstop: ReturnType<typeof setTimeout> | undefined;
    const startBackstop = () => {
      if (settled) return;
      if (options.timeoutMs) {
        backstop = setTimeout(() => stop("timeout"), options.timeoutMs);
        backstop.unref();
      }
    };
    const activity: SshActivity = Object.assign(
      () => {
        if (!transferring || settled) return;
        if (idle) clearTimeout(idle);
        if (options.idleTimeoutMs) {
          idle = setTimeout(() => stop("inactive"), options.idleTimeoutMs);
          idle.unref();
        }
      },
      {
        end: () => {
          if (!transferring || settled) return;
          transferring = false;
          if (idle) clearTimeout(idle);
          startBackstop();
        },
      },
    );
    if (transferring) activity();
    else startBackstop();
    let partial = "";
    const keep = (kept: string, chunk: Buffer) => {
      const next = kept + chunk.toString("utf8");
      return next.length > KEEP_BYTES ? next.slice(next.length - KEEP_BYTES) : next;
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = keep(stdout, chunk);
      if (options.onLine) {
        partial += chunk.toString("utf8");
        const lines = partial.split("\n");
        partial = (lines.pop() ?? "").slice(-KEEP_BYTES);
        for (const line of lines) if (options.onLine(line, activity)) activity();
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = keep(stderr, chunk);
    });
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      if (backstop) clearTimeout(backstop);
      if (idle) clearTimeout(idle);
      if (force) clearTimeout(force);
      child.stdin?.destroy();
      void input.finally(() => resolve({ code, stdout, stderr, ...(stopped ? { stopped } : {}) }));
    };
    child.once("error", (error) => {
      stderr += `\n${error.message}`;
      finish(SSH_FAILED);
    });
    child.once("close", (code) => finish(code));
    let input: Promise<void> = Promise.resolve();
    if (options.stdin && child.stdin) {
      const sink = child.stdin;
      // The other Mac may stop reading early, as a refusal does.
      sink.on("error", () => {});
      input = options
        .stdin(sink, activity)
        .catch(() => undefined)
        .finally(() => sink.end());
    }
  });
}

/**
 * The options of an SSH connection the app keeps for itself (docs/devices.md,
 * "Through the home's SSH"): `SSH_OPTIONS`, with the connection the app's own
 * master over a control socket in a folder only this user may enter, and
 * gone with its session: `ControlPersist=no`. `ClearAllForwardings` stays,
 * so no forward a person's settings ask for opens; it clears a forward on
 * the command line too, so the one the app needs is added afterwards over
 * the control socket (`SshMaster.forward`).
 */
export const SSH_MASTER_OPTIONS: readonly string[] = [
  ...SSH_OPTIONS.filter(
    (option, index, all) => option !== "ControlMaster=no" && all[index + 1] !== "ControlMaster=no",
  ),
  "-o",
  "ControlMaster=yes",
  "-o",
  "ControlPersist=no",
];

/** Where the app's control sockets go: a folder of its own under `/tmp`, so the path fits. */
export const CONTROL_FOLDER_PREFIX = "infinitary-c-";
/** The longest socket path macOS keeps, without its closing zero. */
const SOCKET_PATH_LIMIT = 103;
/** What SSH adds to a control socket's path while it makes it: a dot and 16 random letters. */
const CONTROL_SUFFIX_BYTES = 17;

export type SshMasterOptions = {
  ssh: SshProgram;
  address: string;
  /** The remote command the connection's own session runs, word by word. */
  command: readonly string[];
  /** Each line the remote command prints, as it arrives. */
  onLine: (line: string) => void;
  /** Where its control socket's folder is made; `/tmp` unless a test stands in its own. */
  controlBase?: string;
  /**
   * Added after the master's own options, so a remembered check overrides the
   * captain's known hosts for this connection alone.
   */
  options?: readonly string[];
};

/**
 * One SSH connection the app owns: the captain's own SSH, started as the
 * master of a control socket only this user can reach, whose own session
 * runs a fixed remote command. Every other request - a forward, another
 * session - goes over that control socket and never opens a connection of
 * its own; once the master is gone they fail. It ends with its session:
 * when the remote command ends, or once its input ends, which the remote
 * command reads as the home letting go. `stop` ends it within a bound, then
 * terminates it, then kills it, and removes its control socket's folder.
 */
export class SshMaster {
  /** Resolves once the master exited, with its code and the ends of what it said. */
  readonly exited: Promise<SshResult>;
  private readonly child: ReturnType<typeof spawn>;
  private readonly folder: string;
  private readonly control: string;
  private gone = false;

  constructor(private readonly options: SshMasterOptions) {
    if (options.address.startsWith("-")) throw new Error("An address never starts with a dash.");
    this.folder = mkdtempSync(join(options.controlBase ?? "/tmp", CONTROL_FOLDER_PREFIX));
    chmodSync(this.folder, 0o700);
    this.control = join(this.folder, "c");
    // SSH binds a control socket at its path plus a suffix of its own first.
    if (Buffer.byteLength(this.control) + CONTROL_SUFFIX_BYTES > SOCKET_PATH_LIMIT) {
      rmSync(this.folder, { recursive: true, force: true });
      throw new Error("The folder for the app's own SSH connection is too deep for a socket.");
    }
    const args = [
      ...options.ssh.args,
      ...SSH_MASTER_OPTIONS,
      ...(options.options ?? []),
      "-S",
      this.control,
      "--",
      options.address,
      options.command.map(shellWord).join(" "),
    ];
    this.child = spawn(options.ssh.program, args, {
      env: sshEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let held = "";
    this.child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdout = keepEnd(stdout + text);
      held += text;
      for (let at = held.indexOf("\n"); at >= 0; at = held.indexOf("\n")) {
        const line = held.slice(0, at);
        held = held.slice(at + 1);
        options.onLine(line);
      }
      // A line longer than any message is never one; it is dropped.
      if (held.length > KEEP_BYTES) held = "";
    });
    this.child.stderr?.on("data", (chunk: Buffer) => {
      stderr = keepEnd(stderr + chunk.toString("utf8"));
    });
    // The remote command may stop reading before the home stops writing.
    this.child.stdin?.on("error", () => {});
    this.exited = new Promise((resolve) => {
      let settled = false;
      const finish = (code: number | null) => {
        if (settled) return;
        settled = true;
        this.gone = true;
        rmSync(this.folder, { recursive: true, force: true });
        resolve({ code, stdout, stderr });
      };
      this.child.once("error", (error) => {
        stderr += `\n${error.message}`;
        finish(SSH_FAILED);
      });
      this.child.once("close", (code) => finish(code));
    });
  }

  /** Writes one line to the remote command's input; nothing once it is gone. */
  write(line: string): void {
    if (this.gone || !this.child.stdin?.writable) return;
    this.child.stdin.write(line.endsWith("\n") ? line : `${line}\n`);
  }

  /** Whether the master still runs. */
  alive(): boolean {
    return !this.gone;
  }

  /** Ends the remote command's input: it reads that as the home letting go. */
  endInput(): void {
    this.child.stdin?.end();
  }

  /**
   * Forwards the private socket `socket` on the other Mac to `port` on this
   * Mac's loopback, over the control socket alone (`-F /dev/null`, so no
   * setting of the person's adds anything). True once SSH put it in place.
   */
  async forward(socket: string, port: number): Promise<boolean> {
    if (!socket.startsWith("/") || socket.includes(":")) return false;
    const done = await this.request(["-O", "forward", "-R", `${socket}:127.0.0.1:${port}`]);
    return done.code === 0;
  }

  /**
   * Runs one more remote command as its own session over the control
   * socket, with `stdin` on its input and its own end of input: never a new
   * connection, so it fails once the master is gone (`ProxyCommand` refuses
   * the network).
   */
  session(
    command: readonly string[],
    stdin?: (sink: Writable, activity: SshActivity) => Promise<void>,
    timeoutMs?: number,
    progress: Pick<RunSshOptions, "idleTimeoutMs" | "onLine"> = {},
  ): Promise<SshResult> {
    return runSsh({
      ssh: { program: this.options.ssh.program, args: [...this.options.ssh.args, ...this.own()] },
      address: this.options.address,
      command,
      ...(stdin ? { stdin } : {}),
      ...(timeoutMs ? { timeoutMs } : {}),
      ...progress,
      // A session over the control socket, never a connection of its own.
      options: ["-T", "-o", "ControlMaster=no", "-o", "ProxyCommand=/usr/bin/false"],
    });
  }

  /**
   * Ends it within `graceMs`: its input first, so the remote command lets
   * go of what it holds, then the master over its control socket, then a
   * stop signal and, if that is not enough, a kill.
   */
  async stop(graceMs = 5_000): Promise<SshResult> {
    this.endInput();
    if (await within(this.exited, graceMs)) return this.exited;
    await this.request(["-O", "exit"]);
    if (await within(this.exited, 1_000)) return this.exited;
    this.child.kill("SIGTERM");
    if (await within(this.exited, 2_000)) return this.exited;
    this.child.kill("SIGKILL");
    return this.exited;
  }

  /** One request on the control socket, never a connection of its own. */
  private request(words: readonly string[]): Promise<SshResult> {
    if (this.gone) return Promise.resolve({ code: SSH_FAILED, stdout: "", stderr: "" });
    return runSsh({
      ssh: { program: this.options.ssh.program, args: [...this.options.ssh.args, ...this.own()] },
      address: this.options.address,
      options: [...words],
      timeoutMs: 15_000,
    });
  }

  /** What reaches this master alone: no settings of the person's, its own control socket. */
  private own(): string[] {
    return ["-F", "/dev/null", "-S", this.control, "-o", "BatchMode=yes"];
  }
}

/** Keeps the end of a stream: the outcome line and SSH's notes fit well inside. */
function keepEnd(text: string): string {
  return text.length > KEEP_BYTES ? text.slice(text.length - KEEP_BYTES) : text;
}

/** Whether `promise` settles within `ms`. */
function within(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    timer.unref?.();
    void promise.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}
