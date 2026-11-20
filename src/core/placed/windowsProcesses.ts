import { basename } from "node:path";
import koffi from "koffi";
import type { ProcessReading } from "./processResources";

/**
 * What Windows lists of its programs, read from the system itself rather
 * than from a program the app starts (docs/heavy-runs.md, "On Windows"):
 * each program's number, parent, birth, processor time and resident memory
 * (`NtQuerySystemInformation`), which program holds the client end of a
 * loopback connection (`GetExtendedTcpTable`), each program's working folder
 * and program file, and the Windows job objects the app makes in place of
 * the process groups a Mac or Linux shell starts (`WindowsJobs`). Only
 * numbers, times, folders and program file paths are read; no argument or
 * environment of any program is read into the app.
 *
 * Every layout here is the 64-bit one: the app runs on Intel and AMD PCs only.
 */

/** A FILETIME counts 100 ns ticks from 1601; the epoch is this many ms later. */
const FILETIME_EPOCH_MS = 11_644_473_600_000n;
const TICKS_PER_MS = 10_000n;

/** `SystemProcessInformation`, and the answer for a buffer too small for it. */
const SYSTEM_PROCESS_INFORMATION = 5;
const STATUS_INFO_LENGTH_MISMATCH = -1073741820;
/** `SYSTEM_PROCESS_INFORMATION`'s fields on 64-bit Windows. */
const SPI = {
  next: 0x00,
  createTime: 0x20,
  userTime: 0x28,
  kernelTime: 0x30,
  pid: 0x50,
  parent: 0x58,
  workingSet: 0x90,
} as const;

/** `AF_INET`, `TCP_TABLE_OWNER_PID_CONNECTIONS` and `MIB_TCP_STATE_ESTAB`. */
const AF_INET = 2;
const TCP_TABLE_OWNER_PID_CONNECTIONS = 4;
const TCP_ESTABLISHED = 5;
const NO_ERROR = 0;
const ERROR_INSUFFICIENT_BUFFER = 122;
/** One `MIB_TCPROW_OWNER_PID`: state, local address and port, remote address and port, owner. */
const TCP_ROW_BYTES = 24;

const PROCESS_TERMINATE = 0x0001;
const PROCESS_VM_READ = 0x0010;
const PROCESS_SET_QUOTA = 0x0100;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
/** `JOB_OBJECT_QUERY | JOB_OBJECT_ASSIGN_PROCESS | JOB_OBJECT_SET_ATTRIBUTES`. */
const JOB_ACCESS = 0x0004 | 0x0001 | 0x0010;
/** `JobObjectBasicProcessIdList`. */
const JOB_PROCESS_IDS = 3;
/** `PROCESS_BASIC_INFORMATION`'s size and its `PebBaseAddress`. */
const BASIC_INFORMATION_BYTES = 48;
const PEB_BASE = 8;
/** The PEB's `ProcessParameters`, and their `CurrentDirectory.DosPath`. */
const PEB_PARAMETERS = 0x20;
const PARAMETERS_CURRENT_DIRECTORY = 0x38;
/** The longest path `QueryFullProcessImageNameW` and a working folder can hold, in characters. */
const PATH_CHARACTERS = 32_768;

/** A Windows birth stamp: its 100 ns ticks since 1601, which the system never repeats for a number. */
export function windowsBirth(createTime: bigint): string {
  return `win:${createTime}`;
}

/**
 * The programs in a `SystemProcessInformation` answer, one row each. A
 * program's parent is the number it was started by, which Windows never
 * changes: once that parent ends, the number can name a later program, so a
 * parent born after its child, or no longer listed, is no parent (0), and
 * walking up from a program stops there, as it stops at the first process
 * on a Mac. The system idle process (0) is no program.
 */
