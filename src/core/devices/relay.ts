import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { Duplex } from "node:stream";
import { COMPUTER } from "@shared/deviceNames";
import { cutText } from "@shared/textCut";
import { isLoopback } from "../connection/addresses";
import { hostEnv } from "../hostEnv";
import { hostPlatform } from "../platform";

/**
 * Reaching another Mac through macOS's own nc (docs/devices.md, "Through
 * macOS's own nc"). Since macOS 15, local network privacy gates an outgoing
 * dial to a local-network address, and tracks the responsible code up the
 * process tree: a dial under Terminal or over SSH, and by any child it
 * spawns, is exempt, but a launchd agent's is not. nc is such a child and
 * only moves bytes, so carrying a dial through it lets the dial take the
 * exemption of whatever started nc - which is what lets the copy the home
 * starts over Remote Login dial back - while the TLS, the home's pin and
 * both keys stay the device's own, end to end. A dial a launchd agent makes
 * is still gated, even through nc, so a headless Mac's background work
 * reaches the home only over a private-network address, or once the Mac has
 * been granted local network access.
 */

/** macOS's own nc. */
export const SYSTEM_RELAY = "/usr/bin/nc";

/** At most this much of what the program says on stderr is kept for its error. */
const SAID_MAX = 1024;

/**
 * The program that carries a dial to `host`, or null to dial directly: on
 * macOS every host but loopback, which local network privacy never asks
 * about; on any other system, nothing.
 */
export function relayFor(host: string, platform: NodeJS.Platform = hostPlatform()): string | null {
  return platform === "darwin" && !isLoopback(host, false) ? SYSTEM_RELAY : null;
}

/**
 * A byte stream to `host:port` through `program`, started as `program host
 * port` with the app's environment: what is written goes to its input, and
 * what it prints is read. The stream ends when the program's output does,
 * and destroying it stops the program. A program that exits with an error
 * before it relayed a byte - nothing answered there - errors the stream
 * with what it said.
 */
export function relayedStream(program: string, host: string, port: number): Duplex {
  return new RelayedStream(
    spawn(program, [host, String(port)], { env: hostEnv(), stdio: ["pipe", "pipe", "pipe"] }),
  );
}

class RelayedStream extends Duplex {
  private relayed = false;
  private said = "";

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    super();
    const { stdin, stdout, stderr } = child;
    stdout.on("data", (chunk: Buffer) => {
      this.relayed = true;
      if (!this.push(chunk)) stdout.pause();
    });
    stdout.once("end", () => this.push(null));
    stderr.on("data", (chunk: Buffer) => {
      if (this.said.length < SAID_MAX) this.said += chunk.toString("utf8");
    });
    // A write after the program is gone fails; its exit says why.
    stdin.on("error", () => {});
    child.once("error", (error) => this.destroy(error));
    child.once("exit", (code, signal) => {
      if (this.relayed || this.destroyed || code === 0) return;
      const said = cutText(this.said.trim(), SAID_MAX);
      this.destroy(
        new Error(
          said ||
            `${child.spawnfile} stopped (${signal ?? code}) before it reached the other ${COMPUTER.one}.`,
        ),
      );
    });
  }

  override _read(): void {
    this.child.stdout.resume();
  }

  override _write(
    chunk: Buffer,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.child.stdin.write(chunk, encoding, () => callback());
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.child.stdin.end(() => callback());
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill();
    callback(error);
  }
}
