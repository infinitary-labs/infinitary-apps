import { homedir } from "node:os";
import { join } from "node:path";
import type { HostChildSpawner } from "../host";
import { hostEnv } from "../hostEnv";
import type { AppPaths } from "../paths";
import type { CrewMachines } from "../placed/crewMachines";
import { LOCAL_MACHINE_ID } from "../session/session";
import { FileReach, privateFolders, protectedPlaces } from "./fileReach";
import { type FileComputer, FileRouter } from "./fileRouter";

/** The folder the home keeps its copies in while it reads or delivers them. */
function fileReachDir(paths: AppPaths): string {
  return join(paths.userData, "file-reach");
}

/**
 * The home's files command (docs/files.md): its own files' reader, and the
 * router that answers every task's list and copy, whichever computer the
 * task runs on and whichever the file is on. A copy left in its folders
 * when the app stopped goes before the first new one.
 */
export function startHomeFiles(options: {
  paths: AppPaths;
  /** The home folder `~` names here; this computer's user's own unless a test names a scratch one. */
  home?: string;
  homeName: string | undefined;
  machines: Pick<CrewMachines, "computers" | "nameOf" | "placeOf"> & {
    answersFiles(machine: string): boolean;
  };
  /** Whether a computer on the devices list runs as another macOS user on this Mac (`DevicePairing.onThisMac`). */
  onThisMac: (deviceId: string) => boolean;
  work: {
    inReach(deviceId: string): boolean;
    ask(deviceId: string, channel: string, args: unknown): Promise<unknown>;
  };
  tasks: {
    get(id: string): { deviceId?: string | null } | undefined;
    note(id: string, text: string, options: { news: boolean }): void;
  };
  /**
   * Starts the process each file is set aside in, so a copy never drops the
   * app's own locks (`FileReachOptions.setAsideProcess`).
   */
  setAsideProcess?: HostChildSpawner;
  /** The crew, set up after this. */
  crew: () => {
    sessions: {
      deliverHandover(
        taskId: string,
        path: string,
        name: string,
        sha256: string,
      ): Promise<{ file: string; path: string }>;
      outsideFileRefusal(taskId: string): string | undefined;
    };
  };
}): FileRouter {
  const { paths, machines } = options;
  const home = options.home ?? hostEnv().HOME ?? homedir();
  const here = new FileReach({
    home,
    protectedPlaces: protectedPlaces({ userData: paths.userData, home }),
    privatePlaces: privateFolders(home),
    stagingDir: join(fileReachDir(paths), "set-aside"),
    ...(options.setAsideProcess ? { setAsideProcess: options.setAsideProcess } : {}),
  });
  const computers = (): FileComputer[] =>
    machines.computers().map((id) => {
      // Named as the crewmate's computers paragraph names it (`computersFor`).
      const place = machines.placeOf(id);
      return {
        id,
        name: place.where.startsWith("as ") ? place.who : machines.nameOf(id),
        inReach: options.work.inReach(id),
        answers: machines.answersFiles(id),
        onThisMac: options.onThisMac(id),
      };
    });
  return new FileRouter({
    here,
    homeName: () => options.homeName,
    computers,
    ask: (machine, channel, args) => options.work.ask(machine, channel, args),
    machineOf: (taskId) => options.tasks.get(taskId)?.deviceId ?? LOCAL_MACHINE_ID,
    refusal: (taskId) => options.crew().sessions.outsideFileRefusal(taskId),
    deliver: (taskId, path, name, sha256) =>
      options.crew().sessions.deliverHandover(taskId, path, name, sha256),
    // Each copy is one row of the task's Activity.
    note: (taskId, text) => options.tasks.note(taskId, text, { news: true }),
    stagingDir: join(fileReachDir(paths), "fetched"),
  });
}