export function processesFromSystemInformation(buffer: Buffer): ProcessReading[] | null {
  const rows: (ProcessReading & { created: bigint })[] = [];
  for (let offset = 0; offset + SPI.workingSet + 8 <= buffer.length; ) {
    const pid = Number(buffer.readBigUInt64LE(offset + SPI.pid));
    const created = buffer.readBigInt64LE(offset + SPI.createTime);
    if (pid > 0) {
      const cpu =
        buffer.readBigInt64LE(offset + SPI.userTime) +
        buffer.readBigInt64LE(offset + SPI.kernelTime);
      const row = {
        pid,
        parent: Number(buffer.readBigUInt64LE(offset + SPI.parent)),
        group: 0,
        started: windowsBirth(created),
        cpuMs: Number(cpu) / Number(TICKS_PER_MS),
        residentBytes: Number(buffer.readBigUInt64LE(offset + SPI.workingSet)),
        created,
        ...(created > 0n ? { bornMs: Number(created / TICKS_PER_MS - FILETIME_EPOCH_MS) } : {}),
      };
      if (!Number.isSafeInteger(row.pid) || !Number.isSafeInteger(row.residentBytes)) return null;
      rows.push(row);
    }
    const next = buffer.readUInt32LE(offset + SPI.next);
    if (next === 0) break;
    offset += next;
  }
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  return rows.length
    ? rows.map(({ created, ...row }) => {
        const parent = byPid.get(row.parent);
        return !parent || parent.pid === row.pid || parent.created > created
          ? { ...row, parent: 0 }
          : row;
      })
    : null;
}

/** A loopback connection's two ends, by port: the caller's and the app's own. */
export type LoopbackPorts = { clientPort: number; serverPort: number };

/**
 * The programs holding the client end of a loopback connection, from a
 * `TCP_TABLE_OWNER_PID_CONNECTIONS` table: each row's state, its local and
 * remote IPv4 address and port (in network order) and the program that owns it.
 */
export function loopbackOwnersFromTcpTable(buffer: Buffer, ends: LoopbackPorts): number[] {
  if (buffer.length < 4) return [];
  const count = buffer.readUInt32LE(0);
  const owners = new Set<number>();
  const port = (offset: number) => buffer.readUInt16BE(offset);
  const loopback = (offset: number) =>
    buffer[offset] === 127 &&
    buffer[offset + 1] === 0 &&
    buffer[offset + 2] === 0 &&
    buffer[offset + 3] === 1;
  for (let index = 0; index < count; index++) {
    const row = 4 + index * TCP_ROW_BYTES;
    if (row + TCP_ROW_BYTES > buffer.length) break;
    if (
      buffer.readUInt32LE(row) === TCP_ESTABLISHED &&
      loopback(row + 4) &&
      port(row + 8) === ends.clientPort &&
      loopback(row + 12) &&
      port(row + 16) === ends.serverPort
    ) {
      const pid = buffer.readUInt32LE(row + 20);
      if (pid > 0) owners.add(pid);
    }
  }
  return [...owners];
}

/**
 * Each program's group from the jobs the app keeps (`lists`, each job's
 * leader with the programs in it). A job made inside another job lists in
 * both, so a program's group is the smallest job that lists it, as a
 * program in a heavy run inside a crewmate's shell is in the run's group;
 * of two jobs that list the same programs, the one made later (later in
 * `lists`) is the inner one. A program in none of them is in no group (0).
 */
export function groupsFromJobs(lists: ReadonlyMap<number, readonly number[]>): Map<number, number> {
  const groups = new Map<number, { leader: number; size: number }>();
  for (const [leader, pids] of lists)
    for (const pid of pids) {
      const before = groups.get(pid);
      if (!before || pids.length <= before.size) groups.set(pid, { leader, size: pids.length });
    }
  return new Map([...groups].map(([pid, { leader }]) => [pid, leader]));
}

/** The process numbers in a `JOBOBJECT_BASIC_PROCESS_ID_LIST`, or null when it did not fit. */
export function jobProcessIds(buffer: Buffer): number[] | null {
  const assigned = buffer.readUInt32LE(0);
  const listed = buffer.readUInt32LE(4);
  if (listed < assigned || 8 + listed * 8 > buffer.length) return null;
  return Array.from({ length: listed }, (_, index) =>
    Number(buffer.readBigUInt64LE(8 + index * 8)),
  );
}

