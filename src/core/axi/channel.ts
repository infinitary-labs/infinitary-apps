import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { HERE } from "../../shared/deviceNames";
import { BROWSER_COMMAND } from "../browser/commandWords";
import type { CrewmateBrowser } from "../browser/taskBrowsers";
import type { HostChildProcess, HostChildSpawner } from "../host";
import { INTEGRATIONS_COMMAND, type TaskIntegrations } from "../integrations";
import { ownTaskCommand } from "./names";
import type {
  AxiCallMessage,
  AxiChildMessage,
  BrowserOp,
  ChannelAnswer,
  ChannelReply,
  IntegrationChannelAnswer,
  IntegrationOpInput,
} from "./protocol";

/**
 * The task channel (docs/axi-commands.md, "The channel"): how a crewmate's
 * `infinitary-<tool>-axi` command reaches its own task's tools in the app.
 *
 * The app listens on a port of this Mac's loopback for the run. Each task
 * that is granted a tool gets its own key, written to a file only its owner
 * can read (0600) in a folder of the app's data only its owner can open
 * (0700), and its shell is told the port and where that file is - never the
 * key itself, on a command line or in the environment. A request carries
 * the key (read from the file), the command's name, its arguments and the
 * working folder; the key alone names the task, so a command reaches only
 * the tools of the task whose key it holds, and a task id in the arguments
 * means nothing. A request a web page could make - one naming another host
 * or carrying an origin - is refused before its key is read. The task's
 * close revokes its key; the folder is emptied when the channel opens and
 * closes, so a run that was killed leaves no key behind for long.
 *
 * Each command runs in a process of its own (`./axiProcess.ts`), which the
 * host starts per request: the SDK it runs writes `process.exitCode`. Its
 * table reaches the task's tool only through `call`, answered here against
 * the browser the task was granted - `TaskBrowsers`, with every guard it
 * keeps.
 *
 * A shell that answers within a limit (Pi's, 3 seconds, which it names in
 * `INFINITARY_SHELL_CAP_MS`) gets its answer within that limit, counted from
 * when the shell started (`INFINITARY_SHELL_STARTED_MS`) while that shell can
 * still answer, not from when this request arrives: a slow launcher must not
 * answer after Pi has already turned the command into a background job. A
 * request that arrives once that limit has run out counts from receipt. An
 * operation still running then goes on, and its answer is kept for the task's
 * next command, which gets it instead of running, even when the limit has
 * already run out. Nothing is ever sent twice.
 *
 * The answer still has to come back through the shell, and a loaded Mac can
 * hold up that way back, or this process, past the limit, which no margin
 * covers. So a request tells its shell, by the id the shell gave it
 * (`INFINITARY_SHELL_ID`), that its command reached the app (`answering`):
 * the shell then waits for the answer rather than turning it into a job.
 */

export type { TaskShell } from "../session/session";

/**
 * The tools a task was granted: its browser, and the integrations its
 * crewmate reaches (`infinitary-integrations-axi`, docs/integrations.md).
 */
export type TaskTools = { browser?: CrewmateBrowser; integrations?: TaskIntegrations };

/** What one operation answers, for either tool. */
type OpAnswer = ChannelAnswer | IntegrationChannelAnswer;

export type AxiChannelOptions = {
  /** Starts the process that runs one command: a utility process in the app, a fork in tests. */
  spawner: HostChildSpawner;
  /** The folder holding the launcher and its `infinitary-<tool>-axi` names (`resources/axi-bin`). */
  binDir: string;
  /** The app's version, which `-v` prints. */
  version: string;
  /** The app's own folder for the keys (`AppPaths.taskChannelDir`); emptied at open and close. */
  keysDir: string;
  /**
   * Told the id of the shell a command came from once it reached the app
   * (`JobManager.answering`), so that shell waits for its answer.
   */
  answering?: (shell: string) => void;
};

/** The variables a task's shell carries (`resources/axi-bin/infinitary-axi` reads them). */
export const AXI_ADDRESS_ENV = "INFINITARY_AXI_ADDRESS";
export const AXI_KEY_ENV = "INFINITARY_AXI_KEY";
export const AXI_VERSION_ENV = "INFINITARY_AXI_VERSION";
export { SHELL_CAP_ENV, SHELL_ID_ENV, SHELL_STARTED_ENV } from "../hostEnv";

