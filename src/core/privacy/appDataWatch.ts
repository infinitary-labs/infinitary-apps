import { execFile, spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { hostEnv } from "../hostEnv";

/**
 * The privacy watch (docs/macos-privacy.md, INF-1217 direction A): macOS
 * asks "Infinitary would like to access data from other apps" when a
 * crewmate's search walks into another app's folder, and the crewmate's
 * command waits until a person answers. The crewmate never sees the
 * dialog, so the app reads macOS's own privacy log while it runs, finds
 * the task whose process asked, and writes on that task's timeline that it
 * waits on macOS, then that macOS has its answer.
 *
 * Every line it reads is macOS's (tccd's `AUTHREQ_*` lines): a request's
 * context names its service, its attribution names the app macOS holds
 * responsible and the process that reached the data, and its result names
 * the answer. A request is this app's when its responsible process is
 * this one.
 */

/** macOS's own log reader. */
export const SYSTEM_LOG = "/usr/bin/log";

/** The service behind "access data from other apps" (`NSAppDataUsageDescription`). */
export const APP_DATA_SERVICE = "kTCCServiceSystemPolicyAppData";

/** What the watch asks the log for: every request line tccd writes, as JSON. */
export const PRIVACY_LOG_ARGS = [
  "stream",
  "--style",
  "ndjson",
  "--predicate",
  'subsystem == "com.apple.TCC" AND category == "access" AND eventMessage BEGINSWITH "AUTHREQ_"',
] as const;

/** One request line, as the watch reads it; anything else is not one. */
export type PrivacyLogLine =
  | { kind: "context"; request: string; service: string }
  | { kind: "attribution"; request: string; responsible: number; accessing: number }
  | { kind: "result"; request: string; answer: PrivacyAnswer };

/** macOS's answer to a request: its `authValue`, 0 refused and 2 allowed. */
export type PrivacyAnswer = "allowed" | "refused" | "other";

/** The message of one ndjson log line, or nothing when the line is not one. */
function messageOf(line: string): string | undefined {
  if (!line.startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(line) as { eventMessage?: unknown };
    return typeof parsed.eventMessage === "string" ? parsed.eventMessage : undefined;
  } catch {
    return undefined;
  }
}

/** One line of `log stream --style ndjson` as a request line, or nothing. */
export function readPrivacyLogLine(line: string): PrivacyLogLine | undefined {
  const message = messageOf(line.trim());
  if (!message) return undefined;
  const request = /^AUTHREQ_[A-Z]+: msgID=([^,\s]+),/.exec(message)?.[1];
  if (!request) return undefined;
  if (message.startsWith("AUTHREQ_CTX:")) {
    const service = /\bservice=([A-Za-z]+)/.exec(message)?.[1];
    return service ? { kind: "context", request, service } : undefined;
  }
  if (message.startsWith("AUTHREQ_ATTRIBUTION:")) {
    const responsible = /responsible=\{TCCDProcess: [^}]*?\bpid=(\d+)/.exec(message)?.[1];
    const accessing = /accessing=\{TCCDProcess: [^}]*?\bpid=(\d+)/.exec(message)?.[1];
    if (!responsible || !accessing) return undefined;
    return {
      kind: "attribution",
      request,
      responsible: Number(responsible),
      accessing: Number(accessing),
    };
  }
  if (message.startsWith("AUTHREQ_RESULT:")) {
    const value = /\bauthValue=(\d+)/.exec(message)?.[1];
    if (value === undefined) return undefined;
    const answer = value === "2" ? "allowed" : value === "0" ? "refused" : "other";
    return { kind: "result", request, answer };
  }
  return undefined;
}

/** The words a task's timeline carries, owned here (docs/macos-privacy.md). */
export const PRIVACY_WORDS = {
  waiting:
    "Waiting on macOS: this task's search reached another app's data, and macOS asks you whether to allow it. The search waits for your answer.",
  answered: {
    allowed: "macOS has your answer, Allow, and this task's search goes on.",
    refused:
      "macOS has your answer, Don't Allow, and this task's search goes on without that app's data.",
    other: "macOS has an answer, and this task's search goes on.",
  },
} as const;

/** What the watch reads of a process: its parent and its working folder. */
export type ProcessReader = {
  parent(pid: number): Promise<number | undefined>;
  cwd(pid: number): Promise<string | undefined>;
};

function run(file: string, args: readonly string[]): Promise<string | undefined> {
  return new Promise((done) => {
    execFile(file, [...args], { env: hostEnv(), timeout: 5_000 }, (error, stdout) =>
      done(error ? undefined : stdout),
    );
  });
}

/** macOS's own `ps` and `lsof`, which read a process of this user without a password. */
export const systemProcessReader: ProcessReader = {
  parent: async (pid) => {
    const out = await run("/bin/ps", ["-o", "ppid=", "-p", String(pid)]);
    const parent = Number(out?.trim());
    return Number.isInteger(parent) && parent > 0 ? parent : undefined;
  },
  cwd: async (pid) => {
    const out = await run("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
    return out
      ?.split("\n")
      .find((line) => line.startsWith("n"))
      ?.slice(1);
  },
};

/** A live task and the folder its crewmate works in. */
export type TaskPlace = { taskId: string; dir: string };

/**
 * The task whose process reached the data: the process, or the nearest of
 * its parents, works inside that task's working copy. A crewmate's own
 * program starts there and so does every command it runs, so a command
 * that moved elsewhere is still found through its parent. The walk stops
 * at this app, which is every crewmate's parent. macOS names a folder by
 * its real path (`/private/var/...` for `/var/...`), so a task's folder is
 * compared by its real path too.
 */
export async function taskOfProcess(
  pid: number,
  options: { reader: ProcessReader; places: readonly TaskPlace[]; self: number },
): Promise<string | undefined> {
  if (options.places.length === 0) return undefined;
  const places = await Promise.all(
    options.places.map(async (place) => ({
      ...place,
      dir: await realpath(place.dir).catch(() => resolve(place.dir)),
    })),
  );
  const seen = new Set<number>();
  let at: number | undefined = pid;
  while (at !== undefined && at > 1 && at !== options.self && !seen.has(at)) {
    seen.add(at);
    const cwd = await options.reader.cwd(at);
    if (cwd) {
      const folder = resolve(cwd);
      const found = places.find(
        (place) => folder === place.dir || folder.startsWith(place.dir + sep),
      );
      if (found) return found.taskId;
    }
    at = await options.reader.parent(at);
  }
  return undefined;
}

/** One run of the log reader: each line it prints, then its end. */
export type PrivacyLogRun = (heard: { line: (text: string) => void; ended: () => void }) => {
  stop: () => void;
};

/** Runs the log reader (`SYSTEM_LOG`, or a development run's stand-in) with the watch's arguments. */
export function runPrivacyLog(program: string): PrivacyLogRun {
  return (heard) => {
    let ended = false;
    const child = spawn(program, [...PRIVACY_LOG_ARGS], {
      env: hostEnv(),
      stdio: ["ignore", "pipe", "ignore"],
    });
    let rest = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (ended) return;
      const lines = (rest + chunk).split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) heard.line(line);
    });
    const end = () => {
      if (ended) return;
      ended = true;
      heard.ended();
    };
    child.on("error", end);
    child.on("close", end);
    return {
      stop: () => {
        ended = true;
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      },
    };
  };
}