/** The job's name: its leader's number and birth, so a later program with that number gets its own. */
export function jobName(pid: number, started: string): string {
  return `Local\\Infinitary-group-${pid}-${started.replace(/^win:/, "")}`;
}

type Handle = unknown;
type Native = {
  querySystem: (kind: number, buffer: Buffer, size: number, needed: number[]) => number;
  tcpTable: (
    buffer: Buffer | null,
    size: number[],
    order: number,
    family: number,
    kind: number,
    reserved: number,
  ) => number;
  openProcess: (access: number, inherit: number, pid: number) => Handle;
  queryProcess: (
    process: Handle,
    kind: number,
    buffer: Buffer,
    size: number,
    returned: number[],
  ) => number;
  readMemory: (
    process: Handle,
    address: bigint,
    buffer: Buffer,
    size: number,
    read: number[],
  ) => number;
  imageName: (process: Handle, flags: number, buffer: Buffer, size: number[]) => number;
  processTimes: (
    process: Handle,
    created: Buffer,
    exited: Buffer,
    kernel: Buffer,
    user: Buffer,
  ) => number;
  closeHandle: (handle: Handle) => number;
  createJob: (attributes: null, name: string) => Handle;
  openJob: (access: number, inherit: number, name: string) => Handle;
  assign: (job: Handle, process: Handle) => number;
  queryJob: (job: Handle, kind: number, info: Buffer, size: number, returned: number[]) => number;
};

let native: Native | undefined;

/** The system's own functions, loaded once and only on Windows. */
function system(): Native {
  if (native) return native;
  const ntdll = koffi.load("ntdll.dll");
  const kernel32 = koffi.load("kernel32.dll");
  const iphlpapi = koffi.load("iphlpapi.dll");
  native = {
    querySystem: ntdll.func(
      "int32_t __stdcall NtQuerySystemInformation(int32_t kind, _Out_ void *buffer, uint32_t size, _Out_ uint32_t *needed)",
    ),
    queryProcess: ntdll.func(
      "int32_t __stdcall NtQueryInformationProcess(void *process, int32_t kind, _Out_ void *buffer, uint32_t size, _Out_ uint32_t *returned)",
    ),
    tcpTable: iphlpapi.func(
      "uint32_t __stdcall GetExtendedTcpTable(_Out_ void *table, _Inout_ uint32_t *size, int32_t order, uint32_t family, int32_t kind, uint32_t reserved)",
    ),
    openProcess: kernel32.func(
      "void * __stdcall OpenProcess(uint32_t access, int32_t inherit, uint32_t pid)",
    ),
    readMemory: kernel32.func(
      "int32_t __stdcall ReadProcessMemory(void *process, uint64_t address, _Out_ void *buffer, uint64_t size, _Out_ uint64_t *read)",
    ),
    imageName: kernel32.func(
      "int32_t __stdcall QueryFullProcessImageNameW(void *process, uint32_t flags, _Out_ void *buffer, _Inout_ uint32_t *size)",
    ),
    processTimes: kernel32.func(
      "int32_t __stdcall GetProcessTimes(void *process, _Out_ void *created, _Out_ void *exited, _Out_ void *kernel, _Out_ void *user)",
    ),
    closeHandle: kernel32.func("int32_t __stdcall CloseHandle(void *handle)"),
    createJob: kernel32.func(
      "void * __stdcall CreateJobObjectW(void *attributes, const char16_t *name)",
    ),
    openJob: kernel32.func(
      "void * __stdcall OpenJobObjectW(uint32_t access, int32_t inherit, const char16_t *name)",
    ),
    assign: kernel32.func("int32_t __stdcall AssignProcessToJobObject(void *job, void *process)"),
    queryJob: kernel32.func(
      "int32_t __stdcall QueryInformationJobObject(void *job, int32_t kind, _Out_ void *info, uint32_t size, _Out_ uint32_t *returned)",
    ),
  } as Native;
  return native;
}

