import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { addressParts, type RemoteLoginRefusal } from "@shared/remoteLogin";
import { hostEnv } from "../hostEnv";
import { hostPlatform } from "../platform";
import { type HostKey, preferHostKey } from "./hostTrust";
import { type SshProgram, systemSshTool } from "./ssh";

/**
 * The other Mac's check line, read without signing in (docs/devices.md,
 * "Your yes on the check line"). `ssh -G` asks the captain's own SSH where
 * it would connect, so an alias still resolves, and `ssh-keyscan` reads the
 * key there. Neither writes SSH settings, and neither offers a key or a
 * password. A failure is a refusal, never a key to trust.
 */

const SCAN_TIMEOUT_MS = 15_000;
const PROBE_TIMEOUT_MS = 3_000;
const KEY_TYPES = "ed25519,ecdsa-sha2-nistp256,rsa";

export type HostKeyRead = HostKey | { refusal: RemoteLoginRefusal };

/**
 * The user the captain's own SSH signs in to `address` as, as its settings
 * resolve it, or null when it cannot tell; the password question names it.
 */
export function signInUser(ssh: SshProgram, address: string): Promise<string | null> {
  const typed = /^([^@]+)@/.exec(addressParts(address).address)?.[1];
  if (typed) return Promise.resolve(typed);
  return run(ssh.program, [...ssh.args, "-G", "--", address], SCAN_TIMEOUT_MS).then((ran) => {
    const user = ran.code === 0 ? /^user (\S+)$/m.exec(ran.stdout)?.[1] : undefined;
    return user && user.length <= 64 ? user : null;
  });
}

/** The key that Mac answers with, or why it could not be read. */
export function readHostKey(ssh: SshProgram, address: string): Promise<HostKeyRead> {
  return resolveDestination(ssh, address).then((where) =>
    where ? scan(where.host, where.port) : { refusal: "unreachable" },
  );
}

/** Where the captain's own SSH would connect, without connecting. */
export function resolveDestination(
  ssh: SshProgram,
  address: string,
): Promise<{ host: string; port: number } | null> {
  return run(ssh.program, [...ssh.args, "-G", "--", address], SCAN_TIMEOUT_MS).then((ran) => {
    if (ran.code !== 0) return null;
    const host = /^hostname (.+)$/m.exec(ran.stdout)?.[1]?.trim();
    const port = Number(/^port (\d+)$/m.exec(ran.stdout)?.[1]);
    if (!host || host.startsWith("-") || !Number.isInteger(port) || port < 1 || port > 65535)
      return null;
    return { host: host.replace(/^\[|\]$/g, ""), port };
  });
}

/** The keys that host offers, with no sign-in. */
function scan(host: string, port: number): Promise<HostKeyRead> {
  return run(
    systemSshTool("ssh-keyscan"),
    ["-T", "15", "-t", KEY_TYPES, "-p", String(port), "--", host],
    SCAN_TIMEOUT_MS,
  ).then(async (ran) => {
    const keys = ran.stdout
      .split("\n")
      .map((line) => parseKeyLine(line))
      .filter((key) => key !== null);
    const chosen = preferHostKey(keys);
    if (chosen) return chosen;
    // macOS ssh-keyscan says "Broken pipe" when nothing answers the port.
    if (/Connection refused|connect\(\) failed|Connection reset|Broken pipe/i.test(ran.stderr))
      return { refusal: "remote-login-off" };
    // Linux's says nothing when the port is refused, so it is asked once
    // itself; a Mac never dials it, which its local network privacy would ask.
    if (hostPlatform() !== "darwin" && (await portRefuses(host, port)))
      return { refusal: "remote-login-off" };
    return { refusal: "unreachable" };
  });
}

/** Whether `host` answers that nothing listens at `port`: a refused connection, never a silence. */
function portRefuses(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    // A refusal comes at once; anything slower is no answer, which the scan already waited out.
    const socket = createConnection({ host, port, timeout: PROBE_TIMEOUT_MS });
    const done = (refused: boolean) => {
      socket.destroy();
      resolve(refused);
    };
    socket.once("connect", () => done(false));
    socket.once("timeout", () => done(false));
    socket.once("error", (error: NodeJS.ErrnoException) => done(error.code === "ECONNREFUSED"));
  });
}

function parseKeyLine(line: string): { type: string; publicKey: string } | null {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 3 || parts[0]?.startsWith("#")) return null;
  const type = parts[1] ?? "";
  const publicKey = parts[2] ?? "";
  if (!type.startsWith("ssh-") && !type.startsWith("ecdsa-")) return null;
  return { type, publicKey };
}

function run(
  program: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(program, args, { env: hostEnv(), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    timer.unref?.();
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };
    child.once("error", (error) => {
      stderr += `\n${error.message}`;
      finish(255);
    });
    child.once("close", (code) => finish(code));
  });
}
