import type { SqlAnswer } from "@shared/personal/contracts";
import { SQL_LIMITS, type SqlRequest, sqlRefusal } from "@shared/sql";
import type { HostChildProcess, HostChildSpawner } from "../host";
import type { SqlChildMessage, SqlParentMessage } from "./sqlProtocol";

/**
 * The core's side of the `sql` read (plugin data surface, Phase B): owns the
 * query process (./sqlProcess.ts), hands it one query at a time, and holds
 * every statement to SQL_LIMITS.timeMs.
 *
 * The time cap is a kill. A statement still running when its timer fires
 * is answered `sql_timeout`, its process is killed - the one way to stop a
 * native SQLite step, and what releases the read snapshot it held on the
 * WAL - and the next query starts a fresh process, so a runaway costs its
 * own caller and nobody else. The timer starts when the query is handed to
 * a process that is open, never while one is starting.
 *
 * The process is started on the first query, not at boot: an app with no
 * query-reading panel never pays for it.
 */

const OPEN_TIMEOUT_MS = 10_000;

type Pending = {
  request: SqlRequest;
  resolve: (answer: SqlAnswer) => void;
  reject: (error: Error) => void;
};

type Child = {
  process: HostChildProcess;
  ready: boolean;
};

export type SqlServiceOptions = {
  /** Absent: the host has no query process, and every query fails. */
  spawner: HostChildSpawner | undefined;
  /** The database file; handed to the query process and nobody else. */
  databasePath: string;
  timeMs?: number;
  log?: (message: string) => void;
};

export class SqlService {
  private readonly queue: Pending[] = [];
  private child: Child | null = null;
  private inFlight: { id: number; pending: Pending; timer: ReturnType<typeof setTimeout> } | null =
    null;
  private nextId = 1;
  private disposed = false;
  private readonly timeMs: number;
  /** How many query processes were started; a kill is followed by one more. */
  private started = 0;

  constructor(private readonly options: SqlServiceOptions) {
    this.timeMs = options.timeMs ?? SQL_LIMITS.timeMs;
  }

  get processesStarted(): number {
    return this.started;
  }

  get pid(): number | undefined {
    return this.child?.process.pid;
  }

  query(request: SqlRequest): Promise<SqlAnswer> {
    if (this.disposed) return Promise.reject(new Error("the query process is shut down"));
    if (!this.options.spawner) {
      return Promise.reject(new Error("this host has no query process"));
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ request, resolve, reject });
      this.pump();
    });
  }

  dispose(): void {
    this.disposed = true;
    const waiting = this.inFlight ? [this.inFlight.pending, ...this.queue] : [...this.queue];
    if (this.inFlight) clearTimeout(this.inFlight.timer);
    this.inFlight = null;
    this.queue.length = 0;
    this.stopChild();
    for (const pending of waiting) pending.reject(new Error("the query process is shut down"));
  }

  private pump(): void {
    if (this.disposed || this.inFlight || this.queue.length === 0) return;
    const child = this.child ?? this.startChild();
    if (!child?.ready) return;
    const pending = this.queue.shift() as Pending;
    const id = this.nextId++;
    const timer = setTimeout(() => this.timedOut(id), this.timeMs);
    this.inFlight = { id, pending, timer };
    const message: SqlParentMessage = { type: "query", id, request: pending.request };
    child.process.postMessage(message);
  }

  private startChild(): Child | null {
    const spawner = this.options.spawner;
    if (!spawner) return null;
    const process = spawner.spawn();
    this.started += 1;
    const child: Child = { process, ready: false };
    this.child = child;
    const openTimer = setTimeout(() => {
      if (this.child === child && !child.ready) {
        this.failChild(child, "the query process did not open the record in time");
      }
    }, OPEN_TIMEOUT_MS);
    process.onMessage((raw) => this.onMessage(child, raw as SqlChildMessage, openTimer));
    process.onExit((code) => {
      clearTimeout(openTimer);
      if (this.child !== child) return;
      this.child = null;
      this.options.log?.(`query process exited (${code ?? "signal"})`);
      if (this.inFlight) {
        const { pending, timer } = this.inFlight;
        clearTimeout(timer);
        this.inFlight = null;
        pending.reject(new Error("the query process stopped"));
      }
      this.pump();
    });
    const open: SqlParentMessage = { type: "open", path: this.options.databasePath };
    process.postMessage(open);
    return child;
  }

  private onMessage(
    child: Child,
    message: SqlChildMessage,
    openTimer: ReturnType<typeof setTimeout>,
  ) {
    if (this.child !== child) return;
    switch (message.type) {
      case "ready":
        clearTimeout(openTimer);
        child.ready = true;
        this.pump();
        return;
      case "failed":
        clearTimeout(openTimer);
        this.failChild(child, `the query process could not open the record: ${message.message}`);
        return;
      case "answer":
      case "error": {
        if (!this.inFlight || this.inFlight.id !== message.id) return;
        const { pending, timer } = this.inFlight;
        clearTimeout(timer);
        this.inFlight = null;
        if (message.type === "answer") pending.resolve(message.answer);
        else pending.reject(new Error(message.message));
        this.pump();
        return;
      }
    }
  }

  /** A process that cannot serve: everything waiting fails, and the next query tries a fresh one. */
  private failChild(child: Child, reason: string): void {
    if (this.child !== child) return;
    this.options.log?.(reason);
    this.stopChild();
    const waiting = [...this.queue];
    this.queue.length = 0;
    for (const pending of waiting) pending.reject(new Error(reason));
  }

  private timedOut(id: number): void {
    if (!this.inFlight || this.inFlight.id !== id) return;
    const { pending } = this.inFlight;
    this.inFlight = null;
    this.options.log?.(`a query ran past ${this.timeMs} ms; its process was stopped`);
    this.stopChild();
    pending.resolve(
      sqlRefusal(
        "sql_timeout",
        `the query ran past ${this.timeMs} ms and was stopped; narrow it with a WHERE or a LIMIT`,
      ),
    );
    this.pump();
  }

  private stopChild(): void {
    const child = this.child;
    this.child = null;
    child?.process.kill();
  }
}
