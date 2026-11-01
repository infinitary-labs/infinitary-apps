import { constants, createWriteStream, type FSWatcher, watch } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, sep } from "node:path";
import { finished } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";

const within = (directory: string, path: string) => {
  const child = relative(directory, path);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
};

/** INF-1936: the gate already owns this UUID; discover only its recorded log directory. */
export function phoneSimulatorLogDirectory(simulator: string, listing: string): string {
  const data = JSON.parse(listing) as {
    devices?: Record<string, { udid?: string; logPath?: string }[]>;
  };
  const matches = Object.values(data.devices ?? {})
    .flat()
    .filter((device) => device.udid === simulator);
  const path = matches.length === 1 ? matches[0]?.logPath : undefined;
  if (!path || !isAbsolute(path) || basename(path) !== simulator)
    throw new Error("The owned simulator has no unique absolute log directory");
  return path;
}

type LogSource = { path: string; directory: string; device: bigint; inode: bigint };
/** lsof -F pftanDi: select the owned launcher's actual regular, writable log.
 * CoreSimulator also writes under com.apple.CoreSimulator.SimDevice.<UUID>,
 * outside the listing's logPath. Derive that directory only from its descriptor.
 */
export function phoneLauncherLogSource(pid: number, directory: string, listing: string): LogSource {
  let currentPid = 0;
  let file: Record<string, string> = {};
  const sources = new Map<string, LogSource>();
  const accept = () => {
    if (
      currentPid !== pid ||
      !/^\d+$/.test(file.f ?? "") ||
      file.t !== "REG" ||
      !/^[wu]$/.test(file.a ?? "")
    )
      return;
    const path = file.n;
    if (!path || !isAbsolute(path)) return;
    const observedDirectory = dirname(path);
    const ownedDirectory = within(directory, path)
      ? directory
      : basename(observedDirectory) === `com.apple.CoreSimulator.SimDevice.${basename(directory)}`
        ? observedDirectory
        : undefined;
    if (!ownedDirectory) return;
    if (!/^0x[0-9a-f]+$/i.test(file.D ?? "") || !/^\d+$/.test(file.i ?? ""))
      throw new Error("The launcher log has no file identity");
    const source = {
      path,
      directory: ownedDirectory,
      device: BigInt(file.D!),
      inode: BigInt(file.i!),
    };
    const prior = sources.get(path);
    if (prior && (prior.device !== source.device || prior.inode !== source.inode))
      throw new Error("The launcher's log identity changed during discovery");
    sources.set(path, source);
  };
  for (const line of listing.split("\n")) {
    const key = line[0],
      value = line.slice(1);
    if (key === "p") {
      accept();
      file = {};
      currentPid = Number(value);
    } else if (key === "f") {
      accept();
      file = { f: value };
    } else if (key) file[key] = value;
  }
  accept();
  if (sources.size !== 1)
    throw new Error(
      "The owned launcher has no unique writable file in its simulator log directory",
    );
  return [...sources.values()][0]!;
}

/** Follow the verified descriptor's file without following rotation or symlinks to another file.
 * A changed/truncated source is an evidence gap, never an excuse to read a replacement.
 */
