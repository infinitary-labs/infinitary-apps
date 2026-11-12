import { TaskService } from "../tasks/taskService";
import { descendsFrom, type ProcessReading, readProcesses } from "./processResources";

/**
 * A crewmate shell's own process group (docs/axi-commands.md, "Never the
 * crew's"): whose task it is, whether the shell that leads it has ended, and
 * the leader's birth stamp when the app read it (`claimShellGroup`), which a
 * program that later took the group's number does not share.
 */
export type ShellGroup = { owner: string; shellEnded: boolean; started?: string };

/**
 * The process groups crewmate shells started in, each kept after its shell
 * ends until its task closes (`forgetClosed`): a program the shell left running,
 * with `&` or nohup, is still in its group. A program that starts a group of
 * its own, as setsid and tmux do, is not.
 *
 * It is kept apart from `ProcessRoots.addGroup`, whose groups end with the run
 * that declared them and decide whose processor, memory and leftover programs
 * a program counts as: a group kept here until its task closes changes neither.
 */
export class ShellGroups {
  private readonly groups = new Map<number, ShellGroup>();
  private readonly owners = new Map<string, Set<number>>();

  /** `open` says whether an owner's task is still open; absent, every owner's is. */
  constructor(private readonly open: (owner: string) => boolean = () => true) {}

  /** A shell started leading `group` for `owner`, born at `started` when known; the answer marks its end. */
  add(group: number, owner: string, started?: string): () => void {
    // The system gives a number to a new group only once the old one is empty.
    const before = this.groups.get(group);
    if (before) this.owners.get(before.owner)?.delete(group);
    const shell: ShellGroup = { owner, shellEnded: false, ...(started ? { started } : {}) };
    this.groups.set(group, shell);
    const owned = this.owners.get(owner) ?? new Set<number>();
    owned.add(group);
    this.owners.set(owner, owned);
    return () => {
      shell.shellEnded = true;
    };
  }

  /** The shell that started `group`, while its task is open. */
  of(group: number): ShellGroup | undefined {
    const shell = this.groups.get(group);
    return shell && this.open(shell.owner) ? { ...shell } : undefined;
  }

  /** Each owner whose task is no longer open: its groups are no longer the crew's. */
  forgetClosed(owners: Iterable<string>): void {
    for (const owner of owners) {
      if (this.open(owner)) continue;
      for (const group of this.owners.get(owner) ?? []) this.groups.delete(group);
      this.owners.delete(owner);
    }
  }
}

/**
 * The home's shell groups, each the crew's while its task is open and
 * forgotten once it closes or is removed.
 */
export function shellGroupsOf(tasks: Pick<TaskService, "get" | "onChange">): ShellGroups {
  const groups = new ShellGroups((owner) => {
    const record = tasks.get(owner);
    return record !== undefined && !TaskService.isClosed(record);
  });
  tasks.onChange(({ taskIds, removed }) => groups.forgetClosed([...taskIds, ...removed]));
  return groups;
}

/**
 * A Claude crewmate's shell told the task channel its process number
 * (`resources/axi-bin/infinitary-crew-shell`, which its client runs each
 * command through): keep its shell's group for `owner`. The client starts
 * each command's shell leading a process group of its own, and the shell
 * runs the program as itself, or, when it does not replace itself, as its
 * child; so the group kept is the one the program or its parent leads.
 * The client also runs its servers and hooks through the program, inside
 * the client's group, which neither they nor the client leads, so none of
 * those is kept.
 * The leader must be a program this app started, directly or through
 * programs it started (`appPid`), never the app itself, so no program can
 * name another's group; its birth stamp is kept with it, since the app
 * never hears that shell end.
 */
export async function claimShellGroup(
  groups: Pick<ShellGroups, "add">,
  owner: string,
  pid: number,
  options: { appPid?: number; read?: () => Promise<ProcessReading[] | null> } = {},
): Promise<boolean> {
  const rows = await (options.read ?? readProcesses)();
  if (!rows) return false;
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const row = byPid.get(pid);
  if (!row || row.exited) return false;
  const leader = row.group === pid ? row : byPid.get(row.parent);
  if (!leader || leader.exited || leader.pid !== row.group || leader.group !== leader.pid)
    return false;
  if (!leader.started) return false;
  if (descendsFrom(leader.pid, options.appPid ?? process.pid, byPid) !== true) return false;
  groups.add(leader.pid, owner, leader.started);
  return true;
}