type Request = { taskId?: string; looked: boolean; answer?: PrivacyAnswer; waiting: boolean };

/**
 * The watch itself: it reads each request line, keeps the app-data
 * requests this app is responsible for, and writes a task's waiting line
 * when its first request still has no answer once the task is found, and
 * its answered line when its last waiting request has one. A request
 * macOS answers at once, from an earlier choice, showed no dialog and
 * writes nothing.
 */
export class AppDataWatch {
  private readonly services = new Map<string, string>();
  private readonly requests = new Map<string, Request>();
  private readonly waiting = new Map<string, Set<string>>();
  private running: { stop: () => void } | undefined;

  constructor(
    private readonly options: {
      run: PrivacyLogRun;
      /** This app's process: macOS names it as responsible for a crewmate's request. */
      self: number;
      findTask: (pid: number) => Promise<string | undefined>;
      note: (taskId: string, text: string, facts: Record<string, unknown>) => void;
    },
  ) {}

  start(): void {
    if (this.running) return;
    this.running = this.options.run({
      line: (text) => this.heard(text),
      ended: () => {
        this.running = undefined;
      },
    });
  }

  dispose(): void {
    this.running?.stop();
    this.running = undefined;
  }

  /** One line of the log, as it arrives. */
  heard(text: string): void {
    const line = readPrivacyLogLine(text);
    if (!line) return;
    if (line.kind === "context") {
      if (line.service === APP_DATA_SERVICE) this.services.set(line.request, line.service);
      return;
    }
    if (line.kind === "attribution") {
      if (!this.services.delete(line.request)) return;
      if (line.responsible !== this.options.self) return;
      const request: Request = { looked: false, waiting: false };
      this.requests.set(line.request, request);
      void this.options.findTask(line.accessing).then(
        (taskId) => this.found(line.request, request, taskId),
        () => this.found(line.request, request, undefined),
      );
      return;
    }
    this.services.delete(line.request);
    const request = this.requests.get(line.request);
    if (!request) return;
    request.answer = line.answer;
    if (request.looked) this.settle(line.request, request);
  }

  private found(id: string, request: Request, taskId: string | undefined): void {
    request.looked = true;
    if (taskId) request.taskId = taskId;
    if (request.answer !== undefined || !taskId) {
      this.settle(id, request);
      return;
    }
    request.waiting = true;
    const open = this.waiting.get(taskId) ?? new Set<string>();
    if (open.size === 0) {
      this.options.note(taskId, PRIVACY_WORDS.waiting, {
        macosPrivacy: "waiting",
        service: APP_DATA_SERVICE,
      });
    }
    open.add(id);
    this.waiting.set(taskId, open);
  }

  private settle(id: string, request: Request): void {
    this.requests.delete(id);
    if (!request.waiting || !request.taskId || request.answer === undefined) return;
    const open = this.waiting.get(request.taskId);
    if (!open?.delete(id)) return;
    if (open.size > 0) return;
    this.waiting.delete(request.taskId);
    this.options.note(request.taskId, PRIVACY_WORDS.answered[request.answer], {
      macosPrivacy: "answered",
      service: APP_DATA_SERVICE,
      answer: request.answer,
    });
  }
}