export async function observePhoneLauncherLog({
  directory,
  source,
  destination,
  seconds,
  record,
  onLine,
  watchPath = watch,
}: {
  directory: string;
  source: LogSource;
  destination: string;
  seconds: number;
  record(event: string, detail?: Record<string, unknown>): void;
  /** Only complete lines appended after the initial snapshot; historical bytes stay evidence. */
  onLine?(line: string): void;
  watchPath?(path: string, changed: () => void): FSWatcher;
}) {
  const root = await realpath(directory);
  if (basename(root) !== basename(directory) || !within(root, await realpath(source.path)))
    throw new Error("The launcher log escapes its owned directory");
  const input = await open(source.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const identity = await input.stat({ bigint: true });
    if (!identity.isFile() || identity.dev !== source.device || identity.ino !== source.inode)
      throw new Error("The launcher's log identity changed before capture");
  } catch (error) {
    await input.close();
    throw error;
  }
  const output = createWriteStream(destination);
  const written = finished(output);
  void written.catch(() => {});
  let position = 0;
  let problem: unknown;
  let closing: Promise<void> | undefined;
  let pending = Promise.resolve();
  const buffer = Buffer.alloc(64 * 1024);
  const decoder = new StringDecoder("utf8");
  let initial = true;
  let partial = "";
  let skipPartial = false;
  let lastByte: number | undefined;
  let deliveredLines = 0;
  let liveLines = 0;
  const notifications = { directory: 0, file: 0 };
  const flush = (trigger = "manual") => {
    pending = pending
      .then(async () => {
        if (problem) return;
        const current = await lstat(source.path, { bigint: true });
        if (
          !current.isFile() ||
          current.dev !== source.device ||
          current.ino !== source.inode ||
          current.size < BigInt(position)
        )
          throw new Error(
            "The owned launcher log was replaced or truncated; capture is incomplete",
          );
        const end = Number(current.size);
        const from = position;
        let delivered = 0;
        let live = 0;
        while (position < end) {
          const { bytesRead } = await input.read(
            buffer,
            0,
            Math.min(buffer.length, end - position),
            position,
          );
          if (!bytesRead) throw new Error("The launcher log ended before its recorded size");
          await new Promise<void>((resolve, reject) =>
            output.write(buffer.subarray(0, bytesRead), (error) =>
              error ? reject(error) : resolve(),
            ),
          );
          lastByte = buffer[bytesRead - 1];
          if (!initial && onLine) {
            partial += decoder.write(buffer.subarray(0, bytesRead));
            while (partial.includes("\n")) {
              const end = partial.indexOf("\n");
              const line = partial.slice(0, end);
              partial = partial.slice(end + 1);
              if (!skipPartial) {
                onLine(line);
                delivered++;
                deliveredLines++;
                if (!closing) {
                  live++;
                  liveLines++;
                }
              }
              skipPartial = false;
            }
          }
          position += bytesRead;
        }
        if (position > from)
          record("launcher-log-read", { trigger, from, through: position, delivered, live });
      })
      .catch((error: unknown) => {
        problem = error;
        record("launcher-log-error", { error: String(error), bytes: position });
      });
    return pending;
  };
  // Observe the held file's writes as well as its directory's rotation notices.
  // Both notifications use the same descriptor, identity checks and serialized reader.
  const watchers: FSWatcher[] = [];
  try {
    for (const [kind, path] of [
      ["directory", directory],
      ["file", source.path],
    ] as const) {
      const watcher = watchPath(path, () => {
        notifications[kind]++;
        if (!closing) void flush(kind);
      });
      watchers.push(watcher);
      watcher.on("error", (error) => {
        problem = error;
        record("launcher-log-error", { watch: kind, error: String(error) });
      });
    }
  } catch (error) {
    for (const watcher of watchers) watcher.close();
    await input.close();
    output.end();
    await written.catch(() => {});
    throw error;
  }
  const close = (reason = "The native journey ended") => {
    if (closing) return closing;
    for (const watcher of watchers) watcher.close();
    clearTimeout(timer);
    record("launcher-log-stop-requested", { reason });
    closing = flush("close").then(async () => {
      await input.close();
      output.end();
      await written;
      record("launcher-log-closed", {
        bytes: position,
        complete: !problem,
        notifications,
        deliveredLines,
        liveLines,
      });
    });
    return closing;
  };
  const timer = setTimeout(() => {
    void close("The existing capture allowance ended").catch((error: unknown) =>
      record("launcher-log-error", { error: String(error) }),
    );
  }, seconds * 1000);
  try {
    await flush("initial");
    if (problem) throw problem;
    initial = false;
    skipPartial = position > 0 && lastByte !== 10;
    record("launcher-log-ready", {
      source: source.path,
      device: String(source.device),
      inode: String(source.inode),
      bytes: position,
    });
    return { close, flush };
  } catch (error) {
    await close("The launcher log could not be captured");
    throw error;
  }
}