/** The whole process table in one answer, or null when the system would not give it. */
export function readWindowsTable(): ProcessReading[] | null {
  try {
    const { querySystem } = system();
    let size = 512 * 1024;
    for (let attempt = 0; attempt < 8; attempt++) {
      const buffer = Buffer.alloc(size);
      const needed = [0];
      const status = querySystem(SYSTEM_PROCESS_INFORMATION, buffer, size, needed);
      if (status === 0)
        return processesFromSystemInformation(buffer.subarray(0, needed[0] || size));
      if (status !== STATUS_INFO_LENGTH_MISMATCH) return null;
      // The table can grow between the two calls; ask with room to spare.
      size = Math.max(size * 2, (needed[0] ?? 0) + 64 * 1024);
    }
    return null;
  } catch {
    return null;
  }
}

/** The programs holding the client end of a loopback connection, or null when unreadable. */
export function readWindowsLoopbackOwners(ends: LoopbackPorts): number[] | null {
  try {
    const { tcpTable } = system();
    let size = 64 * 1024;
    for (let attempt = 0; attempt < 8; attempt++) {
      const buffer = Buffer.alloc(size);
      const asked = [size];
      const status = tcpTable(buffer, asked, 0, AF_INET, TCP_TABLE_OWNER_PID_CONNECTIONS, 0);
      if (status === NO_ERROR) return loopbackOwnersFromTcpTable(buffer, ends);
      if (status !== ERROR_INSUFFICIENT_BUFFER) return null;
      size = Math.max(size * 2, (asked[0] ?? 0) + 4 * 1024);
    }
    return null;
  } catch {
    return null;
  }
}

function withProcess<T>(pid: number, access: number, read: (process: Handle) => T): T | undefined {
  const { openProcess, closeHandle } = system();
  const process = openProcess(access, 0, pid);
  if (!process) return undefined;
  try {
    return read(process);
  } finally {
    closeHandle(process);
  }
}

function readPointer(process: Handle, address: bigint): bigint | undefined {
  const buffer = Buffer.alloc(8);
  return system().readMemory(process, address, buffer, buffer.length, [0])
    ? buffer.readBigUInt64LE(0)
    : undefined;
}

/**
 * The working folder a program of this account works in, from its own
 * process parameters: the folder it was started in or last changed to.
 * A program of another account, or one that ended, has none.
 */
function workingFolder(process: Handle): string | undefined {
  const { queryProcess, readMemory } = system();
  const basic = Buffer.alloc(BASIC_INFORMATION_BYTES);
  if (queryProcess(process, 0, basic, basic.length, [0]) !== 0) return undefined;
  const peb = basic.readBigUInt64LE(PEB_BASE);
  if (peb === 0n) return undefined;
  const parameters = readPointer(process, peb + BigInt(PEB_PARAMETERS));
  if (!parameters) return undefined;
  // CurrentDirectory.DosPath: its length in bytes, then (aligned) its buffer.
  const text = Buffer.alloc(16);
  if (!readMemory(process, parameters + BigInt(PARAMETERS_CURRENT_DIRECTORY), text, 16, [0]))
    return undefined;
  const length = text.readUInt16LE(0);
  const address = text.readBigUInt64LE(8);
  if (length === 0 || length > PATH_CHARACTERS * 2 || address === 0n) return undefined;
  const path = Buffer.alloc(length);
  if (!readMemory(process, address, path, length, [0])) return undefined;
  return windowsFolder(path.toString("utf16le"));
}

/** A folder as Windows writes it, without the `\\?\` prefix or a trailing separator below its drive. */
export function windowsFolder(path: string): string {
  const plain = path.replace(/^\\\\\?\\/, "");
  return /^[A-Za-z]:\\$/.test(plain) ? plain : plain.replace(/[\\/]+$/, "");
}

