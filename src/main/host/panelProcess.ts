import { createInterface } from "node:readline";
import type { HostChildProcess, HostChildSpawner } from "@core/host";
import { utilityProcess } from "electron";

type OutputListener = Parameters<NonNullable<HostChildProcess["onOutput"]>>[0];

/**
 * The process that runs one panel's background module (INF-2205 piece B,
 * docs/personal-panels.md "Background work runs apart"), as a utility
 * process: a panel whose code holds its loop is stopped by killing it, and
 * the packaged app's run-as-node fuse is off, so Node's own `fork` would
 * start the whole app. The entry is the built `panelProcess`
 * (src/core/panels/panelProcess.ts). What it prints is read line by line
 * and handed to the core, which keeps it in the panel log beside the lines
 * its code hands `context.log` (docs/personal-panels.md, "The panel log").
 * Both streams are always read, so a panel that prints a lot never waits on
 * a full pipe.
 */
export function createPanelProcessSpawner(entryPath: string): HostChildSpawner {
  return {
    spawn: (): HostChildProcess => {
      const child = utilityProcess.fork(entryPath, [], {
        serviceName: "Infinitary Panel",
        stdio: "pipe",
      });
      let exited = false;
      const exitListeners: ((code: number | null) => void)[] = [];
      const outputListeners: OutputListener[] = [];
      child.once("exit", (code) => {
        exited = true;
        for (const listener of exitListeners) listener(code);
      });
      for (const [stream, readable] of [
        ["stdout", child.stdout],
        ["stderr", child.stderr],
      ] as const) {
        if (!readable) continue;
        createInterface({ input: readable, crlfDelay: Number.POSITIVE_INFINITY }).on(
          "line",
          (line) => {
            for (const listener of outputListeners) listener(stream, line);
          },
        );
      }
      return {
        get pid() {
          return child.pid;
        },
        postMessage: (message) => {
          if (!exited) child.postMessage(message);
        },
        onMessage: (listener) => child.on("message", listener),
        onExit: (listener) => {
          exitListeners.push(listener);
        },
        onOutput: (listener) => {
          outputListeners.push(listener);
        },
        kill: () => {
          if (!exited) child.kill();
        },
      };
    },
  };
}
