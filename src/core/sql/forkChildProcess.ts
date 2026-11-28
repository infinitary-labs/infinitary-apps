import { fork } from "node:child_process";
import type { HostChildProcess, HostChildSpawner } from "../host";

/**
 * A `HostChildSpawner` over Node's own `fork`, for a host with no Electron:
 * a headless core and the tests. The Electron app spawns a utility process
 * instead (src/main/host/electronHost.ts), because the packaged binary's
 * run-as-node fuse is off and `fork` would start the whole app.
 */
export function forkChildProcess(entryPath: string): HostChildSpawner {
  return {
    spawn: (): HostChildProcess => {
      const child = fork(entryPath, [], {
        execArgv: [],
        stdio: ["ignore", "inherit", "inherit", "ipc"],
      });
      let stopped = false;
      const stop = (): void => {
        if (stopped) return;
        stopped = true;
        child.kill("SIGKILL");
      };
      const exitListeners: ((code: number | null) => void)[] = [];
      child.once("exit", (code) => {
        stopped = true;
        for (const listener of exitListeners) listener(code);
      });
      return {
        pid: child.pid,
        postMessage: (message) => {
          if (stopped || !child.connected) return;
          // The peer can close before Node updates `connected`. Retire the child
          // on a failed write so its owner gets the same exit as any interruption.
          child.send(message as never, (error) => {
            if (error) stop();
          });
        },
        onMessage: (listener) => child.on("message", listener),
        onExit: (listener) => {
          exitListeners.push(listener);
        },
        kill: stop,
      };
    },
  };
}