/** The header a request carries its key in; the key file is that one header line. */
const KEY_HEADER = "x-infinitary-axi-key";

/** Time a command needs around its operation: the launcher, the process, the answer's way back. */
const CAP_MARGIN_MS = 750;
/** A command process that has not answered by now is stopped. */
const PROCESS_BOUND_MS = 60_000;
/** The largest request a command sends: its arguments and working folder. */
const REQUEST_MAX = 1024 * 1024;
/** The loopback address the channel listens on; a shell reaches it by this name only. */
const LOOPBACK = "127.0.0.1";

const OPS: ReadonlySet<BrowserOp> = new Set([
  "navigate",
  "inspect",
  "act",
  "capture",
  "close",
  "pages",
]);

type Grant = {
  taskId: string;
  keyFile: string;
  digest: string;
  tools: TaskTools;
  /**
   * An operation that ran past its shell's limit, kept for the task's next
   * command of the same tool: a browser's answer never reaches an
   * integrations command, nor the other way.
   */
  parked: Map<string, { command: string; work: Promise<OpAnswer> }>;
};

type Outcome = { exitCode: number; stdout: string };

const TIMEOUT = Symbol("timeout");

function digestOf(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/**
 * When the shell's limit runs out. Count from when the shell started only
 * while it can still answer (`received` before `started + cap`): that is the
 * window a slow launcher would otherwise answer after Pi had given up. At or
 * after that, or with no start, count from receipt, as before. A start after
 * receipt cannot be this shell's start, so it must not push the deadline
 * later. No cap: the shell waits for every answer.
 */
function shellDeadline(
  received: number,
  capRaw: string | null,
  startedRaw: string | null,
): number | undefined {
  const cap = Number(capRaw || Number.NaN);
  if (!Number.isFinite(cap) || cap <= 0) return undefined;
  const started = Number(startedRaw || Number.NaN);
  const stillAnswering = Number.isFinite(started) && started > 0 && received < started + cap;
  const origin = stillAnswering ? Math.min(started, received) : received;
  return origin + cap - CAP_MARGIN_MS;
}

/**
 * Wait for `work` until `deadline`, or for good without one. A deadline
 * already past still lets a settled answer win: a later command in the same
 * shell shares that deadline, and a finished kept answer must not become
 * `BUSY` forever.
 */
async function within<T>(
  work: Promise<T>,
  deadline: number | undefined,
): Promise<T | typeof TIMEOUT> {
  if (deadline === undefined) return work;
  const left = Math.max(0, deadline - Date.now());
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), left);
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** One error line the launcher prints as it is, and its exit code. */
function failed(message: string, code: string, exitCode = 1): Outcome {
  return { exitCode, stdout: `error: ${message}\ncode: ${code}\n` };
}

export class AxiChannel {
  private readonly grants = new Map<string, Grant>();
  private readonly byDigest = new Map<string, Grant>();
  private readonly running = new Set<HostChildProcess>();
  private closed = false;

  private constructor(
    private readonly options: AxiChannelOptions,
    private readonly dir: string,
    /** Where a shell reaches the channel: this Mac's loopback and the run's port. */
    readonly address: string,
    private readonly server: Server,
  ) {}