function imagePath(process: Handle, buffer: Buffer): string | undefined {
  const size = [PATH_CHARACTERS];
  if (!system().imageName(process, 0, buffer, size)) return undefined;
  return buffer.subarray(0, (size[0] ?? 0) * 2).toString("utf16le");
}

/** What one program of this account works in and runs: its working folder and its program file. */
export type WindowsPlaces = { folder?: string; image?: string };

/**
 * Each program's working folder and, when `image` is asked for, its
 * program file, for those this account may read; a program it may not
 * read, or one that ended, is left out. Serial, one handle at a time, so a
 * large table cannot use up handles.
 */
export function readWindowsPlaces(
  pids: readonly number[],
  { image: withImage }: { image: boolean },
): Map<number, WindowsPlaces> | null {
  try {
    system();
  } catch {
    return null;
  }
  const buffer = Buffer.alloc(PATH_CHARACTERS * 2);
  const places = new Map<number, WindowsPlaces>();
  for (const pid of pids) {
    const read: WindowsPlaces | undefined =
      withProcess(pid, PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, (process) => {
        const folder = workingFolder(process);
        const image = withImage ? imagePath(process, buffer) : undefined;
        return { ...(folder ? { folder } : {}), ...(image ? { image } : {}) };
      }) ??
      (withImage
        ? withProcess(pid, PROCESS_QUERY_LIMITED_INFORMATION, (process) => {
            const image = imagePath(process, buffer);
            return image ? { image } : {};
          })
        : undefined);
    if (read && (read.folder || read.image)) places.set(pid, read);
  }
  return places;
}

/** A program's file name, as its holder's name (`node.exe`). */
export function programName(image: string): string {
  return basename(image.replace(/\\/g, "/"));
}

/** The birth of a living program, read from its own handle. */
function birthOf(process: Handle): string | undefined {
  const created = Buffer.alloc(8);
  const ignored = Buffer.alloc(8);
  if (!system().processTimes(process, created, Buffer.alloc(8), ignored, Buffer.alloc(8)))
    return undefined;
  return windowsBirth(created.readBigInt64LE(0));
}

/**
 * The programs the leader started before it joined its job, and theirs:
 * the app can only put a program in a job once it runs, by which time it
 * may have started one (Git Bash's launcher starts its bash at once).
 */
function joinStarted(job: Handle, leader: number): void {
  const rows = readWindowsTable();
  if (!rows) return;
  const children = new Map<number, number[]>();
  for (const row of rows) children.set(row.parent, [...(children.get(row.parent) ?? []), row.pid]);
  const pending = [...(children.get(leader) ?? [])];
  const seen = new Set<number>([leader]);
  for (let pid = pending.pop(); pid !== undefined; pid = pending.pop()) {
    if (seen.has(pid)) continue;
    seen.add(pid);
    withProcess(pid, PROCESS_SET_QUOTA | PROCESS_TERMINATE, (process) =>
      system().assign(job, process),
    );
    pending.push(...(children.get(pid) ?? []));
  }
}

function jobMembers(job: Handle): number[] | null {
  const { queryJob } = system();
  let room = 64;
  for (let attempt = 0; attempt < 8; attempt++) {
    const buffer = Buffer.alloc(8 + room * 8);
    const answered = queryJob(job, JOB_PROCESS_IDS, buffer, buffer.length, [0]) !== 0;
    const ids = jobProcessIds(buffer);
    if (answered && ids) return ids;
    // Too small a list still says how many programs are in the job; any other failure says nothing.
    if (!answered && buffer.readUInt32LE(0) === 0) return null;
    room = Math.max(room * 2, buffer.readUInt32LE(0) + 16);
  }
  return null;
}

