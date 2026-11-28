import type { EndedUseReceipt, UseReceipt } from "./requests";

/**
 * Which tasks asked for each Secrets use (docs/secrets.md, "Trusted controller"): the
 * tasks that named it, those still waiting for its end, and those its answer
 * told it waits on the captain, who hear once when it starts. Process-local:
 * after a restart, a use's task is read from its intent (`intentTask`).
 */
export class UseRequesters {
  private readonly named = new Map<string, Set<string>>();
  private readonly awaiting = new Map<string, Set<string>>();
  private readonly startsFor = new Map<string, Set<string>>();

  /** A task heard this receipt. True when the use still waits or runs, so the task waits for its end. */
  heard(receipt: UseReceipt, task: string): boolean {
    add(this.named, receipt.request, task);
    if (receipt.state !== "waiting" && receipt.state !== "executing") return false;
    add(this.awaiting, receipt.request, task);
    if (receipt.state === "waiting") add(this.startsFor, receipt.request, task);
    return true;
  }

  /** The first task that named the use, which its card and history name. */
  first(request: string): string | undefined {
    return this.named.get(request)?.values().next().value;
  }

  names(request: string, task: string): boolean {
    return this.named.get(request)?.has(task) ?? false;
  }

  /** The task cancelled: it receives that answer directly, so it hears neither the start nor the end. */
  left(request: string, task: string): void {
    this.awaiting.get(request)?.delete(task);
  }

  /** The use's program started: the tasks told it waits on the captain that still wait for it, once. */
  began(request: string): string[] {
    const told = this.startsFor.get(request);
    this.startsFor.delete(request);
    return [...(told ?? [])].filter((task) => this.awaiting.get(request)?.has(task));
  }

  /** The use ended: the tasks still waiting for it, once. */
  ended(request: string): string[] {
    const waiting = this.awaiting.get(request);
    this.awaiting.delete(request);
    this.startsFor.delete(request);
    return [...(waiting ?? [])];
  }
}

/**
 * The uses a restart ended (`UseJournal.cutOff`) whose intent names a task
 * still open: each one's task and how the use ended.
 */
export function cutOffTasks(
  cut: { intent: string; receipt: EndedUseReceipt }[],
  open: (task: string) => boolean,
): { task: string; receipt: EndedUseReceipt }[] {
  return cut.flatMap(({ intent, receipt }) => {
    const task = intentTask(intent);
    return task && open(task) ? [{ task, receipt }] : [];
  });
}

/** Namespace idempotency, not authority: two tasks may choose the same local intent name. */
export function taskIntent(task: string, id: string): string {
  return JSON.stringify([task, id]);
}

/** The task a crewmate's intent names (`taskIntent`), or undefined for any other intent. */
export function intentTask(intent: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(intent);
    return Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === "string" &&
      parsed[0] !== "" &&
      typeof parsed[1] === "string"
      ? parsed[0]
      : undefined;
  } catch {
    return undefined;
  }
}

function add(map: Map<string, Set<string>>, request: string, task: string): void {
  const tasks = map.get(request) ?? new Set<string>();
  tasks.add(task);
  map.set(request, tasks);
}
