import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { systemSshTool } from "../../src/core/devices/ssh";
import { claimedPort } from "../helpers/claimedPort";
import { scratchDir } from "../helpers/scratchDirs";

/**
 * An SSH server on this PC's loopback, standing in for another computer's
 * SSH server when the installed app joins a home by its address with
 * Windows' own `ssh.exe` and `ssh-keyscan.exe` (docs/windows.md, "The
 * checks"). The check's person is a standard account, so the server is
 * Win32-OpenSSH's own `sshd.exe` from its pinned release (windows.yml),
 * run in the foreground as that person, which lets in that person alone and
 * by key alone. Windows' sshd runs every command through `cmd.exe`, while
 * the join's fixed command is a POSIX shell's, as on a Mac or Linux
 * computer, so the server hands each command to Git Bash (`ForceCommand`).
 * Its session keeps the server's own environment, which names the home's
 * data folder, where the join's command finds the home's door.
 *
 * The person's own key is `%USERPROFILE%\.ssh\id_ed25519`, made with
 * Windows' own ssh-keygen when the PC has none, and taken away again by
 * `close` when this made it.
 */
export type LoopbackSshd = {
  /** What a person types to reach it: their account at this PC's loopback, at its port. */
  readonly address: string;
  readonly port: number;
  /** Its host key's SHA256 fingerprint, as Windows' ssh-keygen prints it: the check line's own. */
  readonly fingerprint: string;
  /** What the server said, for the evidence. */
  log(): string;
  close(): Promise<void>;
};

export async function startLoopbackSshd(options: {
  /** The unpacked Win32-OpenSSH release holding `sshd.exe`. */
  serverDir: string;
  /** Git Bash, which runs each command the way a Mac's or Linux computer's login shell does. */
  bash: string;
  /** The data folder the join's command looks in first (`INFINITARY_USER_DATA_DIR`). */
  dataDir: string;
  user: string;
}): Promise<LoopbackSshd> {
  const sshd = join(options.serverDir, "sshd.exe");
  if (!existsSync(sshd)) throw new Error(`no sshd.exe in ${options.serverDir}`);
  const keygen = systemSshTool("ssh-keygen");
  const folder = scratchDir("infinitary-windows-sshd-");
  // Every path the server and Git Bash read, written with forward slashes, which both take.
  const slashes = (path: string) => path.replace(/\\/g, "/");
  const hostKey = join(folder, "host_ed25519");
  execFileSync(keygen, ["-q", "-t", "ed25519", "-N", "", "-f", hostKey], { windowsHide: true });
  const fingerprint =
    /SHA256:\S+/.exec(
      execFileSync(keygen, ["-l", "-f", `${hostKey}.pub`], { encoding: "utf8", windowsHide: true }),
    )?.[0] ?? "";

  const sshDir = join(process.env.USERPROFILE ?? "", ".ssh");
  const personKey = join(sshDir, "id_ed25519");
  const madeKey = !existsSync(personKey);
  if (madeKey) {
    mkdirSync(sshDir, { recursive: true });
    execFileSync(keygen, ["-q", "-t", "ed25519", "-N", "", "-f", personKey], {
      windowsHide: true,
    });
  }
  const authorized = join(folder, "authorized_keys");
  writeFileSync(authorized, readFileSync(`${personKey}.pub`));

  // Each command the person's ssh sends, run by Git Bash as a login shell would run it.
  const forced = join(folder, "forced.sh");
  writeFileSync(forced, 'eval "$SSH_ORIGINAL_COMMAND"\n');
  const port = await claimedPort();
  const config = join(folder, "sshd_config");
  writeFileSync(
    config,
    [
      `Port ${port}`,
      "ListenAddress 127.0.0.1",
      `HostKey ${slashes(hostKey)}`,
      `AuthorizedKeysFile ${slashes(authorized)}`,
      // The scratch folder's access list is the profile's, which the person's own files share.
      "StrictModes no",
      "PidFile none",
      "PasswordAuthentication no",
      "KbdInteractiveAuthentication no",
      "LogLevel VERBOSE",
      `ForceCommand "${slashes(options.bash)}" "${slashes(forced)}"`,
      "",
    ].join("\n"),
  );

  let said = "";
  const server: ChildProcess = spawn(sshd, ["-D", "-e", "-f", config], {
    env: { ...process.env, INFINITARY_USER_DATA_DIR: slashes(options.dataDir) },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const keepSaid = (chunk: Buffer) => {
    said = (said + chunk.toString("utf8")).slice(-64 * 1024);
  };
  server.stdout?.on("data", keepSaid);
  server.stderr?.on("data", keepSaid);
  let exited = false;
  server.once("exit", () => {
    exited = true;
  });

  const close = async () => {
    if (!exited) {
      try {
        execFileSync("taskkill", ["/PID", String(server.pid), "/T", "/F"], { stdio: "ignore" });
      } catch {}
    }
    if (madeKey) {
      rmSync(personKey, { force: true });
      rmSync(`${personKey}.pub`, { force: true });
    }
  };
  const deadline = Date.now() + 30_000;
  while (!(await listens(port))) {
    if (exited || Date.now() > deadline) {
      await close();
      throw new Error(`sshd did not listen on 127.0.0.1:${port}:\n${said}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return {
    address: `ssh://${options.user}@127.0.0.1:${port}`,
    port,
    fingerprint,
    log: () => said,
    close,
  };
}

function listens(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}