/**
 * The Windows job objects the app makes in place of process groups: one for
 * each crewmate shell, each Claude crewmate's command and each heavy run,
 * led by the program the app put in it first. Every program a program in a
 * job starts is in the job too, after the program that started it ends; no
 * program in it may leave, since Git Bash's programs leave every job that
 * lets them. A job is named after its leader's number and birth (`jobName`),
 * so the app finds a heavy run's job again after it restarts (`adopt`). A
 * job sets no limit: nothing in it is slowed, capped or ended for being in it.
 */
export class WindowsJobs {
  private readonly jobs = new Map<number, { handle: Handle; started: string }>();

  /**
   * Make the program lead a job of its own, when it still has the birth the
   * app read (`started`; absent, whatever birth it has): every program it
   * starts from now on is in its group. The answer is the leader's birth,
   * or undefined when the app cannot reach it, it has ended, or a job the app
   * keeps under its number still holds a program.
   */
  lead(pid: number, started?: string): string | undefined {
    const held = this.jobs.get(pid);
    if (held && held.started === started) return started;
    try {
      const { createJob, assign, closeHandle } = system();
      return withProcess(
        pid,
        PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION,
        (process) => {
          const birth = birthOf(process);
          if (!birth || (started !== undefined && birth !== started)) return undefined;
          if (held?.started === birth) return birth;
          // Windows may give an ended leader's number to a new program while
          // its job still holds a program; that job keeps its group, and the
          // new program leads none.
          if (held && jobMembers(held.handle)?.length !== 0) return undefined;
          const job = createJob(null, jobName(pid, birth));
          if (!job) return undefined;
          // The job sets no rule, not even leaving on request: Git Bash's
          // programs leave every job that allows it, which would let a
          // program a shell left running escape its group.
          if (!assign(job, process)) {
            closeHandle(job);
            return undefined;
          }
          if (held) closeHandle(held.handle);
          // Kept in the order made, which `groupsFromJobs` reads for nesting.
          this.jobs.delete(pid);
          this.jobs.set(pid, { handle: job, started: birth });
          joinStarted(job, pid);
          return birth;
        },
      );
    } catch {
      return undefined;
    }
  }

  /** Find a job the app made before it restarted, while a program is still in it. */
  adopt(pid: number, started: string): boolean {
    if (this.jobs.get(pid)?.started === started) return true;
    try {
      const job = system().openJob(JOB_ACCESS, 0, jobName(pid, started));
      if (!job) return false;
      this.jobs.set(pid, { handle: job, started });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Each kept job's programs, by its leader. A job no program is in any
   * more has ended, and is let go. Null when a job could not be read.
   */
  members(): Map<number, number[]> | null {
    const lists = new Map<number, number[]>();
    try {
      for (const [leader, { handle }] of [...this.jobs]) {
        const pids = jobMembers(handle);
        if (!pids) return null;
        if (pids.length === 0) {
          system().closeHandle(handle);
          this.jobs.delete(leader);
        } else lists.set(leader, pids);
      }
    } catch {
      return null;
    }
    return lists;
  }

  /** The birth of the program the app made lead the job kept under `pid`. */
  started(pid: number): string | undefined {
    return this.jobs.get(pid)?.started;
  }

  /** Whether the job led by `pid` still has a program in it. */
  exists(pid: number): boolean {
    const held = this.jobs.get(pid);
    if (!held) return false;
    try {
      const pids = jobMembers(held.handle);
      return pids === null || pids.length > 0;
    } catch {
      return true;
    }
  }
}

/** One set of jobs in each app process, read by every process-table reading. */
export const windowsJobs = new WindowsJobs();

/** The process table with each program's group from the app's jobs, or null when unreadable. */
export function readWindowsProcesses(jobs: WindowsJobs = windowsJobs): ProcessReading[] | null {
  const lists = jobs.members();
  const rows = readWindowsTable();
  if (!rows || !lists) return null;
  const groups = groupsFromJobs(lists);
  for (const row of rows) {
    row.group = groups.get(row.pid) ?? 0;
    const started = row.group ? jobs.started(row.group) : undefined;
    if (started) row.groupStarted = started;
  }
  return rows;
}