  /** Empty the keys' folder, its owner's alone, and listen on a loopback port. */
  static async open(options: AxiChannelOptions): Promise<AxiChannel> {
    const dir = options.keysDir;
    // Keys a killed run left answer nothing now; none of them may linger.
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    let channel: AxiChannel | undefined;
    const server = createServer((request, response) => {
      void channel?.handle(request, response);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, LOOPBACK, () => {
          server.off("error", reject);
          resolve();
        });
      });
    } catch (error) {
      rmSync(dir, { recursive: true, force: true });
      throw error;
    }
    const { port } = server.address() as AddressInfo;
    channel = new AxiChannel(options, dir, `${LOOPBACK}:${port}`, server);
    return channel;
  }

  /**
   * Give a task its tools' commands: its key file once, then what its shell
   * carries. A task granted again keeps its key, so a shell already given
   * it still answers, and takes the tools it is granted now.
   */
  grant(taskId: string, tools: TaskTools): { env: Record<string, string>; path: string[] } {
    if (this.closed) throw new Error("The task channel is closed.");
    let grant = this.grants.get(taskId);
    if (!grant) {
      const key = randomBytes(32).toString("hex");
      const keyFile = join(this.dir, `${randomBytes(9).toString("hex")}.key`);
      writeFileSync(keyFile, `${KEY_HEADER}: ${key}\n`, { mode: 0o600, flag: "wx" });
      grant = { taskId, keyFile, digest: digestOf(key), tools, parked: new Map() };
      this.grants.set(taskId, grant);
      this.byDigest.set(grant.digest, grant);
    } else {
      grant.tools = tools;
    }
    return {
      env: {
        [AXI_ADDRESS_ENV]: this.address,
        [AXI_KEY_ENV]: grant.keyFile,
        [AXI_VERSION_ENV]: this.options.version,
      },
      path: [this.options.binDir],
    };
  }

  /** Whether a task holds a key now. */
  granted(taskId: string): boolean {
    return this.grants.has(taskId);
  }

  /** The task closed: its key answers nothing from now on, and its file goes. */
  revoke(taskId: string): void {
    const grant = this.grants.get(taskId);
    if (!grant) return;
    this.grants.delete(taskId);
    this.byDigest.delete(grant.digest);
    try {
      unlinkSync(grant.keyFile);
    } catch {
      // Already gone with the folder.
    }
  }

  /** The app quits: nothing more is answered, every running command stops, the keys go. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const child of this.running) child.kill();
    this.running.clear();
    this.grants.clear();
    this.byDigest.clear();
    this.server.close();
    rmSync(this.dir, { recursive: true, force: true });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const received = Date.now();
    const answer = (outcome: Outcome): void => {
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end(`${outcome.exitCode}\n${outcome.stdout}`);
    };
    // A web page could reach a loopback port too: it names another host
    // (a name rebound to this Mac) or carries its origin. The launcher does neither.
    if (
      request.method !== "POST" ||
      request.url !== "/run" ||
      request.headers.host !== this.address ||
      request.headers.origin !== undefined
    ) {
      request.resume();
      answer(failed("This is not a request a task command makes.", "NO_CHANNEL"));
      return;
    }
    const key = request.headers[KEY_HEADER];
    const grant =
      typeof key === "string" && /^[0-9a-f]{64}$/.test(key)
        ? this.byDigest.get(digestOf(key))
        : undefined;
    if (!grant) {
      request.resume();
      answer(
        failed(
          "This shell's key names no task this app is running: run the command in your task's own shell.",
          "NO_CHANNEL",
        ),
      );
      return;
    }
    const body = await this.readBody(request);
    if (body === undefined) {
      answer(failed("The command's arguments are too long.", "VALIDATION_ERROR", 2));
      return;
    }
    const form = new URLSearchParams(body);
    // Every answer from here comes back through the shell, a refusal too.
    const shell = form.get("shell");
    if (shell) this.options.answering?.(shell);
    // Firstmate 3000's name for a command is the same command.
    const tool = ownTaskCommand(form.get("tool") ?? "");
    const deadline = shellDeadline(received, form.get("cap"), form.get("started"));
    const has =
      (tool === BROWSER_COMMAND && grant.tools.browser !== undefined) ||
      (tool === INTEGRATIONS_COMMAND && grant.tools.integrations !== undefined);
    if (!has) {
      answer(
        failed(
          `This task has no ${tool || "such"} command: it runs only where its task has that tool.`,
          "NO_TOOL",
        ),
      );
      return;
    }
    answer(
      await this.run(grant, {
        tool,
        argv: form.getAll("arg"),
        bin: form.get("bin") || tool,
        cwd: form.get("cwd") ?? "",
        deadline,
      }),
    );
  }

  private readBody(request: IncomingMessage): Promise<string | undefined> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let over = false;
      request.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > REQUEST_MAX) over = true;
        else chunks.push(chunk);
      });
      request.on("end", () => resolve(over ? undefined : Buffer.concat(chunks).toString("utf8")));
      request.on("error", () => resolve(undefined));
    });
  }

  /** Run one command in its own process, answering its calls for this task alone. */
  private run(
    grant: Grant,
    command: { tool: string; argv: string[]; bin: string; cwd: string; deadline?: number },
  ): Promise<Outcome> {
    return new Promise((resolve) => {
      let child: HostChildProcess;
      try {
        child = this.options.spawner.spawn();
      } catch {
        resolve(failed(`${HERE.This} could not start the command right now.`, "FAILED"));
        return;
      }
      this.running.add(child);
      let finished = false;
      const finish = (outcome: Outcome): void => {
        if (finished) return;
        finished = true;
        clearTimeout(bound);
        this.running.delete(child);
        child.kill();
        resolve(outcome);
      };
      const bound = setTimeout(
        () => finish(failed("The command did not answer in time.", "FAILED")),
        PROCESS_BOUND_MS,
      );
      bound.unref?.();
      child.onExit(() => finish(failed("The command stopped before it answered.", "FAILED")));
      child.onMessage((raw) => {
        const message = raw as AxiChildMessage;
        if (message?.type === "done") {
          finish({
            exitCode: Number.isInteger(message.exitCode) ? message.exitCode : 1,
            stdout: String(message.stdout ?? ""),
          });
          return;
        }
        if (message?.type === "call") {
          void this.call(grant, command.tool, message, command.deadline).then((reply) => {
            if (!finished) child.postMessage({ type: "result", id: message.id, reply });
          });
        }
      });
      child.postMessage({
        type: "run",
        tool: command.tool,
        argv: command.argv,
        bin: command.bin,
        cwd: command.cwd,
        version: this.options.version,
      });
    });
  }

  /**
   * One operation on the task's tool, within the shell's limit. A kept
   * answer goes first: the command of that tool that comes after one gets
   * it instead of running, or hears that it still runs.
   */
  private async call(
    grant: Grant,
    tool: string,
    message: AxiCallMessage,
    deadline: number | undefined,
  ): Promise<ChannelReply<OpAnswer>> {
    const parked = grant.parked.get(tool);
    if (parked) {
      const settled = await within(parked.work, deadline);
      if (settled === TIMEOUT) return { kind: "busy", command: parked.command };
      if (grant.parked.get(tool) === parked) grant.parked.delete(tool);
      return { kind: "earlier", command: parked.command, answer: settled };
    }
    const work: Promise<OpAnswer> =
      tool === INTEGRATIONS_COMMAND ? this.integrate(grant, message) : this.operate(grant, message);
    const settled = await within(work, deadline);
    if (settled === TIMEOUT) {
      grant.parked.set(tool, { command: message.command, work });
      return { kind: "running", command: message.command };
    }
    return { kind: "answer", answer: settled };
  }

  /** One of the integrations' operations, for this task alone (`IntegrationsService.forTask`). */
  private async integrate(
    grant: Grant,
    message: AxiCallMessage,
  ): Promise<IntegrationChannelAnswer> {
    const integrations = grant.tools.integrations;
    if (!integrations) return { text: "This task has no integrations.", refused: "refused" };
    try {
      switch (message.op) {
        case "integrations.list":
          return { data: { integrations: integrations.list() } };
        case "integrations.show": {
          const { name } = (message.input ?? {}) as IntegrationOpInput["integrations.show"];
          const shown = integrations.show(String(name ?? ""));
          return "refused" in shown && typeof shown.text === "string"
            ? { text: shown.text, refused: shown.refused as "refused" | "invalid" }
            : { data: shown as Record<string, unknown> };
        }
        case "integrations.call": {
          const { name, action, input } = (message.input ??
            {}) as IntegrationOpInput["integrations.call"];
          return await integrations.call(String(name ?? ""), String(action ?? ""), input);
        }
        default:
          return { text: "That is not an integrations operation.", refused: "invalid" };
      }
    } catch (error) {
      return {
        text: `The integration could not do that: ${error instanceof Error ? error.message : String(error)}.`,
        refused: "refused",
      };
    }
  }

  /** The browser's own operation, never its picture's bytes. */
  private async operate(grant: Grant, message: AxiCallMessage): Promise<ChannelAnswer> {
    const browser = grant.tools.browser;
    const op = message.op as BrowserOp;
    if (!browser || !OPS.has(op)) {
      return { text: "This task has no browser.", refused: "refused" };
    }
    const input = (message.input ?? {}) as never;
    try {
      const { image: _image, ...answer } = await (op === "pages"
        ? browser.pages()
        : browser[op](input));
      return answer;
    } catch (error) {
      return {
        text: `The browser could not do that: ${error instanceof Error ? error.message : String(error)}.`,
        refused: "refused",
      };
    }
  }
}
